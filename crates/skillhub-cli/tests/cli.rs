use skillhub_cli_test_support::{parse, JsonEnvelope};

#[test]
fn json_output_uses_codes_and_ids_not_localized_sentences() {
    let envelope = JsonEnvelope::pending("status");
    let json = serde_json::to_value(envelope).unwrap();
    assert!(json["schema_version"].is_number());
    assert!(json["result_code"].is_string());
    assert!(!json.to_string().contains("部署成功"));
}

#[test]
fn supported_commands_are_explicit_and_no_arbitrary_exec_exists() {
    assert!(parse(["status", "--json"]).is_ok());
    assert!(parse(["exec", "whoami"]).is_err());
}

#[test]
fn non_interactive_high_risk_command_requires_explicit_authorization() {
    let error = parse(["undeploy", "--non-interactive", "--yes"]).unwrap_err();
    assert!(error.contains("--authorize-high-risk"));
}

mod skillhub_cli_test_support {
    pub use skillhub_cli::output::JsonEnvelope;
    pub fn parse<const N: usize>(args: [&str; N]) -> Result<skillhub_cli::args::CliArgs, String> {
        skillhub_cli::args::CliArgs::parse(args)
    }
}
