use skillhub_adapters::invocation::{resolve_invocation, InvocationPlatform, InvocationSource};
use skillhub_core::catalog::CallPolicy;

#[test]
fn claude_frontmatter_defaults_to_model_and_user() {
    let result = resolve_invocation(InvocationPlatform::ClaudeCode, "---\nname: demo\n---", None);

    assert_eq!(result.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(result.source, InvocationSource::Default);
    assert_eq!(result.field, None);
}

#[test]
fn claude_frontmatter_maps_model_and_user_controls() {
    let user_only = resolve_invocation(
        InvocationPlatform::ClaudeCode,
        "---\ndisable-model-invocation: true\n---",
        None,
    );
    assert_eq!(user_only.policy, CallPolicy::ManualOnly);
    assert_eq!(user_only.source, InvocationSource::Explicit);
    assert_eq!(user_only.field.as_deref(), Some("disable-model-invocation"));

    let model_only = resolve_invocation(
        InvocationPlatform::ClaudeCode,
        "---\nuser-invocable: false\n---",
        None,
    );
    assert_eq!(model_only.policy, CallPolicy::ModelOnly);

    let disabled = resolve_invocation(
        InvocationPlatform::ClaudeCode,
        "---\ndisable-model-invocation: true\nuser-invocable: false\n---",
        None,
    );
    assert_eq!(disabled.policy, CallPolicy::Disabled);
}

#[test]
fn aliases_are_supported_for_kimi_and_cursor() {
    let kimi = resolve_invocation(
        InvocationPlatform::KimiCode,
        "---\ndisableModelInvocation: true\n---",
        None,
    );
    assert_eq!(kimi.policy, CallPolicy::ManualOnly);

    let cursor = resolve_invocation(
        InvocationPlatform::Cursor,
        "---\ndisable_model_invocation: true\n---",
        None,
    );
    assert_eq!(cursor.policy, CallPolicy::ManualOnly);
}

#[test]
fn codex_companion_file_controls_implicit_model_invocation() {
    let result = resolve_invocation(
        InvocationPlatform::Codex,
        "",
        Some("policy:\n  allow_implicit_invocation: false\n"),
    );

    assert_eq!(result.policy, CallPolicy::ManualOnly);
    assert_eq!(result.source, InvocationSource::Explicit);
    assert_eq!(
        result.field.as_deref(),
        Some("policy.allow_implicit_invocation")
    );
}

#[test]
fn opencode_slash_and_autoinvoke_map_to_actor_sets() {
    let model_only =
        resolve_invocation(InvocationPlatform::OpenCode, "---\nslash: false\n---", None);
    assert_eq!(model_only.policy, CallPolicy::ModelOnly);

    let user_only = resolve_invocation(
        InvocationPlatform::OpenCode,
        "---\nmetadata:\n  opencode:\n    autoinvoke: false\n---",
        None,
    );
    assert_eq!(user_only.policy, CallPolicy::ManualOnly);

    let disabled = resolve_invocation(
        InvocationPlatform::OpenCode,
        "---\nslash: false\nmetadata:\n  opencode:\n    autoinvoke: false\n---",
        None,
    );
    assert_eq!(disabled.policy, CallPolicy::Disabled);
}

#[test]
fn unsupported_platforms_keep_both_actors_but_mark_evidence_unknown() {
    let result = resolve_invocation(InvocationPlatform::GeminiCli, "---\nname: demo\n---", None);

    assert_eq!(result.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(result.source, InvocationSource::Unknown);
}
