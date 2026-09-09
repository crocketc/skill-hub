use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use super::provider::LlmDeployment;

/// Shared runtime gate for online model calls. The "disable all networking"
/// preference closes the gate; local models keep running because they are
/// offline inference on this machine (requirement 4.6, US-058).
#[derive(Clone)]
pub struct NetworkGate {
    open: Arc<AtomicBool>,
}

impl NetworkGate {
    pub fn open() -> Self {
        Self::with_state(true)
    }

    pub fn closed() -> Self {
        Self::with_state(false)
    }

    pub fn with_state(open: bool) -> Self {
        Self {
            open: Arc::new(AtomicBool::new(open)),
        }
    }

    pub fn set_open(&self, open: bool) {
        self.open.store(open, Ordering::SeqCst);
    }

    pub fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    /// Re-checked before every online attempt and before every retry.
    pub fn allows(&self, deployment: LlmDeployment) -> bool {
        match deployment {
            LlmDeployment::Local => true,
            LlmDeployment::Online => self.is_open(),
        }
    }
}

impl Default for NetworkGate {
    fn default() -> Self {
        Self::open()
    }
}
