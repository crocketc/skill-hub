mod skill_detector;

use std::collections::BTreeMap;
use std::path::Path;

use skillhub_core::scan::{ScanRepository, ScanResult, ScanScope};
use skillhub_core::{
    AppError, AppResult, ErrorCode, RecoveryAction, ScanService as ScanServicePort, Severity,
};

pub use skill_detector::{SkillDetector, SkillDetectorConfig};

/// Incremental, bounded scanner for directory-shaped Skills.
pub struct ScanService {
    detector: SkillDetector,
    registered_scopes: BTreeMap<String, ScanScope>,
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
            registered_scopes: BTreeMap::new(),
        }
    }

    pub fn with_config(config: SkillDetectorConfig) -> Self {
        Self {
            detector: SkillDetector::with_config(config),
            registered_scopes: BTreeMap::new(),
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

    /// Register a scope obtained from discovery, a custom Agent or the
    /// path-policy service. Callers cannot scan command-supplied roots.
    pub fn register_scope(&mut self, scope: ScanScope) -> AppResult<()> {
        self.detector.validate_registered_scope(&scope)?;
        if scope.id.trim().is_empty() {
            return Err(invalid_scope("scope id is required"));
        }
        self.registered_scopes.insert(scope.id.clone(), scope);
        Ok(())
    }

    pub fn scan_registered(&mut self, scope_ids: &[String]) -> AppResult<ScanResult> {
        let scopes = scope_ids
            .iter()
            .map(|id| {
                self.registered_scopes
                    .get(id)
                    .cloned()
                    .ok_or_else(|| invalid_scope(format!("unknown scan scope: {id}")))
            })
            .collect::<AppResult<Vec<_>>>()?;
        self.detector.scan(&scopes)
    }

    pub fn rescan_registered_skill(
        &mut self,
        scope_id: &str,
        path: impl AsRef<Path>,
    ) -> AppResult<ScanResult> {
        let scope = self
            .registered_scopes
            .get(scope_id)
            .ok_or_else(|| invalid_scope(format!("unknown scan scope: {scope_id}")))?
            .clone();
        self.detector.rescan_skill(&scope, path.as_ref())
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

    pub fn scan_with_repository<I, R>(&mut self, scopes: I, repository: &R) -> AppResult<ScanResult>
    where
        I: Into<ScanScopes>,
        R: ScanRepository,
    {
        let scopes = scopes.into().0;
        let result = match repository.load()? {
            Some(previous) => self.scan_with_previous(scopes.clone(), &previous)?,
            None => self.scan(scopes)?,
        };
        repository.replace(&result)
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

fn invalid_scope(detail: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, Severity::Error)
        .with_param("detail", detail.into())
        .with_action(RecoveryAction::Acknowledge)
}
