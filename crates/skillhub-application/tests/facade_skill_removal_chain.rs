//! #12：主体删除的关系链、错误分类与导入回滚（facade 层回归）。
//!
//! 裁决口径（2026-10-07）：主体名下全部使用关系随删除一并清理（"相当于
//! 恢复到没导入状态"），存证事件随之删除；原件文件一律不动；链接部署的
//! 链接文件随 RemoveOwnedTarget 删除；复制部署副本默认保留
//! （KeepSharedDeployment，降级为独立副本）。中央删除失败必须透出
//! `database.constraint` 稳定错误码而不是 `internal.error`。
//!
//! 存储层全链行为由 `skillhub-storage/tests/skill_removal_chain.rs` 覆盖；
//! 本文件在 facade 层覆盖四个此前缺失的回归面：
//! 1. 全链删除经生产 delete 路径成功，且可见树/原件/他人数据符合裁决；
//! 2. 导入回滚路径（cleanup_import_state）复用同一清理链，无半程残留；
//! 3. 中央删除失败透出 `database.constraint`（此前是 `internal.error`）；
//! 4. 链接/复制部署的删除边界（链接文件删、副本默认留）。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryPrecedence, DiscoverySnapshot,
    LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{
    AppCommand, AppCommandResult, CommitDeleteSkill, CommitDeployment, CommitImport,
    GetDeploymentPlan, PrepareDeleteSkill, PrepareDeployment, PrepareImport,
};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::deployment::DeploymentMode;
use skillhub_core::{
    ApplicationFacade, ErrorCode, RemovalChoice, RemovalDecision, RemovalResultState,
};
use skillhub_storage::{CentralLibrary, Database, VersionStore};

// ===== 夹具：集中库工作区 + 已入库主体（同 facade_removal_draft_cascade） =====

struct Workspace {
    _root: tempfile::TempDir,
    library_root: std::path::PathBuf,
    database_path: std::path::PathBuf,
}

fn workspace() -> Workspace {
    let root = tempfile::tempdir().expect("workspace root");
    let database_path = root.path().join("skillhub.sqlite");
    let library_root = root.path().join("library");
    Workspace {
        _root: root,
        library_root,
        database_path,
    }
}

/// 已入库的单版本 Skill：store 指针、portable、可见树就绪，可走完整删除链。
/// 返回捕获的版本 id，供外键投影行引用。
fn seed_imported_skill(
    library: &CentralLibrary,
    database: &Database,
    name: &str,
    source_dir: &std::path::Path,
) -> (Skill, skillhub_core::VersionId) {
    let skill = Skill::new(skillhub_core::SkillId::new(), name);
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert_sync(&skill)
        .expect("insert skill");
    std::fs::create_dir_all(source_dir).expect("create source dir");
    std::fs::write(source_dir.join("SKILL.md"), format!("# {name}\n")).expect("write source");
    let store = VersionStore::from_library(library);
    let version = store
        .capture(skill.id(), source_dir)
        .expect("capture version");
    store
        .set_current(skill.id(), &version.id)
        .expect("set current");
    library
        .save_portable_skill(&skill, Some(&version.id))
        .expect("save portable metadata");
    library
        .materialize_current_skill(&skill, &version.id)
        .expect("materialize visible tree");
    (skill, version.id)
}

async fn prepare_delete(
    facade: &LocalApplicationFacade,
    skill_id: skillhub_core::SkillId,
) -> skillhub_core::RemovalImpact {
    let prepared = facade
        .execute(AppCommand::PrepareDeleteSkill(PrepareDeleteSkill {
            skill_id,
        }))
        .await
        .expect("prepare delete");
    let AppCommandResult::RemovalImpact(impact) = prepared else {
        panic!("expected removal impact");
    };
    impact
}

async fn commit_delete(
    facade: &LocalApplicationFacade,
    operation_id: skillhub_core::OperationId,
    decisions: Vec<RemovalChoice>,
) -> skillhub_core::RemovalResult {
    let committed = facade
        .execute(AppCommand::CommitDeleteSkill(CommitDeleteSkill {
            prepared_delete_id: operation_id,
            decisions,
        }))
        .await
        .expect("commit delete");
    let AppCommandResult::RemovalResult(result) = committed else {
        panic!("expected removal result");
    };
    result
}

// ===== 夹具：导入提交（同 facade_import_check_record） =====

