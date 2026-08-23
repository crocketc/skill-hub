use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use skillhub_core::agent::{
    ClientInstance, ClientPresence, DiscoverySnapshot, LogicalTarget, OperatingSystem,
    PhysicalTarget, ProfileCatalog, TargetScope,
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
                instances.push(ClientInstance {
                    profile_id: profile_id.clone(),
                    client_id: client.id.clone(),
                    kind: client.kind.clone(),
                    supported_os: client.supported_os.clone(),
                    client_presence: ClientPresence::Unknown,
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
                    case_behavior: case_behavior(&roots.operating_system),
                    logical_target_ids: Vec::new(),
                });
            entry.exists |= target.exists;
            entry.readable |= target.readable;
            entry.writable |= target.writable;
            entry.logical_target_ids.push(target.id.clone());
        }
        Ok(DiscoverySnapshot {
            generation: "1".into(),
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
    let readable = fs::read_dir(path).is_ok();
    let writable = readable && !metadata.permissions().readonly();
    (readable, writable)
}

fn physical_identity(path: &Path, operating_system: OperatingSystem) -> String {
    if let Ok(metadata) = fs::metadata(path) {
        if let Some(identity) = metadata_identity(path, &metadata) {
            return format!("fs:{identity}");
        }
    }
    let mut ancestor = path.to_path_buf();
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        if let Some(name) = ancestor.file_name() {
            suffix.push(name.to_string_lossy().into_owned());
        }
        if !ancestor.pop() {
            break;
        }
    }
    if ancestor.exists() {
        if let Ok(metadata) = fs::metadata(&ancestor) {
            if let Some(identity) = metadata_identity(&ancestor, &metadata) {
                suffix.reverse();
                return format!("fs:{identity}:{}", suffix.join("/"));
            }
        }
    }
    let observed = fs::canonicalize(&ancestor).unwrap_or(ancestor);
    let mut value = observed.to_string_lossy().replace('\\', "/");
    if !suffix.is_empty() {
        value.push('/');
        value.push_str(&suffix.join("/"));
    }
    if matches!(operating_system, OperatingSystem::Windows) {
        value = value.to_ascii_lowercase();
    }
    format!("path:{value}")
}

#[cfg(unix)]
fn metadata_identity(_: &Path, metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("dev-{}-ino-{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn metadata_identity(path: &Path, _: &fs::Metadata) -> Option<String> {
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut info = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
    let result = unsafe { GetFileInformationByHandle(handle, &mut info) };
    unsafe { CloseHandle(handle) };
    if result == 0 {
        None
    } else {
        Some(format!(
            "volume-{}-file-{}-{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        ))
    }
}

#[cfg(not(any(unix, windows)))]
fn metadata_identity(_: &Path, _: &fs::Metadata) -> Option<String> {
    None
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

fn case_behavior(operating_system: &OperatingSystem) -> String {
    match operating_system {
        OperatingSystem::Windows => "case_insensitive_normalization",
        // macOS volumes may be case-sensitive or case-insensitive. We do not
        // probe or mutate the volume during discovery; the path fallback keeps
        // the observed spelling and records that the volume behavior is unknown.
        OperatingSystem::Macos => "volume_case_behavior_unknown_preserved_case_fallback",
    }
    .into()
}

fn now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}
