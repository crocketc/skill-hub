//! Resolve the effective Skill invocation policy from the metadata conventions
//! used by supported Agent clients. This module deliberately parses only the
//! small boolean surface that controls who may invoke a Skill; executable
//! content and arbitrary YAML are never interpreted.

use skillhub_core::catalog::CallPolicy;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvocationPlatform {
    Generic,
    ClaudeCode,
    Codex,
    Cursor,
    Windsurf,
    Cline,
    GeminiCli,
    OpenCode,
    KimiCode,
    GrokBuild,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvocationSource {
    Explicit,
    Default,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvocationResolution {
    pub policy: CallPolicy,
    pub source: InvocationSource,
    pub field: Option<String>,
}

impl InvocationResolution {
    fn new(policy: CallPolicy, source: InvocationSource, field: Option<&str>) -> Self {
        Self {
            policy,
            source,
            field: field.map(str::to_owned),
        }
    }
}

/// Resolve a Skill's invocation policy from its `SKILL.md` and optional
/// platform companion file (for example Codex's `agents/openai.yaml`).
///
/// Missing platform-specific fields intentionally resolve to both actors. The
/// `Unknown` source is used only for clients whose official Skill format does
/// not expose an invocation field, so the UI can distinguish a safe default
/// from an evidence gap.
pub fn resolve_invocation(
    platform: InvocationPlatform,
    skill_markdown: &str,
    companion_yaml: Option<&str>,
) -> InvocationResolution {
    match platform {
        InvocationPlatform::Codex => resolve_codex(companion_yaml.unwrap_or(skill_markdown)),
        InvocationPlatform::OpenCode => resolve_opencode(skill_markdown),
        InvocationPlatform::Generic
        | InvocationPlatform::ClaudeCode
        | InvocationPlatform::Cursor
        | InvocationPlatform::Windsurf
        | InvocationPlatform::Cline
        | InvocationPlatform::GeminiCli
        | InvocationPlatform::KimiCode
        | InvocationPlatform::GrokBuild => {
            let parsed = parse_frontmatter(skill_markdown);
            let mut disable = None;
            for key in [
                "disable-model-invocation",
                "disable_model_invocation",
                "disableModelInvocation",
            ] {
                if let Some(value) = parsed.bool_value(key) {
                    disable = Some((value, key));
                    break;
                }
            }
            let user_invocable = parsed
                .bool_value("user-invocable")
                .or_else(|| parsed.bool_value("user_invocable"));
            let flow_type = parsed
                .string_value("type")
                .is_some_and(|value| value == "flow");
            let explicit = disable.is_some() || user_invocable.is_some() || flow_type;
            let policy = match (disable.map(|(value, _)| value), user_invocable, flow_type) {
                (Some(true), Some(false), _) => CallPolicy::Disabled,
                (Some(true), _, _) | (_, _, true) => CallPolicy::ManualOnly,
                (Some(false), Some(false), _) => CallPolicy::ModelOnly,
                (_, Some(false), _) => CallPolicy::ModelOnly,
                _ => CallPolicy::AutomaticAndManual,
            };
            let field = disable
                .map(|(_, key)| key)
                .or_else(|| user_invocable.map(|_| "user-invocable"))
                .or_else(|| flow_type.then_some("type"));
            let source = if explicit {
                InvocationSource::Explicit
            } else if matches!(
                platform,
                InvocationPlatform::Windsurf
                    | InvocationPlatform::Cline
                    | InvocationPlatform::GeminiCli
            ) {
                InvocationSource::Unknown
            } else {
                InvocationSource::Default
            };
            InvocationResolution::new(policy, source, field)
        }
    }
}

fn resolve_codex(content: &str) -> InvocationResolution {
    match bool_value(content, "allow_implicit_invocation") {
        Some(false) => InvocationResolution::new(
            CallPolicy::ManualOnly,
            InvocationSource::Explicit,
            Some("policy.allow_implicit_invocation"),
        ),
        Some(true) => InvocationResolution::new(
            CallPolicy::AutomaticAndManual,
            InvocationSource::Explicit,
            Some("policy.allow_implicit_invocation"),
        ),
        None => InvocationResolution::new(
            CallPolicy::AutomaticAndManual,
            InvocationSource::Default,
            None,
        ),
    }
}

fn resolve_opencode(content: &str) -> InvocationResolution {
    let slash = bool_value(content, "slash");
    let autoinvoke = bool_value(content, "autoinvoke");
    let policy = match (slash.unwrap_or(true), autoinvoke.unwrap_or(true)) {
        (false, false) => CallPolicy::Disabled,
        (false, true) => CallPolicy::ModelOnly,
        (true, false) => CallPolicy::ManualOnly,
        (true, true) => CallPolicy::AutomaticAndManual,
    };
    let field = match (slash, autoinvoke) {
        (Some(_), _) => Some("slash"),
        (_, Some(_)) => Some("metadata.opencode.autoinvoke"),
        _ => None,
    };
    InvocationResolution::new(
        policy,
        if field.is_some() {
            InvocationSource::Explicit
        } else {
            InvocationSource::Default
        },
        field,
    )
}

#[derive(Default)]
struct Frontmatter<'a> {
    lines: Vec<&'a str>,
}

impl<'a> Frontmatter<'a> {
    fn bool_value(&self, key: &str) -> Option<bool> {
        self.lines
            .iter()
            .find_map(|line| value_for_key(line, key).and_then(parse_bool))
    }

    fn string_value(&self, key: &str) -> Option<String> {
        self.lines.iter().find_map(|line| {
            value_for_key(line, key)
                .map(strip_quotes)
                .map(str::to_owned)
        })
    }
}

fn parse_frontmatter(text: &str) -> Frontmatter<'_> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Frontmatter::default();
    }
    let lines = lines
        .take_while(|line| line.trim() != "---")
        .collect::<Vec<_>>();
    Frontmatter { lines }
}

fn bool_value(content: &str, key: &str) -> Option<bool> {
    content
        .lines()
        .find_map(|line| value_for_key(line, key).and_then(parse_bool))
}

fn value_for_key<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let trimmed = line.trim();
    let (candidate, value) = trimmed.split_once(':')?;
    (candidate.trim() == key).then_some(value.trim())
}

fn strip_quotes(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
        })
        .unwrap_or(value)
}

fn parse_bool(value: &str) -> Option<bool> {
    match strip_quotes(value) {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
