use std::io;
use std::path::Path;

#[cfg(unix)]
pub fn create_dir_link(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
pub fn create_dir_link(source: &Path, destination: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_dir(source, destination)
}

#[cfg(not(any(unix, windows)))]
pub fn create_dir_link(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory symlinks are not supported on this platform",
    ))
}

#[cfg(unix)]
pub fn remove_dir_link(path: &Path) -> io::Result<()> {
    std::fs::remove_file(path)
}

#[cfg(windows)]
pub fn remove_dir_link(path: &Path) -> io::Result<()> {
    std::fs::remove_dir(path)
}

#[cfg(not(any(unix, windows)))]
pub fn remove_dir_link(path: &Path) -> io::Result<()> {
    std::fs::remove_dir(path)
}
