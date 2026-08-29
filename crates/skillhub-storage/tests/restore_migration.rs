use skillhub_core::backup::{BackupInput, BackupScope, RestoreConflictDecision};
use skillhub_core::SkillId;
use skillhub_storage::backup::{BackupService, RestoreService};
use tempfile::tempdir;

#[test]
fn restores_portable_skills_without_reusing_device_targets() {
    let root = tempdir().unwrap();
    let package_root = root.path().join("packages");
    let library_root = root.path().join("library");
    let backup = BackupService::new(package_root);
    let id = SkillId::new();
    let input = BackupInput::new(
        BackupScope::Full,
        r#"{"skills":[],"deployments":[{"target_path":"C:\\Users\\old\\.agents"}]}"#,
        vec![(id, "# Portable".into())],
    );
    let plan = backup.prepare(&input).unwrap();
    let package = backup.create(&input, &plan, &[]).unwrap();
    let restore = RestoreService::new(library_root);
    let restore_plan = restore.prepare(&package).unwrap();
    assert_eq!(restore_plan.skills, 1);
    assert_eq!(restore_plan.deployments_requiring_rediscovery, 1);
    let result = restore.commit(&package, &restore_plan, &[]).unwrap();
    assert_eq!(result.skills_restored, 1);
    assert!(result.deployments_requiring_rediscovery > 0);
    assert!(!restore
        .root()
        .join("skills")
        .join(id.to_string())
        .join("SKILL.md")
        .to_string_lossy()
        .contains("Users\\old"));
}

#[test]
fn restore_conflict_can_skip_and_staged_failure_preserves_live_library() {
    let root = tempdir().unwrap();
    let package_root = root.path().join("packages");
    let library_root = root.path().join("library");
    let backup = BackupService::new(package_root);
    let id = SkillId::new();
    let input = BackupInput::new(
        BackupScope::Full,
        r#"{"skills":[]}"#,
        vec![(id, "# New".into())],
    );
    let package = backup
        .create(&input, &backup.prepare(&input).unwrap(), &[])
        .unwrap();
    let restore = RestoreService::new(library_root.clone());
    std::fs::create_dir_all(library_root.join("skills").join(id.to_string())).unwrap();
    std::fs::write(
        library_root
            .join("skills")
            .join(id.to_string())
            .join("SKILL.md"),
        "# Live",
    )
    .unwrap();
    let plan = restore.prepare(&package).unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    let result = restore
        .commit(&package, &plan, &[(id, RestoreConflictDecision::Skip)])
        .unwrap();
    assert_eq!(result.skills_skipped, 1);
    assert_eq!(
        std::fs::read_to_string(
            library_root
                .join("skills")
                .join(id.to_string())
                .join("SKILL.md")
        )
        .unwrap(),
        "# Live"
    );

    let failing = RestoreService::new(library_root.clone()).with_fault("before_restore_switch");
    let error = failing
        .commit(&package, &plan, &[(id, RestoreConflictDecision::Overwrite)])
        .unwrap_err();
    assert_eq!(error.code, skillhub_core::ErrorCode::InternalError);
    assert_eq!(
        std::fs::read_to_string(
            library_root
                .join("skills")
                .join(id.to_string())
                .join("SKILL.md")
        )
        .unwrap(),
        "# Live"
    );
}
