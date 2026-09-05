use skillhub_application::LocalApplicationFacade;
use skillhub_core::source::SkillRepo;
use skillhub_core::{AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode};
use skillhub_storage::Database;

fn repo(owner: &str, name: &str, branch: &str, enabled: bool) -> SkillRepo {
    SkillRepo {
        owner: owner.into(),
        name: name.into(),
        branch: branch.into(),
        enabled,
    }
}

fn facade() -> LocalApplicationFacade {
    LocalApplicationFacade::new(Database::open_in_memory().expect("database"))
}

#[tokio::test]
async fn list_skill_repos_seeds_four_default_repos_once() {
    let facade = facade();

    let result = facade
        .query(AppQuery::ListSkillRepos(skillhub_core::ListSkillRepos))
        .await
        .expect("list repos");
    let AppQueryResult::SkillRepos(repos) = result else {
        panic!("expected skill repos");
    };
    assert_eq!(repos.len(), 4);
    assert!(repos.iter().all(|repo| repo.enabled));
    assert!(repos
        .iter()
        .any(|repo| repo.owner == "anthropics" && repo.name == "skills"));

    // 第二次读取来自持久化记录而不是再次播种
    let AppQueryResult::SkillRepos(again) = facade
        .query(AppQuery::ListSkillRepos(skillhub_core::ListSkillRepos))
        .await
        .expect("list repos again")
    else {
        panic!("expected skill repos");
    };
    assert_eq!(again, repos);
}

#[tokio::test]
async fn add_skill_repo_upserts_sorted_and_rejects_invalid_coordinates() {
    let facade = facade();

    let error = facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("bad.owner", "skills", "main", true),
        }))
        .await
        .expect_err("invalid owner");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let result = facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("aaa", "zeta", "feature/x", true),
        }))
        .await
        .expect("add repo");
    let AppCommandResult::SkillRepos(repos) = result else {
        panic!("expected skill repos");
    };
    assert_eq!(
        repos.first().map(|repo| repo.owner.as_str()),
        Some("ComposioHQ") // 排序按字节序，大写在前
    );

    // 相同 owner+name 再次添加：替换而不是新增
    let result = facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("aaa", "zeta", "main", false),
        }))
        .await
        .expect("upsert repo");
    let AppCommandResult::SkillRepos(repos) = result else {
        panic!("expected skill repos");
    };
    assert_eq!(repos.iter().filter(|repo| repo.owner == "aaa").count(), 1);
    let updated = repos.iter().find(|repo| repo.owner == "aaa").unwrap();
    assert!(!updated.enabled);
    assert_eq!(updated.branch, "main");
}

#[tokio::test]
async fn remove_skill_repo_persists_and_reports_unknown_entries() {
    let facade = facade();

    let result = facade
        .execute(AppCommand::RemoveSkillRepo(
            skillhub_core::RemoveSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect("remove repo");
    let AppCommandResult::SkillRepos(repos) = result else {
        panic!("expected skill repos");
    };
    assert_eq!(repos.len(), 3);
    assert!(!repos
        .iter()
        .any(|repo| repo.owner == "anthropics" && repo.name == "skills"));

    let error = facade
        .execute(AppCommand::RemoveSkillRepo(
            skillhub_core::RemoveSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect_err("second remove must fail");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn download_repo_skill_rejects_invalid_coordinates_before_network() {
    let facade = facade();
    let skill = skillhub_core::source::DiscoverableRepoSkill {
        key: "../evil/skills:pdf".into(),
        name: "PDF".into(),
        description: String::new(),
        directory: "pdf".into(),
        readme_url: None,
        repo_owner: "../evil".into(),
        repo_name: "skills".into(),
        repo_branch: "main".into(),
    };

    let error = facade
        .execute(AppCommand::DownloadRepoSkill(
            skillhub_core::DownloadRepoSkill { skill },
        ))
        .await
        .expect_err("invalid repo coordinates");
    assert_eq!(error.code, ErrorCode::InvalidInput);
}

#[tokio::test]
async fn discovery_query_respects_the_network_switch() {
    let database = Database::open_in_memory().expect("database");
    let mut preferences = database.desktop_settings_repository().get().expect("preferences");
    preferences.network_enabled = false;
    database
        .desktop_settings_repository()
        .save(&preferences)
        .expect("save preferences");
    let facade = LocalApplicationFacade::new(database);
    let error = facade
        .query(AppQuery::DiscoverRepoSkills(
            skillhub_core::DiscoverRepoSkills,
        ))
        .await
        .expect_err("network disabled");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}

#[tokio::test]
async fn download_repo_skill_respects_the_network_switch() {
    let database = Database::open_in_memory().expect("database");
    let mut preferences = database.desktop_settings_repository().get().expect("preferences");
    preferences.network_enabled = false;
    database
        .desktop_settings_repository()
        .save(&preferences)
        .expect("save preferences");
    let facade = LocalApplicationFacade::new(database);
    let skill = skillhub_core::source::DiscoverableRepoSkill {
        key: "anthropics/skills:pdf".into(),
        name: "PDF".into(),
        description: String::new(),
        directory: "pdf".into(),
        readme_url: None,
        repo_owner: "anthropics".into(),
        repo_name: "skills".into(),
        repo_branch: "main".into(),
    };

    let error = facade
        .execute(AppCommand::DownloadRepoSkill(
            skillhub_core::DownloadRepoSkill { skill },
        ))
        .await
        .expect_err("network disabled");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}
