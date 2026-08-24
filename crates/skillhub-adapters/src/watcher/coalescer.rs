use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use skillhub_core::WatchHint;

/// Coalesces noisy editor notifications into one confirming-scan hint per
/// nearest recognized Skill or target.
#[derive(Debug)]
pub struct WatchCoalescer {
    stable_window: Duration,
    pending: BTreeMap<String, (Instant, WatchHint)>,
}

impl WatchCoalescer {
    pub fn new(stable_window: Duration) -> Self {
        Self {
            stable_window,
            pending: BTreeMap::new(),
        }
    }

    pub fn stable_window(&self) -> Duration {
        self.stable_window
    }

    pub fn push(&mut self, hint: WatchHint) {
        let key = hint.coalescing_key();
        self.pending.insert(key, (Instant::now(), hint));
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
        let now = Instant::now();
        let mut ready = Vec::new();
        let mut pending = BTreeMap::new();
        for (key, (seen_at, hint)) in std::mem::take(&mut self.pending) {
            if now.duration_since(seen_at) >= self.stable_window || self.stable_window.is_zero() {
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