async fn prepare_import(
    facade: &LocalApplicationFacade,
    root: &std::path::Path,
    name: &str,
) -> Box<skillhub_core::PreparedImport> {
    let candidate = skillhub_core::ImportCandidate::detected(
        skillhub_core::SourceDescriptor::new(
            skillhub_core::SourceKind::Local,
            skillhub_core::SourceLocator::local_path(root),
        ),
        root.to_string_lossy(),
        ".",
        "SKILL.md",
        name,
    );
    let prepared = facade
        .execute(AppCommand::PrepareImport(PrepareImport {
            candidate,
            tree_hash: None,
            runtime_name_override: None,
        }))
        .await
        .expect("prepared import");
    let AppCommandResult::PreparedImport(prepared) = prepared else {
        panic!("expected prepared import");
    };
    prepared
}

async fn commit_import(
    facade: &LocalApplicationFacade,
    prepared: &skillhub_core::PreparedImport,
    decision: skillhub_core::ImportDecision,
) -> Result<Box<skillhub_core::ImportSummary>, skillhub_core::AppError> {
    let committed = facade
        .execute(AppCommand::CommitImport(CommitImport {
            prepared_import_id: prepared.id,
            decision,
            governance_decision: skillhub_core::ImportGovernanceDecision {
                group_actions: prepared
                    .analysis
                    .governance_groups
                    .iter()
                    .map(|group| (group.group_id.clone(), group.default_action))
                    .collect(),
                item_overrides: Default::default(),
            },
            batch_id: None,
            candidate_key: None,
            runtime_name_override: None,
            batch_signature: None,
            security_decision: None,
        }))
        .await;
    match committed {
        Ok(AppCommandResult::ImportSummary(summary)) => Ok(summary),
        Ok(other) => panic!("expected import summary, got {other:?}"),
        Err(error) => Err(error),
    }
}

// ===== 夹具：真实 schema 上的关系链种子行（同存储层 skill_removal_chain） =====

/// 给一个已入库主体种上完整的导入/投影链行。`skill`/`version` 用真实 id；
/// capture 只写对象库，versions 行在此显式补齐供外键投影引用。
fn seed_import_chain(connection: &rusqlite::Connection, skill: &str, version: &str) {
    connection
        .execute(
            "INSERT OR IGNORE INTO versions(id,skill_id,content_hash,manifest_json,created_at) VALUES(?1,?2,'hash','{}',1)",
            rusqlite::params![version, skill],
        )
        .expect("seed version row");
    connection
        .execute_batch(&format!(
            "INSERT INTO sources(id,kind,locator,created_at) VALUES('src-{k}','local','/fixture/{k}',1);
             INSERT INTO skill_sources(skill_id,source_id) VALUES('{k}','src-{k}');
             INSERT INTO tags(id,name) VALUES('tag-{k}','tag-{k}');
             INSERT INTO skill_tags(skill_id,tag_id) VALUES('{k}','tag-{k}');
             INSERT OR IGNORE INTO catalog_skill_metadata(skill_id,requirements_json) VALUES('{k}','[]');
             INSERT INTO import_batches(batch_id,status,started_at) VALUES('batch-{k}','completed',1);
             INSERT INTO import_provenance_events_v19(provenance_id,skill_id,source_path,source_path_key,relationship,file_representation,ownership,content_fingerprint,source_kind,source_locator,imported_at,batch_id,source_class)
               VALUES('ev1-{k}','{k}','C:/src/{k}','c:/src/{k}','import_copy','directory','observed_unmanaged','fp-{k}','local','C:/src/{k}',1,'batch-{k}','user_local'),
                      ('ev2-{k}','{k}','C:/src2/{k}','c:/src2/{k}','import_copy','directory','observed_unmanaged','fp2-{k}','local','C:/src2/{k}',2,'batch-{k}','user_local');
             INSERT INTO source_copy_relations(relation_id,skill_id,latest_provenance_id,physical_source_id,identity_algorithm,identity_version,source_path_key,active,fact_json)
               VALUES('sr-{k}','{k}','ev1-{k}','phys-{k}','path-v1',1,'c:/src/{k}',1,'{{}}');
             INSERT INTO import_batch_items(batch_id,candidate_key,skill_id,provenance_id,source_relation_id,status)
               VALUES('batch-{k}','item-by-skill','{k}',NULL,NULL,'succeeded'),
                      ('batch-{k}','item-by-provenance','{k}','ev1-{k}',NULL,'succeeded'),
                      ('batch-{k}','item-by-relation','{k}',NULL,'sr-{k}','succeeded');
             INSERT INTO original_migrations(id,skill_id,original_path,backup_path,content_fingerprint,state,confirmed_at,source_relation_id)
               VALUES('mig-{k}','{k}','C:/src/{k}','C:/backup/{k}','fp-{k}','Migrated',1,'sr-{k}');
             INSERT INTO directory_nodes(node_id,path,path_key,role,exists_flag,observed_at)
               VALUES('node-{k}','C:/agents/{k}','c:/agents/{k}','agent_native',1,1);
             INSERT INTO deployment_relations(relation_id,skill_id,agent_client_id,path,path_key,directory_node_id,relationship,file_representation,ownership,content_fingerprint,origin,match_state,active,observed_at)
               VALUES('rel-{k}','{k}','agent-{k}','C:/agents/{k}','c:/agents/{k}','node-{k}','import_copy','directory','observed_unmanaged','fp-{k}','scan','content_verified',1,1);
             INSERT INTO observed_deployments(id,skill_id,client_id,original_path,path_key,content_fingerprint,match_state,origin,status,observed_at)
               VALUES('obs-{k}','{k}','agent-{k}','C:/observed/{k}','c:/observed/{k}','fp-{k}','content_verified','import','active',1);
             INSERT INTO search_display_names(skill_id,display_name) VALUES('{k}','Name {k}');
             INSERT INTO skills_fts(skill_id,display_name,runtime_name,original_description) VALUES('{k}','Name {k}','{k}','desc');
             INSERT INTO translation_records(skill_id,language,translated_text,source_description_hash,provider,model,origin,created_at,updated_at)
               VALUES('{k}','zh-CN','译文','h','provider','model','generated',1,1);
             INSERT INTO security_alerts(skill_id,version_id,level,state,decided_at,decision_source)
               VALUES('{k}','{v}','warning','alert',1,'import');
             INSERT INTO version_labels(version_id,skill_id,label,created_at,updated_at)
               VALUES('{v}','{k}','label-{k}',1,1);
             INSERT INTO check_runs(id,skill_id,version_id,kind,state,started_at)
               VALUES('run-{k}','{k}','{v}','basic','passed',1);
             INSERT INTO check_findings(id,run_id,code,severity) VALUES('finding-{k}','run-{k}','some_code','warning');
             INSERT INTO source_update_checks(skill_id,state,checked_at) VALUES('{k}','up_to_date',1);
             INSERT INTO combinations(id,name,created_at,updated_at) VALUES('combo-{k}','combo-{k}',1,1);
             INSERT INTO combination_skills(combination_id,skill_id,position) VALUES('combo-{k}','{k}',0);
             INSERT INTO skill_lineage(skill_id,version_id,origin_skill_id,origin_version_id,created_at)
               VALUES('{k}','{v}','origin-outside','origin-version',1);",
            k = skill,
            v = version,
        ))
        .expect("seed import chain rows");
}

