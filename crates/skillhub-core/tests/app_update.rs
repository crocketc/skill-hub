use skillhub_core::{
    select_artifact, verify_artifact, verify_downloaded_artifact, AppCommand, AppQuery,
    AppQueryResult, BuildTrust, CheckApplicationUpdate, DownloadApplicationUpdate, ErrorCode,
    InstallApplicationUpdate, OpenOfficialRelease, PrepareApplicationUpdate,
    RollbackApplicationUpdate, SetApplicationUpdatePolicy, UpdateArtifact, UpdateManifest,
    UpdatePlatform, UpdateSignaturePublicKey, UpdateState, DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY,
};

const TEST_TAURI_PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const TEST_TAURI_SIGNATURE: &str = "untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==";

fn test_public_key() -> UpdateSignaturePublicKey {
    UpdateSignaturePublicKey {
        value: TEST_TAURI_PUBLIC_KEY.to_owned(),
    }
}

fn fixture_artifact(target: &str, size: u64, sha256: String, signature: String) -> UpdateArtifact {
    UpdateArtifact {
        target: target.to_owned(),
        url: "https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip"
            .to_owned(),
        size,
        sha256,
        signature,
    }
}

fn signed_test_artifact() -> UpdateArtifact {
    fixture_artifact(
        "windows-x86_64",
        4,
        "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08".to_owned(),
        TEST_TAURI_SIGNATURE.to_owned(),
    )
}

#[test]
fn application_update_contracts_are_typed_and_manual_by_default() {
    let query = AppQuery::CheckApplicationUpdate(CheckApplicationUpdate {
        current_version: "0.1.0".to_owned(),
        repository: "crocketc/skill-hub".to_owned(),
        build_trust: BuildTrust::WindowsUnsigned,
    });
    assert_eq!(
        serde_json::to_value(query).unwrap()["type"],
        "check_application_update"
    );

    let open = AppCommand::OpenOfficialRelease(OpenOfficialRelease {
        release_url: "https://github.com/crocketc/skill-hub/releases".to_owned(),
    });
    assert_eq!(
        serde_json::to_value(open).unwrap()["type"],
        "open_official_release"
    );

    let policy = AppCommand::SetApplicationUpdatePolicy(SetApplicationUpdatePolicy {
        enabled: true,
        check_on_startup: false,
    });
    assert_eq!(
        serde_json::to_value(policy).unwrap()["type"],
        "set_application_update_policy"
    );
}

#[test]
fn application_update_signed_commands_keep_stable_wire_shapes() {
    let manifest = UpdateManifest {
        version: "1.2.3".to_owned(),
        notes: "Security update".to_owned(),
        published_at: Some("2026-08-31T00:00:00Z".to_owned()),
        artifacts: vec![fixture_artifact(
            "windows-x86_64",
            3,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
            TEST_TAURI_SIGNATURE.to_owned(),
        )],
    };
    let platform = UpdatePlatform {
        target: "windows".to_owned(),
        arch: "x86_64".to_owned(),
    };
    let artifact = manifest.artifacts[0].clone();
    let commands = [
        AppCommand::PrepareApplicationUpdate(PrepareApplicationUpdate {
            current_version: "1.2.2".to_owned(),
            manifest,
            platform,
        }),
        AppCommand::DownloadApplicationUpdate(DownloadApplicationUpdate { artifact }),
        AppCommand::InstallApplicationUpdate(InstallApplicationUpdate),
        AppCommand::RollbackApplicationUpdate(RollbackApplicationUpdate),
    ];
    let expected = [
        "prepare_application_update",
        "download_application_update",
        "install_application_update",
        "rollback_application_update",
    ];
    for (command, expected_type) in commands.into_iter().zip(expected) {
        assert_eq!(
            serde_json::to_value(command).unwrap()["type"],
            expected_type
        );
    }
}

#[test]
fn application_update_state_query_result_keeps_stable_wire_shape() {
    let result = AppQueryResult::ApplicationUpdateState(UpdateState::Checking);

    let json = serde_json::to_value(result).unwrap();

    assert_eq!(json["type"], "application_update_state");
    assert_eq!(json["payload"], "checking");
}

#[test]
fn update_artifact_size_uses_lossless_string_wire_shape() {
    let artifact = fixture_artifact(
        "windows-x86_64",
        9007199254740993,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
        TEST_TAURI_SIGNATURE.to_owned(),
    );

    let json = serde_json::to_value(&artifact).unwrap();
    let decoded: UpdateArtifact = serde_json::from_value(json.clone()).unwrap();

    assert_eq!(json["size"], "9007199254740993");
    assert_eq!(decoded.size, 9007199254740993);
}

