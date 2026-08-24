use super::rules::BasicRuleset;
use super::secrets::has_plaintext_credential;
use sha2::{Digest, Sha256};
use skillhub_core::application::{BasicCheckOutput, BasicCheckScanner as BasicCheckScannerPort};
use skillhub_core::check::Finding;
use skillhub_core::{AppError, AppResult, ErrorCode, Severity};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BinaryFileMetadata {
    pub file: String,
    pub size: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BasicScanReport {
    pub findings: Vec<Finding>,
    pub binary_files: Vec<BinaryFileMetadata>,
}

/// Local-only scanner. It reads bytes and never invokes a shell, interpreter,
/// network client, decoder with side effects, or model.
#[derive(Clone, Debug, Default)]
pub struct BasicScanner {
    ruleset: BasicRuleset,
}

impl BasicScanner {
    pub fn new(ruleset: BasicRuleset) -> Self {
        Self { ruleset }
    }

    pub fn ruleset(&self) -> &BasicRuleset {
        &self.ruleset
    }

    /// Scan a directory-shaped version and return stable findings in path and
    /// location order. A single file is accepted for small imported versions.
    pub fn scan_version(&self, root: impl AsRef<Path>) -> AppResult<Vec<Finding>> {
        Ok(self.scan_version_report(root)?.findings)
    }

    pub fn scan_version_report(&self, root: impl AsRef<Path>) -> AppResult<BasicScanReport> {
        let root = root.as_ref();
        let metadata = fs::symlink_metadata(root).map_err(io_error)?;
        let mut files = Vec::new();
        if metadata.is_file() {
            files.push(root.to_path_buf());
        } else if metadata.is_dir() {
            collect_files(root, &mut files)?;
        } else {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)
                .with_param("reason", "scan root is not a file or directory"));
        }
        files.sort_by_key(|path| normalized_relative(root, path));

        let mut report = BasicScanReport::default();
        for file in files {
            let relative = normalized_relative(root, &file);
            let bytes = fs::read(&file).map_err(io_error)?;
            if is_binary(&bytes) {
                report.binary_files.push(BinaryFileMetadata {
                    file: relative,
                    size: bytes.len() as u64,
                });
                continue;
            }
            let text = String::from_utf8(bytes).map_err(|_| {
                AppError::new(ErrorCode::InternalError, Severity::Error)
                    .with_param("reason", "non-UTF-8 file was not identified as binary")
            })?;
            scan_text(&self.ruleset, &relative, &text, &mut report.findings);
        }
        report.findings.sort_by(|left, right| {
            (&left.file, left.line_start, &left.code, &left.id).cmp(&(
                &right.file,
                right.line_start,
                &right.code,
                &right.id,
            ))
        });
        Ok(report)
    }
}

impl BasicCheckScannerPort for BasicScanner {
    fn scan_version(&self, root: &Path) -> AppResult<BasicCheckOutput> {
        Ok(BasicCheckOutput {
            ruleset_id: self.ruleset.id.clone(),
            findings: self.scan_version(root)?,
            coverage_inputs: serde_json::json!({ "root": "materialized_version" }),
        })
    }
}

fn collect_files(root: &Path, files: &mut Vec<PathBuf>) -> AppResult<()> {
    let entries = fs::read_dir(root).map_err(io_error)?;
    for entry in entries {
        let entry = entry.map_err(io_error)?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_files(&path, files)?;
        } else if metadata.is_file() {
            files.push(path);
        }
    }
    Ok(())
}

