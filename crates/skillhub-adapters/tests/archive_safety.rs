use std::path::PathBuf;

use skillhub_adapters::source::{
    AcquisitionError, AcquisitionLimits, AcquisitionWorkspace, ArchiveExtractor,
};
use skillhub_core::source::AcquisitionErrorCode as CoreAcquisitionErrorCode;
use tempfile::tempdir;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

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
fn rejects_each_unsafe_zip_path_independently() {
    for (name, expected) in [
        ("../escape.txt", "parent"),
        ("/absolute.txt", "absolute"),
        ("C:/drive.txt", "drive"),
        ("//server/share.txt", "unc"),
        ("NUL", "device_nul"),
        ("CON", "device_con"),
        ("COM1", "device_com1"),
        ("LPT1", "device_lpt1"),
        ("NUL ", "device_trailing_space"),
        ("COM1 ", "device_alias_trailing_space"),
    ] {
        let (_directory, archive) = one_file_zip(name);
        let error = ArchiveExtractor::new(test_limits())
            .extract(archive)
            .unwrap_err();
        assert_eq!(
            error.code.as_str(),
            "source.archive_path_escape",
            "{expected}"
        );
    }
}

#[test]
fn rejects_parent_traversal_fixture() {
    let error = ArchiveExtractor::new(test_limits())
        .extract(fixture("path-traversal.zip"))
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchivePathEscape);
}

#[test]
fn rejects_zip_symbolic_link_without_materializing_it() {
    let error = ArchiveExtractor::new(test_limits())
        .extract(fixture("zip-symlink.zip"))
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchivePathEscape);
}

#[test]
fn rejects_tar_symbolic_link_and_hard_link_independently() {
    for link_type in [tar::EntryType::symlink(), tar::EntryType::hard_link()] {
        let directory = tempdir().unwrap();
        let archive = directory.path().join("links.tar");
        let file = std::fs::File::create(&archive).unwrap();
        let mut builder = tar::Builder::new(file);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(link_type);
        header.set_size(0);
        header.set_cksum();
        builder
            .append_link(&mut header, "escape.txt", "../../outside.txt")
            .unwrap();
        builder.finish().unwrap();

        let error = ArchiveExtractor::new(test_limits())
            .extract(archive)
            .unwrap_err();
        assert_eq!(error.code, CoreAcquisitionErrorCode::ArchivePathEscape);
    }
}

#[test]
fn rejects_tar_link_escape_fixture() {
    let error = ArchiveExtractor::new(test_limits())
        .extract(fixture("link-escape.tar"))
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchivePathEscape);
}

#[test]
fn rejects_entry_count_before_zip_archive_is_constructed() {
    let error = ArchiveExtractor::new(test_limits())
        .extract(fixture("entry-count-limit.zip"))
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveEntryLimit);
}

#[test]
fn rejects_truncated_zip_tail_without_panicking() {
    let directory = tempdir().unwrap();
    for bytes in [b"PK\x05\x06".as_slice(), b"PK\x05\x06\0\0\0\0".as_slice()] {
        let archive = directory
            .path()
            .join(format!("truncated-{}.zip", bytes.len()));
        std::fs::write(&archive, bytes).unwrap();
        let error = ArchiveExtractor::new(test_limits())
            .extract(&archive)
            .unwrap_err();
        assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFormatInvalid);
    }
}

#[test]
fn rejects_zip32_count_that_is_smaller_than_the_real_central_directory() {
    let directory = tempdir().unwrap();
    let archive = zip_with_files(&directory, 2);
    let mut bytes = std::fs::read(&archive).unwrap();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    bytes[eocd + 10] = 1;
    bytes[eocd + 11] = 0;
    std::fs::write(&archive, bytes).unwrap();

    let error = ArchiveExtractor::new(test_limits())
        .extract(archive)
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFormatInvalid);
}

#[test]
fn rejects_truncated_central_directory_file_header() {
    let directory = tempdir().unwrap();
    let archive = zip_with_files(&directory, 1);
    let mut bytes = std::fs::read(&archive).unwrap();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    let central_size = u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap());
    bytes[eocd + 12..eocd + 16].copy_from_slice(&(central_size - 1).to_le_bytes());
    std::fs::write(&archive, bytes).unwrap();

    let error = ArchiveExtractor::new(test_limits())
        .extract(archive)
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFormatInvalid);
}

