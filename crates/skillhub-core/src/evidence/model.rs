use serde::{Deserialize, Serialize};

use crate::SkillId;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEvidence {
    pub skill_id: SkillId,
    pub agent_id: Option<String>,
    pub calls: u32,
    pub source: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct EvidenceCoverage {
    pub sources: Vec<String>,
    pub complete: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum GlobalSkillRecommendation {
    KeepInGlobal,
    ConsiderMoving,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct GlobalSkillSuggestion {
    pub skill_id: SkillId,
    pub calls: u32,
    pub recommendation: GlobalSkillRecommendation,
    pub reason: String,
    pub applied_automatically: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct UsageEvidenceAnalysis {
    pub experimental: bool,
    pub window_days: u32,
    pub threshold_calls: u32,
    pub coverage: EvidenceCoverage,
    pub suggestions: Vec<GlobalSkillSuggestion>,
}
