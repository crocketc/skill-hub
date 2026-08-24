mod coalescer;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use skillhub_core::AppResult;

pub use coalescer::WatchCoalescer;
pub use skillhub_core::{WatchHint, WatchHintKind};

/// In-process watcher boundary. Native OS backends can feed it hints, while
/// this type owns active-root filtering, lifecycle and compensation state.
#[derive(Debug)]
pub struct Watcher {
    active_roots: BTreeSet<PathBuf>,
    coalescer: WatchCoalescer,
    running: bool,
    compensation_pending: bool,
}

impl Watcher {
    pub fn new<I, P>(roots: I) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self::with_stable_window(roots, Duration::from_millis(400))
    }

    pub fn with_stable_window<I, P>(roots: I, stable_window: Duration) -> Self
    where
        I: IntoIterator<Item = P>,
        P: Into<PathBuf>,
    {
        Self {
            active_roots: roots.into_iter().map(Into::into).collect(),
            coalescer: WatchCoalescer::new(stable_window),
            running: false,
            compensation_pending: false,
        }
    }

    pub fn active_roots(&self) -> impl Iterator<Item = &Path> {
        self.active_roots.iter().map(PathBuf::as_path)
    }

    pub fn coalescer(&self) -> &WatchCoalescer {
        &self.coalescer
    }

    pub fn coalescer_mut(&mut self) -> &mut WatchCoalescer {
        &mut self.coalescer
    }

    pub fn start(&mut self) -> AppResult<()> {
        self.running = true;
        Ok(())
    }

    pub fn stop(&mut self) -> AppResult<()> {
        self.running = false;
        self.coalescer = WatchCoalescer::new(self.coalescer.stable_window());
        self.compensation_pending = false;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    /// Submit an OS notification. Notifications outside active allowed roots
    /// are discarded before they can reach the coalescer.
    pub fn push(&mut self, hint: WatchHint) -> bool {
        if !self.running || !self.is_allowed(&hint) {
            return false;
        }
        if hint.is_compensation() {
            self.compensation_pending = true;
        } else {
            self.coalescer.push(hint);
        }
        true
    }

    pub fn emit(&mut self, hint: WatchHint) -> bool {
        self.push(hint)
    }

    pub fn handle_hint(&mut self, hint: WatchHint) -> bool {
        self.push(hint)
    }

    pub fn on_overflow(&mut self, root: impl Into<String>) -> bool {
        self.push(WatchHint::overflow(root))
    }

    pub fn on_app_resumed(&mut self) -> bool {
        self.push(WatchHint::app_resumed())
    }

    pub fn on_reconnected(&mut self, root: impl Into<String>) -> bool {
        self.push(WatchHint::reconnected(root))
    }

    pub fn flush(&mut self) -> AppResult<Vec<WatchHint>> {
        if !self.running {
            return Ok(Vec::new());
        }
        Ok(self.coalescer.flush_after_stable())
    }

    pub fn take_compensation_scan(&mut self) -> bool {
        std::mem::take(&mut self.compensation_pending)
    }

    pub fn compensation_scan_pending(&self) -> bool {
        self.compensation_pending
    }

    pub fn request_compensation_scan(&mut self) {
        if self.running {
            self.compensation_pending = true;
        }
    }

    fn is_allowed(&self, hint: &WatchHint) -> bool {
        if hint.kind() == WatchHintKind::AppResumed {
            return !self.active_roots.is_empty();
        }
        self.active_roots.iter().any(|root| hint.belongs_to(root))
    }
}

pub type InProcessWatcher = Watcher;
