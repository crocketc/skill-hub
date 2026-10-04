//! Local open policy for Skill-owned library resources.
//!
//! Contract: [`OpenDefaultApplication`], [`OpenSkillFolder`],
//! [`ChooseExternalApplication`].
//!
//! The webview must never receive arbitrary filesystem paths from SkillHub:
//! local resources (markdown files, assets, the Skill folder itself) are
//! opened through these commands instead. The facade resolves every request
//! against the owning Skill's materialized library tree and rejects anything
//! outside it before a platform opener ever runs.

use serde::{Deserialize, Serialize};

use crate::SkillId;

/// Opens one path inside the Skill's materialized library tree with the
/// platform default application. `path` is an absolute path previously handed
/// to the caller through a SkillHub read model (for example the visible tree
/// root or an asset inside it).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OpenDefaultApplication {
    pub skill_id: SkillId,
    pub path: String,
}

/// Reveals one directory inside the Skill's materialized library tree in the
/// platform file manager.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct OpenSkillFolder {
    pub skill_id: SkillId,
    pub path: String,
}

/// Offers the platform "open with" chooser for one file inside the Skill's
/// materialized library tree. Platforms without such a chooser refuse with a
/// structured error instead of silently falling back to the default
/// application.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct ChooseExternalApplication {
    pub skill_id: SkillId,
    pub path: String,
}
