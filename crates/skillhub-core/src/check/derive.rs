use super::{CheckKind, CheckRun, CheckRunPhase, CheckState};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckResult {
    pub state: CheckState,
    pub run: Option<CheckRun>,
}

impl Default for CheckResult {
    fn default() -> Self {
        Self {
            state: CheckState::NotChecked,
            run: None,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CheckProjection {
    pub basic: CheckResult,
    pub llm: CheckResult,
}

impl CheckProjection {
    pub fn apply(&mut self, run: CheckRun) {
        let result = CheckResult {
            state: derive_check_state(&run),
            run: Some(run),
        };
        match result.run.as_ref().map(|value| value.kind) {
            Some(CheckKind::Basic) => self.basic = result,
            Some(CheckKind::Llm) => self.llm = result,
            None => unreachable!("a check result always contains its run"),
        }
    }
}

pub fn derive_check_state(run: &CheckRun) -> CheckState {
    match run.phase {
        CheckRunPhase::Running => CheckState::Running,
        CheckRunPhase::Failed => CheckState::Failed,
        CheckRunPhase::Completed => {
            if run.failure_reason.is_some()
                || run.findings.iter().any(|finding| finding.is_actionable())
            {
                CheckState::Failed
            } else {
                CheckState::Passed
            }
        }
    }
}
