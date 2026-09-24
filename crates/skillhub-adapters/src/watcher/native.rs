//! Native OS watch backend boundary. Backends only produce hints; whether a
//! hint becomes a relationship fact is decided by the confirmation scan in
//! the application layer. The clock is injectable so stable-window behavior
//! is tested deterministically instead of with sleeps.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use notify::Watcher as _;
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, WatchHint, WatchHintKind};

use super::coalescer::WatchCoalescer;
use super::Watcher;

/// Millis clock driving the stable window. Injectable so tests advance time
/// deterministically.
pub trait WatchClock: Send + std::fmt::Debug {
    fn now_millis(&self) -> u64;
}

/// Monotonic system clock anchored at construction.
#[derive(Debug)]
pub struct SystemWatchClock {
    anchor: Instant,
}

impl SystemWatchClock {
    pub fn new() -> Self {
        Self {
            anchor: Instant::now(),
        }
    }
}

impl Default for SystemWatchClock {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchClock for SystemWatchClock {
    fn now_millis(&self) -> u64 {
        self.anchor
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
}

/// Manually advanced clock for deterministic stable-window tests.
#[derive(Clone, Debug, Default)]
pub struct ManualWatchClock {
    now_millis: Arc<AtomicU64>,
}

impl ManualWatchClock {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn advance(&self, millis: u64) {
        self.now_millis.fetch_add(millis, Ordering::SeqCst);
    }
}

impl WatchClock for ManualWatchClock {
    fn now_millis(&self) -> u64 {
        self.now_millis.load(Ordering::SeqCst)
    }
}

/// One raw OS notification translated into a hint source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeWatchEvent {
    pub kind: NativeWatchEventKind,
    pub path: PathBuf,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWatchEventKind {
    Created,
    Changed,
    Removed,
    Renamed,
    Overflow,
}

/// The OS event source behind a [`NativeRelationshipWatcher`].
pub trait NativeWatchBackend: Send {
    /// Begin (or restart) watching exactly these roots. Restarting must
    /// replace prior registrations atomically so a root generation switch
    /// has no event-loss window.
    fn start(&mut self, roots: &[PathBuf]) -> AppResult<()>;

    fn stop(&mut self) -> AppResult<()>;

    /// Drain events that already arrived, without blocking.
    fn poll(&mut self) -> Vec<NativeWatchEvent>;
}

/// notify-backed backend. Restarting drops and rebuilds the inner watcher so
/// a root switch cannot miss events created between unwatch and watch.
#[derive(Default)]
pub struct NotifyWatchBackend {
    inner: Option<notify::RecommendedWatcher>,
    receiver: Option<mpsc::Receiver<Result<notify::Event, notify::Error>>>,
    watched_roots: Vec<PathBuf>,
}

impl NotifyWatchBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn take_overflow_events(&self) -> Vec<NativeWatchEvent> {
        self.watched_roots
            .iter()
            .map(|root| NativeWatchEvent {
                kind: NativeWatchEventKind::Overflow,
                path: root.clone(),
            })
            .collect()
    }
}

impl std::fmt::Debug for NotifyWatchBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotifyWatchBackend")
            .field("watched_roots", &self.watched_roots)
            .finish()
    }
}

impl NativeWatchBackend for NotifyWatchBackend {
    fn start(&mut self, roots: &[PathBuf]) -> AppResult<()> {
        // Dropping the old watcher is the reset; its stop result cannot make
        // a fresh registration fail.
        let _ = self.stop();
        let (sender, receiver) = mpsc::channel();
        let mut inner = notify::recommended_watcher(move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| {
            AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("reason", format!("watch backend init failed: {error}"))
        })?;
        for root in roots {
            inner
                .watch(root.as_path(), notify::RecursiveMode::Recursive)
                .map_err(|error| {
                    AppError::new(ErrorCode::InternalError, Severity::Error)
                        .with_param("root", root.to_string_lossy().into_owned())
                        .with_param("reason", format!("watch root registration failed: {error}"))
                })?;
        }
        self.inner = Some(inner);
        self.receiver = Some(receiver);
        self.watched_roots = roots.to_vec();
        Ok(())
    }

    fn stop(&mut self) -> AppResult<()> {
        self.inner = None;
        if let Some(receiver) = &self.receiver {
            while receiver.try_recv().is_ok() {}
        }
        self.receiver = None;
        self.watched_roots.clear();
        Ok(())
    }

    fn poll(&mut self) -> Vec<NativeWatchEvent> {
        let mut events = Vec::new();
        let Some(receiver) = &self.receiver else {
            return events;
        };
        loop {
            match receiver.try_recv() {
                Ok(Ok(event)) => {
                    if event.need_rescan() {
                        events.extend(self.take_overflow_events());
                    } else {
                        let kind = map_notify_kind(&event.kind);
                        events.extend(
                            event
                                .paths
                                .into_iter()
                                .map(|path| NativeWatchEvent { kind, path }),
                        );
                    }
                }
                Ok(Err(_)) => {
                    // Individual backend errors stay hints-only; compensation
                    // scans are driven by resume/overflow lifecycle signals.
                }
                Err(mpsc::TryRecvError::Empty) | Err(mpsc::TryRecvError::Disconnected) => break,
            }
        }
        events
    }
}

