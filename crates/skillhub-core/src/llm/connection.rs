use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::compatibility::{LlmCompatibilityProfile, LlmStructuredOutputStrategy};
use super::model::LlmProfile;
use super::provider::{CustomHeader, LlmDeployment, LlmProtocolFamily, LlmProviderConfig};

/// Three-level connection report.
///
/// The levels answer three different questions and are deliberately kept
/// apart, because a model that answers plain text is *callable* even when the
/// profile's structured-output strategy is not usable:
///
/// 1. `endpoint` — the address answered at all (any HTTP status counts).
/// 2. `model` — authentication, model existence and a parseable envelope,
///    proven by one low-token plain-text request.
/// 3. `structured` — the configured compatibility profile can complete the
///    structured request the real tasks will use.
///
/// Only [`ConnectionTestResult::model_ok`] may be reported as "the model can be
/// called"; [`ConnectionTestResult::task_ready`] is the stricter verdict that
/// also needs structured output.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ConnectionTestResult {
    pub endpoint: EndpointCheckResult,
    #[serde(default)]
    pub model: Option<ModelCheckResult>,
    #[serde(default)]
    pub model_failure_code: Option<String>,
    #[serde(default)]
    pub structured: Option<StructuredCheckResult>,
    #[serde(default)]
    pub structured_failure_code: Option<String>,
}

impl ConnectionTestResult {
    /// Authentication and model availability are proven; the model answers.
    /// A failing structured level never clears this.
    pub fn model_ok(&self) -> bool {
        self.model.as_ref().is_some_and(|model| model.ok)
    }

    /// The profile's own structured-output strategy completed a structured
    /// round-trip. Only reached when the model level passed.
    pub fn structured_ok(&self) -> bool {
        self.structured
            .as_ref()
            .is_some_and(|structured| structured.ok)
    }

