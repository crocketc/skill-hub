/// Return true when a line contains a likely literal credential rather than a
/// variable reference or a documentation placeholder.
pub fn has_plaintext_credential(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains(" private key-----") {
        return true;
    }

    if has_connection_string(&lower) {
        return true;
    }

    let prefixes = ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-"];
    if prefixes
        .iter()
        .any(|prefix| has_literal_after(line, prefix))
    {
        return true;
    }

    for marker in ["api_key", "api-key", "token", "password", "secret"] {
        let Some(position) = lower.match_indices(marker).find_map(|(position, _)| {
            let before_is_word = position > 0
                && lower[..position]
                    .chars()
                    .next_back()
                    .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_');
            let after_marker = position + marker.len();
            let after_is_word = lower[after_marker..]
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric() || character == '_');
            (!before_is_word && !after_is_word).then_some(position)
        }) else {
            continue;
        };
        let after_marker = position + marker.len();
        let after = line[after_marker..].trim_start();
        let after = after
            .strip_prefix('=')
            .or_else(|| after.strip_prefix(':'))
            .unwrap_or(after)
            .trim_start();
        let value = after.trim_matches(['"', '\'', '`', ' ', '\t']);
        if value.is_empty()
            || value.starts_with('$')
            || value.starts_with('<')
            || value.starts_with('{')
            || is_placeholder(value)
        {
            continue;
        }
        let length = value
            .chars()
            .take_while(|character| {
                character.is_ascii_alphanumeric() || "_-./+".contains(*character)
            })
            .count();
        if length >= 8 {
            return true;
        }
    }
    false
}

fn has_connection_string(lower: &str) -> bool {
    let uri_with_userinfo = lower.contains("://")
        && lower.split("://").skip(1).any(|rest| {
            rest.split('/')
                .next()
                .is_some_and(|authority| authority.contains('@'))
        });
    let key_value_dsn = (lower.contains("server=") || lower.contains("host="))
        && (lower.contains("password=") || lower.contains("user id=") || lower.contains("uid="));
    uri_with_userinfo || key_value_dsn
}

fn is_placeholder(value: &str) -> bool {
    let normalized = value
        .trim_matches(['"', '\'', '`', ' ', '\t', ';', ','])
        .to_ascii_lowercase();
    normalized == "changeme"
        || normalized == "password"
        || normalized == "secret"
        || normalized == "token"
        || normalized.starts_with("your-")
        || normalized.starts_with("your_")
        || normalized.starts_with("dummy")
        || normalized.starts_with("sample")
        || normalized.starts_with("placeholder")
        || normalized == "example"
        || normalized.starts_with("example-")
        || normalized.starts_with("example_")
}

fn has_literal_after(line: &str, prefix: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let Some(position) = lower.find(prefix) else {
        return false;
    };
    let value = &line[position + prefix.len()..];
    let length = value
        .chars()
        .take_while(|character| character.is_ascii_alphanumeric() || "_-".contains(*character))
        .count();
    length >= 8 && !value.starts_with('$') && !value.starts_with('<')
}
