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
