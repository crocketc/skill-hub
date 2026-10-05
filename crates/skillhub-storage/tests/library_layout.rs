use std::sync::{Arc, Mutex};

use skillhub_core::{
    catalog::{CallPolicy, Skill},
    SkillId,
};
use skillhub_storage::{CentralLibrary, LibraryManifest, PortableSkillRecord};
use skillhub_testkit::TempWorkspace;

#[test]
fn initialization_creates_visible_skills_and_internal_management_dirs() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();

    assert!(library.paths().skills_dir.ends_with("skills"));
    assert!(library.paths().management_dir.ends_with(".skillhub"));
    assert!(library.paths().skills_dir.is_dir());
    assert!(library.paths().management_dir.is_dir());
    assert!(library.paths().versions_dir.is_dir());
    assert!(library.paths().objects_dir.is_dir());
    assert!(library.paths().backups_dir.is_dir());
    assert!(library.paths().tmp_dir.is_dir());
    assert_eq!(library.load_manifest().unwrap().format_version, 1);
}

#[test]
fn create_accepts_missing_or_empty_directories_and_materializes_a_complete_layout() {
    let missing = tempfile::tempdir().unwrap();
    let missing_root = missing.path().join("new-library");
    let created = CentralLibrary::create(&missing_root).expect("create missing root");
    assert_eq!(created.load_manifest().unwrap(), LibraryManifest::default());
    assert!(created.paths().skills_dir.is_dir());
    assert!(created.paths().objects_dir.is_dir());

    let empty = tempfile::tempdir().unwrap();
    let opened = CentralLibrary::create(empty.path()).expect("create empty root");
    assert_eq!(opened.load_manifest().unwrap(), LibraryManifest::default());
}

#[test]
fn create_rejects_unknown_user_files_without_overwriting_them() {
    let root = tempfile::tempdir().unwrap();
    let user_file = root.path().join("keep-me.txt");
    std::fs::write(&user_file, "user data").unwrap();

    let error = CentralLibrary::create(root.path()).unwrap_err();

    assert_eq!(error.code.as_str(), "operation.conflict");
    assert_eq!(std::fs::read_to_string(user_file).unwrap(), "user data");
}

#[test]
fn open_existing_requires_and_validates_the_library_manifest() {
    let ordinary = tempfile::tempdir().unwrap();
    let error = CentralLibrary::open_existing(ordinary.path()).unwrap_err();
    assert_eq!(error.code.as_str(), "input.invalid");

    let valid = tempfile::tempdir().unwrap();
    CentralLibrary::create(valid.path()).unwrap();
    let opened = CentralLibrary::open_existing(valid.path()).expect("open existing library");
    assert_eq!(opened.load_manifest().unwrap().format_version, 1);

    std::fs::write(
        valid.path().join(".skillhub/library.json"),
        br#"{"format_version":99,"skills":[]}"#,
    )
    .unwrap();
    let error = CentralLibrary::open_existing(valid.path()).unwrap_err();
    assert_eq!(error.code.as_str(), "input.invalid");
}

#[test]
fn loading_a_legacy_portable_manifest_normalizes_archived_skills_and_preserves_other_facts() {
    let root = tempfile::tempdir().unwrap();
    let library = CentralLibrary::initialize(root.path()).unwrap();
    let legacy = serde_json::json!({
        "format_version": 1,
        "skills": [
            {
                "id": "00000000-0000-0000-0000-0000000000a1",
                "display_name": "Legacy archived",
                "runtime_name": "legacy-archived",
                "lifecycle": "Archived",
                "trial_due": "2026-10-01",
                "tags": ["kept"]
            },
            {
                "id": "00000000-0000-0000-0000-0000000000a2",
                "display_name": "Legacy deprecated",
                "runtime_name": "legacy-deprecated",
                "lifecycle": "Deprecated"
            }
        ]
    });
    std::fs::write(
        &library.paths().manifest_path,
        serde_json::to_vec_pretty(&legacy).unwrap(),
    )
    .unwrap();

    let reopened = CentralLibrary::open_existing(root.path()).unwrap();
    assert_eq!(reopened.load_manifest().unwrap().skills.len(), 2);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&reopened.paths().manifest_path).unwrap()).unwrap();
    assert_eq!(persisted["skills"][0]["lifecycle"], "Normal");
    assert_eq!(persisted["skills"][0]["trial_due"], "2026-10-01");
    assert_eq!(persisted["skills"][0]["tags"][0], "kept");
    assert_eq!(persisted["skills"][1]["lifecycle"], "Deprecated");

    // A later ordinary typed write must also retain this existing trial fact.
    let manifest = reopened.load_manifest().unwrap();
    reopened.write_manifest_atomic(&manifest).unwrap();
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&reopened.paths().manifest_path).unwrap()).unwrap();
    assert_eq!(persisted["skills"][0]["trial_due"], "2026-10-01");
    assert_eq!(persisted["skills"][1]["lifecycle"], "Deprecated");
}

