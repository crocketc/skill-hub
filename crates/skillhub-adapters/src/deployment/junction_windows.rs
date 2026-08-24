use std::io;
use std::path::Path;

#[cfg(windows)]
pub fn create_junction(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory junction support is not available in this executor",
    ))
}

#[cfg(not(windows))]
pub fn create_junction(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory junctions are Windows-only",
    ))
}
