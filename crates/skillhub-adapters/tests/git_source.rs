use std::path::PathBuf;

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
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let url = url::Url::from_directory_path(&repository)
        .unwrap()
        .to_string();

    let acquired = GixSourceFetcher::default().fetch(url).await.unwrap();
    assert!(acquired.root().join("Cargo.toml").is_file());
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
    let repository = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
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
