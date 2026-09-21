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

#[test]
fn generic_platform_without_params_resolves_to_default_model_and_user() {
    let result = resolve_invocation(InvocationPlatform::Generic, "---\nname: demo\n---", None);

    assert_eq!(result.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(result.source, InvocationSource::Default);
    assert_eq!(result.field, None);
}

#[test]
fn same_skill_on_different_platforms_yields_different_facts() {
    // A neutral Skill with no explicit invocation declaration.
    let markdown = "---\nname: demo\n---";

    let claude = resolve_invocation(InvocationPlatform::ClaudeCode, markdown, None);
    let codex = resolve_invocation(
        InvocationPlatform::Codex,
        "",
        Some("policy:\n  allow_implicit_invocation: true\n"),
    );
    let opencode = resolve_invocation(InvocationPlatform::OpenCode, "---\nslash: false\n---", None);
    let generic = resolve_invocation(InvocationPlatform::Generic, markdown, None);

    // Claude and Generic share the Claude-style frontmatter convention.
    assert_eq!(claude.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(claude.source, InvocationSource::Default);
    assert_eq!(generic.source, InvocationSource::Default);

    // Codex and OpenCode read the same neutral content under their own conventions.
    assert_eq!(codex.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(codex.source, InvocationSource::Explicit);
    assert_eq!(opencode.policy, CallPolicy::ModelOnly);
    assert_eq!(opencode.source, InvocationSource::Explicit);

    // The platform genuinely changes the resolved fact.
    let claude_fact = (claude.policy.clone(), claude.source);
    let codex_fact = (codex.policy.clone(), codex.source);
    let opencode_fact = (opencode.policy.clone(), opencode.source);
    let generic_fact = (generic.policy.clone(), generic.source);
    assert_ne!(claude_fact, codex_fact, "Claude and Codex facts must differ");
    assert_ne!(claude_fact, opencode_fact, "Claude and OpenCode facts must differ");
    assert_ne!(codex_fact, opencode_fact, "Codex and OpenCode facts must differ");
    assert_eq!(claude_fact, generic_fact, "Claude and Generic share frontmatter convention");
}

#[test]
fn malformed_frontmatter_does_not_panic_and_falls_back_to_default() {
    let result = resolve_invocation(
        InvocationPlatform::ClaudeCode,
        "---\nthis: : : is : not : valid\n disable-model-invocation: not-a-bool\n---",
        None,
    );
    // Invalid values are ignored, not crashed on; caller gets a safe default.
    assert_eq!(result.policy, CallPolicy::AutomaticAndManual);
    assert_eq!(result.source, InvocationSource::Default);
    assert_eq!(result.field, None);
}

#[test]
fn fact_maps_call_policy_to_user_facing_mode_and_preserves_source() {
    use skillhub_core::catalog::{InvocationMode, InvocationPolicyFact, InvocationPolicySource};

    let fact = InvocationPolicyFact::from_parts(
        CallPolicy::ManualOnly,
        InvocationPolicySource::Explicit,
        Some("disable-model-invocation".to_owned()),
    );
    assert_eq!(fact.mode, InvocationMode::UserOnly);
    assert_eq!(fact.source, InvocationPolicySource::Explicit);
    assert_eq!(fact.field.as_deref(), Some("disable-model-invocation"));

    let default = InvocationPolicyFact::from_parts(
        CallPolicy::AutomaticAndManual,
        InvocationPolicySource::Default,
        None,
    );
    assert_eq!(default.mode, InvocationMode::ModelAndUser);
    assert_eq!(default.source, InvocationPolicySource::Default);
    assert!(default.field.is_none());
}
