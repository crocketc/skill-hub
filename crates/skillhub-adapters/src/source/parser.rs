use skillhub_core::source::{
    ParsedSourceInput, SourceDescriptor, SourceErrorCode, SourceInputError, SourceKind,
    SourceLocator,
};
use std::path::PathBuf;
use url::Url;

pub struct SourceInputParser;

impl SourceInputParser {
    pub fn parse(input: impl AsRef<str>) -> Result<ParsedSourceInput, SourceInputError> {
        let original_input = input.as_ref().to_owned();
        let value = original_input.trim().to_owned();
        if value.is_empty() {
            return Err(error(SourceErrorCode::InvalidInput));
        }
        if is_shell_metacharacter(&value) {
            return Err(error(SourceErrorCode::CommandNotParseable));
        }
        if value.starts_with("npx") || first_token(&value).is_some_and(is_command_name) {
            return Self::parse_command(&value, original_input);
        }

        let descriptor = parse_source(&value, false)?;
        Ok(ParsedSourceInput {
            original_input,
            descriptor,
            skill_selector: None,
            target_hint: None,
            executable: None,
        })
    }

    fn parse_command(
        value: &str,
        original_input: String,
    ) -> Result<ParsedSourceInput, SourceInputError> {
        let tokens = tokenize(value)?;
        if tokens.len() < 4 || tokens[0] != "npx" || tokens[1] != "skills" || tokens[2] != "add" {
            return Err(error(SourceErrorCode::CommandNotParseable));
        }

        let descriptor = parse_source(&tokens[3], true)
            .map_err(|_| error(SourceErrorCode::CommandNotParseable))?;
        let mut skill_selector = None;
        let mut target_hint = None;
        let mut index = 4;
        while index < tokens.len() {
            let destination = match tokens[index].as_str() {
                "--skill" => &mut skill_selector,
                "--agent" => &mut target_hint,
                _ => return Err(error(SourceErrorCode::CommandNotParseable)),
            };
            index += 1;
            let Some(value) = tokens.get(index) else {
                return Err(error(SourceErrorCode::CommandNotParseable));
            };
            if value.is_empty() || value.starts_with('-') || destination.is_some() {
                return Err(error(SourceErrorCode::CommandNotParseable));
            }
            *destination = Some(value.clone());
            index += 1;
        }

        Ok(ParsedSourceInput {
            original_input,
            descriptor,
            skill_selector,
            target_hint,
            executable: None,
        })
    }
}

fn parse_source(
    value: &str,
    allow_repository_shorthand: bool,
) -> Result<SourceDescriptor, SourceInputError> {
    if value.starts_with("github:") || value.starts_with("gitlab:") {
        let (host, path) = value.split_once(':').expect("prefix contains a colon");
        let normalized = repository_url(host, path)?;
        return Ok(SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(normalized),
        ));
    }

    if is_windows_path(value) {
        return Ok(SourceDescriptor::new(
            SourceKind::Local,
            SourceLocator::local_path(PathBuf::from(value)),
        ));
    }

    if let Ok(url) = Url::parse(value) {
        if url.scheme() != "https" {
            return Err(error(SourceErrorCode::HttpsRequired));
        }
        if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err(error(SourceErrorCode::InvalidInput));
        }
        let normalized = url.to_string();
        let kind = if is_repository_url(&url) {
            SourceKind::Git
        } else {
            SourceKind::Https
        };
        let locator = if kind == SourceKind::Git {
            SourceLocator::git_url(normalized)
        } else {
            SourceLocator::https_url(normalized)
        };
        return Ok(SourceDescriptor::new(kind, locator));
    }

    if value.contains("://") {
        return Err(error(SourceErrorCode::Unsupported));
    }
    if allow_repository_shorthand && is_repository_path(value) {
        let normalized = repository_url("github", value)?;
        return Ok(SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(normalized),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(error(SourceErrorCode::InvalidInput));
    }
    if value.contains(char::is_whitespace) && !looks_like_path_with_spaces(value) {
        return Err(error(SourceErrorCode::CommandNotParseable));
    }
    Ok(SourceDescriptor::new(
        SourceKind::Local,
        SourceLocator::local_path(PathBuf::from(value)),
    ))
}

fn is_windows_path(value: &str) -> bool {
    value.as_bytes().get(1) == Some(&b':')
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        && value
            .as_bytes()
            .get(2)
            .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
}

fn repository_url(prefix: &str, path: &str) -> Result<String, SourceInputError> {
    if !is_repository_path(path) {
        return Err(error(SourceErrorCode::InvalidInput));
    }
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let host = match prefix {
        "github" => "github.com",
        "gitlab" => "gitlab.com",
        _ => return Err(error(SourceErrorCode::Unsupported)),
    };
    Ok(format!("https://{host}/{path}"))
}

fn is_repository_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("gitlab.com") {
        return false;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    let parts = url.path().trim_matches('/').split('/').collect::<Vec<_>>();
    parts.len() == 2 && parts.last().is_some_and(|part| !part.is_empty())
}

fn is_repository_path(value: &str) -> bool {
    let path = value.trim_start_matches('/').trim_end_matches('/');
    let parts = path.trim_end_matches(".git").split('/').collect::<Vec<_>>();
    parts.len() >= 2
        && parts.iter().all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '@')
                })
        })
}

fn tokenize(value: &str) -> Result<Vec<String>, SourceInputError> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quote = None;
    for character in value.chars() {
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                token.push(character);
            }
            continue;
        }
        match character {
            '\'' | '\"' => quote = Some(character),
            character if character.is_whitespace() => {
                if !token.is_empty() {
                    tokens.push(std::mem::take(&mut token));
                }
            }
            _ => token.push(character),
        }
    }
    if quote.is_some() {
        return Err(error(SourceErrorCode::CommandNotParseable));
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    Ok(tokens)
}

fn first_token(value: &str) -> Option<&str> {
    value.split_whitespace().next()
}

fn is_command_name(value: &str) -> bool {
    matches!(
        value,
        "curl"
            | "wget"
            | "git"
            | "npm"
            | "npx"
            | "sh"
            | "bash"
            | "zsh"
            | "cmd"
            | "powershell"
            | "pwsh"
            | "python"
            | "node"
    )
}

fn is_shell_metacharacter(value: &str) -> bool {
    value.contains('|')
        || value.contains('>')
        || value.contains('<')
        || value.contains(';')
        || value.contains(char::from(96))
        || value.contains("$({")
        || value.contains("&&")
}

fn looks_like_path_with_spaces(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with(".\\")
        || value.starts_with("..\\")
        || (value.as_bytes().get(1) == Some(&b':')
            && value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic))
}

fn error(code: SourceErrorCode) -> SourceInputError {
    SourceInputError::new(code)
}
