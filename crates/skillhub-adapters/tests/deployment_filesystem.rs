use std::fs;
use std::path::{Path, PathBuf};

use skillhub_adapters::deployment::{
    AppliedTarget, DeploymentFilesystem, OwnershipProof, PreparedTarget,
};
use skillhub_core::{DeploymentMode, SkillId, TargetChange, TargetPlan, VersionId};

#[test]
fn managed_copy_is_verified_against_selected_version_manifest() {
    let fixture = DeploymentFixture::new();

    let applied = fixture.deploy(DeploymentMode::ManagedCopy).unwrap();

    assert_eq!(
        DeploymentFilesystem::hash_tree(&applied.destination_path).unwrap(),
        fixture.selected_version_tree_hash()
    );
    assert_eq!(applied.ownership.mode, DeploymentMode::ManagedCopy);
    assert_eq!(
        applied.ownership.expected_hash,
        fixture.selected_version_tree_hash()
    );
}

#[test]
fn existing_unknown_target_is_rejected_without_overwrite() {
    let fixture = DeploymentFixture::new();
    fs::create_dir_all(fixture.destination()).unwrap();
    fs::write(fixture.destination().join("SKILL.md"), "# unmanaged").unwrap();

    let error = DeploymentFilesystem::new()
        .prepare(&fixture.plan(DeploymentMode::ManagedCopy))
        .unwrap_err();

    assert_eq!(error.code.as_str(), "deployment.target_exists");
    assert_eq!(
        fs::read_to_string(fixture.destination().join("SKILL.md")).unwrap(),
        "# unmanaged"
    );
}

#[test]
fn remove_owned_refuses_modified_managed_copy() {
    let fixture = DeploymentFixture::new();
    let applied = fixture.deploy(DeploymentMode::ManagedCopy).unwrap();
    fs::write(applied.destination_path.join("notes.txt"), "changed").unwrap();

    let error = DeploymentFilesystem::new()
        .remove_owned(&applied.ownership)
        .unwrap_err();

    assert_eq!(error.code.as_str(), "deployment.ownership_mismatch");
    assert!(applied.destination_path.exists());
}

#[test]
fn remove_owned_refuses_added_empty_directory() {
    let fixture = DeploymentFixture::new();
    let applied = fixture.deploy(DeploymentMode::ManagedCopy).unwrap();
    fs::create_dir(applied.destination_path.join("user-data")).unwrap();

    let error = DeploymentFilesystem::new()
        .remove_owned(&applied.ownership)
        .unwrap_err();

    assert_eq!(error.code.as_str(), "deployment.ownership_mismatch");
    assert!(applied.destination_path.exists());
    assert!(applied.destination_path.join("user-data").is_dir());
}

#[test]
fn symbolic_link_round_trip_is_verified_or_reports_capability() {
    let fixture = DeploymentFixture::new();
    let outcome = fixture.deploy(DeploymentMode::SymbolicLink);

    match outcome {
        Ok(applied) => {
            assert_eq!(applied.ownership.mode, DeploymentMode::SymbolicLink);
            assert!(fs::symlink_metadata(&applied.destination_path)
                .unwrap()
                .file_type()
                .is_symlink());
            DeploymentFilesystem::new()
                .remove_owned(&applied.ownership)
                .unwrap();
            assert!(!applied.destination_path.exists());
        }
        Err(error) => assert_eq!(error.code.as_str(), "deployment.symlink_not_supported"),
    }
}

#[test]
fn managed_symbolic_link_can_be_removed_after_its_central_source_updates() {
    let fixture = DeploymentFixture::new();
    let outcome = fixture.deploy(DeploymentMode::SymbolicLink);

    match outcome {
        Ok(applied) => {
            let replacement = fixture.source.with_file_name("updated-source");
            let previous = fixture.source.with_file_name("previous-source");
            fs::create_dir(&replacement).unwrap();
            fs::write(replacement.join("SKILL.md"), "# Updated Notes\n").unwrap();
            fs::rename(&fixture.source, &previous).unwrap();
            fs::rename(&replacement, &fixture.source).unwrap();
            DeploymentFilesystem::new()
                .remove_owned(&applied.ownership)
                .expect("the managed link should still point to the central source");
            assert!(!applied.destination_path.exists());
        }
        Err(error) => assert_eq!(error.code.as_str(), "deployment.symlink_not_supported"),
    }
}

#[cfg(windows)]
#[test]
fn junction_fallback_does_not_require_elevated_test_process() {
    let fixture = DeploymentFixture::new();
    let outcome = fixture.deploy(DeploymentMode::DirectoryJunction);

    match outcome {
        Ok(applied) => {
            assert_eq!(applied.ownership.mode, DeploymentMode::DirectoryJunction);
            DeploymentFilesystem::new()
                .remove_owned(&applied.ownership)
                .unwrap();
            assert!(!applied.destination_path.exists());
        }
        Err(error) => assert_eq!(error.code.as_str(), "deployment.junction_not_supported"),
    }
}

#[cfg(windows)]
#[test]
fn managed_junction_can_be_removed_after_its_central_source_updates() {
    // The deployment owns the junction, not the directory it resolves to.  A
    // source update replaces that directory wholesale, and that must not
    // invalidate the removal proof - otherwise a Windows account without
    // symlink privilege could centralise a Skill but never release it again.
    let fixture = DeploymentFixture::new();
    let applied = fixture
        .deploy(DeploymentMode::DirectoryJunction)
        .expect("a junction must not need an elevated test process");

    let replacement = fixture.source.with_file_name("updated-source");
    let previous = fixture.source.with_file_name("previous-source");
    fs::create_dir(&replacement).unwrap();
    fs::write(replacement.join("SKILL.md"), "# Updated PDF\n").unwrap();
    fs::rename(&fixture.source, &previous).unwrap();
    fs::rename(&replacement, &fixture.source).unwrap();

    DeploymentFilesystem::new()
        .remove_owned(&applied.ownership)
        .expect("the managed junction should still be removable after a source update");
    assert!(!applied.destination_path.exists());
}