#[test]
fn extracts_a_valid_zip64_archive() {
    let directory = tempdir().unwrap();
    let archive = zip64_archive(&directory);
    let acquired = ArchiveExtractor::new(test_limits())
        .extract(archive)
        .unwrap();
    assert!(acquired.root.join("file-0.txt").is_file());
    assert_eq!(acquired.entry_count(), 1);
}

#[test]
fn accepts_zip64_when_size_or_offset_sentinel_triggers_zip64_parsing() {
    for field in ["size", "offset"] {
        let directory = tempdir().unwrap();
        let archive = zip64_archive_with_sentinel(&directory, field);
        let acquired = ArchiveExtractor::new(test_limits())
            .extract(archive)
            .unwrap();
        assert!(acquired.root.join("file-0.txt").is_file(), "{field}");
    }
}

#[test]
fn rejects_zip64_count_size_offset_and_locator_mismatches() {
    for field in ["count", "size", "offset", "locator"] {
        let directory = tempdir().unwrap();
        let archive = zip64_archive(&directory);
        let mut bytes = std::fs::read(&archive).unwrap();
        let eocd = bytes
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .unwrap();
        let locator = eocd - 20;
        let zip64 =
            u64::from_le_bytes(bytes[locator + 8..locator + 16].try_into().unwrap()) as usize;
        match field {
            "count" => bytes[zip64 + 32..zip64 + 40].copy_from_slice(&2_u64.to_le_bytes()),
            "size" => bytes[zip64 + 40..zip64 + 48].copy_from_slice(&1_u64.to_le_bytes()),
            "offset" => bytes[zip64 + 48..zip64 + 56].copy_from_slice(&1_u64.to_le_bytes()),
            "locator" => bytes[locator + 8..locator + 16].copy_from_slice(&0_u64.to_le_bytes()),
            _ => unreachable!(),
        }
        std::fs::write(&archive, bytes).unwrap();

        let error = ArchiveExtractor::new(test_limits())
            .extract(archive)
            .unwrap_err();
        assert_eq!(
            error.code,
            CoreAcquisitionErrorCode::ArchiveFormatInvalid,
            "{field}"
        );
    }
}

#[test]
fn rejects_forged_eocd_signatures_inside_a_valid_comment() {
    let directory = tempdir().unwrap();
    let archive = directory.path().join("comment-signature.zip");
    let file = std::fs::File::create(&archive).unwrap();
    let mut writer = ZipWriter::new(file);
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut writer, b"valid").unwrap();
    let mut comment = vec![0_u8; 22];
    comment[..4].copy_from_slice(b"PK\x05\x06");
    comment[10] = 0xff;
    comment[11] = 0xff;
    writer.set_raw_comment(comment.into_boxed_slice());
    writer.finish().unwrap();

    let error = ArchiveExtractor::new(test_limits())
        .extract(archive)
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFormatInvalid);
}

#[test]
fn rejects_eocd_with_comment_length_that_does_not_reach_eof() {
    let directory = tempdir().unwrap();
    let archive = directory.path().join("truncated-comment.zip");
    let file = std::fs::File::create(&archive).unwrap();
    let mut writer = ZipWriter::new(file);
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut writer, b"valid").unwrap();
    writer.set_comment("comment");
    writer.finish().unwrap();
    let mut bytes = std::fs::read(&archive).unwrap();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    bytes[eocd + 20] = 0xff;
    bytes[eocd + 21] = 0xff;
    std::fs::write(&archive, bytes).unwrap();

    let error = ArchiveExtractor::new(test_limits())
        .extract(archive)
        .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFormatInvalid);
}

#[test]
fn expanded_size_limit_is_enforced_before_disk_exhaustion() {
    let error = ArchiveExtractor::new(AcquisitionLimits {
        max_expanded_bytes: 8,
        ..test_limits()
    })
    .extract(fixture("valid-skill.zip"))
    .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ExpandedSizeLimit);
    assert_eq!(error.code.as_str(), "source.expanded_size_limit");
}

#[test]
fn per_file_limit_is_checked_from_archive_metadata() {
    let error = ArchiveExtractor::new(AcquisitionLimits {
        max_file_bytes: 8,
        ..test_limits()
    })
    .extract(fixture("valid-skill.zip"))
    .unwrap_err();
    assert_eq!(error.code, CoreAcquisitionErrorCode::ArchiveFileSizeLimit);
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

    assert_eq!(error.code, CoreAcquisitionErrorCode::ExpandedSizeLimit);
    assert!(!root.exists());
    assert!(ArchiveExtractor::new(test_limits())
        .extract_into(fixture("valid-skill.zip"), &workspace)
        .is_err());
}

