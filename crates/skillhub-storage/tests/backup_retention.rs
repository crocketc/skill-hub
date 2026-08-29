use skillhub_core::backup::{BackupInput, BackupRetentionPolicy, BackupScope};
use skillhub_storage::backup::{BackupService, RetentionService};
use tempfile::tempdir;

#[test]
fn retention_removes_only_verified_owned_packages_and_keeps_one_valid_backup() {
    let root = tempdir().unwrap();
    let service = BackupService::new(root.path().to_path_buf());
    let input = BackupInput::new(BackupScope::Full, r#"{"skills":[]}"#, Vec::new());
    let plan = service.prepare(&input).unwrap();
    let first = service.create(&input, &plan, &[]).unwrap();
    let second = service.create(&input, &plan, &[]).unwrap();
    let result = RetentionService::new(root.path().to_path_buf())
        .apply(BackupRetentionPolicy { max_backups: 1 })
        .unwrap();
    assert_eq!(result.retained, 1);
    assert_eq!(result.removed, 1);
    assert!(second.root.exists() || first.root.exists());
    assert!(root.path().read_dir().unwrap().all(|entry| {
        let path = entry.unwrap().path();
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .starts_with("skillhub-backup-")
    }));
}
