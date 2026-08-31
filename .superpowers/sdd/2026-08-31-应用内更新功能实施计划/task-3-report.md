# Task 3 Report — Application Updates

## Changed files

- `crates/skillhub-application/src/update_service.rs`
- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade_update.rs`
- `crates/skillhub-storage/src/database/app_update_repository.rs`
- `crates/skillhub-storage/src/database/mod.rs`
- `crates/skillhub-storage/src/lib.rs`
- `crates/skillhub-storage/tests/app_update_repository.rs`

## Implementation summary

- Added `UpdateService` for application update orchestration: policy-aware checks, 24-hour metadata cache, download staging plans, pending install metadata, install-blocked state, successful-launch cleanup, and one-shot startup rollback marker consumption.
- Extended `ApplicationUpdateRepository` to persist policy, last-check metadata, pending install version, staging path, rollback point, state, and attempts through the existing `settings` table.
- Wired existing facade update commands to the service while preserving `OpenOfficialRelease` fallback behavior and without implementing platform installation/restart or UI.
- Added tests for disabled policy avoiding network access, 24-hour cache reuse, queryable prepared download metadata, install failure preserving current version metadata, structured network-disabled errors, one-shot rollback, marker clearing, and untouched skill catalog data.

## Verification

- RED before implementation:
  - `cargo test -p skillhub-application --test facade_update startup_failure_rolls_back_once_without_touching_skill_data`
  - Result: failed as expected with missing `RollbackState`, `rollback_if_unhealthy`, and `get_pending`.
- Final verification:
  - `cargo test -p skillhub-application --test facade_update startup_failure_rolls_back_once_without_touching_skill_data`
  - Result: passed, 1 passed, 0 failed.
  - `cargo test -p skillhub-application --test facade_update`
  - Result: passed, 6 passed, 0 failed.
  - `cargo test -p skillhub-storage --test app_update_repository`
  - Result: passed, 2 passed, 0 failed.
  - `cargo clippy -p skillhub-application -p skillhub-storage --all-targets --all-features --locked -- -D warnings`
  - Result: passed.
  - `cargo test -p skillhub-application --test facade_online`
  - Result: passed, 5 passed, 0 failed.
  - `git diff --check`
  - Result: passed; Git reported existing CRLF normalization warnings for touched Rust files.

## Commit

- Commit hash: final commit hash is reported in the task reply because a commit cannot contain its own final hash in a tracked file without changing that hash.
- Commit message: `feat: orchestrate application updates and rollback state`

## Concerns

- Windows test linking prints `linker stdout` warnings while tests still pass; clippy is clean with `-D warnings`.
- Platform installer/restart remains intentionally blocked with `ErrorCode::ApplicationUpdateInstallBlocked` for a later task.

## Fix Round 1

### Review finding

- `DownloadApplicationUpdate` was calling the Task 2 adapter download path and writing package bytes into the staging location. Task 3 only owns metadata orchestration and download preparation, so real package download belongs to a later task.
- Rollback coverage only proved the catalog row survived; it now also snapshots isolated central Skill library and user Skill directories before and after rollback.

### Changes

- `UpdateService::download` now validates the pending update and artifact identity, confirms a staging path is recorded, and returns `ErrorCode::ApplicationUpdateInstallBlocked` without invoking `GithubReleaseProvider::download` or writing package bytes.
- Added `download_application_update_is_metadata_only_and_does_not_write_package_file`, which uses a localhost-download-capable provider and proves the command is blocked, no staging file is created, and pending update state remains queryable as `ReadyToInstall`.
- Enhanced `startup_failure_rolls_back_once_without_touching_skill_data` with byte-for-byte snapshots of temporary central library and user Skill paths.

### Verification

- RED before fix:
  - `cargo test -p skillhub-application --test facade_update download_application_update_is_metadata_only_and_does_not_write_package_file`
  - Result: failed as expected because `DownloadApplicationUpdate` returned `Ok(DownloadedApplicationUpdate)` and followed the real download path.
- Final verification:
  - `cargo test -p skillhub-application --test facade_update`
  - Result: passed, 7 passed, 0 failed.
  - `cargo test -p skillhub-storage --test app_update_repository`
  - Result: passed, 2 passed, 0 failed.
  - `cargo clippy -p skillhub-application -p skillhub-storage --all-targets --all-features --locked -- -D warnings`
  - Result: passed.
  - `git diff --check`
  - Result: passed; Git reported CRLF normalization warnings for touched Rust files.

### Concerns

- Windows test linking still prints `linker stdout` warnings while tests pass.
- The Task 2 `GithubReleaseProvider` download implementation remains intact for a later task; Task 3 facade now deliberately blocks the command before calling it.
