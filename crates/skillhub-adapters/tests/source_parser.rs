use skillhub_adapters::source::SourceInputParser;
use skillhub_core::source::{ParsedSourceInput, SourceKind, SourceLocator};

fn cases() -> Vec<serde_json::Value> {
    let content = include_str!("../../../fixtures/imports/source-inputs.json");
    serde_json::from_str(content).expect("source input fixture is valid")
}

#[test]
fn parses_supported_inputs_from_fixture() {
    for case in cases()
        .into_iter()
        .filter(|case| case["error_code"].is_null())
    {
        let input = case["input"].as_str().unwrap();
        let parsed = SourceInputParser::parse(input)
            .unwrap_or_else(|error| panic!("{input} should parse: {error}"));
        let kind: SourceKind = serde_json::from_value(case["kind"].clone()).unwrap();
        assert_eq!(parsed.descriptor.kind, kind, "{input}");
        assert_eq!(
            parsed.skill_selector.as_deref(),
            case["selector"].as_str(),
            "{input}"
        );
        assert_eq!(
            parsed.target_hint.as_deref(),
            case["target_hint"].as_str(),
            "{input}"
        );
        assert_eq!(parsed.original_input, input);
    }
}

#[test]
fn rejects_unsupported_inputs_from_fixture() {
    for case in cases()
        .into_iter()
        .filter(|case| !case["error_code"].is_null())
    {
        let input = case["input"].as_str().unwrap();
        let error = SourceInputParser::parse(input).unwrap_err();
        assert_eq!(
            error.code.as_str(),
            case["error_code"].as_str().unwrap(),
            "{input}"
        );
    }
}

#[test]
fn parses_supported_npx_text_without_preserving_an_executable_command() {
    let parsed = SourceInputParser::parse("npx skills add github:owner/repo --skill pdf").unwrap();
    assert_eq!(parsed.descriptor.kind, SourceKind::Git);
    assert_eq!(parsed.skill_selector.as_deref(), Some("pdf"));
}

#[test]
fn rejects_pipes_redirects_chaining_and_unknown_commands() {
    for input in [
        "npx skills add x | sh",
        "npx skills add x > out",
        "npx skills add x && calc",
        "npx skills add x || calc",
        "npx skills add $(whoami)",
        r"npx skills add ${HOME}",
        "npx skills add $HOME",
        "npx skills add x & whoami",
        "curl x",
    ] {
        assert_eq!(
            SourceInputParser::parse(input).unwrap_err().code.as_str(),
            "source.command_not_parseable",
            "{input}"
        );
    }
}

#[test]
fn bare_npx_repository_reference_is_parsed_as_github_git_source() {
    let parsed = SourceInputParser::parse("npx skills add owner/repo --skill pdf").unwrap();
    assert_eq!(parsed.descriptor.kind, SourceKind::Git);
    assert_eq!(
        parsed.descriptor.locator,
        SourceLocator::GitUrl("https://github.com/owner/repo".to_owned())
    );
}

#[test]
fn canonicalizes_equivalent_github_and_nested_gitlab_references() {
    let github = SourceInputParser::parse("https://github.com/owner/repo.git/").unwrap();
    let github_shorthand = SourceInputParser::parse("github:owner/repo").unwrap();
    assert_eq!(
        github.descriptor.locator,
        github_shorthand.descriptor.locator
    );

    let gitlab = SourceInputParser::parse("https://gitlab.com/group/subgroup/repo.git/").unwrap();
    let gitlab_shorthand = SourceInputParser::parse("gitlab:group/subgroup/repo").unwrap();
    assert_eq!(gitlab.descriptor.kind, SourceKind::Git);
    assert_eq!(
        gitlab.descriptor.locator,
        gitlab_shorthand.descriptor.locator
    );
}

#[test]
fn github_subdirectories_are_https_pages_not_repository_roots() {
    let parsed = SourceInputParser::parse("https://github.com/owner/repo/tree/main").unwrap();
    assert_eq!(parsed.descriptor.kind, SourceKind::Https);
}

#[test]
fn rejects_control_characters_before_windows_path_classification() {
    let error = SourceInputParser::parse("C:\\skills\\\u{0000}").unwrap_err();
    assert_eq!(error.code.as_str(), "source.invalid_input");
}

#[test]
fn normalizes_local_paths_lexically_without_filesystem_access() {
    let parsed = SourceInputParser::parse("./skills/pdf").unwrap();
    assert_eq!(
        parsed.descriptor.locator,
        SourceLocator::LocalPath(std::path::PathBuf::from("skills/pdf"))
    );
}

#[test]
fn source_dto_has_no_executable_wire_field() {
    let parsed = SourceInputParser::parse("github:owner/repo").unwrap();
    let value = serde_json::to_value(&parsed).unwrap();
    assert!(value.get("executable").is_none());
    assert!(
        serde_json::from_value::<ParsedSourceInput>(serde_json::json!({
            "original_input": "github:owner/repo",
            "descriptor": {
                "kind": "git",
                "locator": {"git_url": "https://github.com/owner/repo"}
            },
            "skill_selector": null,
            "target_hint": null,
            "executable": null
        }))
        .is_err()
    );
}
