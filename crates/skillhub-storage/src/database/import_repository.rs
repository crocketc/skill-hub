use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::import::{
    analyze_import, CandidateOwnership, ExistingSkillRecord, ImportAnalysis, ImportCandidate,
};
use skillhub_core::source::{SourceDescriptor, SourceKind, SourceLocator};
use skillhub_core::{AppError, AppResult, ErrorCode, Severity, SkillId};

/// Read-only projection of catalog data used during import conflict analysis.
pub struct ImportRepository<'a> {
    database: &'a Database,
}

impl<'a> ImportRepository<'a> {
    pub fn new(database: &'a Database) -> Self {
        Self { database }
    }

    pub fn list_existing(&self) -> AppResult<Vec<ExistingSkillRecord>> {
        let mut statement = self
            .database
            .connection
            .prepare(
                "SELECT s.id, s.runtime_name, v.content_hash, s.ownership \
                 FROM skills s \
                 LEFT JOIN current_pointers p ON p.skill_id=s.id \
                 LEFT JOIN versions v ON v.id=p.version_id \
                 ORDER BY s.id ASC",
            )
            .map_err(error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(error)?;
        rows.map(|row| {
            let (id, runtime_name, tree_hash, ownership) = row.map_err(error)?;
            let skill_id = id.parse().map_err(|_| invalid_id())?;
            Ok(ExistingSkillRecord {
                skill_id,
                runtime_name,
                tree_hash,
                source: self.source_for(skill_id)?,
                ownership: parse_ownership(&ownership),
                // FTS/BM25 scores are supplied by the search projection when
                // available; absence is explicit and never inferred as a match.
                fts_similarity_basis_points: None,
                matched_fields: Vec::new(),
            })
        })
        .collect()
    }

    pub fn analyze(
        &self,
        candidate: ImportCandidate,
        candidate_tree_hash: Option<&str>,
    ) -> AppResult<ImportAnalysis> {
        let existing = self.list_existing()?;
        Ok(analyze_import(candidate, candidate_tree_hash, &existing))
    }

    fn source_for(&self, skill_id: SkillId) -> AppResult<Option<SourceDescriptor>> {
        let row: Option<(String, String)> = self
            .database
            .connection
            .query_row(
                "SELECT s.kind, s.locator FROM sources s \
                 JOIN skill_sources ss ON ss.source_id=s.id \
                 WHERE ss.skill_id=?1 ORDER BY s.id ASC LIMIT 1",
                [skill_id.to_string()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(error)?;
        row.map(|(kind, locator)| parse_source(&kind, &locator))
            .transpose()
    }
}

fn parse_source(kind: &str, locator: &str) -> AppResult<SourceDescriptor> {
    let (kind, locator) = match kind {
        "local" => (SourceKind::Local, SourceLocator::local_path(locator)),
        "https" => (SourceKind::Https, SourceLocator::https_url(locator)),
        "git" => (SourceKind::Git, SourceLocator::git_url(locator)),
        _ => return Err(AppError::new(ErrorCode::InvalidInput, Severity::Error)),
    };
    Ok(SourceDescriptor::new(kind, locator))
}

fn parse_ownership(value: &str) -> CandidateOwnership {
    match value {
        "known_agent_target" => CandidateOwnership::KnownAgentTarget,
        "registered_project" => CandidateOwnership::RegisteredProject,
        "read_only_builtin_or_plugin" => CandidateOwnership::ReadOnlyBuiltinOrPlugin,
        "arbitrary_local_directory" => CandidateOwnership::ArbitraryLocalDirectory,
        "downloaded_source" => CandidateOwnership::DownloadedSource,
        _ => CandidateOwnership::CentralLibrary,
    }
}

fn invalid_id() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
}

fn error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_param("source", error.to_string())
}
