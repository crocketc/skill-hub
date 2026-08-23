use crate::SkillId;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SearchQuery {
    pub text: String,
    pub limit: u32,
}

impl SearchQuery {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            limit: 50,
        }
    }
    pub fn with_limit(mut self, limit: u32) -> Self {
        self.limit = limit.max(1);
        self
    }
}

impl From<&str> for SearchQuery {
    fn from(text: &str) -> Self {
        Self::new(text)
    }
}

impl From<String> for SearchQuery {
    fn from(text: String) -> Self {
        Self::new(text)
    }
}

impl From<&SearchQuery> for SearchQuery {
    fn from(query: &SearchQuery) -> Self {
        query.clone()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct SearchDocument {
    pub skill_id: SkillId,
    pub display_name: String,
    pub runtime_name: String,
    pub original_description: String,
    pub translated_description: Option<String>,
    pub user_note: Option<String>,
    pub tags: Vec<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub requirements: Vec<String>,
    pub markdown: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize, specta::Type)]
pub enum SearchField {
    DisplayName,
    RuntimeName,
    OriginalDescription,
    TranslatedDescription,
    UserNote,
    Tags,
    Author,
    License,
    Requirements,
    Markdown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, specta::Type)]
pub struct SearchHit {
    pub skill_id: SkillId,
    pub skill_name: String,
    pub rank: f64,
    pub highlighted_fields: Vec<SearchField>,
}

impl Eq for SearchHit {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
pub struct DuplicateCandidate {
    pub left_skill_id: SkillId,
    pub right_skill_id: SkillId,
    pub similarity_basis_points: u32,
    pub matched_fields: Vec<SearchField>,
}