#[test]
fn cleanup_failure_is_structured_instead_of_discarded() {
    let mut workspace = AcquisitionWorkspace::new().unwrap();
    workspace.cleanup().unwrap();
    let cleanup = workspace.cleanup().unwrap_err();
    let error = AcquisitionError::new(
        CoreAcquisitionErrorCode::ExpandedSizeLimit,
        "archive exceeded the expanded-size limit",
    )
    .with_cleanup_failure(&cleanup);

    let failure = error.cleanup_failure.as_ref().unwrap();
    assert_eq!(failure.code, CoreAcquisitionErrorCode::WorkspaceUnavailable);
    assert!(failure.message.contains("already been consumed"));
}

fn one_file_zip(name: &str) -> (tempfile::TempDir, PathBuf) {
    let directory = tempdir().unwrap();
    let path = directory.path().join("boundary.zip");
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = ZipWriter::new(file);
    writer
        .start_file(name, SimpleFileOptions::default())
        .unwrap();
    std::io::Write::write_all(&mut writer, b"x").unwrap();
    writer.finish().unwrap();
    (directory, path)
}

fn zip_with_files(directory: &tempfile::TempDir, count: usize) -> PathBuf {
    let path = directory.path().join("central-directory.zip");
    let file = std::fs::File::create(&path).unwrap();
    let mut writer = ZipWriter::new(file);
    for index in 0..count {
        writer
            .start_file(format!("file-{index}.txt"), SimpleFileOptions::default())
            .unwrap();
        std::io::Write::write_all(&mut writer, b"x").unwrap();
    }
    writer.finish().unwrap();
    path
}

fn zip64_archive(directory: &tempfile::TempDir) -> PathBuf {
    let zip32 = zip_with_files(directory, 1);
    let bytes = std::fs::read(&zip32).unwrap();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    let central_size = u32::from_le_bytes(bytes[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
    let central_offset = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
    let mut output = bytes[..eocd].to_vec();
    let zip64_offset = output.len() as u64;
    output.extend_from_slice(b"PK\x06\x06");
    output.extend_from_slice(&44_u64.to_le_bytes());
    output.extend_from_slice(&45_u16.to_le_bytes());
    output.extend_from_slice(&45_u16.to_le_bytes());
    output.extend_from_slice(&0_u32.to_le_bytes());
    output.extend_from_slice(&0_u32.to_le_bytes());
    output.extend_from_slice(&1_u64.to_le_bytes());
    output.extend_from_slice(&1_u64.to_le_bytes());
    output.extend_from_slice(&central_size.to_le_bytes());
    output.extend_from_slice(&central_offset.to_le_bytes());
    output.extend_from_slice(b"PK\x06\x07");
    output.extend_from_slice(&0_u32.to_le_bytes());
    output.extend_from_slice(&zip64_offset.to_le_bytes());
    output.extend_from_slice(&1_u32.to_le_bytes());
    output.extend_from_slice(b"PK\x05\x06");
    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&u16::MAX.to_le_bytes());
    output.extend_from_slice(&u16::MAX.to_le_bytes());
    output.extend_from_slice(&u32::MAX.to_le_bytes());
    output.extend_from_slice(&u32::MAX.to_le_bytes());
    output.extend_from_slice(&0_u16.to_le_bytes());
    std::fs::write(&zip32, output).unwrap();
    zip32
}

fn zip64_archive_with_sentinel(directory: &tempfile::TempDir, field: &str) -> PathBuf {
    let archive = zip64_archive(directory);
    let mut bytes = std::fs::read(&archive).unwrap();
    let eocd = bytes
        .windows(4)
        .rposition(|window| window == b"PK\x05\x06")
        .unwrap();
    match field {
        "size" => bytes[eocd + 12..eocd + 16].copy_from_slice(&u32::MAX.to_le_bytes()),
        "offset" => bytes[eocd + 16..eocd + 20].copy_from_slice(&u32::MAX.to_le_bytes()),
        _ => unreachable!(),
    }
    std::fs::write(&archive, bytes).unwrap();
    archive
}
