use serde::{Deserialize, Serialize};

use crate::relationship::{UsageEntryKey, UsageEnvironmentKey};
use crate::{OperationId, OperationProgress, OperationSummary, SkillId};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct FactsChanged {
    #[serde(default)]
    pub operation_id: Option<OperationId>,
    #[serde(default)]
    pub skill_ids: Vec<SkillId>,
    #[serde(default)]
    pub entry_keys: Vec<UsageEntryKey>,
    #[serde(default)]
    pub environment_keys: Vec<UsageEnvironmentKey>,
    #[serde(default)]
    pub problem_ids: Vec<String>,
}

impl FactsChanged {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn scoped(
        operation_id: Option<OperationId>,
        skill_ids: Vec<SkillId>,
        entry_keys: Vec<UsageEntryKey>,
        environment_keys: Vec<UsageEnvironmentKey>,
        problem_ids: Vec<String>,
    ) -> Self {
        let mut event = Self {
            operation_id,
            skill_ids,
            entry_keys,
            environment_keys,
            problem_ids,
        };
        event.deduplicate_scopes();
        event
    }

    /// Combines confirmed watcher scopes without losing another relation chain.
    pub fn merge(&mut self, mut other: Self) {
        if self.operation_id != other.operation_id {
            self.operation_id = None;
        }
        self.skill_ids.append(&mut other.skill_ids);
        self.entry_keys.append(&mut other.entry_keys);
        self.environment_keys.append(&mut other.environment_keys);
        self.problem_ids.append(&mut other.problem_ids);
        self.deduplicate_scopes();
    }

    pub fn is_empty(&self) -> bool {
        self.operation_id.is_none()
            && self.skill_ids.is_empty()
            && self.entry_keys.is_empty()
            && self.environment_keys.is_empty()
            && self.problem_ids.is_empty()
    }

    fn deduplicate_scopes(&mut self) {
        deduplicate(&mut self.skill_ids);
        deduplicate(&mut self.entry_keys);
        deduplicate(&mut self.environment_keys);
        deduplicate(&mut self.problem_ids);
    }
}

fn deduplicate<T: PartialEq>(values: &mut Vec<T>) {
    let mut unique = Vec::with_capacity(values.len());
    for value in values.drain(..) {
        if !unique.contains(&value) {
            unique.push(value);
        }
    }
    *values = unique;
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(tag = "type", content = "payload")]
pub enum AppEvent {
    #[serde(rename = "operation_progress")]
    OperationProgress(OperationProgress),
    #[serde(rename = "operation_finished")]
    OperationFinished(OperationSummary),
    #[serde(rename = "facts_changed")]
    FactsChanged(FactsChanged),
}
