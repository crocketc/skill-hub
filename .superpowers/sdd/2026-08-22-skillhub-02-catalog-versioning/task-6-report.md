# Task 6 Report

## Changes

- Added typed search models and query/result contracts for FTS5 search hits, field codes, and deterministic duplicate candidates.
- Added incremental `SearchRepository` indexing over the existing `skills_fts` table, with Unicode width/case normalization, BM25 ranking, Chinese substring fallback, and field-code highlighting metadata.
- Added deterministic metadata/content duplicate candidates without embeddings or vector storage.
- Updated the database and storage exports and regenerated the Specta TypeScript bindings.

## Tests

- `cargo test --locked -p skillhub-storage --test search` — passed (4 tests).
- `cargo test --locked -p skillhub-storage --test migrations` — passed (4 tests).
- `cargo test --locked -p skillhub-desktop generate_bindings` — passed.
- `cargo test --locked --workspace` — passed.
- `cargo clippy --locked -p skillhub-core -p skillhub-storage --all-targets --all-features -- -D warnings` — passed.
- `cargo fmt --all` and `git diff --check` — passed.

## Unresolved issues

The search repository currently accepts indexed documents explicitly; wiring catalog/version updates to automatic reindex events is outside this task and belongs to the application integration layer.

## Commit

See the task branch commit after this report is committed.

## Fix round 1

- Added migration 0004 to rebuild the FTS5 table with the trigram tokenizer and added a persistent original display-name table, preserving user-visible capitalization while supporting English and partial Chinese matching.
- Corrected width/case normalization, including full-width characters, and made fallback ranking deterministic from matched field counts instead of a constant zero rank.
- Calculated highlight field codes per normalized query term, including cross-field matches.
- Added BM25-ranked prefiltering before deterministic duplicate metadata/content rules, including candidates with small Markdown changes.
- Expanded tests for original display names, translated descriptions, tags, full-width normalization, cross-field highlights, BM25 ranking, Chinese search, migration upgrade, and modified-content duplicate candidates.

Fix round 1 verification:

- `cargo test --locked -p skillhub-storage --test search` — passed (8 tests).
- `cargo test --locked -p skillhub-storage --test migrations` — passed (4 tests).
- `cargo test --locked --workspace` — passed.
- `cargo clippy --locked --workspace --all-targets --all-features -- -D warnings` — passed.
- `cargo fmt --all` and `git diff --check` — passed.
