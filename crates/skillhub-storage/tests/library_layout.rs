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
