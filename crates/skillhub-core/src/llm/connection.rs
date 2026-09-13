use serde::{Deserialize, Serialize};

use super::compatibility::{LlmCompatibilityProfile, LlmStructuredOutputStrategy};
use super::model::LlmProfile;
use super::provider::{LlmDeployment, LlmProtocolFamily, LlmProviderConfig};

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
/// compatibility_profile、structured_output_override 以及凭据是否在场。
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
        }
    }

    pub fn fingerprint(&self) -> String {
        serde_json::to_string(self).expect("LlmConnectionIdentity serialises to canonical JSON")
    }
}

#[cfg(test)]
mod connection_identity_tests {
    use super::LlmConnectionIdentity;
    use crate::llm::provider::{LlmDeployment, LlmProtocolFamily, LlmProviderConfig};

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
}
