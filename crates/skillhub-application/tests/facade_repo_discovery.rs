use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::sync::Arc;

use skillhub_adapters::source::RepoDiscoveryProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::source::{RepoScanState, SkillRepo, SkillRepoView};
use skillhub_core::{
    AppCommand, AppCommandResult, AppQuery, AppQueryResult, ApplicationFacade, ErrorCode,
};
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

fn scan_state(ok: bool, candidates: u32, error: Option<&str>) -> RepoScanState {
    RepoScanState {
        scanned_at: "2026-09-14T08:30:00Z".into(),
        ok,
        candidate_count: candidates,
        error: error.map(str::to_owned),
    }
}

/// 查找指定仓库的视图；测试断言的便利封装。
fn view_of<'a>(views: &'a [SkillRepoView], owner: &str, name: &str) -> &'a SkillRepoView {
    views
        .iter()
        .find(|view| view.repo.owner == owner && view.repo.name == name)
        .unwrap_or_else(|| panic!("missing repo view {owner}/{name}"))
}

async fn list_views(facade: &LocalApplicationFacade) -> Vec<SkillRepoView> {
    let result = facade
        .query(AppQuery::ListSkillRepos(skillhub_core::ListSkillRepos))
        .await
        .expect("list repos");
    let AppQueryResult::SkillRepos(views) = result else {
        panic!("expected skill repo views");
    };
    views
}

/// 多路由归档 fixture 服务器：路径前缀命中返回 zip 字节，未命中 404。
/// 请求处理在后台线程循环，直到 listener 被 drop。
fn routing_server(routes: Vec<(&'static str, Vec<u8>)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address");
    let routes: Arc<Vec<(String, Vec<u8>)>> = Arc::new(
        routes
            .into_iter()
            .map(|(prefix, body)| (prefix.to_string(), body))
            .collect(),
    );
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let routes = Arc::clone(&routes);
            std::thread::spawn(move || {
                let mut request = [0_u8; 4096];
                if stream.read(&mut request).is_err() {
                    return;
                }
                let head = String::from_utf8_lossy(&request);
                let path = head.split_whitespace().nth(1).unwrap_or("/");
                let (status, payload) = match routes
                    .iter()
                    .find(|(candidate, _)| path.starts_with(candidate.as_str()))
                {
                    Some((_, body)) => (200, body.as_slice()),
                    None => (404, b"not found".as_slice()),
                };
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    payload.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.write_all(payload);
            });
        }
    });
    format!("http://{address}")
}

/// 顶层带 GitHub 归档包装目录（{repo}-{branch}）的最小归档体。
fn repo_zip(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        for (name, body) in entries {
            zip.start_file(name, SimpleFileOptions::default())
                .expect("zip entry");
            zip.write_all(&body).expect("zip body");
        }
        zip.finish().expect("zip finish");
    }
    cursor.into_inner()
}

fn anthropics_archive() -> Vec<u8> {
    repo_zip(vec![(
        "skills-main/pdf/SKILL.md".into(),
        b"---\nname: PDF\ndescription: Handle PDF files\n---\nbody".to_vec(),
    )])
}

#[tokio::test]
async fn list_skill_repos_seeds_four_default_repos_once() {
    let facade = facade();

    let views = list_views(&facade).await;
    assert_eq!(views.len(), 4);
    assert!(views.iter().all(|view| view.repo.enabled));
    assert!(views
        .iter()
        .any(|view| view.repo.owner == "anthropics" && view.repo.name == "skills"));
    // 全新库没有任何扫描历史：每个仓库视图的 scan 都是 None。
    assert!(views.iter().all(|view| view.scan.is_none()));

    // 第二次读取来自持久化记录而不是再次播种
    let again = list_views(&facade).await;
    assert_eq!(again, views);
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
    let AppCommandResult::SkillRepos(views) = result else {
        panic!("expected skill repo views");
    };
    assert_eq!(
        views.first().map(|view| view.repo.owner.as_str()),
        Some("ComposioHQ") // 排序按字节序，大写在前
    );

    // 相同 owner+name 再次添加：替换而不是新增
    let result = facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("aaa", "zeta", "main", false),
        }))
        .await
        .expect("upsert repo");
    let AppCommandResult::SkillRepos(views) = result else {
        panic!("expected skill repo views");
    };
    assert_eq!(
        views.iter().filter(|view| view.repo.owner == "aaa").count(),
        1
    );
    let updated = view_of(&views, "aaa", "zeta");
    assert!(!updated.repo.enabled);
    assert_eq!(updated.repo.branch, "main");
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
    let AppCommandResult::SkillRepos(views) = result else {
        panic!("expected skill repo views");
    };
    assert_eq!(views.len(), 3);
    assert!(!views
        .iter()
        .any(|view| view.repo.owner == "anthropics" && view.repo.name == "skills"));

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
    let mut preferences = database
        .desktop_settings_repository()
        .get()
        .expect("preferences");
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
    let mut preferences = database
        .desktop_settings_repository()
        .get()
        .expect("preferences");
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

