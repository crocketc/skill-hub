use std::path::PathBuf;

use skillhub_adapters::source::{GixSourceFetcher, SourceFetchErrorCode};

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
        .fetch("https://example.com/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
}