/// 跨主体引用行：谱系子主体把被删技能记为上游（origin_skill_id 无外键），
/// 冲突案两名成员分别指向两个主体及其存证。
fn seed_cross_references(connection: &rusqlite::Connection, doomed: &str, survivor: &str) {
    let child = "00000000-0000-0000-0000-0000000000c0";
    connection
        .execute_batch(&format!(
            "INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES('{child}','LineageChild','lineage-child',1,1);
             INSERT INTO skill_lineage(skill_id,version_id,origin_skill_id,origin_version_id,created_at) VALUES('{child}','child-version','{d}','origin-version',1);
             INSERT INTO conflict_cases(conflict_id,kind,classification,evidence_json) VALUES('case-1','duplicate_same_content','same_skill_version','{{}}');
             INSERT INTO conflict_case_members(member_id,conflict_id,skill_id,provenance_id,path) VALUES('member-doomed','case-1','{d}','ev1-{d}','C:/a'),
               ('member-survivor','case-1','{s}','ev1-{s}','C:/b');",
            d = doomed,
            s = survivor,
        ))
        .expect("seed cross references");
}

// ===== 测试 1：facade 删除清空全链，原件/可见树/他人数据符合裁决 =====

#[tokio::test]
async fn delete_clears_the_full_import_chain_and_keeps_the_original_files() {
    let ws = workspace();
    let library = CentralLibrary::initialize(&ws.library_root).expect("initialize central library");
    let database = Database::open(&ws.database_path).expect("open database");
    let doomed_source = ws._root.path().join("originals").join("doomed-src");
    let survivor_source = ws._root.path().join("originals").join("survivor-src");
    let (skill, doomed_version) =
        seed_imported_skill(&library, &database, "Doomed", &doomed_source);
    let (other, survivor_version) =
        seed_imported_skill(&library, &database, "Untouched", &survivor_source);
    {
        let connection = database.connection_for_test();
        seed_import_chain(
            connection,
            &skill.id().to_string(),
            &doomed_version.to_string(),
        );
        seed_import_chain(
            connection,
            &other.id().to_string(),
            &survivor_version.to_string(),
        );
        seed_cross_references(connection, &skill.id().to_string(), &other.id().to_string());
    }
    let skills_dir = ws.library_root.join("skills");
    assert_eq!(
        std::fs::read_dir(&skills_dir).expect("skills dir").count(),
        2,
        "both subjects start with a visible tree"
    );

    let facade = LocalApplicationFacade::new_with_library(database, &ws.library_root);
    let impact = prepare_delete(&facade, skill.id()).await;
    let result = commit_delete(&facade, impact.operation_id, Vec::new()).await;
    assert!(
        result.central_skill_deleted,
        "the full-chain subject must delete successfully through the facade"
    );
    assert_eq!(result.state, RemovalResultState::Committed);

    let audit = Database::open(&ws.database_path).expect("reopen database");
    let connection = audit.connection_for_test();
    let doomed = skill.id().to_string();
    let survivor = other.id().to_string();
    for (table, sql) in [
        ("skills", "SELECT COUNT(*) FROM skills WHERE id=?1"),
        (
            "current_pointers",
            "SELECT COUNT(*) FROM current_pointers WHERE skill_id=?1",
        ),
        (
            "versions",
            "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
        ),
        (
            "import_provenance_events_v19",
            "SELECT COUNT(*) FROM import_provenance_events_v19 WHERE skill_id=?1",
        ),
        (
            "source_copy_relations",
            "SELECT COUNT(*) FROM source_copy_relations WHERE skill_id=?1",
        ),
        (
            "import_batch_items",
            "SELECT COUNT(*) FROM import_batch_items WHERE skill_id=?1",
        ),
        (
            "original_migrations",
            "SELECT COUNT(*) FROM original_migrations WHERE skill_id=?1",
        ),
        (
            "deployment_relations",
            "SELECT COUNT(*) FROM deployment_relations WHERE skill_id=?1",
        ),
        (
            "observed_deployments",
            "SELECT COUNT(*) FROM observed_deployments WHERE skill_id=?1",
        ),
        (
            "skills_fts",
            "SELECT COUNT(*) FROM skills_fts WHERE skill_id=?1",
        ),
        (
            "search_display_names",
            "SELECT COUNT(*) FROM search_display_names WHERE skill_id=?1",
        ),
        (
            "check_runs",
            "SELECT COUNT(*) FROM check_runs WHERE skill_id=?1",
        ),
        (
            "skill_lineage(subject)",
            "SELECT COUNT(*) FROM skill_lineage WHERE skill_id=?1",
        ),
        (
            "skill_lineage(origin)",
            "SELECT COUNT(*) FROM skill_lineage WHERE origin_skill_id=?1",
        ),
        (
            "combination_skills",
            "SELECT COUNT(*) FROM combination_skills WHERE skill_id=?1",
        ),
    ] {
        let rows: i64 = connection
            .query_row(sql, [&doomed], |row| row.get(0))
            .expect("count query");
        assert_eq!(rows, 0, "{table} must not keep rows for the removed skill");
    }

    // 冲突案保留，被删成员降级为 NULL；幸存成员不受影响。
    let (member_skill, member_provenance): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT skill_id,provenance_id FROM conflict_case_members WHERE member_id='member-doomed'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("doomed member row");
    assert_eq!(member_skill, None, "doomed member degrades to NULL skill");
    assert_eq!(
        member_provenance, None,
        "doomed member degrades to NULL provenance evidence"
    );
    let survivor_member: (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT skill_id,provenance_id FROM conflict_case_members WHERE member_id='member-survivor'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("survivor member row");
    assert_eq!(
        survivor_member.0.as_deref(),
        Some(survivor.as_str()),
        "the survivor member keeps its skill link"
    );

    // 谱系子主体本体行保留（清的是 origin 指向，不是子主体）。
    let child_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM skills WHERE id='00000000-0000-0000-0000-0000000000c0'",
            [],
            |row| row.get(0),
        )
        .expect("lineage child row");
    assert_eq!(child_rows, 1, "the lineage child subject itself survives");

    // 幸存主体与其他技能数据完全不受影响。（current_pointers 的库内行只由
    // 导入流程写入，本夹具未种；store 指针断言在下方。存证与批项按种子数
    // 在下方单独断言。）
    for (table, sql) in [
        ("skills", "SELECT COUNT(*) FROM skills WHERE id=?1"),
        (
            "versions",
            "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
        ),
    ] {
        let rows: i64 = connection
            .query_row(sql, [&survivor], |row| row.get(0))
            .expect("survivor count query");
        assert_eq!(rows, 1, "the survivor skill keeps its {table} row");
    }
    let survivor_provenance: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM import_provenance_events_v19 WHERE skill_id=?1",
            [&survivor],
            |row| row.get(0),
        )
        .expect("survivor provenance count");
    assert_eq!(
        survivor_provenance, 2,
        "the survivor keeps both seeded provenance events"
    );
    let survivor_items: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM import_batch_items WHERE skill_id=?1",
            [&survivor],
            |row| row.get(0),
        )
        .expect("survivor batch item count");
    assert_eq!(
        survivor_items, 3,
        "the survivor keeps all three seeded batch items"
    );
    // 幸存主体的 store 当前版本指针原样可用（删除只清被删主体）。
    let survivor_pointer = VersionStore::from_library(&library)
        .current(other.id())
        .expect("read survivor pointer")
        .expect("survivor pointer survives");
    assert_eq!(
        survivor_pointer, survivor_version,
        "the survivor's current version pointer is untouched"
    );

    // 可见树只剩幸存主体的；用户原件文件一律不动。
    assert_eq!(
        std::fs::read_dir(&skills_dir).expect("skills dir").count(),
        1,
        "only the survivor's visible tree remains"
    );
    assert!(
        doomed_source.join("SKILL.md").is_file(),
        "the user's original source file must be untouched"
    );
    assert!(
        survivor_source.join("SKILL.md").is_file(),
        "the survivor's original source file must be untouched"
    );
}

