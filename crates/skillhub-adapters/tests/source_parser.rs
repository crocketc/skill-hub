use skillhub_adapters::source::SourceInputParser;
use skillhub_core::source::SourceKind;

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
        assert!(parsed.executable.is_none());
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
    assert!(parsed.executable.is_none());
}

#[test]
fn rejects_pipes_redirects_chaining_and_unknown_commands() {
    for input in [
        "npx skills add x | sh",
        "npx skills add x > out",
        "npx skills add x && calc",
        "curl x",
    ] {
        assert_eq!(
            SourceInputParser::parse(input).unwrap_err().code.as_str(),
            "source.command_not_parseable",
            "{input}"
        );
    }
}
