//! Relationship watch confirmation runtime (plan Task 6B).
//!
//! OS watcher events are hints only. The runtime owns the native watcher and
//! the pending hint queue: `collect` moves stable-window-elapsed hints into
//! the queue without touching SQLite (the backend channel thread never reads
//! the database), and `confirm_pending` drives the Task 5 checks — a normal
//! file hint runs a Full check scoped to the relations mapped from its path,
//! while compensation hints (Overflow/AppResumed/Reconnected) run a Light
//! scan over every active relation. A failed confirmation keeps its hint in
//! the queue and never archives a relation or advances the relationship
//! revision as a side effect.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use skillhub_adapters::watcher::{
    NativeRelationshipWatcher, NativeWatchBackend, NotifyWatchBackend, SystemWatchClock,
    WatchClock, WatchHint,
};
use skillhub_core::api::{AppCommandResult, RunRelationshipCheck};
use skillhub_core::relationship::{
    RelationshipCheckItemStatus, RelationshipCheckLevel, RelationshipCheckReport,
    RelationshipCheckScope,
};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};

use crate::LocalApplicationFacade;

/// Confirmation operations the runtime needs from the application. Injectable
/// so failure paths are testable without sabotaging SQLite.
pub trait RelationshipCheckExecuting: Send + Sync {
    /// Active local relation roots the watcher should listen to.
    fn active_roots(&self) -> AppResult<Vec<PathBuf>>;

    /// Full check scoped to the relations mapped from this path.
    fn check_path(&self, path: &Path) -> AppResult<RelationshipCheckReport>;

    /// Light compensation scan over every active relation.
    fn compensate(&self) -> AppResult<RelationshipCheckReport>;
}

/// Real executor bound to the application facade.
#[derive(Clone)]
pub struct FacadeRelationshipCheckExecutor {
    facade: Arc<LocalApplicationFacade>,
}

impl FacadeRelationshipCheckExecutor {
    pub fn new(facade: Arc<LocalApplicationFacade>) -> Self {
        Self { facade }
    }

    fn run_scoped(&self, request: RunRelationshipCheck) -> AppResult<RelationshipCheckReport> {
        match self.facade.run_relationship_check(request)? {
            AppCommandResult::RelationshipCheckReport(report) => Ok(report),
            _ => Err(AppError::new(ErrorCode::InternalError, Severity::Error)
                .with_param("operation", "watch_confirmation_check")),
        }
    }
}

impl RelationshipCheckExecuting for FacadeRelationshipCheckExecutor {
    fn active_roots(&self) -> AppResult<Vec<PathBuf>> {
        self.facade
            .with_database("watch.confirm.active_roots", |database| {
                Ok(database
                    .relationship_repository()
                    .list_source_copy_relations(true)?
                    .into_iter()
                    .map(|relation| PathBuf::from(&relation.source_path))
                    .collect())
            })
    }

    fn check_path(&self, path: &Path) -> AppResult<RelationshipCheckReport> {
        let path_text = path.to_string_lossy().into_owned();
        let path_key = skillhub_core::deployment::observed_path_key(&path_text);
        let relation_ids =
            self.facade
                .with_database("watch.confirm.mapped_relations", |database| {
                    Ok(database
                        .relationship_repository()
                        .list_source_copy_relations(true)?
                        .into_iter()
                        .filter(|relation| {
                            relation.source_path_key == path_key
                                || skillhub_core::deployment::path_lives_under(
                                    &path_text,
                                    &relation.source_path,
                                )
                        })
                        .map(|relation| relation.relation_id)
                        .collect())
                })?;
        self.run_scoped(RunRelationshipCheck {
            level: RelationshipCheckLevel::Full,
            scope: RelationshipCheckScope::RelationIds { relation_ids },
        })
    }

    fn compensate(&self) -> AppResult<RelationshipCheckReport> {
        self.run_scoped(RunRelationshipCheck {
            level: RelationshipCheckLevel::Light,
            scope: RelationshipCheckScope::AllActive,
        })
    }
}

/// Outcome of one confirmation pass over the pending queue.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct WatchConfirmationReport {
    /// Hints whose mapped-relation check completed with results.
    pub confirmed_file_hints: usize,
    /// Compensation scans (Overflow/AppResumed/Reconnected) completed.
    pub compensation_scans: usize,
    /// Hints dropped because no active relation maps to their path.
    pub dropped_unmapped: usize,
    /// Hints kept because their check failed; they stay pending.
    pub retained_hints: usize,
    /// Whether any completed check changed a relationship fact; the pump
    /// forwards this as the existing FactsChanged app event.
    pub facts_changed: bool,
}

/// Owns the native watcher and the pending hint queue.
pub struct RelationshipWatchRuntime {
    watcher: NativeRelationshipWatcher,
    roots_generation: u64,
    pending: VecDeque<WatchHint>,
}

impl std::fmt::Debug for RelationshipWatchRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RelationshipWatchRuntime")
            .field("roots_generation", &self.roots_generation)
            .field("pending", &self.pending.len())
            .field("running", &self.watcher.is_running())
            .finish()
    }
}

impl Default for RelationshipWatchRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl RelationshipWatchRuntime {
    pub fn new() -> Self {
        Self::with_components(
            Box::new(NotifyWatchBackend::new()),
            Box::new(SystemWatchClock::new()),
        )
    }

    /// 仅供测试：注入受控 backend 与时钟。
    #[doc(hidden)]
    pub fn for_tests(backend: Box<dyn NativeWatchBackend>, clock: Box<dyn WatchClock>) -> Self {
        Self::with_components(backend, clock)
    }

