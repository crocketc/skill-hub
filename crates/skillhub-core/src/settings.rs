use serde::{Deserialize, Serialize};

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
        }
    }
}

impl DesktopPreferences {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self.language.as_str(), "system" | "zh-CN" | "en-US") {
            return Err("unsupported language preference");
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