#[tokio::test]
async fn refresh_skill_repo_respects_the_network_switch() {
    let database = Database::open_in_memory().expect("database");
    let mut preferences = database
        .desktop_settings_repository()
        .get()
        .expect("preferences");
    preferences.network_enabled = false;
    database
        .desktop_settings_repository()
        .save(&preferences)
        .expect("save preferences");
    let facade = LocalApplicationFacade::new(database);

    let error = facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect_err("network disabled");
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
}

#[tokio::test]
async fn refresh_skill_repo_rejects_invalid_coordinates_and_unknown_entries() {
    let database = Database::open_in_memory().expect("database");
    // 直接经存储层写入越权坐标（add 命令会拒绝它们）：
    // 刷新命令必须再次校验，不信任持久化记录。
    database
        .skill_repo_repository()
        .save(&[repo("bad..owner", "skills", "main", true)])
        .expect("seed invalid coordinates");
    let facade = LocalApplicationFacade::new(database);

    let error = facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "bad..owner".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect_err("invalid coordinates must be rejected");
    assert_eq!(error.code, ErrorCode::InvalidInput);

    let unknown_repo_facade =
        LocalApplicationFacade::new(Database::open_in_memory().expect("database"));
    let error = unknown_repo_facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "not".into(),
                name: "configured".into(),
            },
        ))
        .await
        .expect_err("unknown repo must be rejected");
    assert_eq!(error.code, ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn refresh_skill_repo_scans_only_that_repo_and_records_success_state() {
    let base = routing_server(vec![(
        "/anthropics/skills/archive/refs/heads/main.zip",
        anthropics_archive(),
    )]);
    let facade = facade();
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));

    let result = facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect("refresh repo");
    let AppCommandResult::RepoDiscoveryReport(report) = result else {
        panic!("expected repo discovery report");
    };
    // 只返回该仓库的扫描结果。
    assert_eq!(report.skills.len(), 1);
    assert_eq!(report.skills[0].name, "PDF");
    assert_eq!(report.skills[0].repo_owner, "anthropics");
    assert!(report.warnings.is_empty());

    // 扫描状态被持久化并出现在列表视图中。
    let views = list_views(&facade).await;
    let view = view_of(&views, "anthropics", "skills");
    let scan = view.scan.as_ref().expect("scan state recorded");
    assert!(scan.ok);
    assert_eq!(scan.candidate_count, 1);
    assert_eq!(scan.error, None);
    // scanned_at 是秒精度 RFC3339 UTC（YYYY-MM-DDTHH:MM:SSZ）。
    assert_eq!(scan.scanned_at.len(), 20);
    assert!(scan.scanned_at.ends_with('Z'));
    assert_eq!(scan.scanned_at.as_bytes()[10], b'T');

    // 其他仓库未被本次刷新触碰。
    assert!(views
        .iter()
        .filter(|view| !(view.repo.owner == "anthropics" && view.repo.name == "skills"))
        .all(|view| view.scan.is_none()));
}

#[tokio::test]
async fn refresh_skill_repo_records_failure_state_with_error_summary() {
    // 无路由 → 归档 404：单仓失败，报告 warnings，状态记录 ok=false + 错误摘要。
    let base = routing_server(vec![]);
    let facade = facade();
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));

    let result = facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect("refresh repo still reports");
    let AppCommandResult::RepoDiscoveryReport(report) = result else {
        panic!("expected repo discovery report");
    };
    assert!(report.skills.is_empty());
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(report.warnings[0].owner, "anthropics");
    assert_eq!(report.warnings[0].name, "skills");
    assert!(!report.warnings[0].reason.is_empty());

    let views = list_views(&facade).await;
    let scan = view_of(&views, "anthropics", "skills")
        .scan
        .as_ref()
        .expect("failure state recorded");
    assert!(!scan.ok);
    assert_eq!(scan.candidate_count, 0);
    let error = scan.error.as_deref().expect("error summary kept");
    assert!(!error.is_empty());
}

