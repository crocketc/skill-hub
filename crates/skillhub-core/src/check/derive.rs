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
        let target = match run.kind {
            CheckKind::Basic => &mut self.basic,
            CheckKind::Llm => &mut self.llm,
        };
        if target
            .run
            .as_ref()
            .is_some_and(|current| !is_newer(&run, current))
        {
            return;
        }
        let result = CheckResult {
            state: derive_check_state(&run),
            run: Some(run),
        };
        *target = result;
    }
}

pub fn derive_check_state(run: &CheckRun) -> CheckState {
    match run.phase {
        CheckRunPhase::NotChecked => CheckState::NotChecked,
        CheckRunPhase::Running => CheckState::Running,
        CheckRunPhase::Failed => CheckState::Failed,
        CheckRunPhase::Completed => {
            if run.failure_code.is_some()
                || run.findings.iter().any(|finding| finding.is_actionable())
            {
                CheckState::Failed
            } else {
                CheckState::Passed
            }
        }
    }
}

fn is_newer(candidate: &CheckRun, current: &CheckRun) -> bool {
    (
        candidate.generation,
        candidate.started_at,
        candidate.ended_at.unwrap_or(-1),
        phase_sequence(candidate.phase),
        candidate.id.as_str(),
    ) > (
        current.generation,
        current.started_at,
        current.ended_at.unwrap_or(-1),
        phase_sequence(current.phase),
        current.id.as_str(),
    )
}

fn phase_sequence(phase: CheckRunPhase) -> u8 {
    match phase {
        CheckRunPhase::NotChecked => 0,
        CheckRunPhase::Running => 1,
        CheckRunPhase::Completed | CheckRunPhase::Failed => 2,
    }
}
