use std::fs;
use std::io;
use std::path::Path;

pub fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "managed copy source must not be a symlink",
        ));
    }
    if metadata.is_dir() {
        fs::create_dir(destination)?;
        let staging_identity = skillhub_core::reparse_physical_id_for_path(destination);
        let copy_result = (|| {
            for entry in fs::read_dir(source)? {
                let entry = entry?;
                copy_tree(&entry.path(), &destination.join(entry.file_name()))?;
            }
            Ok(())
        })();
        if let Err(copy_error) = copy_result {
            return Err(cleanup_failed_copy(
                destination,
                staging_identity.as_deref(),
                copy_error,
            ));
        }
    } else {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source, destination)?;
    }
    Ok(())
}

fn cleanup_failed_copy(
    staging: &Path,
    expected_identity: Option<&str>,
    copy_error: io::Error,
) -> io::Error {
    let current_identity = skillhub_core::reparse_physical_id_for_path(staging);
    if expected_identity.is_some() && current_identity.as_deref() == expected_identity {
        return match fs::remove_dir_all(staging) {
            Ok(()) => copy_error,
            Err(cleanup_error) => io::Error::new(
                copy_error.kind(),
                format!(
                    "{copy_error}; could not remove owned staging tree {}: {cleanup_error}",
                    staging.display()
                ),
            ),
        };
    }

    match fs::symlink_metadata(staging) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => copy_error,
        Ok(_) => io::Error::new(
            copy_error.kind(),
            format!(
                "{copy_error}; staging tree identity changed before cleanup: {}",
                staging.display()
            ),
        ),
        Err(cleanup_error) => io::Error::new(
            copy_error.kind(),
            format!(
                "{copy_error}; could not verify staging tree before cleanup {}: {cleanup_error}",
                staging.display()
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::copy_tree;

    #[cfg(unix)]
    #[test]
    fn copy_failure_removes_the_staging_tree_and_preserves_external_target() {
        let workspace = tempdir().unwrap();
        let source = workspace.path().join("source");
        let outside = workspace.path().join("outside");
        let destination = workspace.path().join("stage");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(source.join("first.txt"), "partial copy").unwrap();
        fs::write(outside.join("user-data.txt"), "preserve").unwrap();
        std::os::unix::fs::symlink(&outside, source.join("nested/unsupported-link")).unwrap();

        let error = copy_tree(&source, &destination).expect_err("nested symlink is rejected");

        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(
            !destination.exists(),
            "failed copy must remove its owned partial staging tree"
        );
        assert_eq!(
            fs::read_to_string(outside.join("user-data.txt")).unwrap(),
            "preserve"
        );
    }
}
