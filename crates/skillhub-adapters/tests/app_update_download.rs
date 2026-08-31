use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use sha2::{Digest, Sha256};
use skillhub_adapters::app_update::download::{DownloadedUpdate, UpdateDownloadProvider};
use skillhub_adapters::app_update::github_releases::GithubReleaseProvider;
use skillhub_core::{ErrorCode, UpdateArtifact, UpdateManifest, UpdatePlatform};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn artifact(url: String, bytes: &[u8]) -> UpdateArtifact {
    UpdateArtifact {
        target: "windows-x86_64".to_owned(),
        url,
        size: bytes.len() as u64,
        sha256: format!("{:x}", Sha256::digest(bytes)),
        signature: "signed".to_owned(),
    }
}

async fn serve_once(status: &str, headers: &[(&str, String)], body: &'static [u8]) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let url = format!("http://{address}/asset");
    let status = status.to_owned();
    let headers = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).await;
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    url
}

async fn serve_release_with_sidecar_response(
    sidecar_status: &'static str,
    sidecar_body: &'static [u8],
) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let base = format!("http://{address}/");
    let download_base = base.trim_end_matches('/');
    let release = format!(
        r#"{{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "assets":[
            {{"name":"README.txt","browser_download_url":"{download_base}/README.txt","size":12}},
            {{"name":"skillhub-macos-aarch64.dmg","browser_download_url":"{download_base}/skillhub-macos-aarch64.dmg","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=macos-aarch64"}},
            {{"name":"skillhub-windows-x86_64.zip","browser_download_url":"{download_base}/skillhub-windows-x86_64.zip","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=windows-x86_64"}},
            {{"name":"skillhub-windows-x86_64.zip.sig","browser_download_url":"{download_base}/skillhub-windows-x86_64.zip.sig","size":6}}
        ]
    }}"#
    );
    tokio::spawn(async move {
        for (status, body) in [
            ("200 OK", release.into_bytes()),
            (sidecar_status, sidecar_body.to_vec()),
        ] {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request).await;
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        }
    });
    base
}

#[tokio::test]
async fn cancelled_download_removes_partial_file() {
    let body = b"partial download body";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    let progress = Arc::new(Mutex::new(Vec::new()));
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_on_first_chunk = {
        let progress = Arc::clone(&progress);
        let cancel = Arc::clone(&cancel);
        move |bytes| {
            progress.lock().unwrap().push(bytes);
            cancel.store(true, Ordering::SeqCst);
        }
    };

    let result = provider
        .download(
            &artifact(url, body),
            &destination,
            cancel_on_first_chunk,
            cancel,
        )
        .await;

    assert_eq!(
        result.unwrap_err().code,
        ErrorCode::ApplicationUpdateDownloadCancelled
    );
    assert!(!destination.exists());
    assert_eq!(*progress.lock().unwrap(), vec![body.len() as u64]);
}

#[tokio::test]
async fn manifest_missing_current_platform_asset_is_unavailable() {
    let body = br#"{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "published_at":"2026-08-31T00:00:00Z",
        "assets":[
            {"name":"skillhub-macos-aarch64.dmg","browser_download_url":"https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub-macos-aarch64.dmg","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=macos-aarch64;signature=signed"}
        ]
    }"#;
    let api_base = serve_once(
        "200 OK",
        &[("Content-Type", "application/json".to_owned())],
        body,
    )
    .await
    .replace("/asset", "/");
    let provider = GithubReleaseProvider::with_api_base(&api_base).unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateUnavailable);
}

#[tokio::test]
async fn manifest_maps_current_platform_asset_metadata() {
    let body = br#"{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "published_at":"2026-08-31T00:00:00Z",
        "assets":[
            {"name":"skillhub-windows-x86_64.zip","browser_download_url":"https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=windows-x86_64;signature=signed"}
        ]
    }"#;
    let api_base = serve_once(
        "200 OK",
        &[("Content-Type", "application/json".to_owned())],
        body,
    )
    .await
    .replace("/asset", "/");
    let provider = GithubReleaseProvider::with_api_base(&api_base).unwrap();

    let manifest: UpdateManifest = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap();

    assert_eq!(manifest.version, "1.2.3");
    assert_eq!(manifest.notes, "Release notes");
    assert_eq!(manifest.artifacts[0].target, "windows-x86_64");
    assert_eq!(manifest.artifacts[0].size, 4);
    assert_eq!(
        manifest.artifacts[0].sha256,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
    assert_eq!(manifest.artifacts[0].signature, "signed");
}

#[tokio::test]
async fn manifest_skips_unrelated_assets_and_reads_signature_sidecar() {
    let base = serve_release_with_sidecar_response("200 OK", b"signed").await;
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&base, "http://127.0.0.1/").unwrap();

    let manifest = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap();

    assert_eq!(manifest.artifacts.len(), 1);
    assert_eq!(manifest.artifacts[0].target, "windows-x86_64");
    assert_eq!(manifest.artifacts[0].signature, "signed");
}

#[tokio::test]
async fn manifest_propagates_signature_sidecar_rate_limit() {
    let base = serve_release_with_sidecar_response("429 Too Many Requests", b"rate limited").await;
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&base, "http://127.0.0.1/").unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::SourceSearchRateLimited);
}

