use skillhub_adapters::security::BasicScanner;
use skillhub_core::check::FindingDisposition;
use skillhub_core::Severity;
use std::path::PathBuf;

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
