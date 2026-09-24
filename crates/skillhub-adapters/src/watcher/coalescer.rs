use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use skillhub_core::WatchHint;

use super::native::{SystemWatchClock, WatchClock};

/// Coalesces noisy editor notifications into one confirming-scan hint per
/// nearest recognized Skill or target.
#[derive(Debug)]
pub struct WatchCoalescer {
    stable_window_millis: u64,
    clock: Box<dyn WatchClock>,
    pending: BTreeMap<String, (u64, WatchHint)>,
    recognized_skill_roots: BTreeSet<String>,
}

impl WatchCoalescer {
    pub fn new(stable_window: Duration) -> Self {
        Self::with_clock(stable_window, Box::new(SystemWatchClock::new()))
    }

    pub fn with_clock(stable_window: Duration, clock: Box<dyn WatchClock>) -> Self {
        Self {
            stable_window_millis: stable_window.as_millis().try_into().unwrap_or(u64::MAX),
            clock,
            pending: BTreeMap::new(),
            recognized_skill_roots: BTreeSet::new(),
        }
    }

    pub fn stable_window(&self) -> Duration {
        Duration::from_millis(self.stable_window_millis)
    }

    /// Discard pending hints and learned skill roots while keeping the clock
    /// and stable window; the stop path uses this to keep its identity.
    pub fn reset(&mut self) {
        self.pending.clear();
        self.recognized_skill_roots.clear();
    }

    pub fn set_recognized_skill_roots<I, P>(&mut self, roots: I)
    where
        I: IntoIterator<Item = P>,
        P: Into<std::path::PathBuf>,
    {
        self.recognized_skill_roots = roots
            .into_iter()
            .map(|root| normalize_path(&root.into()))
            .collect();
    }

    pub fn push(&mut self, hint: WatchHint) {
        if let Some(skill_root) = hint.skill_root() {
            self.recognized_skill_roots
                .insert(normalize_path(&skill_root));
        }
        let key = hint.coalescing_key_with_skill_roots(&self.recognized_skill_roots);
        self.pending.insert(key, (self.clock.now_millis(), hint));
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Return hints at a stable boundary. The caller controls when this
    /// boundary is reached, avoiding a blocking sleep in the watcher thread.
    pub fn flush_after_stable(&mut self) -> Vec<WatchHint> {
        std::mem::take(&mut self.pending)
            .into_values()
            .map(|(_, hint)| hint)
            .collect()
    }

    pub fn flush_ready(&mut self) -> Vec<WatchHint> {
        let now = self.clock.now_millis();
        let mut ready = Vec::new();
        let mut pending = BTreeMap::new();
        for (key, (seen_at, hint)) in std::mem::take(&mut self.pending) {
            if self.stable_window_millis == 0
                || now >= seen_at.saturating_add(self.stable_window_millis)
            {
                ready.push(hint);
            } else {
                pending.insert(key, (seen_at, hint));
            }
        }
        self.pending = pending;
        ready
    }

    pub fn flush(&mut self) -> Vec<WatchHint> {
        std::mem::take(&mut self.pending)
            .into_values()
            .map(|(_, hint)| hint)
            .collect()
    }
}

fn normalize_path(path: &std::path::Path) -> String {
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
