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
