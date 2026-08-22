use crate::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(transparent)]
pub struct AllowedRootId(uuid::Uuid);

impl AllowedRootId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4())
    }
}

impl Default for AllowedRootId {
    fn default() -> Self {
        Self::new()
    }
}

/// A filesystem root that the application is explicitly permitted to access.
#[derive(Clone, Debug)]
pub struct AllowedRoot {
    id: AllowedRootId,
    path: PathBuf,
}

impl AllowedRoot {
    pub fn new(path: impl AsRef<Path>) -> AppResult<Self> {
        Self::with_id(AllowedRootId::new(), path)
    }

    pub fn with_id(id: AllowedRootId, path: impl AsRef<Path>) -> AppResult<Self> {
        let path = std::fs::canonicalize(path.as_ref()).map_err(|_| path_error())?;
        if !path.is_dir() {
            return Err(path_error());
        }
        Ok(Self { id, path })
    }

    pub fn id(&self) -> AllowedRootId {
        self.id
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[derive(Clone, Debug)]
pub struct SafePath {
    root_id: AllowedRootId,
    path: PathBuf,
}

impl SafePath {
    pub fn root_id(&self) -> AllowedRootId {
        self.root_id
    }
    pub fn as_path(&self) -> &Path {
        &self.path
    }
    pub fn into_path(self) -> PathBuf {
        self.path
    }
}

#[derive(Clone, Debug, Default)]
pub struct PathPolicy {
    roots: HashMap<AllowedRootId, AllowedRoot>,
}

impl PathPolicy {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_roots(roots: impl IntoIterator<Item = AllowedRoot>) -> AppResult<Self> {
        let mut policy = Self::new();
        for root in roots {
            policy.register_root(root)?;
        }
        Ok(policy)
    }

    pub fn register_root(&mut self, root: AllowedRoot) -> AppResult<()> {
        if self.roots.insert(root.id, root).is_some() {
            return Err(path_error());
        }
        Ok(())
    }

    pub fn resolve_existing(
        &self,
        root_id: AllowedRootId,
        child: impl AsRef<Path>,
    ) -> AppResult<SafePath> {
        let root = self.root(root_id)?;
        validate_child(child.as_ref())?;
        let candidate = root.path.join(child.as_ref());
        let canonical = std::fs::canonicalize(&candidate).map_err(|_| path_error())?;
        if !canonical.starts_with(&root.path) {
            return Err(path_error());
        }
        Ok(SafePath {
            root_id,
            path: canonical,
        })
    }

    pub fn resolve_for_create(
        &self,
        root_id: AllowedRootId,
        child: impl AsRef<Path>,
    ) -> AppResult<SafePath> {
        let root = self.root(root_id)?;
        validate_child(child.as_ref())?;
        let candidate = root.path.join(child.as_ref());
        let mut ancestor = candidate.as_path();
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(path_error)?;
        }
        let canonical_ancestor = std::fs::canonicalize(ancestor).map_err(|_| path_error())?;
        if !canonical_ancestor.starts_with(&root.path) {
            return Err(path_error());
        }
        if candidate.exists() {
            let canonical = std::fs::canonicalize(&candidate).map_err(|_| path_error())?;
            if !canonical.starts_with(&root.path) {
                return Err(path_error());
            }
        }
        Ok(SafePath {
            root_id,
            path: candidate,
        })
    }

    fn root(&self, id: AllowedRootId) -> AppResult<&AllowedRoot> {
        self.roots.get(&id).ok_or_else(path_error)
    }
}

fn validate_child(path: &Path) -> AppResult<()> {
    if path.as_os_str().is_empty() || path.is_absolute() || path.to_string_lossy().contains('\0') {
        return Err(path_error());
    }
    let raw = path.to_string_lossy();
    if raw.ends_with('/') || raw.ends_with('\\') {
        return Err(path_error());
    }
    for component in path.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(path_error())
            }
            Component::CurDir => return Err(path_error()),
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                #[cfg(windows)]
                if text.contains(':') || text.bytes().any(|b| b < 32 || b"<>\"|?*".contains(&b)) {
                    return Err(path_error());
                }
            }
        }
    }
    Ok(())
}

fn path_error() -> AppError {
    AppError::new(ErrorCode::PathOutsideAllowedRoots, Severity::Error)
        .with_action(RecoveryAction::ChooseAnotherName)
}
