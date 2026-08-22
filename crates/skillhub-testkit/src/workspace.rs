use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use tempfile::{tempdir, TempDir};

use crate::FaultInjector;

/// An isolated filesystem layout for tests.
///
/// All paths returned by this type are descendants of the temporary root. The
/// temporary directory is removed when the workspace is dropped.
pub struct TempWorkspace {
    tempdir: TempDir,
    central_root: PathBuf,
    agents_root: PathBuf,
    projects_root: PathBuf,
    faults: FaultInjector,
}

impl TempWorkspace {
    /// Creates a workspace and its three top-level fixture roots.
    pub fn new() -> io::Result<Self> {
        let tempdir = tempdir()?;
        let root = tempdir.path();
        let central_root = root.join("central");
        let agents_root = root.join("agents");
        let projects_root = root.join("projects");
        fs::create_dir_all(&central_root)?;
        fs::create_dir_all(&agents_root)?;
        fs::create_dir_all(&projects_root)?;
        Ok(Self {
            tempdir,
            central_root,
            agents_root,
            projects_root,
            faults: FaultInjector::new(),
        })
    }

    /// Returns the temporary workspace root.
    pub fn root(&self) -> &Path {
        self.tempdir.path()
    }

    /// Returns the isolated central library root.
    pub fn central_root(&self) -> &Path {
        &self.central_root
    }

    /// Returns (and creates) an isolated root for a named Agent.
    pub fn agent_root(&self, name: &str) -> PathBuf {
        self.named_root(&self.agents_root, name)
    }

    /// Returns (and creates) an isolated root for a named project.
    pub fn project_root(&self, name: &str) -> PathBuf {
        self.named_root(&self.projects_root, name)
    }

    /// Returns the workspace's reusable fault injector.
    pub fn faults(&self) -> &FaultInjector {
        &self.faults
    }

    /// Copies a file or directory fixture to an exact destination inside the workspace.
    ///
    /// Relative destinations are interpreted relative to [`Self::root`]. Symlinks
    /// are rejected so copying a fixture cannot introduce a path that escapes the
    /// isolated workspace.
    pub fn copy_fixture(
        &self,
        source: impl AsRef<Path>,
        destination: impl AsRef<Path>,
    ) -> io::Result<PathBuf> {
        let source = source.as_ref();
        let destination = self.workspace_path(destination.as_ref())?;
        self.validate_destination(&destination)?;
        copy_entry(source, &destination)?;
        Ok(destination)
    }

    fn named_root(&self, parent: &Path, name: &str) -> PathBuf {
        let path = parent.join(safe_component(name));
        // The roots are a convenience API returning paths rather than Results;
        // `new` has already created their parents, so this is best-effort lazy
        // creation for each named fixture.
        let _ = fs::create_dir_all(&path);
        path
    }

    fn workspace_path(&self, path: &Path) -> io::Result<PathBuf> {
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            self.root().join(path)
        };
        if candidate
            .components()
            .any(|component| matches!(component, Component::ParentDir))
            || !is_within(self.root(), &candidate)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "destination must remain inside the temporary workspace",
            ));
        }
        Ok(candidate)
    }

    fn validate_destination(&self, destination: &Path) -> io::Result<()> {
        let mut ancestor = destination;
        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "destination has no workspace root",
                )
            })?;
        }
        let canonical = fs::canonicalize(ancestor)?;
        let canonical_root = fs::canonicalize(self.root())?;
        if !canonical.starts_with(canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "destination must remain inside the temporary workspace",
            ));
        }
        if destination.exists() && fs::symlink_metadata(destination)?.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "destination cannot be a symlink",
            ));
        }
        Ok(())
    }
}

fn safe_component(name: &str) -> String {
    let mut value = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' => '_',
            _ => character,
        })
        .collect::<String>();
    if value.is_empty() || value == "." || value == ".." {
        value = "unnamed".to_owned();
    }
    value
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    let mut root_components = root.components();
    let mut candidate_components = candidate.components();
    loop {
        match (root_components.next(), candidate_components.next()) {
            (Some(root_component), Some(candidate_component))
                if root_component == candidate_component => {}
            (None, _) => return true,
            _ => return false,
        }
    }
}

fn copy_entry(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "symlink fixtures are not copied",
        ));
    }
    if metadata.is_dir() {
        fs::create_dir_all(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}
