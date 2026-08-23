use super::rules;
use skillhub_core::catalog::{DeclaredRequirement, RequirementKind};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceLocation {
    pub file: String,
    pub line: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnvironmentVariableEvidence {
    pub name: String,
    pub value: Option<String>,
    pub location: SourceLocation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequirementEvidence {
    pub kind: RequirementKind,
    pub name: String,
    pub version: Option<String>,
    pub explicit: bool,
    pub source_code: String,
    pub location: SourceLocation,
}

impl RequirementEvidence {
    pub fn as_declared_requirement(&self) -> DeclaredRequirement {
        DeclaredRequirement {
            kind: self.kind.clone(),
            name: self.name.clone(),
            version: self.version.clone(),
            explicit: self.explicit,
            source: self.source_code.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompatibilityStatement {
    pub kind: String,
    pub value: String,
    pub source_code: String,
    pub location: SourceLocation,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedRequirements {
    pub explicit: Vec<RequirementEvidence>,
    pub clues: Vec<RequirementEvidence>,
    pub environment_variables: Vec<EnvironmentVariableEvidence>,
    pub compatibility: Vec<CompatibilityStatement>,
    pub user_notes: Vec<String>,
    pub summary_code: String,
}

pub struct DeclaredRequirementParser;

impl DeclaredRequirementParser {
    pub fn parse(root: impl AsRef<Path>) -> io::Result<ParsedRequirements> {
        let root = root.as_ref();
        let files = collect_files(root)?;
        let mut parsed = ParsedRequirements {
            explicit: Vec::new(),
            clues: Vec::new(),
            environment_variables: Vec::new(),
            compatibility: Vec::new(),
            user_notes: Vec::new(),
            summary_code: "requirements.no_explicit_declaration_found".to_owned(),
        };
        let mut seen_env = BTreeSet::new();
        for file in files {
            let content = fs::read_to_string(&file)?;
            let relative = file
                .strip_prefix(root)
                .unwrap_or(&file)
                .to_string_lossy()
                .replace('\\', "/");
            let frontmatter = frontmatter_lines(&content);
            let known_file = !relative.eq_ignore_ascii_case("SKILL.md");
            for (line_no, line) in content.lines().enumerate() {
                let line_number = line_no + 1;
                let trimmed = line.trim();
                let user_note = trimmed.contains("用户备注");
                if user_note {
                    parsed.user_notes.push(trimmed.to_owned());
                }
                if !user_note {
                    parse_compatibility(trimmed, line_number, &relative, &mut parsed.compatibility);
                }
                let explicit = frontmatter.contains(&line_number) && is_explicit_line(trimmed)
                    || is_markdown_explicit(trimmed);
                if !known_file {
                    if let Some((kind, name, version)) = rules::classify(trimmed) {
                        let evidence = RequirementEvidence {
                            kind,
                            name,
                            version,
                            explicit,
                            source_code: sanitize_source(trimmed),
                            location: SourceLocation {
                                file: relative.clone(),
                                line: line_number,
                            },
                        };
                        if explicit {
                            parsed.explicit.push(evidence);
                        } else {
                            parsed.clues.push(evidence);
                        }
                    }
                }
                for name in rules::environment_variables(trimmed) {
                    if seen_env.insert(name.clone()) {
                        parsed
                            .environment_variables
                            .push(EnvironmentVariableEvidence {
                                name,
                                value: None,
                                location: SourceLocation {
                                    file: relative.clone(),
                                    line: line_number,
                                },
                            });
                    }
                }
            }
            parse_known_file(&relative, &content, &frontmatter, &mut parsed);
        }
        deduplicate(&mut parsed.explicit);
        deduplicate(&mut parsed.clues);
        parsed.summary_code = if parsed.explicit.is_empty() {
            "requirements.no_explicit_declaration_found"
        } else {
            "requirements.explicit_declarations_found"
        }
        .to_owned();
        Ok(parsed)
    }
}

fn collect_files(root: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    collect_files_recursive(root, &mut files)?;
    files.sort();
    Ok(files)
}

fn collect_files_recursive(root: &Path, files: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_recursive(&path, files)?;
        } else if path.is_file() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if name.eq_ignore_ascii_case("SKILL.md")
                || matches!(
                    name.to_ascii_lowercase().as_str(),
                    "requirements.txt"
                        | "pyproject.toml"
                        | "package.json"
                        | "dockerfile"
                        | ".env.example"
                )
            {
                files.push(path);
            }
        }
    }
    Ok(())
}

fn frontmatter_lines(content: &str) -> BTreeSet<usize> {
    let mut lines = BTreeSet::new();
    let mut in_frontmatter = false;
    for (index, line) in content.lines().enumerate() {
        if index == 0 && line.trim() == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter && line.trim() == "---" {
            break;
        }
        if in_frontmatter {
            lines.insert(index + 1);
        }
    }
    lines
}

fn is_explicit_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("requires:")
        || lower.contains("requirements:")
        || lower.contains("dependencies:")
        || lower.starts_with("-")
        || lower.starts_with("python=")
        || lower.starts_with("ffmpeg=")
        || lower.starts_with("env:")
}

fn is_markdown_explicit(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    (lower.contains("requires") || lower.contains("requirements") || lower.contains("dependencies"))
        && (lower.contains(':')
            || lower.contains("python")
            || lower.contains("ffmpeg")
            || lower.contains("mcp")
            || lower.contains("plugin"))
}

fn parse_compatibility(
    line: &str,
    line_no: usize,
    file: &str,
    output: &mut Vec<CompatibilityStatement>,
) {
    let lower = line.to_ascii_lowercase();
    let candidates = [("agent", "agent:"), ("os", "os:")];
    for (kind, marker) in candidates {
        if let Some(index) = lower.find(marker) {
            let values = line[index + marker.len()..]
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty());
            for value in values {
                output.push(CompatibilityStatement {
                    kind: kind.to_owned(),
                    value: value.to_owned(),
                    source_code: sanitize_source(line.trim()),
                    location: SourceLocation {
                        file: file.to_owned(),
                        line: line_no,
                    },
                });
            }
        }
    }
}

fn parse_known_file(
    relative: &str,
    content: &str,
    frontmatter: &BTreeSet<usize>,
    parsed: &mut ParsedRequirements,
) {
    let known = !relative.eq_ignore_ascii_case("SKILL.md");
    if !known {
        return;
    }
    for (index, line) in content.lines().enumerate() {
        if let Some((kind, name, version)) = rules::classify(line) {
            let evidence = RequirementEvidence {
                kind,
                name,
                version,
                explicit: true,
                source_code: sanitize_source(line.trim()),
                location: SourceLocation {
                    file: relative.to_owned(),
                    line: index + 1,
                },
            };
            parsed.explicit.push(evidence);
        }
        let _ = frontmatter;
    }
}

fn deduplicate(values: &mut Vec<RequirementEvidence>) {
    let mut unique = Vec::with_capacity(values.len());
    for value in values.drain(..) {
        if !unique.iter().any(|existing: &RequirementEvidence| {
            existing.kind == value.kind
                && existing.name == value.name
                && existing.location == value.location
        }) {
            unique.push(value);
        }
    }
    *values = unique;
}

fn sanitize_source(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if is_name_start(bytes, index) {
            let name_start = index;
            index += 1;
            while index < bytes.len() && is_name_char(bytes[index]) {
                index += 1;
            }
            let name = &line[name_start..index];
            let mut separator = index;
            while separator < bytes.len() && bytes[separator].is_ascii_whitespace() {
                separator += 1;
            }
            if is_env_name(name)
                && separator < bytes.len()
                && (bytes[separator] == b'=' || bytes[separator] == b':')
            {
                let mut output = String::with_capacity(name_start + name.len() + 12);
                output.push_str(&line[..name_start]);
                output.push_str(name);
                output.push_str("=<redacted>");
                return output;
            }
            index = name_start + name.len();
        } else {
            index += 1;
        }
    }
    line.to_owned()
}

fn is_name_start(bytes: &[u8], index: usize) -> bool {
    bytes[index].is_ascii_uppercase() || bytes[index] == b'_'
}

fn is_name_char(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
}

fn is_env_name(name: &str) -> bool {
    name.len() > 2 && name.contains('_') && name.bytes().all(is_name_char)
}
