use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use skillhub_core::catalog::Skill;
use skillhub_core::SkillId;
use skillhub_storage::{CentralLibrary, VersionStore};
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    library: CentralLibrary,
    skill: Skill,
    previous: skillhub_core::VersionRecord,
    target: skillhub_core::VersionRecord,
    armed_faults: Arc<Mutex<HashSet<&'static str>>>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("library root");
        let armed_faults = Arc::new(Mutex::new(HashSet::new()));
        let fault_state = Arc::clone(&armed_faults);
        let library = CentralLibrary::initialize_with_fault_handler(
            root.path(),
            Arc::new(move |point| fault_state.lock().unwrap().remove(point)),
        )
        .expect("initialize central library");
        let skill = Skill::new(SkillId::new(), "Visible replacement");
        let store = VersionStore::from_library(&library);

        let previous_source = tempfile::tempdir().expect("previous source");
        fs::write(previous_source.path().join("SKILL.md"), "# Previous\n")
            .expect("write previous version");
        let previous = store
            .capture(skill.id(), previous_source.path())
            .expect("capture previous version");
        let target_source = tempfile::tempdir().expect("target source");
        fs::write(target_source.path().join("SKILL.md"), "# Target\n")
            .expect("write target version");
        let target = store
            .capture(skill.id(), target_source.path())
            .expect("capture target version");
        store
            .set_current(skill.id(), &previous.id)
            .expect("set previous current version");
        library
            .materialize_current_skill(&skill, &previous.id)
            .expect("materialize previous version");

        Self {
            _root: root,
            library,
            skill,
            previous,
            target,
            armed_faults,
        }
    }

    fn output(&self) -> PathBuf {
        self.library.visible_skill_path(&self.skill)
    }

    fn arm(&self, points: &[&'static str]) {
        self.armed_faults
            .lock()
            .unwrap()
            .extend(points.iter().copied());
    }
}

#[test]
fn failed_staging_and_backup_restore_keeps_a_recoverable_backup() {
    let fixture = Fixture::new();
    fixture.arm(&[
        "before_visible_staging_rename",
        "before_visible_backup_restore",
    ]);

    let error = fixture
        .library
        .prepare_visible_tree_replacement(&fixture.skill, &fixture.target.id)
        .expect_err("both staging and compensation must fail");
    assert_eq!(
        error.params.get("reason").and_then(serde_json::Value::as_str),
        Some("visible_backup_restore_failed")
    );
    let backup = PathBuf::from(
        error
            .params
            .get("recovery_backup_path")
            .and_then(serde_json::Value::as_str)
            .expect("error exposes retained backup path"),
    );
    assert!(backup.is_dir(), "the old visible tree remains recoverable");
    assert!(!fixture.output().exists(), "failed output stays absent");

    fixture
        .library
        .recover_visible_tree_backup(
            &fixture.skill,
            &backup,
            &fixture.target.id,
            &fixture.previous.manifest.tree_hash,
        )
        .expect("restore the exact retained backup");
    assert_eq!(
        fs::read_to_string(fixture.output().join("SKILL.md")).unwrap(),
        "# Previous\n"
    );
    assert!(!backup.exists());
}


#[test]
fn materialize_replaces_an_existing_tree_and_can_repeat() {
    let fixture = Fixture::new();

    fixture
        .library
        .materialize_current_skill(&fixture.skill, &fixture.target.id)
        .expect("replace an existing visible tree with its current version");
    assert_eq!(
        fs::read_to_string(fixture.output().join("SKILL.md")).unwrap(),
        "# Target\n"
    );

    fixture
        .library
        .materialize_current_skill(&fixture.skill, &fixture.target.id)
        .expect("repeating materialization of the same version remains valid");
    assert_eq!(
        fs::read_to_string(fixture.output().join("SKILL.md")).unwrap(),
        "# Target\n"
    );
}

#[test]
fn rollback_rejects_a_visible_output_whose_identity_changed() {
    let fixture = Fixture::new();
    let replacement = fixture
        .library
        .prepare_visible_tree_replacement(&fixture.skill, &fixture.target.id)
        .expect("prepare visible replacement");
    let backup = replacement.backup_path().unwrap().to_path_buf();
    fs::write(fixture.output().join("SKILL.md"), "# Changed outside transaction\n")
        .expect("change visible output");

    let error = fixture
        .library
        .rollback_visible_tree_replacement(&replacement)
        .expect_err("do not overwrite an output changed after prepare");
    assert_eq!(
        error.params.get("reason").and_then(serde_json::Value::as_str),
        Some("visible_output_identity_changed")
    );
    assert!(backup.is_dir(), "the prior tree remains available for recovery");
    assert_eq!(
        fs::read_to_string(fixture.output().join("SKILL.md")).unwrap(),
        "# Changed outside transaction\n"
    );
}

#[test]
fn recovery_rejects_a_backup_replaced_by_a_directory_link() {
    let fixture = Fixture::new();
    let replacement = fixture
        .library
        .prepare_visible_tree_replacement(&fixture.skill, &fixture.target.id)
        .expect("prepare visible replacement");
    let backup = replacement.backup_path().unwrap().to_path_buf();
    fs::remove_dir_all(&backup).expect("remove real backup for substitution test");
    let external = tempfile::tempdir().expect("external directory");
    fs::write(external.path().join("keep.txt"), "external data").unwrap();
    if !create_directory_link(external.path(), &backup) {
        eprintln!("SKILLHUB-TEST-SKIP; directory links are unavailable on this host");
        return;
    }

    let error = fixture
        .library
        .rollback_visible_tree_replacement(&replacement)
        .expect_err("a substituted directory link is not a recovery backup");
    assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);
    assert_eq!(fs::read_to_string(external.path().join("keep.txt")).unwrap(), "external data");
    assert!(fs::symlink_metadata(&backup).is_ok(), "do not follow or delete the link");
}

#[test]
fn recovery_rejects_a_dangling_output_link_and_keeps_the_backup() {
    let fixture = Fixture::new();
    fixture.arm(&[
        "before_visible_staging_rename",
        "before_visible_backup_restore",
    ]);
    let error = fixture
        .library
        .prepare_visible_tree_replacement(&fixture.skill, &fixture.target.id)
        .expect_err("leave the prior tree in the recovery slot");
    let backup = PathBuf::from(
        error
            .params
            .get("recovery_backup_path")
            .and_then(serde_json::Value::as_str)
            .expect("recovery path"),
    );
    let dangling_target = fixture._root.path().join("missing-output-target");
    if !create_directory_link(&dangling_target, &fixture.output()) {
        eprintln!("SKILLHUB-TEST-SKIP; directory links are unavailable on this host");
        return;
    }

    let error = fixture
        .library
        .recover_visible_tree_backup(
            &fixture.skill,
            &backup,
            &fixture.target.id,
            &fixture.previous.manifest.tree_hash,
        )
        .expect_err("a dangling output link is still an occupied unsafe path");
    assert_eq!(error.code, skillhub_core::ErrorCode::OperationConflict);
    assert!(backup.is_dir(), "recovery evidence must remain available");
    assert!(fs::symlink_metadata(fixture.output()).is_ok());
}

#[cfg(unix)]
fn create_directory_link(target: &Path, link: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(windows)]
fn create_directory_link(target: &Path, link: &Path) -> bool {
    std::os::windows::fs::symlink_dir(target, link).is_ok()
}

#[cfg(not(any(unix, windows)))]
fn create_directory_link(_target: &Path, _link: &Path) -> bool {
    false
}
