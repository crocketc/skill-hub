use serde::{Deserialize, Serialize};

/// Per-capability LLM switches (requirement 5.42, US-047). Every capability
/// defaults to off: the product never calls an online model without an
/// explicit user decision.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields, default)]
pub struct LlmCapabilitySettings {
    pub safety_check: bool,
    pub semantic_duplicate: bool,
    pub description_translation: bool,
    pub online_search_assist: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct DesktopPreferences {
    pub network_enabled: bool,
    pub llm_provider: String,
    pub data_scope: String,
    pub language: String,
    pub theme: String,
    pub density: String,
    pub automation_per_skill: bool,
    pub automation_batch: bool,
    pub automation_global: bool,
    pub backup_location: String,
    pub backup_retention_days: u32,
    #[serde(default)]
    pub default_llm_provider_id: Option<String>,
    /// AI output language, independent from the interface language
    /// ("system" follows the interface language).
    #[serde(default = "default_ai_output_language")]
    pub ai_output_language: String,
    #[serde(default)]
    pub llm_capabilities: LlmCapabilitySettings,
    #[serde(default)]
    pub import_auto_ai_check: bool,
}

fn default_ai_output_language() -> String {
    "system".into()
}

impl Default for DesktopPreferences {
    fn default() -> Self {
        Self {
            network_enabled: true,
            llm_provider: String::new(),
            data_scope: "explicit_selection".into(),
            language: "system".into(),
            theme: "moss-neutral".into(),
            density: "standard".into(),
            automation_per_skill: false,
            automation_batch: false,
            automation_global: false,
            backup_location: String::new(),
            backup_retention_days: 30,
            default_llm_provider_id: None,
            ai_output_language: default_ai_output_language(),
            llm_capabilities: LlmCapabilitySettings::default(),
            import_auto_ai_check: false,
        }
    }
}

impl DesktopPreferences {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.language.as_str(), "system" | "zh-CN" | "en-US") {
            return Err("unsupported language preference");
        }
        if !matches!(
            self.ai_output_language.as_str(),
            "system" | "zh-CN" | "en-US"
        ) {
            return Err("unsupported AI output language preference");
        }
        if !matches!(
            self.density.as_str(),
            "compact" | "standard" | "comfortable"
        ) {
            return Err("unsupported density preference");
        }
        if self.theme.trim().is_empty() {
            return Err("theme preference is required");
        }
        if !(1..=3650).contains(&self.backup_retention_days) {
            return Err("backup retention must be between 1 and 3650 days");
        }
        Ok(())
    }
}
