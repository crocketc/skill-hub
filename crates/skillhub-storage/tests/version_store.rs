use std::fs;
use std::sync::Arc;
use std::thread;

use serde_json::Value;
use skillhub_core::{LibraryPaths, SkillId};
use skillhub_storage::VersionStore;
use tempfile::TempDir;

struct Fixture {
    _root: TempDir,
    source: TempDir,
    store: VersionStore,
    skill: SkillId,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let paths = LibraryPaths::from_root(root.path());
        for path in [&paths.versions_dir, &paths.objects_dir, &paths.metadata_dir] {
            fs::create_dir_all(path).unwrap();
        }
        Self {
            _root: root,
            source,
            store: VersionStore::new(paths),
            skill: SkillId::new(),
        }
    }

    fn write(&self, name: &str, content: &[u8]) {
        let path = self.source.path().join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }
}

#[test]
fn equal_file_content_is_stored_once_across_versions() {
    let fixture = Fixture::new();
    fixture.write("SKILL.md", b"same");
    let first = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    fixture.write("note.md", b"new");
    let second = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(fixture.store.object_count_for_bytes(b"same").unwrap(), 1);
}

#[test]
fn materialized_version_matches_manifest_hashes() {
    let fixture = Fixture::new();
    fixture.write("SKILL.md", b"content");
    let version = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let output = tempfile::tempdir().unwrap();
    fixture
        .store
        .materialize(&version.id, output.path())
        .unwrap();
    assert_eq!(
        fs::read(output.path().join("SKILL.md")).unwrap(),
        b"content"
    );
    assert_eq!(
        fixture.store.hash_tree(output.path()).unwrap(),
        version.manifest.tree_hash
    );
}

#[test]
fn traversal_and_symlink_escape_are_rejected() {
    let fixture = Fixture::new();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/tmp", fixture.source.path().join("link")).unwrap();
    #[cfg(windows)]
    if std::os::windows::fs::symlink_dir("C:\\Windows", fixture.source.path().join("link")).is_err()
    {
        return;
    }
    assert!(fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .is_err());
}

#[test]
fn version_manifests_are_immutable_and_canonically_sorted() {
    let fixture = Fixture::new();
    fixture.write("z.txt", b"z");
    fixture.write("a.txt", b"a");
    let version = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    assert_eq!(version.manifest.entries[0].path, "a.txt");
    assert_eq!(version.manifest.entries[1].path, "z.txt");
    let before = fixture.store.load_manifest(&version.id).unwrap();
    assert!(fixture.store.save_manifest(&version.id, &before).is_err());
    assert_eq!(fixture.store.load_manifest(&version.id).unwrap(), before);
}

#[test]
fn set_current_rejects_other_skill_and_rollback_keeps_newer_history() {
    let fixture = Fixture::new();
    fixture.write("SKILL.md", b"one");
    let first = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    fixture.write("SKILL.md", b"two");
    let second = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let other = fixture
        .store
        .capture(SkillId::new(), fixture.source.path())
        .unwrap();
    assert!(fixture.store.set_current(fixture.skill, &other.id).is_err());
    fixture
        .store
        .set_current(fixture.skill, &second.id)
        .unwrap();
    fixture.store.set_current(fixture.skill, &first.id).unwrap();
    assert_eq!(
        fixture.store.current(fixture.skill).unwrap(),
        Some(first.id)
    );
    assert!(fixture.store.load_manifest(&second.id).is_ok());
}

#[test]
fn diff_reports_added_removed_and_changed_files() {
    let fixture = Fixture::new();
    fixture.write("same.txt", b"one");
    fixture.write("removed.txt", b"gone");
    let first = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    fs::remove_file(fixture.source.path().join("removed.txt")).unwrap();
    fixture.write("same.txt", b"two");
    fixture.write("added.txt", b"new");
    let second = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let diff = fixture.store.diff(&first.id, &second.id).unwrap();
    assert_eq!(diff.added, vec!["added.txt"]);
    assert_eq!(diff.removed, vec!["removed.txt"]);
    assert_eq!(diff.changed, vec!["same.txt"]);
}

#[test]
fn concurrent_captures_and_current_updates_do_not_share_temporary_files() {
    let fixture = Fixture::new();
    fixture.write("SKILL.md", b"concurrent");
    let store = Arc::new(fixture.store);
    let source = fixture.source.path().to_path_buf();
    let skill = fixture.skill;
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let store = Arc::clone(&store);
            let source = source.clone();
            thread::spawn(move || store.capture(skill, source).unwrap().id)
        })
        .collect();
    let ids: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert!(ids.iter().all(|id| id == &ids[0]));
    for id in ids {
        store.set_current(skill, &id).unwrap();
    }
}

#[test]
fn tampered_object_is_rejected_before_materialization() {
    let fixture = Fixture::new();
    fixture.write("SKILL.md", b"original");
    let version = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let object = version.manifest.entries[0]
        .object_id
        .strip_prefix("sha256:")
        .unwrap();
    fs::write(
        fixture.store.objects_path_for_test().join(object),
        b"tampered",
    )
    .unwrap();
    assert!(fixture
        .store
        .materialize(&version.id, tempfile::tempdir().unwrap().path())
        .is_err());
}

#[test]
fn existing_output_symlink_is_rejected() {
    let fixture = Fixture::new();
    fixture.write("nested/file.txt", b"safe");
    let version = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let output = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            tempfile::tempdir().unwrap().path(),
            output.path().join("nested"),
        )
        .unwrap();
        assert!(fixture
            .store
            .materialize(&version.id, output.path())
            .is_err());
    }
    #[cfg(windows)]
    {
        fs::create_dir(output.path().join("nested")).unwrap();
        fs::write(output.path().join("nested/file.txt"), b"existing").unwrap();
        assert!(fixture
            .store
            .materialize(&version.id, output.path())
            .is_err());
    }
}

#[test]
fn manifest_rejects_noncanonical_duplicate_and_invalid_object_entries() {
    let fixture = Fixture::new();
    fixture.write("nested/file.txt", b"safe");
    let version = fixture
        .store
        .capture(fixture.skill, fixture.source.path())
        .unwrap();
    let path = fixture
        .store
        .manifest_path_for_test(fixture.skill, &version.id);
    let original: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    for mutation in [
        ("path", Value::String("nested\\file.txt".into())),
        ("object_id", Value::String("sha256:ABC".into())),
    ] {
        let mut value = original.clone();
        value["entries"][0][mutation.0] = mutation.1;
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        assert!(fixture.store.load_manifest(&version.id).is_err());
    }
    let mut duplicate = original;
    let first_entry = duplicate["entries"][0].clone();
    duplicate["entries"]
        .as_array_mut()
        .unwrap()
        .push(first_entry);
    fs::write(&path, serde_json::to_vec_pretty(&duplicate).unwrap()).unwrap();
    assert!(fixture.store.load_manifest(&version.id).is_err());
}