// 审查 m3（2026-09-14）：钉住“显式刷新不受启停抑制”——禁用仓库被显式
// 刷新时仍会扫描并记录最近扫描状态；且刷新绝不把持久化的 enabled 翻回
// true（扫描用的 enabled=true 只存在于刷新内部副本）。
#[tokio::test]
async fn refresh_skill_repo_scans_a_disabled_repo_without_flipping_enabled() {
    let base = routing_server(vec![(
        "/anthropics/skills/archive/refs/heads/main.zip",
        anthropics_archive(),
    )]);
    let facade = facade();
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    // 先把默认种子的 anthropics/skills 禁用。
    facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("anthropics", "skills", "main", false),
        }))
        .await
        .expect("disable repo");
    assert!(
        !view_of(&list_views(&facade).await, "anthropics", "skills")
            .repo
            .enabled
    );

    let result = facade
        .execute(AppCommand::RefreshSkillRepo(
            skillhub_core::RefreshSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect("refresh disabled repo");
    let AppCommandResult::RepoDiscoveryReport(report) = result else {
        panic!("expected repo discovery report");
    };
    // 禁用仓照样完成扫描，返回它自己的发现结果。
    assert_eq!(report.skills.len(), 1);
    assert_eq!(report.skills[0].repo_owner, "anthropics");
    assert!(report.warnings.is_empty());

    // 最近一次扫描状态被持久化并回显。
    let views = list_views(&facade).await;
    let view = view_of(&views, "anthropics", "skills");
    let scan = view.scan.as_ref().expect("scan state recorded");
    assert!(scan.ok);
    assert_eq!(scan.candidate_count, 1);
    assert_eq!(scan.error, None);

    // 持久化的启停配置不被显式刷新改写：enabled 保持 false。
    assert!(!view.repo.enabled);
}

#[tokio::test]
async fn discover_repo_skills_records_per_repo_scan_state_and_skips_disabled() {
    let base = routing_server(vec![
        (
            "/anthropics/skills/archive/refs/heads/main.zip",
            anthropics_archive(),
        ),
        // cexll/myclaude 无路由 → 404 失败。
    ]);
    let facade = facade();
    facade.set_repo_discovery_provider_for_tests(Arc::new(
        RepoDiscoveryProvider::with_archive_base_for_tests(&base),
    ));
    // 只留两个仓库便于断言；cexll 先禁用。
    facade
        .execute(AppCommand::RemoveSkillRepo(
            skillhub_core::RemoveSkillRepo {
                owner: "ComposioHQ".into(),
                name: "awesome-claude-skills".into(),
            },
        ))
        .await
        .expect("remove repo");
    facade
        .execute(AppCommand::RemoveSkillRepo(
            skillhub_core::RemoveSkillRepo {
                owner: "JimLiu".into(),
                name: "baoyu-skills".into(),
            },
        ))
        .await
        .expect("remove repo");
    facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("cexll", "myclaude", "master", false),
        }))
        .await
        .expect("disable cexll");

    let result = facade
        .query(AppQuery::DiscoverRepoSkills(
            skillhub_core::DiscoverRepoSkills,
        ))
        .await
        .expect("discover");
    let AppQueryResult::RepoDiscoveryReport(report) = result else {
        panic!("expected discovery report");
    };
    assert_eq!(report.skills.len(), 1);
    assert!(report.warnings.is_empty(), "disabled repos are not scanned");

    let views = list_views(&facade).await;
    let ok_scan = view_of(&views, "anthropics", "skills")
        .scan
        .as_ref()
        .expect("success state recorded");
    assert!(ok_scan.ok);
    assert_eq!(ok_scan.candidate_count, 1);
    // 禁用的仓库不参与扫描，也没有新的扫描状态。
    assert!(view_of(&views, "cexll", "myclaude").scan.is_none());

    // 重新启用后再整体扫描：404 让它记录失败状态（含错误摘要）。
    facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("cexll", "myclaude", "master", true),
        }))
        .await
        .expect("enable cexll");
    let AppQueryResult::RepoDiscoveryReport(report) = facade
        .query(AppQuery::DiscoverRepoSkills(
            skillhub_core::DiscoverRepoSkills,
        ))
        .await
        .expect("discover again")
    else {
        panic!("expected discovery report");
    };
    assert_eq!(report.warnings.len(), 1);
    assert_eq!(report.warnings[0].owner, "cexll");

    let views = list_views(&facade).await;
    let failed_scan = view_of(&views, "cexll", "myclaude")
        .scan
        .as_ref()
        .expect("failure state recorded");
    assert!(!failed_scan.ok);
    assert_eq!(failed_scan.candidate_count, 0);
    assert!(failed_scan
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("404"));
}

#[tokio::test]
async fn remove_skill_repo_also_forgets_its_scan_state() {
    let database = Database::open_in_memory().expect("database");
    database
        .skill_repo_scan_state_repository()
        .put("anthropics", "skills", &scan_state(true, 2, None))
        .expect("seed scan state");
    let facade = LocalApplicationFacade::new(database);

    facade
        .execute(AppCommand::RemoveSkillRepo(
            skillhub_core::RemoveSkillRepo {
                owner: "anthropics".into(),
                name: "skills".into(),
            },
        ))
        .await
        .expect("remove repo");
    // 重新添加同名仓库：陈旧的扫描状态不得被误读为“最近一次扫描”。
    facade
        .execute(AppCommand::AddSkillRepo(skillhub_core::AddSkillRepo {
            repo: repo("anthropics", "skills", "main", true),
        }))
        .await
        .expect("re-add repo");

    let views = list_views(&facade).await;
    assert!(view_of(&views, "anthropics", "skills").scan.is_none());
}
