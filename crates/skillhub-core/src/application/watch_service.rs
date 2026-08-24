use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::api::{AppEvent, FactsChanged};
use crate::AppResult;

/// The kind of filesystem or lifecycle signal received by the watcher.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WatchHintKind {
    Changed,
    Created,
    Removed,
    Renamed,
    Overflow,
    AppResumed,
    Reconnected,
}

/// A watcher signal. It is only a hint; it must not be persisted as a fact.
#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct WatchHint {
    root: String,
    path: String,
    target_id: Option<String>,
    kind: WatchHintKind,
}

impl WatchHint {
    pub fn new(path: impl Into<String>) -> Self {
        let path = path.into();
        Self {
            root: String::new(),
            path,
            target_id: None,
            kind: WatchHintKind::Changed,
        }
    }

    pub fn for_root(root: impl Into<String>, path: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            ..Self::new(path)
        }
    }

    pub fn for_target(path: impl Into<String>, target_id: impl Into<String>) -> Self {
        Self {
            target_id: Some(target_id.into()),
            ..Self::new(path)
        }
    }

    pub fn overflow(root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            kind: WatchHintKind::Overflow,
            ..Self::new(String::new())
        }
    }

    pub fn app_resumed() -> Self {
        Self {
            kind: WatchHintKind::AppResumed,
            ..Self::new(String::new())
        }
    }

    pub fn reconnected(root: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            kind: WatchHintKind::Reconnected,
            ..Self::new(String::new())
        }
    }

    pub fn with_kind(mut self, kind: WatchHintKind) -> Self {
        self.kind = kind;
        self
    }

    pub fn with_target(mut self, target_id: impl Into<String>) -> Self {
        self.target_id = Some(target_id.into());
        self
    }

    pub fn root(&self) -> Option<&Path> {
        (!self.root.is_empty()).then(|| Path::new(self.root.as_str()))
    }

    pub fn path(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }

    pub fn path_str(&self) -> &str {
        &self.path
    }

    pub fn target_id(&self) -> Option<&str> {
        self.target_id.as_deref()
    }

    pub fn kind(&self) -> WatchHintKind {
        self.kind
    }

    pub fn is_compensation(&self) -> bool {
        matches!(
            self.kind,
            WatchHintKind::Overflow | WatchHintKind::AppResumed | WatchHintKind::Reconnected
        )
    }

    pub fn belongs_to(&self, root: &Path) -> bool {
        if !self.root_matches_path() {
            return false;
        }
        if self.kind == WatchHintKind::AppResumed {
            return true;
        }
        let candidate = if !self.path.is_empty() {
            Path::new(&self.path)
        } else if !self.root.is_empty() {
            Path::new(&self.root)
        } else {
            return false;
        };
        path_starts_with(candidate, root)
    }

    pub fn root_matches_path(&self) -> bool {
        if self.root.is_empty() || self.kind == WatchHintKind::AppResumed {
            return true;
        }
        if self.path.is_empty() {
            return path_starts_with(Path::new(&self.root), Path::new(&self.root));
        }
        path_starts_with(Path::new(&self.path), Path::new(&self.root))
    }

    pub fn skill_root(&self) -> Option<PathBuf> {
        Path::new(&self.path)
            .file_name()
            .is_some_and(|name| name == "SKILL.md")
            .then(|| {
                Path::new(&self.path)
                    .parent()
                    .unwrap_or(Path::new(&self.path))
                    .to_path_buf()
            })
    }

    pub fn coalescing_key(&self) -> String {
        self.coalescing_key_with_skill_roots(&BTreeSet::new())
    }

    pub fn coalescing_key_with_skill_roots(&self, skill_roots: &BTreeSet<String>) -> String {
        if let Some(target_id) = &self.target_id {
            return format!("target:{target_id}");
        }
        let path = Path::new(&self.path);
        if let Some(skill_root) = self.skill_root() {
            return format!("skill:{}", skill_root.display());
        }
        if let Some(skill_root) = skill_roots
            .iter()
            .filter(|root| path_starts_with(path, Path::new(root)))
            .max_by_key(|root| root.len())
        {
            return format!("skill:{skill_root}");
        }
        format!("path:{}", path.display())
    }
}

