use std::path::PathBuf;

use skillhub_adapters::source::{AcquisitionLimits, AcquisitionWorkspace, ArchiveExtractor};
use skillhub_core::source::AcquisitionErrorCode;

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/imports")
        .join(name)
}

fn test_limits() -> AcquisitionLimits {
    AcquisitionLimits {
        max_entries: 32,
        max_expanded_bytes: 1024 * 1024,
        max_file_bytes: 1024 * 1024,
    }
}

#[test]
fn rejects_parent_absolute_and_link_escape_entries() {
    for name in ["path-traversal.zip", "link-escape.tar"] {
        let error = ArchiveExtractor::new(test_limits())
            .extract(fixture(name))
            .unwrap_err();
        assert_eq!(error.code.as_str(), "source.archive_path_escape", "{name}");
    }
}

#[test]
fn expanded_size_limit_is_enforced_before_disk_exhaustion() {
    let error = ArchiveExtractor::new(AcquisitionLimits {
        max_expanded_bytes: 8,
        ..test_limits()
    })
    .extract(fixture("valid-skill.zip"))
    .unwrap_err();
    assert_eq!(error.code, AcquisitionErrorCode::ExpandedSizeLimit);
    assert_eq!(error.code.as_str(), "source.expanded_size_limit");
}

#[test]
fn valid_archive_is_extracted_into_a_unique_isolated_workspace() {
    let first = ArchiveExtractor::new(test_limits())
        .extract(fixture("valid-skill.zip"))
        .unwrap();
    let second = ArchiveExtractor::new(test_limits())
        .extract(fixture("valid-skill.zip"))
        .unwrap();

    assert!(first.root().join("SKILL.md").is_file());
    assert!(second.root().join("SKILL.md").is_file());
    assert_ne!(first.root(), second.root());
}

#[test]
fn failed_extraction_removes_the_workspace_and_it_cannot_be_reused() {
    let workspace = AcquisitionWorkspace::new().unwrap();
    let root = workspace.root().to_path_buf();
    let error = ArchiveExtractor::new(AcquisitionLimits {
        max_expanded_bytes: 8,
        ..test_limits()
    })
    .extract_into(fixture("valid-skill.zip"), &workspace)
    .unwrap_err();

    assert_eq!(error.code, AcquisitionErrorCode::ExpandedSizeLimit);
    assert!(!root.exists());
    assert!(ArchiveExtractor::new(test_limits())
        .extract_into(fixture("valid-skill.zip"), &workspace)
        .is_err());
}