// ===== 测试 2：导入回滚（cleanup_import_state）清空全链存证 =====

/// 导入提交在最后一步（冲突案落库）被注入失败时，整条导入链——包括已
/// 落库的存证事件、批次项与来源副本关系——必须随 cleanup_import_state
/// 一并回滚，不留"看似成功"的半程状态；错误保持原错误码而不是
/// "清理也失败"的 OperationConflict 包装。
#[tokio::test]
async fn failed_import_rolls_back_the_full_evidence_chain() {
    let ws = workspace();
    let facade_ws = LocalApplicationFacade::new_with_library(
        Database::open(&ws.database_path).expect("open database"),
        &ws.library_root,
    );
    let first_source = tempfile::tempdir().expect("first source");
    std::fs::write(
        first_source.path().join("SKILL.md"),
        "---\nname: Notes\ndescription: first\n---\n\n# Notes v1\n",
    )
    .expect("write first skill");
    let first = prepare_import(&facade_ws, first_source.path(), "Notes").await;
    commit_import(
        &facade_ws,
        &first,
        skillhub_core::ImportDecision::CopyIntoLibrary,
    )
    .await
    .expect("first import succeeds");

    // 基线：第一次导入落库后的全链计数。
    let baseline = {
        let database = Database::open(&ws.database_path).expect("reopen database");
        let connection = database.connection_for_test();
        let count = |sql: &str| -> i64 {
            connection
                .query_row(sql, [], |row| row.get(0))
                .expect("count")
        };
        (
            count("SELECT COUNT(*) FROM skills"),
            count("SELECT COUNT(*) FROM versions"),
            count("SELECT COUNT(*) FROM import_provenance_events_v19"),
            count("SELECT COUNT(*) FROM source_copy_relations"),
            count("SELECT COUNT(*) FROM import_batch_items"),
            count("SELECT COUNT(*) FROM skills_fts"),
        )
    };
    assert_eq!(baseline.0, 1, "exactly one subject after the first import");

    // 注入确定性失败：冲突案表拒绝一切插入（提交链的最后一步）。
    facade_ws
        .database_for_tests()
        .lock()
        .expect("database lock")
        .connection_for_test()
        .execute_batch(
            "CREATE TRIGGER block_conflict_cases BEFORE INSERT ON conflict_cases
             BEGIN SELECT RAISE(ABORT, 'injected conflict case failure'); END;",
        )
        .expect("inject failing trigger");

    let second_source = tempfile::tempdir().expect("second source");
    std::fs::write(
        second_source.path().join("SKILL.md"),
        "---\nname: Notes\ndescription: different\n---\n\n# Notes v2\n",
    )
    .expect("write second skill");
    let second = prepare_import(&facade_ws, second_source.path(), "Notes").await;
    let error = commit_import(
        &facade_ws,
        &second,
        skillhub_core::ImportDecision::KeepIndependent,
    )
    .await
    .expect_err("a failing conflict case write must fail the import");
    assert_eq!(
        error.code,
        ErrorCode::InternalError,
        "the original error surfaces; an OperationConflict wrapper would mean the rollback itself failed"
    );

    // 无半程状态：第二个主体的整条导入链（含存证）全部回滚。
    let audit = Database::open(&ws.database_path).expect("reopen database");
    let connection = audit.connection_for_test();
    let count = |sql: &str| -> i64 {
        connection
            .query_row(sql, [], |row| row.get(0))
            .expect("count")
    };
    assert_eq!(count("SELECT COUNT(*) FROM skills"), baseline.0, "skills");
    assert_eq!(
        count("SELECT COUNT(*) FROM versions"),
        baseline.1,
        "versions"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM import_provenance_events_v19"),
        baseline.2,
        "provenance events roll back with the failed import"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM source_copy_relations"),
        baseline.3,
        "source copy relations roll back with the failed import"
    );
    assert_eq!(count("SELECT COUNT(*) FROM skills_fts"), baseline.5, "fts");
    // 失败证据行按设计保留：失败批项以 (batch_id, candidate_key) 记录一次
    // 失败尝试，不指向任何主体（skill_id 为空）；指向主体的成功批项不增。
    let owned_items: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM import_batch_items WHERE skill_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("owned batch item count");
    assert_eq!(
        owned_items, baseline.4,
        "batch items owned by a subject roll back with the failed import"
    );
    let failed_items: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM import_batch_items WHERE status='failed' AND skill_id IS NULL",
            [],
            |row| row.get(0),
        )
        .expect("failed batch item count");
    assert_eq!(
        failed_items, 1,
        "the failed attempt keeps exactly one failure evidence row"
    );
    let skills_dir = ws.library_root.join("skills");
    assert_eq!(
        std::fs::read_dir(&skills_dir).expect("skills dir").count(),
        1,
        "only the first import's visible tree survives"
    );
}

