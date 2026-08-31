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

- Pending at report creation time.
