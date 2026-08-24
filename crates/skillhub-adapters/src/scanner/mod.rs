mod skill_detector;
use skill_detector::SkillDetector;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use skillhub_core::agent::{AgentRepository as DiscoveryRepository, LogicalTarget};
use skillhub_core::project::{Project, ProjectRepository};
use skillhub_core::scan::{ScanRepository, ScanResult, ScanScope};
use skillhub_core::{
    physical_id_for_path, AppError, AppResult, ErrorCode, PathPolicy, ProjectId, RecoveryAction,
    Severity,
};

pub use skill_detector::SkillDetectorConfig;

/// Incremental, bounded scanner for directory-shaped Skills.
pub struct ScanService {
    detector: SkillDetector,
    registered_scopes: BTreeMap<String, ScanScope>,
    scope_physical_ids: BTreeMap<String, String>,
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
            scope_physical_ids: BTreeMap::new(),
        }
    }

    pub fn with_config(config: SkillDetectorConfig) -> Self {
        Self {
            detector: SkillDetector::with_config(config),
            registered_scopes: BTreeMap::new(),
            scope_physical_ids: BTreeMap::new(),
        }
    }

    #[allow(dead_code)]
    pub(crate) fn scan<I>(&mut self, scopes: I) -> AppResult<ScanResult>
    where
        I: Into<ScanScopes>,
    {
        self.detector.scan(&scopes.into().0)
    }

    #[allow(dead_code)]
    pub(crate) fn scan_scope(&mut self, scope: &ScanScope) -> AppResult<ScanResult> {
        self.detector.scan(std::slice::from_ref(scope))
    }

    /// Resolve a persisted discovery target ID and authorize its path against
    /// the application's already-registered path policy.
    pub fn register_discovery_target<R>(
        &mut self,
        target_id: &str,
        repository: &R,
        path_policy: &PathPolicy,
    ) -> AppResult<()>
    where
        R: DiscoveryRepository,
    {
        let snapshot = repository
            .load_discovery()?
            .ok_or_else(|| invalid_scope("discovery snapshot is unavailable"))?;
        let target = snapshot
            .logical_targets
            .iter()
            .find(|target| target.id == target_id)
            .ok_or_else(|| invalid_scope(format!("unknown discovery target: {target_id}")))?;
        let physical = snapshot
            .physical_targets
            .iter()
            .find(|physical| physical.id == target.physical_id)
            .ok_or_else(|| invalid_scope("discovery physical target is unavailable"))?;
        if !target.available
            || !target.exists
            || !target.readable
            || target.physical_id.trim().is_empty()
            || !physical.logical_target_ids.iter().any(|id| id == target_id)
        {
            return Err(invalid_scope(
                "discovery target is not available for scanning",
            ));
        }
        let authorized_path = path_policy.authorize_existing(&target.path)?;
        let current_physical_id = physical_id_for_path(authorized_path.as_path())
            .ok_or_else(|| invalid_scope("discovery physical identity is unavailable"))?;
        if current_physical_id != target.physical_id {
            return Err(invalid_scope("discovery physical identity changed"));
        }
        let scope = ScanScope::registered(target.id.clone(), authorized_path.into_path())
            .with_marker(&target.marker);
        self.register_scope_with_physical_id(scope, target.physical_id.clone())
    }

    /// Internal fixture/adapter boundary for an already resolved target.
    #[allow(dead_code)]
    pub(crate) fn register_discovery_target_raw(
        &mut self,
        target: &LogicalTarget,
    ) -> AppResult<()> {
        if target.id.trim().is_empty() || !target.available || !target.exists || !target.readable {
            return Err(invalid_scope(
                "discovery target is not available for scanning",
            ));
        }
        self.register_scope_with_physical_id(
            ScanScope::registered(&target.id, &target.path).with_marker(&target.marker),
            target.physical_id.clone(),
        )
    }

    /// Resolve a persisted project ID and authorize its device path against
    /// the application's already-registered path policy.
    pub fn register_project_scope<R>(
        &mut self,
        project_id: ProjectId,
        repository: &R,
        path_policy: &PathPolicy,
    ) -> AppResult<()>
    where
        R: ProjectRepository,
    {
        let project = repository.get(project_id)?;
        let authorized_path = path_policy.authorize_existing(project.path())?;
        let current_physical_id = physical_id_for_path(authorized_path.as_path())
            .ok_or_else(|| invalid_scope("project physical identity is unavailable"))?;
        if project.physical_id.trim().is_empty() || current_physical_id != project.physical_id {
            return Err(invalid_scope("project physical identity changed"));
        }
        self.register_scope_with_physical_id(
            ScanScope::registered(project_id.to_string(), authorized_path.into_path()),
            project.physical_id,
        )
    }

    /// Internal fixture/adapter boundary for an already resolved project.
    #[allow(dead_code)]
    pub(crate) fn register_project_scope_raw(&mut self, project: &Project) -> AppResult<()> {
        self.register_scope_with_physical_id(
            ScanScope::registered(project.id.to_string(), &project.device_path),
            project.physical_id.clone(),
        )
    }

    #[allow(dead_code)]
    pub(crate) fn register_scope(&mut self, scope: ScanScope) -> AppResult<()> {
        let physical_id = physical_id_for_path(&scope.root)
            .ok_or_else(|| invalid_scope("scope physical identity is unavailable"))?;
        self.register_scope_with_physical_id(scope, physical_id)
    }

    fn register_scope_with_physical_id(
        &mut self,
        scope: ScanScope,
        physical_id: String,
    ) -> AppResult<()> {
        self.detector.validate_registered_scope(&scope)?;
        if scope.id.trim().is_empty() || physical_id.trim().is_empty() {
            return Err(invalid_scope("scope id is required"));
        }
        self.scope_physical_ids
            .insert(scope.id.clone(), physical_id);
        self.registered_scopes.insert(scope.id.clone(), scope);
        Ok(())
    }

    pub fn scan_registered(&mut self, scope_ids: &[String]) -> AppResult<ScanResult> {
        let mut seen_physical_ids = BTreeSet::new();
        let scopes = self
            .registered_scopes_for(scope_ids)?
            .into_iter()
            .filter(|(_, physical_id)| seen_physical_ids.insert(physical_id.clone()))
            .map(|(scope, _)| scope)
            .collect::<Vec<_>>();
        self.detector.scan(&scopes)
    }

    pub fn scan_registered_with_previous(
        &mut self,
        scope_ids: &[String],
        previous: &ScanResult,
    ) -> AppResult<ScanResult> {
        let mut seen_physical_ids = BTreeSet::new();
        let scopes = self
            .registered_scopes_for(scope_ids)?
            .into_iter()
            .filter(|(_, physical_id)| seen_physical_ids.insert(physical_id.clone()))
            .map(|(scope, _)| scope)
            .collect::<Vec<_>>();
        self.detector.scan_with_previous(&scopes, previous)
    }

    pub fn scan_registered_with_repository<R>(
        &mut self,
        scope_ids: &[String],
        repository: &R,
    ) -> AppResult<ScanResult>
    where
        R: ScanRepository,
    {
        let mut seen_physical_ids = BTreeSet::new();
        let scopes = self
            .registered_scopes_for(scope_ids)?
            .into_iter()
            .filter(|(_, physical_id)| seen_physical_ids.insert(physical_id.clone()))
            .map(|(scope, _)| scope)
            .collect::<Vec<_>>();
        let result = match repository.load()? {
            Some(previous) => self.detector.scan_with_previous(&scopes, &previous)?,
            None => self.detector.scan(&scopes)?,
        };
        repository.replace(&result)
    }

    fn registered_scopes_for(&self, scope_ids: &[String]) -> AppResult<Vec<(ScanScope, String)>> {
        scope_ids
            .iter()
            .map(|id| {
                let scope = self
                    .registered_scopes
                    .get(id)
                    .cloned()
                    .ok_or_else(|| invalid_scope(format!("unknown scan scope: {id}")))?;
                let physical_id = self
                    .scope_physical_ids
                    .get(id)
                    .cloned()
                    .ok_or_else(|| invalid_scope(format!("unknown scan scope: {id}")))?;
                let current_physical_id = physical_id_for_path(&scope.root)
                    .ok_or_else(|| invalid_scope("scope physical identity is unavailable"))?;
                if current_physical_id != physical_id {
                    return Err(invalid_scope("scope physical identity changed"));
                }
                Ok((scope, physical_id))
            })
            .collect()
    }

    pub fn rescan_registered_skill(
        &mut self,
        scope_id: &str,
        path: impl AsRef<Path>,
    ) -> AppResult<ScanResult> {
        let scope = self
            .registered_scopes_for(&[scope_id.to_owned()])?
            .remove(0)
            .0;
        self.detector.rescan_skill(&scope, path.as_ref())
    }

    /// Continue from a persisted confirmed snapshot, checking metadata before
    /// reusing its fingerprints.
    #[allow(dead_code)]
    pub(crate) fn scan_with_previous<I>(
        &mut self,
        scopes: I,
        previous: &ScanResult,
    ) -> AppResult<ScanResult>
    where
        I: Into<ScanScopes>,
    {
        self.detector.scan_with_previous(&scopes.into().0, previous)
    }

    #[allow(dead_code)]
    pub(crate) fn scan_with_repository<I, R>(
        &mut self,
        scopes: I,
        repository: &R,
    ) -> AppResult<ScanResult>
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

    #[allow(dead_code)]
    pub(crate) fn rescan_skill(
        &mut self,
        scope: &ScanScope,
        path: impl AsRef<Path>,
    ) -> AppResult<ScanResult> {
        self.detector.rescan_skill(scope, path.as_ref())
    }
}

#[allow(dead_code)]
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