// ===== 测试 3：中央删除失败透出 database.constraint =====

/// 幸存主体的迁移审计行指向被删主体的来源副本关系（NO ACTION 外键），
/// 清理链在 source_copy_relations 一步被拦下。该失败必须以
/// `database.constraint` 稳定错误码进入部分结果（此前分类为
/// `internal.error`，前端无从区分）。
#[tokio::test]
async fn central_delete_failure_surfaces_database_constraint() {
    let ws = workspace();
    let library = CentralLibrary::initialize(&ws.library_root).expect("initialize central library");
    let database = Database::open(&ws.database_path).expect("open database");
    let doomed_source = tempfile::tempdir().expect("doomed source");
    let survivor_source = tempfile::tempdir().expect("survivor source");
    let (skill, doomed_version) =
        seed_imported_skill(&library, &database, "Doomed", doomed_source.path());
    let (other, _) = seed_imported_skill(&library, &database, "Untouched", survivor_source.path());
    let doomed = skill.id().to_string();
    {
        let connection = database.connection_for_test();
        // 被删主体的来源副本关系（删除链在第 6 步删除它）。
        connection
            .execute_batch(&format!(
                "INSERT INTO import_batches(batch_id,status,started_at) VALUES('batch-{d}','completed',1);
                 INSERT INTO import_provenance_events_v19(provenance_id,skill_id,source_path,source_path_key,relationship,file_representation,ownership,content_fingerprint,source_kind,source_locator,imported_at,batch_id,source_class)
                   VALUES('ev1-{d}','{d}','C:/src/{d}','c:/src/{d}','import_copy','directory','observed_unmanaged','fp','local','C:/src',1,'batch-{d}','user_local');
                 INSERT INTO source_copy_relations(relation_id,skill_id,latest_provenance_id,physical_source_id,identity_algorithm,identity_version,source_path_key,active,fact_json)
                   VALUES('sr-{d}','{d}','ev1-{d}','phys','path-v1',1,'c:/src',1,'{{}}');
                 INSERT OR IGNORE INTO versions(id,skill_id,content_hash,manifest_json,created_at) VALUES('{v}','{d}','hash','{{}}',1);",
                d = doomed,
                v = doomed_version,
            ))
            .expect("seed doomed relation rows");
        // 幸存主体的迁移审计行跨主体指向 sr-doomed：NO ACTION 拦下删除。
        connection
            .execute(
                "INSERT INTO original_migrations(id,skill_id,original_path,backup_path,content_fingerprint,state,confirmed_at,restored_relation_id) VALUES('mig-cross',?1,'C:/x','C:/y','fp','RolledBack',1,?2)",
                rusqlite::params![other.id().to_string(), format!("sr-{doomed}")],
            )
            .expect("seed cross migration row");
    }

    let facade = LocalApplicationFacade::new_with_library(database, &ws.library_root);
    let impact = prepare_delete(&facade, skill.id()).await;
    let result = commit_delete(&facade, impact.operation_id, Vec::new()).await;

    assert!(
        !result.central_skill_deleted,
        "the constrained deletion must not report success"
    );
    assert_eq!(result.state, RemovalResultState::PartiallyCommitted);
    assert_eq!(
        result.central_delete_error,
        Some(ErrorCode::DatabaseConstraint),
        "the constraint failure must surface database.constraint, not internal.error"
    );
    assert!(
        result.recovery_operation_id.is_some(),
        "the partial result must reference the recovery candidate"
    );
    // 清理链整体回滚：主体行一个未少。
    let audit = Database::open(&ws.database_path).expect("reopen database");
    assert!(
        audit
            .catalog_repository()
            .expect("catalog repository")
            .get_sync(skill.id())
            .expect("read catalog")
            .is_some(),
        "the subject row must roll back with the failed chain"
    );
}