#[cfg(windows)]
#[test]
fn junction_probe_cleans_up_and_needs_no_privilege() {
    // The per-volume probe decides whether a relation conversion may proceed.
    // On Windows a junction is the only link kind an unelevated account can
    // create, so the probe has to report it - and it must never leave its own
    // test entry behind in the user's directory.
    let fixture = DeploymentFixture::new();
    let capabilities =
        DeploymentFilesystem::new().probe_link_capabilities(&fixture.target_root, &fixture.source);

    assert!(capabilities.junction);
    let leftovers = fs::read_dir(&fixture.target_root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".skillhub-link-probe-")
        })
        .count();
    assert_eq!(leftovers, 0, "the probe must remove its own entry");
}

// ---------------------------------------------------------------------------
// Task 6: volume-accurate link capability probing for relation conversions.
// ---------------------------------------------------------------------------

#[test]
fn link_probe_reports_materialized_capability_and_cleans_up_after_itself() {
    let fixture = DeploymentFixture::new();
    let capabilities =
        DeploymentFilesystem::new().probe_link_capabilities(&fixture.target_root, &fixture.source);

    assert!(capabilities.copy);
    // Whatever the platform answers, the probe must not leave an entry in the
    // user's directory.
    let leftovers = fs::read_dir(&fixture.target_root).unwrap().count();
    assert_eq!(leftovers, 0, "probe must clean up its temporary entry");

    if capabilities.symlink {
        // A reported capability must be reproducible at the same location.
        let destination = fixture
            .target_root
            .join(".skillhub-link-probe-reproduction");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&fixture.source, &destination).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&fixture.source, &destination).unwrap();
        assert!(fs::symlink_metadata(&destination)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_file(&destination).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn link_probe_refuses_an_unwritable_relation_parent_instead_of_guessing() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = DeploymentFixture::new();
    let original_mode = fs::metadata(&fixture.target_root)
        .unwrap()
        .permissions()
        .mode();
    let restore_permissions = |root: &std::path::Path| {
        let mut restore = fs::metadata(root).unwrap().permissions();
        restore.set_mode(original_mode);
        fs::set_permissions(root, restore).unwrap();
    };
    let mut permissions = fs::metadata(&fixture.target_root).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&fixture.target_root, permissions).unwrap();

    // Fail the test honestly when the platform ignores the read-only bit
    // (for example a root test process) instead of reporting a fake pass.
    let control = fixture.target_root.join(".skillhub-link-probe-control");
    let readonly_enforced = std::os::unix::fs::symlink(&fixture.source, &control).is_err();
    let _ = std::fs::remove_file(&control);
    if !readonly_enforced {
        restore_permissions(&fixture.target_root);
        eprintln!("skipping: this process can write read-only directories (root?)");
        return;
    }

    let capabilities =
        DeploymentFilesystem::new().probe_link_capabilities(&fixture.target_root, &fixture.source);
    assert!(!capabilities.symlink);
    assert!(!capabilities.junction);

    restore_permissions(&fixture.target_root);
}

struct DeploymentFixture {
    _tempdir: tempfile::TempDir,
    source: PathBuf,
    target_root: PathBuf,
    destination: PathBuf,
}

impl DeploymentFixture {
    fn new() -> Self {
        let tempdir = tempfile::tempdir().unwrap();
        let source = tempdir.path().join("versions").join("pdf");
        let target_root = tempdir.path().join("agent").join("skills");
        let destination = target_root.join("pdf");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::create_dir_all(&target_root).unwrap();
        fs::write(source.join("SKILL.md"), "# PDF\n").unwrap();
        fs::write(source.join("nested").join("notes.txt"), "stable").unwrap();
        Self {
            _tempdir: tempdir,
            source,
            target_root,
            destination,
        }
    }

    fn deploy(&self, mode: DeploymentMode) -> skillhub_core::AppResult<AppliedTarget> {
        let filesystem = DeploymentFilesystem::new();
        let prepared: PreparedTarget = filesystem.prepare(&self.plan(mode))?;
        filesystem.apply(prepared)
    }

    fn selected_version_tree_hash(&self) -> String {
        DeploymentFilesystem::hash_tree(&self.source).unwrap()
    }

    fn destination(&self) -> &Path {
        &self.destination
    }

    fn plan(&self, mode: DeploymentMode) -> TargetPlan {
        TargetPlan {
            physical_target_id: "physical-agent-skills".to_owned(),
            logical_target_ids: vec!["codex-global".to_owned()],
            target_path: self.target_root.to_string_lossy().into_owned(),
            destination_path: self.destination.to_string_lossy().into_owned(),
            source_path: self.source.to_string_lossy().into_owned(),
            runtime_name: "pdf".to_owned(),
            skill_id: SkillId::new(),
            version_id: VersionId::parse(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            )
            .unwrap(),
            mode,
            change: TargetChange::Create,
            warnings: Vec::new(),
            conflicts: Vec::new(),
        }
    }
}

#[allow(dead_code)]
fn assert_proof_is_send_sync(_: &OwnershipProof) {}