    fn with_components(backend: Box<dyn NativeWatchBackend>, clock: Box<dyn WatchClock>) -> Self {
        Self {
            watcher: NativeRelationshipWatcher::with_clock(
                std::iter::empty::<PathBuf>(),
                Duration::from_millis(400),
                backend,
                clock,
            ),
            roots_generation: 0,
            pending: VecDeque::new(),
        }
    }

    pub fn roots_generation(&self) -> u64 {
        self.roots_generation
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_running(&self) -> bool {
        self.watcher.is_running()
    }

    /// Lifecycle-injected compensation triggers (Task 6C).
    pub fn on_app_resumed(&mut self) -> bool {
        self.watcher.on_app_resumed()
    }

    pub fn on_reconnected(&mut self, root: impl Into<String>) -> bool {
        self.watcher.on_reconnected(root)
    }

    pub fn on_overflow(&mut self, root: impl Into<String>) -> bool {
        self.watcher.on_overflow(root)
    }

    /// First start: pull the current root generation and begin watching.
    /// Empty relation roots keep the watcher stopped.
    pub fn start(&mut self, executor: &dyn RelationshipCheckExecuting) -> AppResult<()> {
        self.refresh_roots(executor)?;
        if self.watcher.active_roots().next().is_some() {
            self.watcher.start()?;
        }
        Ok(())
    }

    pub fn stop(&mut self) -> AppResult<()> {
        self.watcher.stop()
    }

    /// Switch to the latest root generation. Only a changed set bumps the
    /// generation; the backend replaces registrations without a stop/start
    /// gap, an empty set keeps the watcher stopped, and a non-empty set on a
    /// stopped watcher starts it again.
    pub fn refresh_roots(&mut self, executor: &dyn RelationshipCheckExecuting) -> AppResult<bool> {
        let roots = executor.active_roots()?;
        let current: std::collections::BTreeSet<PathBuf> =
            self.watcher.active_roots().map(Path::to_path_buf).collect();
        let next: std::collections::BTreeSet<PathBuf> = roots.iter().cloned().collect();
        if current == next {
            return Ok(false);
        }
        self.watcher.apply_root_generation(roots)?;
        if !self.watcher.is_running() && self.watcher.active_roots().next().is_some() {
            self.watcher.start()?;
        }
        self.roots_generation += 1;
        Ok(true)
    }

    /// Drain backend events through the watcher and queue everything that
    /// passed the stable window. Never touches SQLite.
    pub fn collect(&mut self) -> AppResult<usize> {
        let mut queued = 0usize;
        for hint in self.watcher.poll()? {
            self.pending.push_back(hint);
            queued += 1;
        }
        if self.watcher.take_compensation_scan() {
            self.pending.push_back(WatchHint::app_resumed());
            queued += 1;
        }
        Ok(queued)
    }

    /// Confirm pending hints against real relations. A failed check keeps
    /// its hint queued and never changes facts as a side effect.
    pub fn confirm_pending(
        &mut self,
        executor: &dyn RelationshipCheckExecuting,
    ) -> WatchConfirmationReport {
        let mut report = WatchConfirmationReport::default();
        let mut remaining = VecDeque::new();
        while let Some(hint) = self.pending.pop_front() {
            let outcome = if hint.is_compensation() {
                executor.compensate().map(|check| (check, true))
            } else {
                executor
                    .check_path(&hint.path())
                    .map(|check| (check, false))
            };
            match outcome {
                Ok((check, is_compensation)) => {
                    if is_compensation {
                        report.compensation_scans += 1;
                    } else if check.items.is_empty() {
                        report.dropped_unmapped += 1;
                    } else {
                        report.confirmed_file_hints += 1;
                    }
                    report.facts_changed |= check.items.iter().any(|item| {
                        matches!(
                            item.status,
                            RelationshipCheckItemStatus::Checked
                                | RelationshipCheckItemStatus::Archived
                        )
                    });
                }
                Err(_) => {
                    report.retained_hints += 1;
                    remaining.push_back(hint);
                }
            }
        }
        self.pending = remaining;
        report
    }
}

/// The pump binds a runtime to the real facade executor. Desktop managed
/// state holds it strongly (plan 6.6); the Tauri setup owns its thread (6C).
#[derive(Clone)]
pub struct RelationshipWatchPump {
    runtime: Arc<std::sync::Mutex<RelationshipWatchRuntime>>,
    executor: FacadeRelationshipCheckExecutor,
}

impl RelationshipWatchPump {
    pub fn new(facade: Arc<LocalApplicationFacade>) -> Self {
        Self {
            runtime: Arc::new(std::sync::Mutex::new(RelationshipWatchRuntime::new())),
            executor: FacadeRelationshipCheckExecutor::new(facade),
        }
    }

    pub fn runtime(&self) -> &std::sync::Mutex<RelationshipWatchRuntime> {
        &self.runtime
    }

    pub fn executor(&self) -> &FacadeRelationshipCheckExecutor {
        &self.executor
    }

    pub fn start(&self) -> AppResult<()> {
        let mut runtime = self.runtime.lock().expect("watch runtime");
        runtime.start(&self.executor)
    }

    pub fn stop(&self) -> AppResult<()> {
        let mut runtime = self.runtime.lock().expect("watch runtime");
        runtime.stop()
    }

    /// One pump tick: refresh roots, collect stable hints, confirm them.
    /// Returns the confirmation report so the caller can emit FactsChanged.
    pub fn tick(&self) -> AppResult<WatchConfirmationReport> {
        let mut runtime = self.runtime.lock().expect("watch runtime");
        runtime.refresh_roots(&self.executor)?;
        runtime.collect()?;
        Ok(runtime.confirm_pending(&self.executor))
    }
}
