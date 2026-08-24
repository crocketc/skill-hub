use std::fs;

use skillhub_adapters::source::{GixSourceFetcher, SourceFetchErrorCode};
use tempfile::tempdir;

#[tokio::test]
async fn git_fetch_copies_a_local_repository_without_running_hooks() {
    let directory = tempdir().unwrap();
    let repository = directory.path().join("repository");
    gix::init(&repository).unwrap();
    fs::create_dir_all(repository.join(".git/hooks")).unwrap();
    fs::write(repository.join("SKILL.md"), "---\nname: fixture\n---\n").unwrap();
    let marker = repository.join("hook-ran");
    fs::write(
        repository.join(".git/hooks/post-checkout"),
        format!("echo x > {}", marker.display()),
    )
    .unwrap();

    let acquired = GixSourceFetcher::default()
        .fetch(repository.to_string_lossy().to_string())
        .await
        .unwrap();

    assert!(acquired.root().join("SKILL.md").is_file());
    assert!(!marker.exists());
    assert!(!acquired.root().join(".git").exists());
}

#[tokio::test]
async fn git_fetch_rejects_unsupported_remote_schemes() {
    let error = GixSourceFetcher::default()
        .fetch("https://example.com/owner/repository")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::GitFetchFailed);
}
