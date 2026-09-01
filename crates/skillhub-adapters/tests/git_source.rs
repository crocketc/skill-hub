use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use skillhub_adapters::source::{AcquisitionLimits, GixSourceFetcher, SourceFetchErrorCode};

#[tokio::test]
async fn git_fetch_materializes_selected_head_tree_not_worktree_files() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");

    let acquired = GixSourceFetcher::default()
        .fetch(repository.to_string_lossy().to_string())
        .await
        .unwrap();

    assert!(acquired.root().join("Cargo.toml").is_file());
    assert!(!acquired.root().join("target").exists());
    assert!(!acquired.root().join(".git").exists());
}

#[tokio::test]
async fn git_fetch_accepts_a_file_url_and_reads_the_remote_tree_without_hooks() {
    let fixture = temporary_git_repository();
    let url = url::Url::from_directory_path(fixture.path())
        .unwrap()
        .to_string();

    let acquired = GixSourceFetcher::default().fetch(url).await.unwrap();
    assert!(acquired.root().join("SKILL.md").is_file());
}

fn temporary_git_repository() -> tempfile::TempDir {
    temporary_git_repository_with_content(b"# fixture\n")
}

fn temporary_git_repository_with_content(content: &[u8]) -> tempfile::TempDir {
    let fixture = tempfile::tempdir().unwrap();
    run_git(fixture.path(), &["init"]);
    run_git(
        fixture.path(),
        &["config", "user.email", "skillhub-tests@example.com"],
    );
    run_git(fixture.path(), &["config", "user.name", "SkillHub Tests"]);
    fs::write(fixture.path().join("SKILL.md"), content).unwrap();
    run_git(fixture.path(), &["add", "SKILL.md"]);
    run_git(
        fixture.path(),
        &["commit", "--no-gpg-sign", "--no-verify", "-m", "fixture"],
    );
    fixture
}

fn run_git(repository: &Path, args: &[&str]) {
    let output = Command::new("git")
        .current_dir(repository)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("failed to invoke git for fixture: {error}"));
    assert!(
        output.status.success(),
        "git fixture command {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn git_fetch_rejects_unsupported_remote_schemes() {
    let error = GixSourceFetcher::default()
        .fetch("http://example.com/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
}

#[tokio::test]
async fn git_fetch_rejects_unpinned_ssh_and_git_transports() {
    for source in [
        "ssh://example.com/owner/repository",
        "git://example.com/owner/repository",
    ] {
        let error = GixSourceFetcher::default().fetch(source).await.unwrap_err();
        assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
        assert!(error.message.contains("disabled"));
    }
}

#[tokio::test]
async fn git_tree_limits_apply_across_nested_directories() {
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let error = GixSourceFetcher::new(AcquisitionLimits {
        max_entries: 1,
        ..AcquisitionLimits::default()
    })
    .fetch(repository.to_string_lossy().to_string())
    .await
    .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
}

#[tokio::test]
async fn git_clone_download_is_bounded_before_tree_materialization() {
    let repository = temporary_git_repository_with_content(b"0123456789abcdef");
    let url = url::Url::from_directory_path(&repository)
        .unwrap()
        .to_string();
    let error = GixSourceFetcher::new(AcquisitionLimits {
        max_expanded_bytes: 1,
        ..AcquisitionLimits::default()
    })
    .fetch(url)
    .await
    .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::DownloadSizeLimit);
    assert!(error.message.contains("Git download"));
}

#[tokio::test]
async fn git_https_fetch_rejects_private_connection_addresses() {
    let error = GixSourceFetcher::default()
        .fetch("https://127.0.0.1/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::RedirectBlocked);
}

#[tokio::test]
async fn git_https_fetch_rejects_private_dns_names() {
    let error = GixSourceFetcher::default()
        .fetch("https://localhost/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::RedirectBlocked);
}

#[tokio::test]
async fn git_https_remote_has_an_explicit_safe_protocol_boundary() {
    let error = GixSourceFetcher::default()
        .fetch("https://example.com/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
    assert!(error.message.contains("canonical GitHub/GitLab"));
}