    /// The model is reachable *and* structured output works: the provider is
    /// ready for the application's real tasks.
    pub fn task_ready(&self) -> bool {
        self.model_ok() && self.structured_ok()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EndpointCheckResult {
    pub reachable: bool,
    // u32 keeps the generated TypeScript contract free of BigInt-only types.
    pub latency_ms: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ModelCheckResult {
    pub ok: bool,
    pub latency_ms: Option<u32>,
}

/// Structured-output compatibility of the configured compatibility profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct StructuredCheckResult {
    pub ok: bool,
    pub latency_ms: Option<u32>,
}

/// The configuration identity a connection-test result belongs to.
///
/// 只有身份字段参与指纹：endpoint、protocol、deployment、model、
/// compatibility_profile、structured_output_override、凭据是否在场，以及
/// 自定义请求头的 SHA-256 摘要（2026-09-14 遗留风险清理：头的取值可能
/// 影响连通性与认证方式，但摘要形态保证原始值不进入持久化串）。
/// `enabled`、显示名与超时等运行参数不参与——停用再启用或改名不否定
/// "当时连接成功"这一事实；凭据被清除则结果自动失效（当前配置已无法
/// 以测试时的方式完成认证）。指纹是 serde_json 按字段声明顺序的规范
/// 序列化串：同一身份永远得到同一串，可跨进程稳定比较。
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LlmConnectionIdentity {
    pub endpoint: String,
    pub protocol: LlmProtocolFamily,
    pub deployment: LlmDeployment,
    pub model: String,
    pub compatibility_profile: LlmCompatibilityProfile,
    pub structured_output_override: Option<LlmStructuredOutputStrategy>,
    pub credential_present: bool,
    pub custom_headers_digest: String,
}

/// 自定义头的摘要：对头的规范 JSON（名称/值/凭据引用/sensitive 标记，按
/// 配置顺序）做 SHA-256。任一字段变化都会改变摘要，而持久化侧只见十六
/// 进制摘要，不落地任何头的明文。
fn custom_headers_digest(headers: &[CustomHeader]) -> String {
    let canonical = serde_json::to_string(headers).unwrap_or_else(|_| "[]".to_owned());
    let digest = Sha256::digest(canonical.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl LlmConnectionIdentity {
    /// 读取侧：从持久化的供应商配置推导（凭据在场由调用方按 OS 凭据库
    /// 实况传入，而非仅看 `credential_ref` 是否存在）。
    pub fn from_provider_config(config: &LlmProviderConfig, credential_present: bool) -> Self {
        Self {
            endpoint: config.endpoint.clone(),
            protocol: config.protocol,
            deployment: config.deployment,
            model: config.model.clone(),
            compatibility_profile: config.compatibility_profile,
            structured_output_override: config.structured_output_override,
            credential_present,
            custom_headers_digest: custom_headers_digest(&config.custom_headers),
        }
    }

    /// 记录侧：从刚完成实测的运行时 profile 推导，字段与配置一一对应。
    pub fn from_profile(profile: &LlmProfile, credential_present: bool) -> Self {
        Self {
            endpoint: profile.endpoint.clone(),
            protocol: profile.protocol,
            deployment: profile.deployment,
            model: profile.model.clone(),
            compatibility_profile: profile.compatibility_profile,
            structured_output_override: profile.structured_output_override,
            credential_present,
            custom_headers_digest: custom_headers_digest(&profile.custom_headers),
        }
    }

    pub fn fingerprint(&self) -> String {
        serde_json::to_string(self).expect("LlmConnectionIdentity serialises to canonical JSON")
    }
}

#[cfg(test)]
mod connection_identity_tests {
    use super::LlmConnectionIdentity;
    use crate::llm::provider::{CustomHeader, LlmDeployment, LlmProtocolFamily, LlmProviderConfig};

    fn config() -> LlmProviderConfig {
        LlmProviderConfig::new(
            "deepseek",
            "DeepSeek",
            LlmProtocolFamily::OpenAiCompatible,
            LlmDeployment::Online,
            "https://deepseek.test/v1",
            "deepseek-chat",
            None,
        )
        .expect("valid provider config")
    }

    /// 记录侧（来自 LlmProfile）与读取侧（来自 LlmProviderConfig）必须得到
    /// 同一指纹，否则"测试后保存"的结果永远无法被沿用。
    #[test]
    fn profile_and_provider_config_yield_the_same_fingerprint() {
        let config = config();
        let from_config = LlmConnectionIdentity::from_provider_config(&config, true).fingerprint();
        let profile = config.to_profile().expect("valid profile");
        let from_profile = LlmConnectionIdentity::from_profile(&profile, true).fingerprint();
        assert_eq!(from_config, from_profile);
        assert!(from_profile.contains("https://deepseek.test/v1"));
    }

    #[test]
    fn identical_identities_are_stable_and_identity_changes_move_the_fingerprint() {
        let base = LlmConnectionIdentity::from_provider_config(&config(), true).fingerprint();
        assert_eq!(
            base,
            LlmConnectionIdentity::from_provider_config(&config(), true).fingerprint(),
            "同身份重复推导必须稳定（跨进程可比）"
        );

        let mut changed = config();
        changed.endpoint = "https://other.test/v1".to_owned();
        assert_ne!(
            base,
            LlmConnectionIdentity::from_provider_config(&changed, true).fingerprint()
        );

        let mut changed = config();
        changed.model = "other-model".to_owned();
        assert_ne!(
            base,
            LlmConnectionIdentity::from_provider_config(&changed, true).fingerprint()
        );

        let mut changed = config();
        changed.protocol = LlmProtocolFamily::Anthropic;
        assert_ne!(
            base,
            LlmConnectionIdentity::from_provider_config(&changed, true).fingerprint()
        );

        // 凭据在场翻转改变指纹：清除凭据后旧结果自动失效。
        assert_ne!(
            base,
            LlmConnectionIdentity::from_provider_config(&config(), false).fingerprint()
        );

        // 非身份字段（label）不影响指纹。
        let mut relabelled = config();
        relabelled.label = Some(" renamed ".to_owned());
        assert_eq!(
            base,
            LlmConnectionIdentity::from_provider_config(&relabelled, true).fingerprint()
        );
    }

    // —— 遗留风险清理（2026-09-14）：custom_headers 纳入身份指纹。 ——

    fn header(name: &str, value: Option<&str>) -> CustomHeader {
        CustomHeader {
            name: name.to_owned(),
            value: value.map(str::to_owned),
            credential_ref: None,
            sensitive: value.is_some(),
        }
    }

    #[test]
    fn custom_header_changes_move_the_fingerprint_without_leaking_values() {
        let base = LlmConnectionIdentity::from_provider_config(&config(), true).fingerprint();

        let mut with_header = config();
        with_header.custom_headers = vec![header("x-trace", Some("tenant-v1"))];
        let with_header = {
            let fingerprint =
                LlmConnectionIdentity::from_provider_config(&with_header, true).fingerprint();
            assert_ne!(base, fingerprint, "新增自定义头改变身份");
            (with_header, fingerprint)
        };

        // 同名头的值变化同样失效（值可能影响连通性与认证方式）。
        let mut changed_value = with_header.0.clone();
        changed_value.custom_headers[0].value = Some("tenant-v2".to_owned());
        assert_ne!(
            with_header.1,
            LlmConnectionIdentity::from_provider_config(&changed_value, true).fingerprint()
        );

        // 头名或 sensitive 标记变化也是身份变化。
        let mut renamed = with_header.0.clone();
        renamed.custom_headers[0].name = "x-trace-2".to_owned();
        assert_ne!(
            with_header.1,
            LlmConnectionIdentity::from_provider_config(&renamed, true).fingerprint()
        );
        let mut flagged = with_header.0.clone();
        flagged.custom_headers[0].sensitive = false;
        assert_ne!(
            with_header.1,
            LlmConnectionIdentity::from_provider_config(&flagged, true).fingerprint()
        );

        // 摘要形态：原始头值不得进入持久化指纹串（避免敏感明文入库）。
        assert!(!with_header.1.contains("tenant-v1"));
    }

    #[test]
    fn profile_side_digest_matches_config_side_with_custom_headers() {
        let mut config = config();
        config.custom_headers = vec![header("x-a", Some("v1")), header("x-b", None)];
        let from_config = LlmConnectionIdentity::from_provider_config(&config, true).fingerprint();
        let profile = config.to_profile().expect("valid profile");
        let from_profile = LlmConnectionIdentity::from_profile(&profile, true).fingerprint();
        assert_eq!(from_config, from_profile, "带头的身份两侧仍须同指纹");
    }
}
