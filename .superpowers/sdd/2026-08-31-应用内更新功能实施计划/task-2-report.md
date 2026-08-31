# Task 2 Report — 官方清单、资产下载与临时包管理

## Changed files

- `crates/skillhub-adapters/src/app_update/download.rs`
- `crates/skillhub-adapters/src/app_update/mod.rs`
- `crates/skillhub-adapters/src/app_update/github_releases.rs`
- `crates/skillhub-adapters/tests/app_update_download.rs`
- `crates/skillhub-core/src/app_update/update.rs`
- `crates/skillhub-core/src/app_update/mod.rs`
- `crates/skillhub-core/src/error.rs`
- `crates/skillhub-core/src/lib.rs`

## Summary

- Added `UpdateDownloadProvider` and `DownloadedUpdate` in the adapter app-update download module.
- Added streaming reqwest artifact downloads with cumulative byte progress, cancellation, size/hash validation, 429 handling, and cleanup of partial temporary/destination files.
- Added GitHub release-to-`UpdateManifest` mapping with required platform selection and rejection of missing hash/signature metadata.
- Reused core official artifact URL validation by exposing it from `skillhub-core`.
- Added the missing `ApplicationUpdateDownloadCancelled` core error code required by the Task 2 brief.

## TDD / verification

- RED: `cargo test -p skillhub-adapters --test app_update_download cancelled_download_removes_partial_file` failed before implementation because `download` module, provider methods, and `ApplicationUpdateDownloadCancelled` were missing.
- GREEN: `cargo test -p skillhub-adapters --test app_update_download cancelled_download_removes_partial_file` passed, 1 passed, 0 failed.
- `cargo test -p skillhub-adapters --test app_update_download` passed, 9 passed, 0 failed.
- `cargo test -p skillhub-adapters --lib app_update` passed, 2 passed, 0 failed.
- `cargo fmt --all -- --check` passed.
- `git diff --check` passed; Git emitted only CRLF normalization warnings on Windows.

## Concerns

- The brief listed adapter files only, but the required cancellation code did not exist in `skillhub-core`, and the official artifact URL validator was private. I made the smallest core changes needed to satisfy the frozen contract and avoid duplicating the URL rule in adapters.
- Manifest asset metadata mapping currently expects GitHub asset `digest` in `sha256:<hex>` form and semicolon-delimited `label` metadata containing `target=...;signature=...`; release workflow alignment should confirm it publishes exactly that shape.

## Commit

- `9e28ce9 fix: harden update artifact download mapping`

## Revision 2 — fix pass

This round kept the Task 2 boundary on the adapter side and tightened the manifest/download edge cases that the review called out.

### Updated files in this round

- `crates/skillhub-adapters/src/app_update/download.rs`
- `crates/skillhub-adapters/src/app_update/github_releases.rs`
- `crates/skillhub-adapters/tests/app_update_download.rs`

### What changed

- Skipped unrelated release assets while mapping the current platform updater artifact.
- Read the matching `.sig` sidecar content when the signature was not embedded in release metadata.
- Kept failed and cancelled downloads confined to the temporary file created by this download attempt.
- Preserved any pre-existing destination file on download failure or cancellation.
- Kept production download validation on the official artifact URL path, with localhost only available through the test-only download provider.
- Separated SHA-256 integrity failures from missing-signature failures in download metadata validation.

### Verification

- `cargo test -p skillhub-adapters --test app_update_download` passed, 15 passed, 0 failed.
- `cargo test -p skillhub-adapters --lib app_update` passed, 2 passed, 0 failed.
- `cargo fmt --all -- --check` passed.
- `git diff --check` passed with only CRLF normalization warnings from Git.

### Concerns

- No functional blocker remains in Task 2 from this round.
- The workspace still emits linker warnings during the test build on Windows, but they are not test failures.

## Revision 3 — signature sidecar error semantics

This round narrowed the `fetch_signature_sidecar` error mapping so that sidecar lookup keeps real missing-signature cases distinct from transient transport or server failures.

### Updated files in this round

- `crates/skillhub-adapters/src/app_update/github_releases.rs`
- `crates/skillhub-adapters/tests/app_update_download.rs`

### What changed

- Kept sidecar `404` responses mapped to `ApplicationUpdateSignatureMissing`.
- Mapped sidecar `429` responses to `SourceSearchRateLimited`.
- Mapped other non-success sidecar responses to `ApplicationUpdateUnavailable` with a retry action.
- Added regression tests for sidecar `429 Too Many Requests` and `500 Internal Server Error`.

### Verification

- `cargo test -p skillhub-adapters --test app_update_download manifest_propagates_signature_sidecar_rate_limit -- --nocapture` passed.
- `cargo test -p skillhub-adapters --test app_update_download manifest_propagates_signature_sidecar_server_error -- --nocapture` passed.
- `cargo test -p skillhub-adapters --test app_update_download` passed, 17 passed, 0 failed.
- `cargo test -p skillhub-adapters --lib app_update` passed, 2 passed, 0 failed.
- `cargo fmt --all -- --check` passed.
- `git diff --check` passed with only CRLF normalization warnings from Git.

### Concerns

- No additional concerns from this round.

### Commit

- `33d0fc2 fix: preserve signature sidecar error semantics`