// ===== 测试 4/5 夹具：部署 harness（同 facade_deployment_accounting） =====

struct DeploymentHarness {
    facade: LocalApplicationFacade,
    database_dir: tempfile::TempDir,
    // 集中库目录必须与 facade 同生命周期：facade 内部持有独立实例，这里的
    // 句柄只为保住临时目录不被提前清理。
    _library_root: tempfile::TempDir,
    target_root: tempfile::TempDir,
    skill: Skill,
    version_id: skillhub_core::VersionId,
}

async fn deployment_harness() -> DeploymentHarness {
    let database_dir = tempfile::tempdir().expect("database dir");
    let database = Database::open(database_dir.path().join("skillhub.sqlite")).expect("database");
    let skill = Skill::new(skillhub_core::SkillId::new(), "find-skills");
    database
        .catalog_repository()
        .expect("catalog repository")
        .insert(&skill)
        .await
        .expect("insert skill");
    let source = tempfile::tempdir().expect("source");
    std::fs::write(
        source.path().join("SKILL.md"),
        "---\nname: find-skills\ndescription: demo skill for deployment\n---\n\n# Demo\n",
    )
    .expect("write skill markdown");
    let library_root = tempfile::tempdir().expect("library root");
    let library = CentralLibrary::initialize(library_root.path()).expect("central library");
    let version = VersionStore::from_library(&library)
        .capture(skill.id(), source.path())
        .expect("capture version");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO versions (id, skill_id, content_hash, manifest_json, created_at) VALUES (?1, ?2, 'hash', '{}', 0)",
            rusqlite::params![version.id.to_string(), skill.id().to_string()],
        )
        .expect("insert version row");
    let target_root = tempfile::tempdir().expect("target root");
    let physical_id =
        skillhub_core::physical_id_for_path(target_root.path()).expect("target identity");
    let snapshot = DiscoverySnapshot {
        generation: "1".into(),
        observed_at: "2026-09-18T00:00:00Z".into(),
        instances: vec![ClientInstance {
            profile_id: "anthropic".into(),
            client_id: "anthropic.claude-code".into(),
            kind: ClientKind::Cli,
            display_name: "Fixture".into(),
            supported_os: vec![OperatingSystem::Windows],
            client_presence: ClientPresence::Unknown,
        }],
        logical_targets: vec![LogicalTarget {
            id: "claude-global".into(),
            profile_id: "anthropic".into(),
            client_id: "anthropic.claude-code".into(),
            scope: TargetScope::Global,
            path: target_root.path().to_string_lossy().into_owned(),
            agent_root_id: "fixture-root".into(),
            marker: "SKILL.md".into(),
            precedence: DirectoryPrecedence::Preferred,
            shared_reference: false,
            builtin: false,
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id,
            status: skillhub_core::agent::DirectoryObservationStatus::Existing,
            physical_identity_verified: true,
        }],
        physical_targets: Vec::new(),
        agent_roots: Vec::new(),
    };
    database
        .agent_repository()
        .replace(&snapshot)
        .expect("save discovery");
    let facade = LocalApplicationFacade::new_with_library(database, library_root.path());
    DeploymentHarness {
        facade,
        database_dir,
        _library_root: library_root,
        target_root,
        skill,
        version_id: version.id,
    }
}

