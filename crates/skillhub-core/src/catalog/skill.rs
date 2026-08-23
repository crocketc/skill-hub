use super::metadata::{CallPolicy, DeclaredRequirement, TranslationState};
use crate::{AppError, ErrorCode, Severity, SkillId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize, specta::Type)]
pub enum SkillLifecycle {
    Normal,
    Deprecated,
    Archived,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum TrialState {
    Active,
    Due,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Skill {
    id: SkillId,
    display_name: String,
    runtime_name: String,
    original_description: String,
    translated_description: Option<String>,
    translation_state: TranslationState,
    user_note: Option<String>,
    tags: BTreeSet<String>,
    author: Option<String>,
    license: Option<String>,
    call_policy: CallPolicy,
    lifecycle: SkillLifecycle,
    declared_requirements: Vec<DeclaredRequirement>,
    trial_due: Option<(i32, u8, u8)>,
}

impl Skill {
    pub fn new(id: SkillId, name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            id,
            display_name: name.clone(),
            runtime_name: name,
            original_description: String::new(),
            translated_description: None,
            translation_state: TranslationState::NotTranslated,
            user_note: None,
            tags: BTreeSet::new(),
            author: None,
            license: None,
            call_policy: CallPolicy::AutomaticAndManual,
            lifecycle: SkillLifecycle::Normal,
            declared_requirements: Vec::new(),
            trial_due: None,
        }
    }
    pub fn id(&self) -> SkillId {
        self.id
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
    pub fn runtime_name(&self) -> &str {
        &self.runtime_name
    }
    pub fn original_description(&self) -> &str {
        &self.original_description
    }
    pub fn translated_description(&self) -> Option<&str> {
        self.translated_description.as_deref()
    }
    pub fn note(&self) -> Option<&str> {
        self.user_note.as_deref()
    }
    pub fn tags(&self) -> &BTreeSet<String> {
        &self.tags
    }
    pub fn lifecycle(&self) -> SkillLifecycle {
        self.lifecycle
    }
    pub fn requirements(&self) -> &[DeclaredRequirement] {
        &self.declared_requirements
    }
    pub fn trial_due(&self) -> Option<(i32, u8, u8)> {
        self.trial_due
    }
    pub fn call_policy(&self) -> CallPolicy {
        self.call_policy.clone()
    }
    pub fn author(&self) -> Option<&str> {
        self.author.as_deref()
    }
    pub fn license(&self) -> Option<&str> {
        self.license.as_deref()
    }
    pub fn with_description(mut self, value: impl Into<String>) -> Self {
        self.original_description = value.into();
        self
    }
    pub fn with_note(mut self, value: impl Into<String>) -> Self {
        self.user_note = Some(value.into());
        self
    }
    pub fn with_tag(mut self, value: impl Into<String>) -> Self {
        self.tags.insert(value.into());
        self
    }
    pub fn with_author(mut self, value: impl Into<String>) -> Self {
        self.author = Some(value.into());
        self
    }
    pub fn with_license(mut self, value: impl Into<String>) -> Self {
        self.license = Some(value.into());
        self
    }
    pub fn with_trial_due(mut self, year: i32, month: u8, day: u8) -> Self {
        self.trial_due = Some((year, month, day));
        self.with_tag("temporary_trial")
    }
    pub fn trial_state(&self, date: (i32, u8, u8)) -> TrialState {
        if self.trial_due.map(|due| date >= due).unwrap_or(false) {
            TrialState::Due
        } else {
            TrialState::Active
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn set_persisted_fields(
        &mut self,
        display: String,
        runtime: String,
        description: String,
        translated: Option<String>,
        note: Option<String>,
        tags: BTreeSet<String>,
        author: Option<String>,
        license: Option<String>,
        policy: CallPolicy,
        lifecycle: SkillLifecycle,
        requirements: Vec<DeclaredRequirement>,
        trial_due: Option<(i32, u8, u8)>,
    ) {
        self.display_name = display;
        self.runtime_name = runtime;
        self.original_description = description;
        self.translated_description = translated;
        self.translation_state = if self.translated_description.is_some() {
            TranslationState::Translated
        } else {
            TranslationState::NotTranslated
        };
        self.user_note = note;
        self.tags = tags;
        self.author = author;
        self.license = license;
        self.call_policy = policy;
        self.lifecycle = lifecycle;
        self.declared_requirements = requirements;
        self.trial_due = trial_due;
    }
    pub fn validate(&self) -> Result<(), AppError> {
        if self.display_name.trim().is_empty() {
            Err(AppError::new(ErrorCode::InvalidInput, Severity::Error))
        } else if self.tags.contains("temporary_trial") != self.trial_due.is_some() {
            Err(AppError::new(
                ErrorCode::CatalogInvalidMetadata,
                Severity::Error,
            ))
        } else {
            Ok(())
        }
    }

    pub fn rename(&mut self, name: impl Into<String>) -> Result<(), AppError> {
        let name = name.into();
        if name.trim().is_empty() {
            return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error));
        }
        self.display_name = name.clone();
        self.runtime_name = name;
        Ok(())
    }

    pub fn set_lifecycle(&mut self, lifecycle: SkillLifecycle) {
        self.lifecycle = lifecycle;
    }

    pub fn set_trial_due(&mut self, due: Option<(i32, u8, u8)>) {
        self.trial_due = due;
        if due.is_some() {
            self.tags.insert("temporary_trial".to_owned());
        } else {
            self.tags.remove("temporary_trial");
        }
    }

    pub fn set_metadata(
        &mut self,
        display_name: Option<String>,
        note: Option<String>,
        tags: BTreeSet<String>,
        author: Option<String>,
        license: Option<String>,
    ) -> Result<(), AppError> {
        if let Some(name) = display_name {
            self.rename(name)?;
        }
        self.user_note = note;
        self.tags = tags;
        self.author = author;
        self.license = license;
        self.validate()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        id: SkillId,
        display: String,
        runtime: String,
        description: String,
        translated: Option<String>,
        note: Option<String>,
        tags: BTreeSet<String>,
        author: Option<String>,
        license: Option<String>,
        policy: CallPolicy,
        lifecycle: SkillLifecycle,
        requirements: Vec<DeclaredRequirement>,
        trial_due: Option<(i32, u8, u8)>,
    ) -> Result<Self, AppError> {
        let mut skill = Self::new(id, display.clone());
        skill.set_persisted_fields(
            display,
            runtime,
            description,
            translated,
            note,
            tags,
            author,
            license,
            policy,
            lifecycle,
            requirements,
            trial_due,
        );
        skill.validate()?;
        Ok(skill)
    }
}
