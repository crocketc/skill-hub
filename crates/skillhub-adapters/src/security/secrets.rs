/// Return true when a line contains a likely literal credential rather than a
/// variable reference or a documentation placeholder.
pub fn has_plaintext_credential(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains(" private key-----") {
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
        let Some(position) = lower.find(marker) else {
            continue;
        };
        let after = line[position + marker.len()..].trim_start();
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
            || value.eq_ignore_ascii_case("changeme")
            || value.eq_ignore_ascii_case("your-key")
            || value.eq_ignore_ascii_case("your_token")
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