fn path_starts_with(candidate: &Path, root: &Path) -> bool {
    if candidate.starts_with(root) {
        return true;
    }
    #[cfg(windows)]
    {
        let candidate = candidate
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        let root = root
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        candidate == root
            || candidate
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('\\'))
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[async_trait::async_trait]
pub trait WatchConfirmation: Send + Sync {
    async fn confirm(&self, hints: Vec<WatchHint>) -> AppResult<()>;

    async fn compensation_scan(&self) -> AppResult<()>;
}

#[derive(Default)]
struct WatchState {
    running: bool,
    pending: BTreeMap<String, WatchHint>,
    compensation_pending: bool,
    active_roots: BTreeSet<String>,
    recognized_skill_roots: BTreeSet<String>,
    confirmed_batches: u64,
}

/// Coordinates watcher hints and confirming scans while keeping lifecycle
/// operations idempotent. A hint is never a durable fact by itself.
pub struct WatchService {
    state: Arc<Mutex<WatchState>>,
    confirmation: Option<Arc<dyn WatchConfirmation>>,
    events: Option<tokio::sync::broadcast::Sender<AppEvent>>,
}

impl Clone for WatchService {
    fn clone(&self) -> Self {
        Self {
            state: self.state.clone(),
            confirmation: self.confirmation.clone(),
            events: self.events.clone(),
        }
    }
}

impl Default for WatchService {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchService {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(WatchState::default())),
            confirmation: None,
            events: None,
        }
    }

    pub fn with_confirmation(confirmation: Arc<dyn WatchConfirmation>) -> Self {
        Self {
            confirmation: Some(confirmation),
            ..Self::new()
        }
    }

    pub fn with_event_sender(mut self, sender: tokio::sync::broadcast::Sender<AppEvent>) -> Self {
        self.events = Some(sender);
        self
    }

    pub fn set_active_roots<I, P>(&self, roots: I)
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut state = self.state.lock().expect("watch state mutex poisoned");
        state.active_roots = roots
            .into_iter()
            .map(|root| normalize_path(root.as_ref()))
            .collect();
    }

    pub fn start(&self) -> AppResult<()> {
        self.state
            .lock()
            .expect("watch state mutex poisoned")
            .running = true;
        Ok(())
    }

    pub fn stop(&self) -> AppResult<()> {
        let mut state = self.state.lock().expect("watch state mutex poisoned");
        state.running = false;
        state.pending.clear();
        state.compensation_pending = false;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.state
            .lock()
            .expect("watch state mutex poisoned")
            .running
    }

    /// Queue a hint. This does not invoke the confirmation port or publish an
    /// event, so callers can safely accept noisy editor notifications.
    pub fn submit_hint(&self, hint: WatchHint) -> AppResult<bool> {
        let mut state = self.state.lock().expect("watch state mutex poisoned");
        if !hint.root_matches_path() {
            return Err(invalid_watch("watch hint root does not contain its path"));
        }
        if !state.running || !is_allowed(&state.active_roots, &hint) {
            return Ok(false);
        }
        if hint.is_compensation() {
            state.compensation_pending = true;
        } else {
            if let Some(skill_root) = hint.skill_root() {
                state
                    .recognized_skill_roots
                    .insert(normalize_path(&skill_root));
            }
            let key = hint.coalescing_key_with_skill_roots(&state.recognized_skill_roots);
            state.pending.insert(key, hint);
        }
        Ok(true)
    }

    pub fn emit_watch_hint(&self, hint: WatchHint) -> AppResult<bool> {
        self.submit_hint(hint)
    }

    pub fn handle_hint(&self, hint: WatchHint) -> AppResult<bool> {
        self.submit_hint(hint)
    }

    pub fn pending_hints(&self) -> Vec<WatchHint> {
        self.state
            .lock()
            .expect("watch state mutex poisoned")
            .pending
            .values()
            .cloned()
            .collect()
    }

    pub fn take_compensation_scan(&self) -> bool {
        let mut state = self.state.lock().expect("watch state mutex poisoned");
        std::mem::take(&mut state.compensation_pending)
    }

    pub fn confirmed_batches(&self) -> u64 {
        self.state
            .lock()
            .expect("watch state mutex poisoned")
            .confirmed_batches
    }

    /// Confirm queued hints. The event is published only after the scan port
    /// succeeds; this is the boundary between hints and facts.
    pub async fn confirm_pending(&self) -> AppResult<Option<FactsChanged>> {
        if self.confirmation.is_none() {
            let state = self.state.lock().expect("watch state mutex poisoned");
            if state.pending.is_empty() && !state.compensation_pending {
                return Ok(None);
            }
            return Err(invalid_watch("watch confirmation scanner is unavailable"));
        }
        let (hints, compensation) = {
            let mut state = self.state.lock().expect("watch state mutex poisoned");
            if !state.running {
                return Ok(None);
            }
            (
                std::mem::take(&mut state.pending)
                    .into_values()
                    .collect::<Vec<_>>(),
                std::mem::take(&mut state.compensation_pending),
            )
        };
        if hints.is_empty() && !compensation {
            return Ok(None);
        }
        let confirmation = self
            .confirmation
            .as_ref()
            .expect("confirmation checked before taking pending hints");
        let result = async {
            if compensation {
                confirmation.compensation_scan().await?;
            }
            if !hints.is_empty() {
                confirmation.confirm(hints.clone()).await?;
            }
            Ok::<_, crate::AppError>(())
        }
        .await;
        if let Err(error) = result {
            let mut state = self.state.lock().expect("watch state mutex poisoned");
            for hint in hints {
                let key = hint.coalescing_key_with_skill_roots(&state.recognized_skill_roots);
                state.pending.insert(key, hint);
            }
            state.compensation_pending |= compensation;
            return Err(error);
        }
        self.state
            .lock()
            .expect("watch state mutex poisoned")
            .confirmed_batches += 1;
        let event = FactsChanged::new();
        if let Some(sender) = &self.events {
            let _ = sender.send(AppEvent::FactsChanged(event.clone()));
        }
        Ok(Some(event))
    }

    pub async fn run_scheduled_confirmation(&self) -> AppResult<Option<FactsChanged>> {
        self.confirm_pending().await
    }
}

fn normalize_path(path: &Path) -> String {
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

fn is_allowed(roots: &BTreeSet<String>, hint: &WatchHint) -> bool {
    if roots.is_empty() {
        return false;
    }
    if hint.kind() == WatchHintKind::AppResumed {
        return true;
    }
    let path = hint.path();
    roots.iter().any(|root| {
        let root = Path::new(root);
        path_starts_with(&path, root)
            || hint
                .root()
                .is_some_and(|hint_root| path_starts_with(hint_root, root))
    })
}

fn invalid_watch(detail: impl Into<String>) -> crate::AppError {
    crate::AppError::new(crate::ErrorCode::InvalidInput, crate::Severity::Error)
        .with_param("detail", detail.into())
        .with_action(crate::RecoveryAction::Acknowledge)
}
