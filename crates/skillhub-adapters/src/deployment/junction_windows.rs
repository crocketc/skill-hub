//! Windows directory junctions.
//!
//! A junction is an NTFS mount-point reparse point.  Unlike a symbolic link it
//! needs no `SeCreateSymbolicLinkPrivilege`, so it is the link kind that keeps
//! "centralise management" available to an account that cannot create symbolic
//! links.  A junction always resolves to an absolute local path and cannot span
//! volumes; the deployment planner owns that constraint and rejects the
//! cross-volume case before anything is written.

#[cfg(windows)]
pub fn create_junction(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> std::io::Result<()> {
    let canonical = std::fs::canonicalize(source)?;
    let (substitute, print) = junction_names(&canonical);
    // A junction record is written into an existing empty directory.
    std::fs::create_dir(destination)?;
    match write_mount_point(destination, &substitute, &print) {
        Ok(()) => Ok(()),
        Err(error) => {
            // Never leave a half-built entry behind in the user's own
            // directory: the caller keeps the original entry on failure.
            let _ = std::fs::remove_dir(destination);
            Err(error)
        }
    }
}

#[cfg(windows)]
pub fn remove_junction(path: &std::path::Path) -> std::io::Result<()> {
    // `RemoveDirectoryW`, which `remove_dir` calls, deletes the reparse point
    // and never the directory it resolves to - which is exactly what a
    // deployment owns.
    std::fs::remove_dir(path)
}

/// Whether a directory entry is a reparse point rather than a plain directory.
/// A link kind that reported success without materializing would otherwise
/// leave an empty directory where the Skill belongs.
#[cfg(windows)]
pub fn is_reparse_point(path: &std::path::Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    std::fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0
        })
        .unwrap_or(false)
}

/// The four `USHORT` name fields plus the `ULONG` flags that precede the path
/// buffer in a mount-point reparse record.
#[cfg(windows)]
const MOUNT_POINT_FIXED_LENGTH: usize = 12;
/// The tag, data length and reserved fields that precede the union.
#[cfg(windows)]
const REPARSE_HEADER_LENGTH: usize = 8;
/// `MAXIMUM_REPARSE_DATA_BUFFER_SIZE`: the kernel rejects larger records.
#[cfg(windows)]
const MAXIMUM_REPARSE_DATA_LENGTH: usize = 16_384;
#[cfg(windows)]
const BACKSLASH: u16 = 0x5c;
/// `\\?\`
#[cfg(windows)]
const VERBATIM_PREFIX: [u16; 4] = [0x5c, 0x5c, 0x3f, 0x5c];
/// `\??\`
#[cfg(windows)]
const NT_PREFIX: [u16; 4] = [0x5c, 0x3f, 0x3f, 0x5c];
/// `UNC\`
#[cfg(windows)]
const UNC_SEGMENT: [u16; 4] = [0x55, 0x4e, 0x43, 0x5c];

/// NT namespace target plus a user-facing print name.
#[cfg(windows)]
fn junction_names(canonical: &std::path::Path) -> (Vec<u16>, Vec<u16>) {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = canonical.as_os_str().encode_wide().collect();
    // `canonicalize` yields a verbatim path (`\\?\C:\...`, `\\?\UNC\...`).
    // A junction stores an NT namespace path, which uses `\??\` for both.
    let rest = wide.strip_prefix(&VERBATIM_PREFIX).unwrap_or(&wide);
    let mut substitute = NT_PREFIX.to_vec();
    substitute.extend_from_slice(rest);
    let print = if rest.starts_with(&UNC_SEGMENT) {
        // `\\?\UNC\srv\share` -> `\\srv\share`
        let mut printed = vec![BACKSLASH, BACKSLASH];
        printed.extend_from_slice(&rest[UNC_SEGMENT.len()..]);
        printed
    } else {
        // `\\?\C:\x` -> `C:\x`
        rest.to_vec()
    };
    (substitute, print)
}

/// Writes the mount-point reparse record.  The record is assembled byte by
/// byte rather than through a `#[repr(C)]` mirror of `REPARSE_DATA_BUFFER`, so
/// the layout the kernel reads is stated explicitly instead of inferred.
#[cfg(windows)]
fn write_mount_point(
    destination: &std::path::Path,
    substitute: &[u16],
    print: &[u16],
) -> std::io::Result<()> {
    use std::io;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    let substitute_bytes = substitute.len() * 2;
    let print_bytes = print.len() * 2;
    let data_length = MOUNT_POINT_FIXED_LENGTH + substitute_bytes + print_bytes;
    if data_length > MAXIMUM_REPARSE_DATA_LENGTH || data_length > u16::MAX as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "junction target path is too long for a reparse record",
        ));
    }

    let mut buffer = vec![0u8; REPARSE_HEADER_LENGTH + data_length];
    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&(data_length as u16).to_le_bytes());
    // The two names are stored back to back.  Their lengths are explicit, so
    // neither needs a NUL terminator.
    buffer[8..10].copy_from_slice(&0u16.to_le_bytes());
    buffer[10..12].copy_from_slice(&(substitute_bytes as u16).to_le_bytes());
    buffer[12..14].copy_from_slice(&(substitute_bytes as u16).to_le_bytes());
    buffer[14..16].copy_from_slice(&(print_bytes as u16).to_le_bytes());
    buffer[16..20].copy_from_slice(&0u32.to_le_bytes());
    let paths = REPARSE_HEADER_LENGTH + MOUNT_POINT_FIXED_LENGTH;
    for (index, unit) in substitute.iter().chain(print.iter()).enumerate() {
        let offset = paths + index * 2;
        buffer[offset..offset + 2].copy_from_slice(&unit.to_le_bytes());
    }

    let wide = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut returned = 0u32;
    let written = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr() as *const std::ffi::c_void,
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        )
    };
    let outcome = if written == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    };
    unsafe { CloseHandle(handle) };
    outcome
}

#[cfg(not(windows))]
pub fn create_junction(_: &std::path::Path, _: &std::path::Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "directory junctions are Windows-only",
    ))
}

#[cfg(not(windows))]
pub fn remove_junction(path: &std::path::Path) -> std::io::Result<()> {
    std::fs::remove_dir(path)
}

/// Off Windows the equivalent reparse point is a directory symbolic link.
#[cfg(not(windows))]
pub fn is_reparse_point(path: &std::path::Path) -> bool {
    std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}
