use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use skillhub_core::agent::{
    ClientInstance, DiscoverySnapshot, LogicalTarget, OperatingSystem, PhysicalTarget,
    ProfileCatalog, TargetScope,
};
use skillhub_core::AppResult;

#[derive(Clone, Debug)]
pub struct DiscoveryRoots {
    pub operating_system: OperatingSystem,
    pub user_home: PathBuf,
    pub project_roots: Vec<PathBuf>,
}

impl DiscoveryRoots {
    pub fn new(operating_system: OperatingSystem, user_home: impl Into<PathBuf>) -> Self {
        Self {
            operating_system,
            user_home: user_home.into(),
            project_roots: Vec::new(),
        }
    }

    pub fn with_project_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.project_roots.push(root.into());
        self
    }

    pub fn with_project_roots(mut self, roots: impl IntoIterator<Item = PathBuf>) -> Self {
        self.project_roots.extend(roots);
        self
    }
}

#[derive(Clone, Debug)]
pub struct DiscoverAgents {
    catalog: ProfileCatalog,
}

impl DiscoverAgents {
    pub fn new(catalog: ProfileCatalog) -> Self {
        Self { catalog }
    }

    pub fn builtin() -> Self {
        Self::new(ProfileCatalog::builtin())
    }

    pub fn discover(&self, roots: &DiscoveryRoots) -> AppResult<DiscoverySnapshot> {
        let mut instances = Vec::new();
        let mut logical_targets = Vec::new();
        for profile in &self.catalog.profiles {
            let profile_id = profile_id(&profile.brand);
            for client in &profile.clients {
                if !client.supported_os.contains(&roots.operating_system) {
                    continue;
                }
                let start = logical_targets.len();
                for candidate in &client.path_candidates {
                    for path in expand_candidate(candidate, roots) {
                        let path_string = path.to_string_lossy().into_owned();
                        let exists = path.is_dir();
                        let (readable, writable) = directory_access(&path, exists);
                        let physical_id = physical_identity(&path, roots.operating_system.clone());
                        logical_targets.push(LogicalTarget {
                            id: format!(
                                "{profile_id}:{}:{}:{path_string}",
                                client.id,
                                scope_code(&candidate.scope)
                            ),
                            profile_id: profile_id.clone(),
                            client_id: client.id.clone(),
                            scope: candidate.scope.clone(),
                            path: path_string,
                            marker: candidate.marker.clone(),
                            precedence: candidate.precedence.clone(),
                            exists,
                            readable,
                            writable,
                            available: exists && readable,
                            physical_id,
                        });
                    }
                }
                let available = logical_targets[start..]
                    .iter()
                    .any(|target| target.available);
                instances.push(ClientInstance {
                    profile_id: profile_id.clone(),
                    client_id: client.id.clone(),
                    kind: client.kind.clone(),
                    supported_os: client.supported_os.clone(),
                    available,
                });
            }
        }

        let mut physical = BTreeMap::<String, PhysicalTarget>::new();
        for target in &logical_targets {
            if !target.exists {
                continue;
            }
            let entry = physical
                .entry(target.physical_id.clone())
                .or_insert_with(|| PhysicalTarget {
                    id: target.physical_id.clone(),
                    path: target.path.clone(),
                    exists: target.exists,
                    readable: target.readable,
                    writable: target.writable,
                    logical_target_ids: Vec::new(),
                });
            entry.exists |= target.exists;
            entry.readable |= target.readable;
            entry.writable |= target.writable;
            entry.logical_target_ids.push(target.id.clone());
        }
        Ok(DiscoverySnapshot {
            generation: 1,
            observed_at: now(),
            instances,
            logical_targets,
            physical_targets: physical.into_values().collect(),
        })
    }
}

fn expand_candidate(
    candidate: &skillhub_core::agent::PathCandidate,
    roots: &DiscoveryRoots,
) -> Vec<PathBuf> {
    let raw = candidate.path.as_str();
    if raw.contains("{user_home}") {
        return vec![roots
            .user_home
            .join(trim_suffix(raw.replace("{user_home}", "")))];
    }
    if raw.contains("%USERPROFILE%") || raw.contains("$HOME") {
        let replaced = raw.replace("%USERPROFILE%", "").replace("$HOME", "");
        return vec![roots.user_home.join(trim_suffix(replaced))];
    }
    if raw.contains("{project_root}") {
        let suffix = trim_suffix(raw.replace("{project_root}", ""));
        return roots
            .project_roots
            .iter()
            .map(|root| root.join(&suffix))
            .collect();
    }
    Vec::new()
}

fn trim_suffix(value: String) -> String {
    value.trim_start_matches(['/', '\\']).to_owned()
}

fn directory_access(path: &Path, exists: bool) -> (bool, bool) {
    if !exists {
        return (false, false);
    }
    let Ok(metadata) = fs::metadata(path) else {
        return (false, false);
    };
    let writable = !metadata.permissions().readonly();
    (true, writable)
}

fn physical_identity(path: &Path, operating_system: OperatingSystem) -> String {
    let observed = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut value = observed.to_string_lossy().replace('\\', "/");
    if matches!(operating_system, OperatingSystem::Windows) {
        value = value.to_ascii_lowercase();
    }
    format!("path:{value}")
}

fn profile_id(brand: &str) -> String {
    brand
        .chars()
        .filter_map(|character| {
            if character.is_ascii_alphanumeric() {
                Some(character.to_ascii_lowercase())
            } else if character == '-' || character == '_' || character == ' ' {
                Some('-')
            } else {
                None
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_owned()
}

fn scope_code(scope: &TargetScope) -> &'static str {
    match scope {
        TargetScope::Global => "global",
        TargetScope::Project => "project",
        TargetScope::Extra => "extra",
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
