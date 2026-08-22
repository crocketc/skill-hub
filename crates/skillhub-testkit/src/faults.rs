use std::collections::HashSet;
use std::fmt;
use std::sync::Mutex;

/// Named points at which a later operation test may inject a failure.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum FaultPoint {
    AfterPrepare,
    AfterFirstTarget,
    BeforeVerify,
}

impl FaultPoint {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AfterPrepare => "after_prepare",
            Self::AfterFirstTarget => "after_first_target",
            Self::BeforeVerify => "before_verify",
        }
    }
}

impl From<FaultPoint> for String {
    fn from(point: FaultPoint) -> Self {
        point.as_str().to_owned()
    }
}

impl From<&FaultPoint> for String {
    fn from(point: &FaultPoint) -> Self {
        (*point).into()
    }
}

/// A deterministic, thread-safe collection of one-shot named failures.
#[derive(Debug, Default)]
pub struct FaultInjector {
    armed: Mutex<HashSet<String>>,
}

impl FaultInjector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Arms a named point. The next [`Self::take`] consumes it.
    pub fn fail_once(&self, point: impl Into<String>) {
        self.armed
            .lock()
            .expect("fault injector mutex poisoned")
            .insert(point.into());
    }

    /// Consumes a pending failure, returning whether this invocation should fail.
    pub fn take(&self, point: impl Into<String>) -> bool {
        self.armed
            .lock()
            .expect("fault injector mutex poisoned")
            .remove(&point.into())
    }

    /// Returns an injected error when the named point is armed.
    pub fn check(&self, point: impl Into<String>) -> Result<(), InjectedFault> {
        let point = point.into();
        if self.take(point.clone()) {
            Err(InjectedFault { point })
        } else {
            Ok(())
        }
    }

    pub fn after_prepare(&self) -> bool {
        self.take(FaultPoint::AfterPrepare)
    }

    pub fn after_first_target(&self) -> bool {
        self.take(FaultPoint::AfterFirstTarget)
    }

    pub fn before_verify(&self) -> bool {
        self.take(FaultPoint::BeforeVerify)
    }
}

/// Error returned by [`FaultInjector::check`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InjectedFault {
    point: String,
}

impl InjectedFault {
    pub fn point(&self) -> &str {
        &self.point
    }
}

impl fmt::Display for InjectedFault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "injected fault at {}", self.point)
    }
}

impl std::error::Error for InjectedFault {}
