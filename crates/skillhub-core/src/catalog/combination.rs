use crate::{AppError, CombinationId, ErrorCode, Severity, SkillId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum CombinationMember {
    Skill(SkillId),
    Combination(CombinationId),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SkillCombination {
    id: CombinationId,
    name: String,
    members: Vec<CombinationMember>,
}
impl SkillCombination {
    pub fn id_for_test() -> CombinationId {
        CombinationId::new()
    }
    pub fn create(
        name: impl Into<String>,
        members: Vec<CombinationMember>,
    ) -> Result<Self, AppError> {
        if members
            .iter()
            .any(|m| matches!(m, CombinationMember::Combination(_)))
        {
            return Err(AppError::new(
                ErrorCode::CombinationNestingNotAllowed,
                Severity::Error,
            ));
        }
        Ok(Self {
            id: CombinationId::new(),
            name: name.into(),
            members,
        })
    }
    pub fn id(&self) -> CombinationId {
        self.id
    }
    pub fn members(&self) -> &[CombinationMember] {
        &self.members
    }
}
