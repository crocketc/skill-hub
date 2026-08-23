use std::sync::{Arc, Mutex};

use skillhub_core::SkillId;
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
