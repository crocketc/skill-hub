use skillhub_core::{
    source::SourceKind, AppError, AppResult, CandidateOwnership, ErrorCode, ImportAction,
    ImportCandidate, ProjectId, RecoveryAction, Severity,
};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnownAgentDirectory {
    pub root: PathBuf,
    pub profile_id: String,
    pub client_id: String,
    pub scope: String,
    pub read_only: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnownProjectDirectory {
    pub root: PathBuf,
    pub project_id: ProjectId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadOnlySkillDirectory {
    pub root: PathBuf,
    pub owner: String,
}

#[derive(Clone, Debug, Default)]
pub struct OwnershipClassifier {
    central_library_root: Option<PathBuf>,
    agent_directories: Vec<KnownAgentDirectory>,
    project_directories: Vec<KnownProjectDirectory>,
    read_only_directories: Vec<ReadOnlySkillDirectory>,
}

impl OwnershipClassifier {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_central_library_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.central_library_root = Some(root.into());
        self
    }

    pub fn with_agent_directories(
        mut self,
        directories: impl IntoIterator<Item = KnownAgentDirectory>,
    ) -> Self {
        self.agent_directories.extend(directories);
        self
    }

    pub fn with_project_directories(
        mut self,
        directories: impl IntoIterator<Item = KnownProjectDirectory>,
    ) -> Self {
        self.project_directories.extend(directories);
        self
    }

    pub fn with_read_only_directories(
        mut self,
        directories: impl IntoIterator<Item = ReadOnlySkillDirectory>,
    ) -> Self {
        self.read_only_directories.extend(directories);
        self
    }

    pub fn classify(&self, candidate: ImportCandidate) -> AppResult<ImportCandidate> {
        if candidate.source.kind != SourceKind::Local {
            return Ok(candidate.with_ownership(
                CandidateOwnership::DownloadedSource,
                ImportAction::CopyIntoLibrary,
                None,
            ));
        }

        let candidate_root = canonicalize_existing(&candidate.absolute_root)?;
        let mut matches = Vec::new();

        if let Some(root) = &self.central_library_root {
            let skills_root = canonicalize_existing(root.join("skills"))
                .or_else(|_| canonicalize_existing(root))?;
            push_match(
                &mut matches,
                &candidate_root,
                &skills_root,
                CandidateOwnership::CentralLibrary,
                ImportAction::UseExistingManagedSkill,
                None,
            );
        }

        for directory in &self.agent_directories {
            let root = canonicalize_existing(&directory.root)?;
            let (ownership, action, detail) = if directory.read_only {
                (
                    CandidateOwnership::ReadOnlyBuiltinOrPlugin,
                    ImportAction::CopyAsIndependentManagedSkill,
                    Some(agent_detail(directory)),
                )
            } else {
                (
                    CandidateOwnership::KnownAgentTarget,
                    ImportAction::EstablishManagedRelation,
                    Some(agent_detail(directory)),
                )
            };
            push_match(
                &mut matches,
                &candidate_root,
                &root,
                ownership,
                action,
                detail,
            );
        }

        for directory in &self.project_directories {
            let root = canonicalize_existing(&directory.root)?;
            push_match(
                &mut matches,
                &candidate_root,
                &root,
                CandidateOwnership::RegisteredProject,
                ImportAction::EstablishManagedRelation,
                Some(directory.project_id.to_string()),
            );
        }

        for directory in &self.read_only_directories {
            let root = canonicalize_existing(&directory.root)?;
            push_match(
                &mut matches,
                &candidate_root,
                &root,
                CandidateOwnership::ReadOnlyBuiltinOrPlugin,
                ImportAction::CopyAsIndependentManagedSkill,
                Some(directory.owner.clone()),
            );
        }

        matches.sort_by(|left, right| {
            right
                .root_depth
                .cmp(&left.root_depth)
                .then_with(|| ownership_rank(right.ownership).cmp(&ownership_rank(left.ownership)))
        });

        if let Some(best) = matches.into_iter().next() {
            return Ok(candidate.with_ownership(best.ownership, best.action, best.detail));
        }

        Ok(candidate.with_ownership(
            CandidateOwnership::ArbitraryLocalDirectory,
            ImportAction::CopyIntoLibrary,
            None,
        ))
    }
}

#[derive(Clone, Debug)]
struct OwnershipMatch {
    root_depth: usize,
    ownership: CandidateOwnership,
    action: ImportAction,
    detail: Option<String>,
}

fn push_match(
    matches: &mut Vec<OwnershipMatch>,
    candidate_root: &Path,
    registered_root: &Path,
    ownership: CandidateOwnership,
    action: ImportAction,
    detail: Option<String>,
) {
    if candidate_root.starts_with(registered_root) {
        matches.push(OwnershipMatch {
            root_depth: registered_root.components().count(),
            ownership,
            action,
            detail,
        });
    }
}

fn ownership_rank(ownership: CandidateOwnership) -> u8 {
    match ownership {
        CandidateOwnership::ReadOnlyBuiltinOrPlugin => 6,
        CandidateOwnership::CentralLibrary => 5,
        CandidateOwnership::RegisteredProject => 4,
        CandidateOwnership::KnownAgentTarget => 3,
        CandidateOwnership::ArbitraryLocalDirectory => 2,
        CandidateOwnership::DownloadedSource => 1,
        CandidateOwnership::Unclassified => 0,
    }
}

fn agent_detail(directory: &KnownAgentDirectory) -> String {
    format!(
        "{}:{}:{}",
        directory.profile_id, directory.client_id, directory.scope
    )
}

fn canonicalize_existing(path: impl AsRef<Path>) -> AppResult<PathBuf> {
    path.as_ref()
        .canonicalize()
        .map_err(|error| io_error(path.as_ref(), error))
}

fn io_error(path: &Path, error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("path", path.to_string_lossy().into_owned())
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}
