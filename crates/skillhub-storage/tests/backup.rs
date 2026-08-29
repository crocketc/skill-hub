use skillhub_core::backup::{BackupInput, BackupScope, SensitiveContentDecision};
use skillhub_core::{ErrorCode, SkillId};
use skillhub_storage::backup::BackupService;
use tempfile::tempdir;

#[test]
fn full_backup_round_trip_contains_portable_data_and_no_secret_or_device_path() {
    let destination = tempdir().unwrap();
    let device_path = r"C:\Users\crock\skillhub";
    let input = BackupInput::new(
        BackupScope::Full,
        r#"{"skills":[{"id":"portable"}]}"#,
        vec![(SkillId::new(), "# Skill\nNo secret".into())],
    )
    .with_device_path(device_path);
    let service = BackupService::new(destination.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    assert!(plan.sensitive_items.is_empty());
    let package = service.create(&input, &plan, &[]).unwrap();
    let verified = service.verify(&package).unwrap();
    assert_eq!(verified.manifest.format_version, 1);
    assert!(!verified
        .bytes
        .windows(device_path.len())
        .any(|window| window == device_path.as_bytes()));
}

#[test]
fn changed_archive_entry_fails_manifest_verification() {
    let destination = tempdir().unwrap();
    let input = BackupInput::new(
        BackupScope::Full,
        r#"{"skills":[{"id":"portable"}]}"#,
        vec![(SkillId::new(), "# Skill".into())],
    );
    let service = BackupService::new(destination.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let package = service.create(&input, &plan, &[]).unwrap();
    std::fs::write(package.root.join("portable/skills.json"), "tampered").unwrap();
    assert_eq!(
        service.verify(&package).unwrap_err().code,
        ErrorCode::BackupChecksumMismatch
    );
}

#[test]
fn possible_plaintext_credential_pauses_backup_until_choice() {
    let destination = tempdir().unwrap();
    let input = BackupInput::new(
        BackupScope::Full,
        r#"{"skills":[{"id":"portable"}]}"#,
        vec![(SkillId::new(), "OPENAI_API_KEY=sk-live-secret".into())],
    );
    let service = BackupService::new(destination.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    assert_eq!(plan.sensitive_items.len(), 1);
    let error = service.create(&input, &plan, &[]).unwrap_err();
    assert_eq!(error.code, ErrorCode::BackupSensitiveDecisionRequired);
    let package = service
        .create(
            &input,
            &plan,
            &[(
                plan.sensitive_items[0].skill_id,
                SensitiveContentDecision::IncludeAndMark,
            )],
        )
        .unwrap();
    assert!(
        service
            .verify(&package)
            .unwrap()
            .manifest
            .contains_sensitive_skill_content
    );
}

#[test]
fn manifest_path_escape_is_rejected_before_reading_outside_package() {
    let destination = tempdir().unwrap();
    let input = BackupInput::new(BackupScope::Full, r#"{"skills":[]}"#, Vec::new());
    let service = BackupService::new(destination.path().to_path_buf());
    let plan = service.prepare(&input).unwrap();
    let package = service.create(&input, &plan, &[]).unwrap();
    std::fs::write(
        package.root.join("backup.json"),
        r#"{"format_version":1,"entries":[{"path":"../outside","sha256":"00"}],"contains_sensitive_skill_content":false}"#,
    )
    .unwrap();
    assert_eq!(
        service.verify(&package).unwrap_err().code,
        ErrorCode::BackupChecksumMismatch
    );
}