fn map_notify_kind(kind: &notify::EventKind) -> NativeWatchEventKind {
    use notify::event::{EventKind, ModifyKind};
    match kind {
        EventKind::Create(_) => NativeWatchEventKind::Created,
        EventKind::Remove(_) => NativeWatchEventKind::Removed,
        EventKind::Modify(ModifyKind::Name(_)) => NativeWatchEventKind::Renamed,
        EventKind::Modify(_) | EventKind::Access(_) | EventKind::Other | EventKind::Any => {
            NativeWatchEventKind::Changed
        }
    }
}

/// Owns the native backend plus the confirm-side [`Watcher`] (active-root
/// filtering, coalescing and compensation state). OS events go in as hints;
/// only hints whose stable window elapsed come back out as confirmed batches.
pub struct NativeRelationshipWatcher {
    inner: Watcher,
    backend: Box<dyn NativeWatchBackend>,
}

impl std::fmt::Debug for NativeRelationshipWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeRelationshipWatcher")
            .field("inner", &self.inner)
            .field("running", &self.is_running())
            .finish()
    }
}

impl NativeRelationshipWatcher {
    pub fn new<I, P>(roots: I, backend: Box<dyn NativeWatchBackend>) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self::with_stable_window(roots, Duration::from_millis(400), backend)
    }

    pub fn with_stable_window<I, P>(
        roots: I,
        stable_window: Duration,
        backend: Box<dyn NativeWatchBackend>,
    ) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self::with_clock(
            roots,
            stable_window,
            backend,
            Box::new(SystemWatchClock::new()),
        )
    }

    pub fn with_clock<I, P>(
        roots: I,
        stable_window: Duration,
        backend: Box<dyn NativeWatchBackend>,
        clock: Box<dyn WatchClock>,
    ) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self {
            inner: Watcher::with_coalescer(roots, WatchCoalescer::with_clock(stable_window, clock)),
            backend,
        }
    }

    pub fn set_recognized_skill_roots<I, P>(&mut self, roots: I)
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        self.inner.coalescer_mut().set_recognized_skill_roots(roots);
    }

    pub fn start(&mut self) -> AppResult<()> {
        let roots: Vec<PathBuf> = self.inner.active_roots().map(Path::to_path_buf).collect();
        self.backend.start(&roots)?;
        self.inner.start()
    }

    pub fn stop(&mut self) -> AppResult<()> {
        self.backend.stop()?;
        self.inner.stop()
    }

    pub fn is_running(&self) -> bool {
        self.inner.is_running()
    }

    pub fn active_roots(&self) -> impl Iterator<Item = &Path> {
        self.inner.active_roots()
    }

    pub fn push(&mut self, hint: WatchHint) -> bool {
        self.inner.push(hint)
    }

    pub fn on_app_resumed(&mut self) -> bool {
        self.inner.on_app_resumed()
    }

    pub fn on_reconnected(&mut self, root: impl Into<String>) -> bool {
        self.inner.on_reconnected(root)
    }

    pub fn compensation_scan_pending(&self) -> bool {
        self.inner.compensation_scan_pending()
    }

    pub fn take_compensation_scan(&mut self) -> bool {
        self.inner.take_compensation_scan()
    }

    /// Drain native events into the confirm pipeline and return hints whose
    /// stable window has elapsed. Compensation needs never appear here.
    pub fn poll(&mut self) -> AppResult<Vec<WatchHint>> {
        if !self.inner.is_running() {
            return Ok(Vec::new());
        }
        for event in self.backend.poll() {
            self.route(event);
        }
        Ok(self.inner.coalescer_mut().flush_ready())
    }

    /// Force-drain every pending hint regardless of the stable window.
    pub fn flush(&mut self) -> AppResult<Vec<WatchHint>> {
        self.inner.flush()
    }

    fn route(&mut self, event: NativeWatchEvent) {
        let Some(root) = self.root_for(&event.path) else {
            return;
        };
        let root_lossy = root.to_string_lossy();
        match event.kind {
            NativeWatchEventKind::Overflow => {
                self.inner.on_overflow(root_lossy.into_owned());
            }
            kind => {
                let hint = WatchHint::for_root(root_lossy, event.path.to_string_lossy())
                    .with_kind(hint_kind(kind));
                self.inner.push(hint);
            }
        }
    }

    fn root_for(&self, path: &Path) -> Option<&Path> {
        let normalized = normalize(path);
        self.inner
            .active_roots()
            .filter(|root| {
                let candidate = normalize(root);
                normalized == candidate || normalized.starts_with(&format!("{candidate}/"))
            })
            .max_by_key(|root| normalize(root).len())
    }
}

fn hint_kind(kind: NativeWatchEventKind) -> WatchHintKind {
    match kind {
        NativeWatchEventKind::Created => WatchHintKind::Created,
        NativeWatchEventKind::Changed => WatchHintKind::Changed,
        NativeWatchEventKind::Removed => WatchHintKind::Removed,
        NativeWatchEventKind::Renamed => WatchHintKind::Renamed,
        NativeWatchEventKind::Overflow => WatchHintKind::Overflow,
    }
}

fn normalize(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        value
    }
}