fn scan_text(ruleset: &BasicRuleset, file: &str, text: &str, findings: &mut Vec<Finding>) {
    let mut seen = BTreeSet::new();
    for (index, line) in text.lines().enumerate() {
        let line_number = index as u32 + 1;
        let lower = line.to_ascii_lowercase();
        let mut codes = Vec::new();
        let example_line = is_example_line(&lower);
        if lower.contains("rm -rf")
            || lower.contains("rm -fr")
            || lower.contains("del /f")
            || lower.contains("rmdir /s")
            || lower.contains("remove-item") && lower.contains("-recurse")
            || lower.contains("mkfs.")
        {
            codes.push("security.destructive_command");
        }
        if lower.contains("sudo ")
            || lower.contains("runas ")
            || lower.contains("verb runas")
            || lower.contains("doas ")
        {
            codes.push("security.elevation");
        }
        if lower.contains("chmod ")
            || lower.contains("chown ")
            || lower.contains("icacls ")
            || lower.contains("set-acl")
        {
            codes.push("security.permission_change");
        }
        if lower.contains("crontab")
            || lower.contains("launchagents")
            || lower.contains("scheduled task")
            || lower.contains("schtasks")
            || lower.contains("systemd") && lower.contains("enable")
            || lower.contains("registry") && lower.contains("\\run")
        {
            codes.push("security.persistence");
        }
        if (is_download_command(&lower))
            && (lower.contains("| bash")
                || lower.contains("| sh")
                || lower.contains("| zsh")
                || lower.contains("invoke-expression")
                || lower.contains("iex ")
                || lower.contains("| iex")
                || lower.ends_with(" iex")
                || lower.contains("chmod +x")
                || lower.contains("&& bash ")
                || lower.contains("&& sh ")
                || lower.contains("; bash ")
                || lower.contains("; sh ")
                || lower.contains("; pwsh ")
                || lower.contains("; powershell ")
                || lower.contains("&& ./"))
        {
            codes.push("security.download_and_execute");
        }
        if (lower.contains("curl ")
            || lower.contains("wget ")
            || lower.contains("invoke-restmethod"))
            && (lower.contains("-x post")
                || lower.contains("--data")
                || lower.contains(" -d ")
                || lower.contains("-method post")
                || lower.contains("upload"))
            && !example_line
        {
            codes.push("security.data_upload");
        }
        if (lower.contains("curl ") && (lower.contains("--form") || lower.contains(" -f "))
            || lower.contains("invoke-webrequest") && lower.contains("-infile")
            || lower.starts_with("scp ")
            || lower.starts_with("rsync "))
            && !example_line
        {
            codes.push("security.data_upload");
        }
        if lower.contains("eval ")
            || lower.contains("bash -c $")
            || lower.contains("sh -c $")
            || lower.contains("$()")
        {
            codes.push("security.command_interpolation");
        }
        if lower.contains("base64 -d")
            || lower.contains("base64 --decode")
            || lower.contains("frombase64string")
            || line
                .chars()
                .any(|character| character == '\u{200b}' || character == '\u{202e}')
        {
            codes.push("security.obfuscation");
        }
        if lower.contains("../")
            || lower.contains(r"..\")
            || lower.contains("%2e%2e")
            || lower.contains("..%2f")
        {
            codes.push("security.path_traversal");
        }
        if !example_line && has_plaintext_credential(line) {
            codes.push("security.possible_plaintext_credential");
        }
        if lower.contains("ignore previous instructions")
            || lower.contains("ignore all previous")
            || lower.contains("reveal the system prompt")
            || lower.contains("hidden context")
        {
            codes.push("security.prompt_injection");
        }
        if lower.contains("<script")
            || lower.contains("javascript:")
            || lower.contains("![") && lower.contains(")(") && lower.contains("http")
        {
            codes.push("security.suspicious_external_resource");
        }

        for code in codes {
            if !seen.insert((code, line_number)) {
                continue;
            }
            let severity = ruleset
                .rule(code)
                .map(|rule| rule.severity)
                .unwrap_or(Severity::Warning);
            findings.push(make_finding(code, severity, file, line_number, line));
        }
    }
}

fn is_example_line(lower: &str) -> bool {
    lower.contains("documentation only")
        || lower.contains("syntax example")
        || lower.contains("examples use")
}

fn is_download_command(lower: &str) -> bool {
    lower.contains("curl ")
        || lower.contains("wget ")
        || lower.contains("invoke-webrequest")
        || lower.starts_with("irm ")
        || lower.starts_with("iwr ")
        || lower.contains(" irm ")
        || lower.contains(" iwr ")
}

fn make_finding(code: &str, severity: Severity, file: &str, line: u32, evidence: &str) -> Finding {
    let evidence_hash = sha256(evidence.as_bytes());
    let id = sha256(format!("{code}\0{file}\0{line}\0{evidence_hash}").as_bytes());
    let mut finding = Finding::at(id, code, severity, file, line, None);
    finding.evidence_hash = Some(evidence_hash);
    if code == "security.possible_plaintext_credential" {
        finding.message_params.insert(
            "evidence_summary".into(),
            serde_json::json!("credential value redacted"),
        );
    } else {
        finding
            .message_params
            .insert("ruleset".into(), serde_json::json!(BasicRuleset::ID));
        finding
            .message_params
            .insert("evidence".into(), serde_json::json!(evidence));
    }
    finding
}

fn sha256(input: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(input);
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0) || std::str::from_utf8(bytes).is_err()
}

fn normalized_relative(root: &Path, path: &Path) -> String {
    if root == path {
        return root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
    }
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn io_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("reason", error.to_string())
}