#[test]
fn failed_legacy_manifest_normalization_keeps_original_and_can_retry() {
    let root = tempfile::tempdir().unwrap();
    let library = CentralLibrary::initialize(root.path()).unwrap();
    let legacy = br#"{"format_version":1,"skills":[{"id":"00000000-0000-0000-0000-0000000000a1","display_name":"Legacy","runtime_name":"legacy","lifecycle":"Archived"}]}"#;
    std::fs::write(&library.paths().manifest_path, legacy).unwrap();

    let fault = Arc::new(|point: &str| point == "before_manifest_replace");
    assert!(CentralLibrary::initialize_with_fault_handler(root.path(), fault).is_err());
    assert_eq!(
        std::fs::read(&library.paths().manifest_path).unwrap(),
        legacy
    );

    let retried = CentralLibrary::open_existing(root.path()).unwrap();
    assert_eq!(retried.load_manifest().unwrap().skills.len(), 1);
    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&retried.paths().manifest_path).unwrap()).unwrap();
    assert_eq!(persisted["skills"][0]["lifecycle"], "Normal");
}

#[test]
fn both_modes_probe_writability_and_report_an_actionable_error() {
    let root = tempfile::tempdir().unwrap();
    let library = CentralLibrary::create(root.path()).expect("create library");
    assert!(!library.paths().management_dir.join(".write-probe").exists());
    let reopened = CentralLibrary::open_existing(root.path()).expect("open library");
    assert_eq!(reopened.load_manifest().unwrap().format_version, 1);
}

#[test]
fn interrupted_manifest_write_keeps_previous_valid_manifest() {
    let ws = TempWorkspace::new().unwrap();
    let armed = Arc::new(Mutex::new(false));
    let fault = {
        let armed = Arc::clone(&armed);
        Arc::new(move |point: &str| {
            if point != "before_manifest_replace" {
                return false;
            }
            let mut armed = armed.lock().unwrap();
            let was_armed = *armed;
            *armed = false;
            was_armed
        })
    };
    let library = CentralLibrary::initialize_with_fault_handler(ws.central_root(), fault).unwrap();
    *armed.lock().unwrap() = true;
    let original = library.load_manifest().unwrap();
    let changed = LibraryManifest {
        format_version: 1,
        skills: vec![PortableSkillRecord::new(SkillId::new(), "pdf")],
    };

    assert!(library.write_manifest_atomic(&changed).is_err());
    assert_eq!(library.load_manifest().unwrap(), original);
}

#[test]
fn successful_manifest_write_replaces_previous_manifest() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let changed = LibraryManifest {
        format_version: 1,
        skills: vec![PortableSkillRecord::new(SkillId::new(), "pdf")],
    };

    library.write_manifest_atomic(&changed).unwrap();
    assert_eq!(library.load_manifest().unwrap(), changed);
}

#[test]
fn unknown_manifest_version_is_rejected_without_overwriting_existing_data() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let original = library.load_manifest().unwrap();
    let future = LibraryManifest {
        format_version: 99,
        skills: Vec::new(),
    };

    assert!(library.write_manifest_atomic(&future).is_err());
    assert_eq!(library.load_manifest().unwrap(), original);

    std::fs::write(
        library.paths().manifest_path.clone(),
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();
    let error = library.load_manifest().unwrap_err();
    assert_eq!(error.code.as_str(), "input.invalid");
}

#[test]
fn initialization_rejects_an_existing_unknown_manifest_version() {
    let ws = TempWorkspace::new().unwrap();
    let management = ws.central_root().join(".skillhub");
    std::fs::create_dir_all(&management).unwrap();
    std::fs::write(
        management.join("library.json"),
        br#"{"format_version":99,"skills":[]}"#,
    )
    .unwrap();

    let error = CentralLibrary::initialize(ws.central_root()).unwrap_err();
    assert_eq!(error.code.as_str(), "input.invalid");
}

