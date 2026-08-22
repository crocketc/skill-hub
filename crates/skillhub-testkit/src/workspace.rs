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
        self.try_agent_root(name)
            .expect("failed to create isolated Agent root")
    }

    /// Returns (and creates) an isolated root for a named project.
    pub fn project_root(&self, name: &str) -> PathBuf {
        self.try_project_root(name)
            .expect("failed to create isolated project root")
    }

    /// Fallible variant of [`Self::agent_root`] for callers that need to
    /// observe filesystem failures instead of panicking.
    pub fn try_agent_root(&self, name: &str) -> io::Result<PathBuf> {
        self.named_root(&self.agents_root, name)
    }

    /// Fallible variant of [`Self::project_root`] for callers that need to
    /// observe filesystem failures instead of panicking.
    pub fn try_project_root(&self, name: &str) -> io::Result<PathBuf> {
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
        let canonical_root = fs::canonicalize(self.root())?;
        validate_destination(&destination, &canonical_root)?;
        copy_entry(source, &destination, &canonical_root)?;
        Ok(destination)
    }

    fn named_root(&self, parent: &Path, name: &str) -> io::Result<PathBuf> {
        let path = parent.join(safe_component(name));
        fs::create_dir_all(&path).map(|()| path)
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
}

fn validate_destination(destination: &Path, canonical_root: &Path) -> io::Result<()> {
    let mut ancestor = destination;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "destination cannot contain a symlink",
                    ));
                }
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "destination has no workspace root",
                    )
                })?;
            }
            Err(error) => return Err(error),
        }
    }
    let canonical = fs::canonicalize(ancestor)?;
    if !canonical.starts_with(canonical_root) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "destination must remain inside the temporary workspace",
        ));
    }
    Ok(())
}

fn safe_component(name: &str) -> String {
    let mut value = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '\0' | '<' | '>' | '"' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            _ => character,
        })
        .collect::<String>();
    while value.ends_with(['.', ' ']) {
        value.pop();
    }
    if value.is_empty() || value == "." || value == ".." {
        value = "unnamed".to_owned();
    }
    if is_reserved_windows_name(&value) {
        value.insert(0, '_');
    }
    value
}

fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
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

fn copy_entry(source: &Path, destination: &Path, canonical_root: &Path) -> io::Result<()> {
    // Re-check every recursive target. A symlink can exist below the initial
    // destination even when the top-level destination itself is safe.
    validate_destination(destination, canonical_root)?;
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
            copy_entry(
                &entry.path(),
                &destination.join(entry.file_name()),
                canonical_root,
            )?;
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}
