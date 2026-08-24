mod skill_detector;

use std::path::Path;

use skillhub_core::scan::{ScanResult, ScanScope};
use skillhub_core::{AppResult, ScanService as ScanServicePort};

pub use skill_detector::{SkillDetector, SkillDetectorConfig};

/// Incremental, bounded scanner for directory-shaped Skills.
pub struct ScanService {
    detector: SkillDetector,
}

impl Default for ScanService {
    fn default() -> Self {
        Self::new()
    }
}

impl ScanService {
    pub fn new() -> Self {
        Self {
            detector: SkillDetector::default(),
        }
    }

    pub fn with_config(config: SkillDetectorConfig) -> Self {
        Self {
            detector: SkillDetector::with_config(config),
        }
    }

    pub fn scan<I>(&mut self, scopes: I) -> AppResult<ScanResult>
    where
        I: Into<ScanScopes>,
    {
        self.detector.scan(&scopes.into().0)
    }

    pub fn scan_scope(&mut self, scope: &ScanScope) -> AppResult<ScanResult> {
        self.detector.scan(std::slice::from_ref(scope))
    }

    /// Continue from a persisted confirmed snapshot, checking metadata before
    /// reusing its fingerprints.
    pub fn scan_with_previous<I>(
        &mut self,
        scopes: I,
        previous: &ScanResult,
    ) -> AppResult<ScanResult>
    where
        I: Into<ScanScopes>,
    {
        self.detector.scan_with_previous(&scopes.into().0, previous)
    }

    pub fn rescan_skill(
        &mut self,
        scope: &ScanScope,
        path: impl AsRef<Path>,
    ) -> AppResult<ScanResult> {
        self.detector.rescan_skill(scope, path.as_ref())
    }
}

impl ScanServicePort for ScanService {
    fn scan(&mut self, scopes: &[ScanScope]) -> AppResult<ScanResult> {
        self.detector.scan(scopes)
    }
}

#[derive(Clone, Debug)]
pub struct ScanScopes(Vec<ScanScope>);

impl From<ScanScope> for ScanScopes {
    fn from(scope: ScanScope) -> Self {
        Self(vec![scope])
    }
}

impl From<&ScanScope> for ScanScopes {
    fn from(scope: &ScanScope) -> Self {
        Self(vec![scope.clone()])
    }
}

impl From<Vec<ScanScope>> for ScanScopes {
    fn from(scopes: Vec<ScanScope>) -> Self {
        Self(scopes)
    }
}

impl From<&[ScanScope]> for ScanScopes {
    fn from(scopes: &[ScanScope]) -> Self {
        Self(scopes.to_vec())
    }
}

impl<const N: usize> From<[ScanScope; N]> for ScanScopes {
    fn from(scopes: [ScanScope; N]) -> Self {
        Self(scopes.into_iter().collect())
    }
}
