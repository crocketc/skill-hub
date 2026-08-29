use crate::{OperationId, SkillId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum CallPolicyCapability {
    Editable,
    ReadOnlyRecognized,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CallPolicyPlan {
    pub id: OperationId,
    pub skill_id: SkillId,
    pub capability: CallPolicyCapability,
    pub before: crate::catalog::CallPolicy,
    pub after: crate::catalog::CallPolicy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, specta::Type)]
#[serde(deny_unknown_fields)]
pub struct CallPolicyResult {
    pub skill_id: SkillId,
    pub capability: CallPolicyCapability,
    pub policy: crate::catalog::CallPolicy,
}