#[test]
fn portable_manifest_preserves_invocation_policy() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let skill = Skill::from_parts(
        SkillId::new(),
        "model-only".to_owned(),
        "model-only".to_owned(),
        "Description".to_owned(),
        None,
        None,
        None,
        Default::default(),
        None,
        None,
        CallPolicy::ModelOnly,
        skillhub_core::catalog::SkillLifecycle::Normal,
        Vec::new(),
        None,
    )
    .unwrap();

    library.save_portable_skill(&skill, None).unwrap();
    let (record, _) = library.load_portable_skill(skill.id()).unwrap().unwrap();
    assert_eq!(record.call_policy, CallPolicy::ModelOnly);
}

#[test]
fn portable_skill_write_persists_trial_due() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let skill = Skill::new(SkillId::new(), "temporary-trial").with_trial_due(2026, 10, 1);

    library.save_portable_skill(&skill, None).unwrap();

    let persisted: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&library.paths().manifest_path).unwrap()).unwrap();
    assert_eq!(persisted["skills"][0]["trial_due"], "2026-10-01");
}

#[test]
fn removing_a_portable_skill_also_removes_its_visible_managed_directory() {
    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let skill_id = SkillId::new();
    let record = PortableSkillRecord::new(skill_id, "visible-skill");
    let visible = library.visible_skill_path_for_runtime(skill_id, &record.runtime_name);
    std::fs::create_dir_all(&visible).unwrap();
    std::fs::write(visible.join("SKILL.md"), "# managed copy").unwrap();
    library
        .write_manifest_atomic(&LibraryManifest {
            format_version: 1,
            skills: vec![record],
        })
        .unwrap();

    library.remove_portable_skill(skill_id).unwrap();

    assert!(!visible.exists());
    assert!(library.load_manifest().unwrap().skills.is_empty());
}

/// W1-2：草稿目录移动 helper。把 `drafts/<skill_id>/` 移入指定备份路径，
/// 返回是否发生了移动；无草稿时返回 false；注入故障时草稿原位保留。
#[test]
fn drafts_removal_moves_skill_drafts_into_retained_backup() {
    use skillhub_storage::MarkdownDraftStore;
    use std::sync::Arc;

    let ws = TempWorkspace::new().unwrap();
    let library = CentralLibrary::initialize(ws.central_root()).unwrap();
    let drafts = MarkdownDraftStore::from_library(&library);
    let skill = SkillId::new();
    drafts
        .save(skill, "SKILL.md", "# draft\n", None, "object-1", 1)
        .unwrap();
    drafts
        .save(skill, "docs/notes.md", "# notes\n", None, "object-2", 2)
        .unwrap();

    let backup = library.paths().tmp_dir.join("drafts-backup-fixture");
    let moved = library.prepare_drafts_removal(skill, &backup).unwrap();
    assert!(moved, "a subject with drafts reports a moved directory");
    assert!(!library.paths().drafts_dir.join(skill.to_string()).exists());
    assert!(backup.is_dir());
    assert_eq!(std::fs::read_dir(&backup).unwrap().count(), 2);

    // 无草稿主体：不移动、不建备份目录。
    let empty_backup = library.paths().tmp_dir.join("drafts-backup-empty");
    let absent = SkillId::new();
    let moved = library
        .prepare_drafts_removal(absent, &empty_backup)
        .unwrap();
    assert!(!moved, "a subject without drafts reports no move");
    assert!(
        !empty_backup.exists(),
        "no backup directory appears for an empty subject"
    );

    // 消费既有"丢弃备份"步骤：同一路径原语可丢弃草稿备份。
    library.discard_visible_tree_removal(&backup).unwrap();
    assert!(!backup.exists());

    // 注入故障：移动失败时草稿原位保留，错误带稳定故障点。
    let armed_faults = Arc::new(std::sync::Mutex::new(std::collections::HashSet::from([
        "before_drafts_removal_rename",
    ])));
    let faulted = {
        let armed_faults = Arc::clone(&armed_faults);
        CentralLibrary::initialize_with_fault_handler(
            ws.central_root(),
            Arc::new(move |point| armed_faults.lock().unwrap().remove(point)),
        )
        .unwrap()
    };
    let drafts = MarkdownDraftStore::from_library(&faulted);
    let skill = SkillId::new();
    drafts
        .save(skill, "SKILL.md", "# stuck\n", None, "object-4", 4)
        .unwrap();
    let backup = faulted.paths().tmp_dir.join("drafts-backup-fault");
    let error = faulted
        .prepare_drafts_removal(skill, &backup)
        .expect_err("the injected fault must fail the move");
    assert_eq!(
        error.params.get("fault"),
        Some(&serde_json::json!("before_drafts_removal_rename"))
    );
    assert!(
        faulted.paths().drafts_dir.join(skill.to_string()).is_dir(),
        "a failed move must leave the drafts in place"
    );
    assert!(!backup.exists());
}
