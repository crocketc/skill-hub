use skillhub_core::catalog::RequirementKind;

pub(crate) fn classify(text: &str) -> Option<(RequirementKind, String, Option<String>)> {
    let lower = text.to_ascii_lowercase();
    let tokens: Vec<_> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| !token.is_empty())
        .collect();
    let kind = if lower.contains("ffmpeg") {
        RequirementKind::Ffmpeg
    } else if lower.contains("python") {
        RequirementKind::Python
    } else if lower.contains("mcp") {
        RequirementKind::Mcp
    } else if lower.contains("plugin") {
        RequirementKind::Plugin
    } else if ["node", "docker", "pandoc", "imagemagick", "git"]
        .iter()
        .any(|tool| tokens.contains(tool))
    {
        RequirementKind::OtherTool
    } else {
        return None;
    };
    let name = match kind {
        RequirementKind::Python => "python",
        RequirementKind::Ffmpeg => "ffmpeg",
        RequirementKind::Mcp => "mcp",
        RequirementKind::Plugin => "plugin",
        RequirementKind::OtherTool => lower
            .split(|c: char| !c.is_ascii_alphanumeric())
            .find(|token| matches!(*token, "node" | "docker" | "pandoc" | "imagemagick" | "git"))
            .unwrap_or("tool"),
        RequirementKind::EnvironmentVariable => unreachable!(),
    };
    Some((kind, name.to_owned(), version(text)))
}

pub(crate) fn environment_variables(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|token| {
            token.len() > 2
                && token.contains('_')
                && token
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        })
        .map(str::to_owned)
}

fn version(text: &str) -> Option<String> {
    for (index, ch) in text.char_indices() {
        if matches!(ch, '=' | '>' | '<') {
            let value: String = text[index + ch.len_utf8()..]
                .chars()
                .skip_while(|c| !c.is_ascii_digit())
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}