#[tokio::test]
async fn manifest_propagates_signature_sidecar_server_error() {
    let base = serve_release_with_sidecar_response("500 Internal Server Error", b"error").await;
    let provider =
        GithubReleaseProvider::with_download_base_for_tests(&base, "http://127.0.0.1/").unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateUnavailable);
}

#[tokio::test]
async fn manifest_rejects_non_https_asset_endpoint() {
    let body = br#"{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "assets":[
            {"name":"skillhub-windows-x86_64.zip","browser_download_url":"http://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=windows-x86_64;signature=signed"}
        ]
    }"#;
    let api_base = serve_once(
        "200 OK",
        &[("Content-Type", "application/json".to_owned())],
        body,
    )
    .await
    .replace("/asset", "/");
    let provider = GithubReleaseProvider::with_api_base(&api_base).unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
}

#[tokio::test]
async fn manifest_rejects_missing_hash_metadata() {
    let body = br#"{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "assets":[
            {"name":"skillhub-windows-x86_64.zip","browser_download_url":"https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip","size":4,"label":"target=windows-x86_64;signature=signed"}
        ]
    }"#;
    let api_base = serve_once(
        "200 OK",
        &[("Content-Type", "application/json".to_owned())],
        body,
    )
    .await
    .replace("/asset", "/");
    let provider = GithubReleaseProvider::with_api_base(&api_base).unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
}

#[tokio::test]
async fn manifest_rejects_missing_signature_metadata() {
    let body = br#"{
        "tag_name":"v1.2.3",
        "body":"Release notes",
        "assets":[
            {"name":"skillhub-windows-x86_64.zip","browser_download_url":"https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip","size":4,"digest":"sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08","label":"target=windows-x86_64"}
        ]
    }"#;
    let api_base = serve_once(
        "200 OK",
        &[("Content-Type", "application/json".to_owned())],
        body,
    )
    .await
    .replace("/asset", "/");
    let provider = GithubReleaseProvider::with_api_base(&api_base).unwrap();

    let error = provider
        .fetch_manifest(
            "crocketc/skill-hub",
            &UpdatePlatform {
                target: "windows".to_owned(),
                arch: "x86_64".to_owned(),
            },
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureMissing);
}

#[tokio::test]
async fn response_over_size_limit_removes_partial_file() {
    let body = b"too large";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    let mut artifact = artifact(url, body);
    artifact.size = (body.len() - 1) as u64;

    let error = provider
        .download(
            &artifact,
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
    assert!(!destination.exists());
}

#[tokio::test]
async fn failed_download_keeps_existing_destination_file() {
    let body = b"too large";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    std::fs::write(&destination, b"existing package").unwrap();
    let mut artifact = artifact(url, body);
    artifact.size = (body.len() - 1) as u64;

    let error = provider
        .download(
            &artifact,
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
    assert_eq!(std::fs::read(&destination).unwrap(), b"existing package");
}

#[tokio::test]
async fn cancelled_download_keeps_existing_destination_file() {
    let body = b"partial download body";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    std::fs::write(&destination, b"existing package").unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_on_first_chunk = {
        let cancel = Arc::clone(&cancel);
        move |_| {
            cancel.store(true, Ordering::SeqCst);
        }
    };

    let error = provider
        .download(
            &artifact(url, body),
            &destination,
            cancel_on_first_chunk,
            cancel,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateDownloadCancelled);
    assert_eq!(std::fs::read(&destination).unwrap(), b"existing package");
}

#[tokio::test]
async fn production_download_rejects_localhost_artifact_url() {
    let body = b"test";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::new();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");

    let error = provider
        .download(
            &artifact(url, body),
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
    assert!(!destination.exists());
}

#[tokio::test]
async fn download_rejects_invalid_sha256_metadata() {
    let body = b"test";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    let mut artifact = artifact(url, body);
    artifact.sha256 = "sha256-not-hex".to_owned();

    let error = provider
        .download(
            &artifact,
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
    assert!(!destination.exists());
}

#[tokio::test]
async fn download_rejects_missing_signature_metadata() {
    let body = b"test";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");
    let mut artifact = artifact(url, body);
    artifact.signature.clear();

    let error = provider
        .download(
            &artifact,
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureMissing);
    assert!(!destination.exists());
}

#[tokio::test]
async fn http_429_removes_partial_file() {
    let body = b"rate limited";
    let url = serve_once("429 Too Many Requests", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");

    let error = provider
        .download(
            &artifact(url, body),
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::SourceSearchRateLimited);
    assert!(!destination.exists());
}

#[tokio::test]
async fn successful_download_returns_bytes_hash_and_final_path() {
    let body = b"test";
    let url = serve_once("200 OK", &[], body).await;
    let provider = GithubReleaseProvider::with_download_base_for_tests(
        "http://127.0.0.1:1/",
        "http://127.0.0.1/",
    )
    .unwrap();
    let temp = TempDir::new().unwrap();
    let destination = temp.path().join("skillhub.zip");

    let downloaded: DownloadedUpdate = provider
        .download(
            &artifact(url, body),
            &destination,
            |_| {},
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();

    assert_eq!(downloaded.path, destination);
    assert_eq!(downloaded.bytes, 4);
    assert_eq!(
        downloaded.sha256,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
    );
}
