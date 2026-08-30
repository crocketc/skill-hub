# Plan09 Task30: AI helpers, online-query assistance, and usage evidence

## Scope

Connect the existing semantic-duplicate, description-translation, online-search-query, and experimental usage-evidence services to `LocalApplicationFacade` without changing the frozen API contract or adding network behavior.

## TDD acceptance cases

- Missing LLM configuration returns structured `llm.not_configured` info for semantic duplicate analysis, description translation, and online-query generation; no runner or write is invoked.
- Configured LLM calls the fixed task service and maps results to the corresponding command result. Online-query generation only returns a suggestion; source fetching remains a separate operation.
- Translation is stored separately from the original description. User revisions require explicit submission and a later generated translation never silently overwrites a user revision.
- Semantic duplicate analysis uses deterministic local search candidates, is read-only, and always marks recommendations as not automatically applied.
- Evidence analysis uses only the local evidence provider, labels output experimental, reports window/threshold/coverage, emits no suggestions when reliable data is absent, and never invents Agent calls.

## Implementation boundary

Only `crates/skillhub-application/src/lib.rs`, its facade integration tests, generated bindings, and this plan are in scope. Existing core services, schemas, storage repositories, and frozen API types are consumed as-is.

## Verification

Run the focused facade tests, `cargo fmt --check`, `cargo check`, Clippy, `cargo test -p skillhub-desktop generate_bindings`, and `git diff --check` before the independent commit.