async fn deploy(
    harness: &DeploymentHarness,
    mode_override: Option<DeploymentMode>,
) -> skillhub_core::DeploymentId {
    let planned = harness
        .facade
        .query(skillhub_core::AppQuery::GetDeploymentPlan(
            GetDeploymentPlan {
                request: skillhub_core::deployment::DeploymentPlanRequest {
                    skill_id: harness.skill.id(),
                    version_id: harness.version_id.clone(),
                    runtime_name: "find-skills".into(),
                    logical_target_ids: vec!["claude-global".into()],
                    mode_override,
                },
            },
        ))
        .await
        .expect("deployment plan");
    let skillhub_core::AppQueryResult::DeploymentPlan(plan) = planned else {
        panic!("expected deployment plan");
    };
    let prepared = harness
        .facade
        .execute(AppCommand::PrepareDeployment(PrepareDeployment { plan }))
        .await
        .expect("prepare deployment");
    let AppCommandResult::PreparedDeployment(prepared) = prepared else {
        panic!("expected prepared deployment");
    };
    let summary = harness
        .facade
        .execute(AppCommand::CommitDeployment(CommitDeployment {
            prepared_deployment_id: prepared.id,
        }))
        .await
        .expect("commit deployment");
    let AppCommandResult::DeploymentSummary(summary) = summary else {
        panic!("expected deployment summary");
    };
    assert!(
        summary.committed,
        "deployment must succeed; failures: {:?}",
        summary
            .targets
            .iter()
            .map(|target| target.error_code.clone())
            .collect::<Vec<_>>()
    );
    summary
        .targets
        .first()
        .expect("deployment target id")
        .deployment_id
        .expect("deployment id present on success")
}

