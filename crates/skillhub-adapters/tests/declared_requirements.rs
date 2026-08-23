use skillhub_adapters::requirements::{DeclaredRequirementParser, EnvironmentVariableEvidence};
use skillhub_core::catalog::RequirementKind;
use std::path::Path;

fn parse_fixture(name: &str) -> skillhub_adapters::requirements::ParsedRequirements {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/skills/requirements")
        .join(name);
    DeclaredRequirementParser::parse(root).unwrap()
}

#[test]
fn separates_explicit_requirements_from_reference_clues() {
    let parsed = parse_fixture("python-ffmpeg-env");
    assert!(parsed
        .explicit
        .iter()
        .any(|r| r.kind == RequirementKind::Python));
    assert!(parsed
        .clues
        .iter()
        .any(|r| r.kind == RequirementKind::Ffmpeg && r.location.line == 18));
    assert!(parsed
        .environment_variables
        .iter()
        .any(|v: &EnvironmentVariableEvidence| {
            v.name == "OPENAI_API_KEY"
                && v.value.is_none()
                && v.location.file == "SKILL.md"
                && v.location.line == 5
        }));
}

#[test]
fn absence_is_reported_as_no_explicit_declaration_not_no_dependencies() {
    let parsed = parse_fixture("no-declarations");
    assert_eq!(
        parsed.summary_code,
        "requirements.no_explicit_declaration_found"
    );
    assert_ne!(parsed.summary_code, "requirements.none");
}

#[test]
fn preserves_source_compatibility_statements_separately() {
    let parsed = parse_fixture("source-compatibility");
    assert!(parsed
        .compatibility
        .iter()
        .any(|statement| { statement.kind == "agent" && statement.value == "Codex" }));
    assert!(parsed
        .compatibility
        .iter()
        .any(|statement| { statement.kind == "os" && statement.value == "Windows" }));
    assert!(parsed
        .user_notes
        .iter()
        .any(|note| note.contains("用户备注")));
}

#[test]
fn known_dependency_files_are_explicit_but_credentials_are_never_read() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("SKILL.md"),
        "# Uses a helper\nSee requirements.txt for setup.\n",
    )
    .unwrap();
    std::fs::write(
        root.path().join("requirements.txt"),
        "ffmpeg-python==0.2.0\nprefix OPENAI_API_KEY=do-not-read # ffmpeg\n",
    )
    .unwrap();
    let parsed = DeclaredRequirementParser::parse(root.path()).unwrap();
    assert!(parsed.explicit.iter().any(|requirement| {
        requirement.kind == RequirementKind::Ffmpeg
            && requirement.location.file == "requirements.txt"
    }));
    assert!(!parsed.clues.iter().any(|requirement| {
        requirement.kind == RequirementKind::Ffmpeg
            && requirement.location.file == "requirements.txt"
    }));
    assert!(parsed
        .environment_variables
        .iter()
        .any(|variable| variable.name == "OPENAI_API_KEY" && variable.value.is_none()));
    assert!(parsed
        .explicit
        .iter()
        .all(|requirement| !requirement.source_code.contains("do-not-read")));
}

#[test]
fn user_notes_do_not_become_compatibility_statements_and_tool_names_use_boundaries() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("SKILL.md"),
        "用户备注：agent: Codex\nThis is a digital workflow.\n",
    )
    .unwrap();
    let parsed = DeclaredRequirementParser::parse(root.path()).unwrap();
    assert!(parsed.compatibility.is_empty());
    assert!(!parsed
        .clues
        .iter()
        .any(|requirement| requirement.kind == RequirementKind::OtherTool));
}

#[test]
fn redacts_spaced_and_colon_environment_assignments_on_requirement_lines() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("SKILL.md"),
        "OPENAI_API_KEY = first-secret # ffmpeg\nANTHROPIC_API_KEY: second-secret Python\n",
    )
    .unwrap();
    let parsed = DeclaredRequirementParser::parse(root.path()).unwrap();
    assert!(parsed
        .environment_variables
        .iter()
        .any(|variable| { variable.name == "OPENAI_API_KEY" && variable.value.is_none() }));
    assert!(parsed
        .environment_variables
        .iter()
        .any(|variable| { variable.name == "ANTHROPIC_API_KEY" && variable.value.is_none() }));
    assert!(parsed
        .explicit
        .iter()
        .chain(parsed.clues.iter())
        .all(|requirement| {
            !requirement.source_code.contains("first-secret")
                && !requirement.source_code.contains("second-secret")
        }));
}

#[test]
fn tool_names_require_word_boundaries() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("SKILL.md"),
        "pythonista ffmpegish mcpserver pluginization\n",
    )
    .unwrap();
    let parsed = DeclaredRequirementParser::parse(root.path()).unwrap();
    assert!(!parsed
        .explicit
        .iter()
        .chain(parsed.clues.iter())
        .any(|requirement| {
            matches!(
                requirement.kind,
                RequirementKind::Python
                    | RequirementKind::Ffmpeg
                    | RequirementKind::Mcp
                    | RequirementKind::Plugin
            )
        }));
}

#[test]
fn redacts_quoted_and_yaml_values_without_preserving_suffixes() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("SKILL.md"),
        "OPENAI_API_KEY=\"first secret\" ffmpeg\nOPENAI_API_KEY: second secret Python\n",
    )
    .unwrap();
    let parsed = DeclaredRequirementParser::parse(root.path()).unwrap();
    assert!(parsed
        .explicit
        .iter()
        .chain(parsed.clues.iter())
        .all(|requirement| {
            !requirement.source_code.contains("first")
                && !requirement.source_code.contains("secret")
                && !requirement.source_code.contains("second")
                && !requirement.source_code.contains("ffmpeg")
                && !requirement.source_code.contains("Python")
        }));
}
