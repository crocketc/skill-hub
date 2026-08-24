use skillhub_adapters::security::BasicScanner;
use skillhub_core::check::FindingDisposition;
use skillhub_core::Severity;
use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/skills/security")
        .join(name)
}

fn scan_fixture(name: &str) -> Vec<skillhub_core::check::Finding> {
    BasicScanner::default()
        .scan_version(fixture_path(name))
        .expect("fixture scan should succeed")
}

trait FindingAssertions {
    fn has_code_at(&self, code: &str, file: &str, line: u32) -> bool;
    fn single(&self) -> &skillhub_core::check::Finding;
}

impl FindingAssertions for [skillhub_core::check::Finding] {
    fn has_code_at(&self, code: &str, file: &str, line: u32) -> bool {
        self.iter().any(|finding| {
            finding.code == code
                && finding.file.as_deref() == Some(file)
                && finding.line_start == Some(line)
        })
    }

    fn single(&self) -> &skillhub_core::check::Finding {
        assert_eq!(self.len(), 1, "expected one finding, got {self:#?}");
        &self[0]
    }
}

#[test]
fn reports_dangerous_delete_and_download_execute_with_exact_locations() {
    let findings = scan_fixture("dangerous-commands");
    assert!(findings.has_code_at("security.destructive_command", "SKILL.md", 8));
    assert!(findings.has_code_at("security.download_and_execute", "SKILL.md", 12));
}

#[test]
fn user_api_key_is_warnable_and_acknowledgeable_not_a_hard_block() {
    let findings = scan_fixture("user-api-key");
    let finding = findings.single();
    assert_eq!(finding.code, "security.possible_plaintext_credential");
    assert_eq!(finding.severity, Severity::Warning);
    assert!(finding
        .allowed_dispositions
        .contains(&FindingDisposition::Acknowledged));
}

#[test]
fn credential_evidence_is_redacted_before_persistence() {
    let findings = scan_fixture("user-api-key");
    let finding = findings.single();
    let params = serde_json::to_string(&finding.message_params).expect("finding params serialize");
    assert!(!params.contains("sk-test-user-key-1234567890"));
    assert!(!finding.message_params.contains_key("evidence"));
    assert_eq!(
        finding.message_params.get("evidence_summary"),
        Some(&serde_json::json!("credential value redacted"))
    );
    assert!(finding.evidence_hash.is_some());
    assert_eq!(finding.file.as_deref(), Some("SKILL.md"));
    assert_eq!(finding.line_start, Some(6));
}

#[test]
fn benign_commands_and_placeholders_are_not_reported() {
    let findings = scan_fixture("benign-commands");
    assert!(findings.is_empty(), "unexpected findings: {findings:#?}");
}

#[test]
fn reports_obfuscation_exfiltration_and_prompt_injection_as_stable_findings() {
    let obfuscated = scan_fixture("obfuscated-exfiltration");
    assert!(obfuscated
        .iter()
        .any(|finding| finding.code == "security.obfuscation"));
    assert!(obfuscated
        .iter()
        .any(|finding| finding.code == "security.data_upload"));

    let injection = scan_fixture("prompt-injection");
    assert!(injection
        .iter()
        .any(|finding| finding.code == "security.prompt_injection"));
}

#[test]
fn reports_downloaded_file_execution_patterns() {
    let findings = scan_fixture("download-execution");
    assert!(findings
        .iter()
        .any(|finding| finding.code == "security.download_and_execute"));
    assert!(findings.len() >= 4, "findings: {findings:#?}");
    assert!(
        findings.has_code_at("security.download_and_execute", "SKILL.md", 11),
        "findings: {findings:#?}"
    );
    assert!(
        findings.has_code_at("security.download_and_execute", "SKILL.md", 12),
        "findings: {findings:#?}"
    );
}

#[test]
fn reports_common_upload_forms_and_tools() {
    let findings = scan_fixture("upload-patterns");
    assert_eq!(
        findings
            .iter()
            .filter(|finding| finding.code == "security.data_upload")
            .count(),
        5,
        "findings: {findings:#?}"
    );
    assert!(scan_fixture("benign-commands")
        .iter()
        .all(|finding| { finding.code != "security.data_upload" }));
}

#[test]
fn reports_all_deterministic_rule_categories() {
    let findings = scan_fixture("all-rule-categories");
    for code in [
        "security.elevation",
        "security.permission_change",
        "security.persistence",
        "security.command_interpolation",
        "security.path_traversal",
    ] {
        assert!(
            findings.iter().any(|finding| finding.code == code),
            "missing {code}: {findings:#?}"
        );
    }
}

#[test]
fn reports_credentials_but_ignores_example_values() {
    let findings = scan_fixture("credential-patterns");
    assert!(
        findings
            .iter()
            .filter(|finding| finding.code == "security.possible_plaintext_credential")
            .count()
            >= 5,
        "findings: {findings:#?}"
    );
    assert!(findings.iter().any(|finding| {
        finding.code == "security.possible_plaintext_credential" && finding.line_start == Some(8)
    }));
    let benign = scan_fixture("benign-commands");
    assert!(benign
        .iter()
        .all(|finding| finding.code != "security.possible_plaintext_credential"));
}

#[test]
fn default_ruleset_is_loaded_from_the_versioned_json_source() {
    let rules_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("rules/basic-v1.json");
    let from_json = skillhub_adapters::security::BasicRuleset::from_json(rules_path)
        .expect("checked-in rules should parse");
    assert_eq!(
        skillhub_adapters::security::BasicRuleset::default(),
        from_json
    );
}

#[test]
fn binary_files_are_reported_as_metadata_without_content_findings() {
    let root = tempdir().expect("temporary root");
    let bytes = [0_u8, b'r', b'm', b' ', b'-', b'r', b'f'];
    fs::write(root.path().join("payload.bin"), bytes).expect("binary fixture");
    let report = BasicScanner::default()
        .scan_version_report(root.path())
        .expect("binary scan should succeed");
    assert!(report.findings.is_empty());
    assert_eq!(report.binary_files[0].file, "payload.bin");
    assert_eq!(report.binary_files[0].size, bytes.len() as u64);
}

#[test]
fn finding_identity_and_evidence_are_deterministic() {
    let first = scan_fixture("dangerous-commands");
    let second = scan_fixture("dangerous-commands");
    assert_eq!(first, second);
    assert!(first.iter().all(|finding| {
        !finding.id.is_empty()
            && finding
                .evidence_hash
                .as_ref()
                .is_some_and(|hash| hash.len() == 64)
            && finding.file.is_some()
            && finding.line_start.is_some()
    }));
}