// ===== 测试 4：链接部署随主体删除，链接文件被删 =====

#[tokio::test]
async fn removing_the_subject_deletes_the_link_deployment_target() {
    let host = skillhub_adapters::deployment::DeploymentFilesystem::new().available_capabilities();
    if !(host.symlink || host.junction) {
        eprintln!("host supports neither symlinks nor junctions; link boundary case skipped");
        return;
    }
    let harness = deployment_harness().await;
    // 链接部署按主机探针选符号链接或目录联接（Windows 无特权时走联接）。
    let link_mode = if host.symlink {
        DeploymentMode::SymbolicLink
    } else {
        DeploymentMode::DirectoryJunction
    };
    let deployment_id = deploy(&harness, Some(link_mode)).await;
    let deployed = harness.target_root.path().join("find-skills");
    assert!(
        deployed.exists(),
        "the link artifact must exist before deletion"
    );

    let impact = prepare_delete(&harness.facade, harness.skill.id()).await;
    assert_eq!(impact.deployments.len(), 1, "the link relation is listed");
    let result = commit_delete(
        &harness.facade,
        impact.operation_id,
        vec![RemovalChoice {
            deployment_id,
            decision: RemovalDecision::RemoveOwnedTarget,
            confirm_shared_target_removal: false,
        }],
    )
    .await;
    assert!(
        result.central_skill_deleted,
        "subject deletion succeeds: {result:?}"
    );
    assert_eq!(result.state, RemovalResultState::Committed);
    let item = &result.decisions[0];
    assert_eq!(item.status, skillhub_core::RemovalItemStatus::Applied);
    assert!(item.target_removed, "the link target is removed");
    assert!(item.relation_removed, "the relation is removed");
    assert!(
        !deployed.exists(),
        "the link deployment's link file must be deleted with the subject"
    );
    let audit = Database::open(harness.database_dir.path().join("skillhub.sqlite"))
        .expect("reopen database");
    assert!(
        audit
            .catalog_repository()
            .expect("catalog repository")
            .get_sync(harness.skill.id())
            .expect("read catalog")
            .is_none(),
        "the subject's catalog row is gone"
    );
}

// ===== 测试 5：复制部署默认保留副本（KeepSharedDeployment） =====

#[tokio::test]
async fn keeping_a_copy_deployment_keeps_the_files_by_default() {
    let harness = deployment_harness().await;
    let deployment_id = deploy(&harness, Some(DeploymentMode::ManagedCopy)).await;
    let deployed = harness.target_root.path().join("find-skills");
    assert!(deployed.join("SKILL.md").is_file(), "the copy must land");

    let impact = prepare_delete(&harness.facade, harness.skill.id()).await;
    assert_eq!(impact.deployments.len(), 1, "the copy relation is listed");
    let result = commit_delete(
        &harness.facade,
        impact.operation_id,
        vec![RemovalChoice {
            deployment_id,
            decision: RemovalDecision::KeepSharedDeployment,
            confirm_shared_target_removal: false,
        }],
    )
    .await;
    assert!(result.central_skill_deleted, "subject deletion succeeds");
    let item = &result.decisions[0];
    assert_eq!(item.status, skillhub_core::RemovalItemStatus::Applied);
    assert!(
        !item.target_removed,
        "the default keep decision never touches the copy files"
    );
    assert!(item.relation_removed, "only the relation is removed");
    assert!(
        deployed.join("SKILL.md").is_file(),
        "the managed copy stays on disk by default (degraded to an independent copy)"
    );
}