#[test]
fn semver_comparison_treats_release_as_newer_than_prerelease() {
    assert_eq!(
        skillhub_core::version_is_newer("1.0.0-beta.1", "1.0.0"),
        Some(true)
    );
    assert_eq!(
        skillhub_core::version_is_newer("1.0.0", "1.0.1"),
        Some(true)
    );
    assert_eq!(
        skillhub_core::version_is_newer("1.0.1", "1.0.0"),
        Some(false)
    );
}

#[test]
fn select_artifact_uses_exact_platform_architecture() {
    let manifest = UpdateManifest {
        version: "v1.3.0".to_owned(),
        notes: "Release notes".to_owned(),
        published_at: None,
        artifacts: vec![
            fixture_artifact(
                "windows-aarch64",
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
                TEST_TAURI_SIGNATURE.to_owned(),
            ),
            fixture_artifact(
                "windows-x86_64",
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
                TEST_TAURI_SIGNATURE.to_owned(),
            ),
        ],
    };
    let selected = select_artifact(
        &manifest,
        &UpdatePlatform {
            target: "windows".to_owned(),
            arch: "x86_64".to_owned(),
        },
    )
    .unwrap();

    assert_eq!(selected.target, "windows-x86_64");
}

#[test]
fn select_artifact_rejects_missing_exact_platform_architecture() {
    let manifest = UpdateManifest {
        version: "1.3.0".to_owned(),
        notes: "Release notes".to_owned(),
        published_at: None,
        artifacts: vec![fixture_artifact(
            "windows-aarch64",
            3,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".to_owned(),
            TEST_TAURI_SIGNATURE.to_owned(),
        )],
    };

    let error = select_artifact(
        &manifest,
        &UpdatePlatform {
            target: "windows".to_owned(),
            arch: "x86_64".to_owned(),
        },
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateUnavailable);
}

#[test]
fn artifact_verification_accepts_correct_size_hash_tauri_signature_and_official_url() {
    let artifact = signed_test_artifact();

    verify_artifact(b"test", &artifact, &test_public_key()).unwrap();
}

#[test]
fn artifact_verification_rejects_forged_tauri_signature() {
    let mut artifact = signed_test_artifact();
    artifact.signature = TEST_TAURI_SIGNATURE.replace("SSbXxwA=", "SSbXxwB=");

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureInvalid);
}

#[test]
fn artifact_verification_rejects_size_mismatch() {
    let mut artifact = signed_test_artifact();
    artifact.size = 5;

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
}

#[test]
fn artifact_verification_rejects_hash_mismatch() {
    let artifact = fixture_artifact(
        "windows-x86_64",
        4,
        "00".repeat(32),
        TEST_TAURI_SIGNATURE.to_owned(),
    );
    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();
    assert_eq!(error.code, ErrorCode::ApplicationUpdateIntegrityFailed);
}

#[test]
fn artifact_verification_rejects_empty_signature() {
    let mut artifact = signed_test_artifact();
    artifact.signature.clear();

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureMissing);
}

#[test]
fn downloaded_artifact_verification_accepts_valid_signature_without_official_url() {
    let mut artifact = signed_test_artifact();
    artifact.url = "http://127.0.0.1:9/skillhub-update.zip".to_owned();

    verify_downloaded_artifact(b"test", &artifact, &test_public_key()).unwrap();
}

#[test]
fn downloaded_artifact_verification_rejects_forged_signature() {
    let mut artifact = signed_test_artifact();
    artifact.url = "http://127.0.0.1:9/skillhub-update.zip".to_owned();
    artifact.signature = TEST_TAURI_SIGNATURE.replace("SSbXxwA=", "SSbXxwB=");

    let error = verify_downloaded_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateSignatureInvalid);
}

#[test]
fn default_signature_public_key_verifies_signed_test_artifact() {
    let public_key = UpdateSignaturePublicKey {
        value: DEFAULT_UPDATE_SIGNATURE_PUBLIC_KEY.to_owned(),
    };

    verify_artifact(b"test", &signed_test_artifact(), &public_key).unwrap();
}

#[test]
fn artifact_verification_rejects_non_https_url() {
    let mut artifact = signed_test_artifact();
    artifact.url =
        "http://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip".to_owned();

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
}

#[test]
fn artifact_verification_rejects_unofficial_https_url() {
    let mut artifact = signed_test_artifact();
    artifact.url = "https://updates.example.invalid/skillhub.zip".to_owned();

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
}

#[test]
fn artifact_verification_rejects_official_url_with_extra_path_segments() {
    let mut artifact = signed_test_artifact();
    artifact.url =
        "https://github.com/crocketc/skill-hub/releases/download/v1.2.3/skillhub.zip/extra"
            .to_owned();

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
}

#[test]
fn artifact_verification_rejects_invalid_url() {
    let mut artifact = signed_test_artifact();
    artifact.url = "not a url".to_owned();

    let error = verify_artifact(b"test", &artifact, &test_public_key()).unwrap_err();

    assert_eq!(error.code, ErrorCode::ApplicationUpdateInvalidArtifactUrl);
}
