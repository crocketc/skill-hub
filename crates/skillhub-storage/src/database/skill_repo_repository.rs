use super::Database;
use rusqlite::OptionalExtension;
use skillhub_core::source::SkillRepo;
use skillhub_core::{AppError, AppResult, ErrorCode, RecoveryAction, Severity};

const KEY: &str = "skill_repos";

/// 发现模块默认仓库（实现规格 §3）。
pub fn default_skill_repos() -> Vec<SkillRepo> {
    vec![
        SkillRepo {
            owner: "anthropics".into(),
            name: "skills".into(),
            branch: "main".into(),
            enabled: true,
        },
        SkillRepo {
            owner: "ComposioHQ".into(),
            name: "awesome-claude-skills".into(),
            branch: "master".into(),
            enabled: true,
        },
        SkillRepo {
            owner: "cexll".into(),
            name: "myclaude".into(),
            branch: "master".into(),
            enabled: true,
        },
        SkillRepo {
            owner: "JimLiu".into(),
            name: "baoyu-skills".into(),
            branch: "main".into(),
            enabled: true,
        },
    ]
}

pub struct SkillRepoRepository<'a> {
    database: &'a Database,
}

impl<'a> SkillRepoRepository<'a> {
    pub(crate) fn new(database: &'a Database) -> Self {
        Self { database }
    }

    /// 仓库列表；首次读取（未配置）时写入默认 4 仓库。
    pub fn list(&self) -> AppResult<Vec<SkillRepo>> {
        let value: Option<String> = self
            .database
            .connection
            .query_row(
                "SELECT value_json FROM settings WHERE key=?1",
                [KEY],
                |row| row.get(0),
            )
            .optional()
            .map_err(database_error)?;
        match value {
            Some(json) => {
                let repos: Vec<SkillRepo> =
                    serde_json::from_str(&json).map_err(|_| invalid_record())?;
                Ok(repos)
            }
            None => {
                let repos = default_skill_repos();
                self.save(&repos)?;
                Ok(repos)
            }
        }
    }

    pub fn save(&self, repos: &[SkillRepo]) -> AppResult<()> {
        for repo in repos {
            if repo.owner.trim().is_empty() || repo.name.trim().is_empty() {
                return Err(AppError::new(ErrorCode::InvalidInput, Severity::Warning)
                    .with_param("field", "owner/name")
                    .with_action(RecoveryAction::Retry));
            }
        }
        let json = serde_json::to_string(repos).map_err(|_| invalid_record())?;
        self.database
            .connection
            .execute(
                "INSERT INTO settings(key,value_json,updated_at) VALUES(?1,?2,strftime('%s','now')) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
                rusqlite::params![KEY, json],
            )
            .map_err(database_error)?;
        Ok(())
    }
}

fn invalid_record() -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error).with_action(RecoveryAction::Retry)
}

fn database_error(error: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::InternalError, Severity::Error)
        .with_param("source", error.to_string())
        .with_action(RecoveryAction::Retry)
}

#[cfg(test)]
mod tests {
    use crate::Database;

    #[test]
    fn seeds_defaults_and_round_trips() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.skill_repo_repository();

        let seeded = repository.list().unwrap();
        assert_eq!(seeded.len(), 4);
        assert!(seeded.iter().all(|repo| repo.enabled));
        assert_eq!(seeded[0].owner, "anthropics");

        // 持久化后再次读取返回同一集合
        let mut updated = seeded.clone();
        updated.truncate(2);
        updated[0].enabled = false;
        repository.save(&updated).unwrap();
        assert_eq!(repository.list().unwrap(), updated);
    }

    #[test]
    fn rejects_repos_without_owner_or_name() {
        let database = Database::open_in_memory().unwrap();
        let repository = database.skill_repo_repository();
        let bad = vec![skillhub_core::source::SkillRepo {
            owner: " ".into(),
            name: "skills".into(),
            branch: "main".into(),
            enabled: true,
        }];
        let error = repository.save(&bad).unwrap_err();
        assert_eq!(error.code, skillhub_core::ErrorCode::InvalidInput);
    }
}
