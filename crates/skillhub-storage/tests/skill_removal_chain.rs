//! #12：删除技能的关系安全清理链（真实 schema＋外键强制下全链清空）。
//!
//! 开发状态 2026-10-06 #12 第 1/4 项（2026-10-07 查库定因后裁决）：应用连接
//! 显式启用外键（`PRAGMA foreign_keys=ON`），旧 `remove_sync` 只删四张表，
//! `current_pointers.version_id`/`deployments.version_id` 对 versions 的
//! RESTRICT 与 `source_copy_relations.skill_id` 的 NO ACTION 必然拦下
//! `DELETE FROM skills`，75/75 个技能删除全部失败。治理裁决：主体名下全部
//! 使用关系随删除一并删除（"相当于恢复到没导入状态"），因此存证事件
//! （import_provenance_events_v19）也随主体删除；原件文件一律不动（文件面
//! 行为不在本层）。本测试在启用外键的真实迁移 schema 上种满全链行，断言
//! `remove_sync` 后：
//! 1. 主体名下所有表无该技能残留；
//! 2. 无悬空关系边（deployment_relations 不留 SET NULL 空边）；
//! 3. 冲突成员按 schema 语义降级为 NULL（行保留、证据去关联）；
//! 4. 其他技能与批次/组合等共享实体完全不受影响；
//! 5. 任一步失败整体回滚，不留半删残局。

use skillhub_storage::{CatalogRepositorySqlite, Database};

/// 在启用外键的真实 schema 中种满全链行；`doomed` 将被删除，
/// `survivor` 用于断言隔离。
struct ChainFixture {
    doomed: &'static str,
    survivor: &'static str,
    version_doomed: &'static str,
    version_survivor: &'static str,
}

fn seed_chain(connection: &rusqlite::Connection, fixture: &ChainFixture) {
    let sql = format!(
        "INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES('{d}','Doomed','doomed',1,1),('{s}','Survivor','survivor',1,1),('{c}','LineageChild','lineage-child',1,1);",
        d = fixture.doomed,
        s = fixture.survivor,
        c = "00000000-0000-0000-0000-0000000000c0",
    );
    connection.execute_batch(&sql).unwrap();
    for (skill, version) in [
        (fixture.doomed, fixture.version_doomed),
        (fixture.survivor, fixture.version_survivor),
    ] {
        connection
            .execute_batch(&format!(
                "INSERT INTO versions(id,skill_id,content_hash,manifest_json,created_at) VALUES('{v}','{k}','hash-{k}','{{}}',1);
                 INSERT INTO current_pointers(skill_id,version_id,updated_at) VALUES('{k}','{v}',1);
                 INSERT INTO sources(id,kind,locator,created_at) VALUES('src-{k}','local','/fixture/{k}',1);
                 INSERT INTO skill_sources(skill_id,source_id) VALUES('{k}','src-{k}');
                 INSERT INTO tags(id,name) VALUES('tag-{k}','tag-{k}');
                 INSERT INTO skill_tags(skill_id,tag_id) VALUES('{k}','tag-{k}');
                 INSERT INTO catalog_skill_metadata(skill_id,requirements_json) VALUES('{k}','[]');
                 INSERT INTO targets(id,agent_id,scope,path,created_at) VALUES('target-{k}','agent-{k}','global','C:/agents/{k}',1);
                 INSERT INTO deployments(id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,created_at,updated_at)
                   VALUES('dep-{k}','{k}','{v}','target-{k}','deployed','copy',1,'{k}','hash-{k}',1,1);
                 INSERT INTO directory_nodes(node_id,path,path_key,role,exists_flag,observed_at)
                   VALUES('node-{k}','C:/agents/{k}','c:/agents/{k}','agent_native',1,1);
                 INSERT INTO deployment_relations(relation_id,skill_id,agent_client_id,path,path_key,directory_node_id,relationship,file_representation,ownership,content_fingerprint,origin,match_state,active,observed_at)
                   VALUES('rel-{k}','{k}','agent-{k}','C:/agents/{k}','c:/agents/{k}','node-{k}','import_copy','directory','observed_unmanaged','fp-{k}','scan','content_verified',1,1);
                 INSERT INTO observed_deployments(id,skill_id,client_id,original_path,path_key,content_fingerprint,match_state,origin,status,observed_at)
                   VALUES('obs-{k}','{k}','agent-{k}','C:/observed/{k}','c:/observed/{k}','fp-{k}','content_verified','import','active',1);
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
                   VALUES('{k}','{v}','00000000-0000-0000-0000-0000000000e0','origin-version',1);",
                k = skill,
                v = version,
            ))
            .unwrap();
    }
    // 交叉谱系：被删技能作为「谱系上游 origin」出现在另一个主体的行里
    // （origin_skill_id 无外键，必须显式清理；child 本体行保留）。
    connection
        .execute(
            "INSERT INTO skill_lineage(skill_id,version_id,origin_skill_id,origin_version_id,created_at) VALUES(?1,'child-version',?2,'origin-version',1)",
            rusqlite::params![
                "00000000-0000-0000-0000-0000000000c0",
                fixture.doomed,
            ],
        )
        .unwrap();
    // 冲突案：两名成员分别指向两个技能；被删成员按 schema 语义降级为
    // NULL（skill_id SET NULL 由级联完成；provenance_id 由清理链显式置空，
    // 否则 NO ACTION 外键拦下存证删除）。
    connection
        .execute_batch(&format!(
            "INSERT INTO conflict_cases(conflict_id,kind,classification,evidence_json) VALUES('case-1','duplicate_same_content','same_skill_version','{{}}');
             INSERT INTO conflict_case_members(member_id,conflict_id,skill_id,provenance_id,path) VALUES('member-doomed','case-1','{d}','ev1-{d}','C:/a'),
               ('member-survivor','case-1','{s}','ev1-{s}','C:/b');",
            d = fixture.doomed,
            s = fixture.survivor,
        ))
        .unwrap();
}

fn count(connection: &rusqlite::Connection, sql: &str, skill: &str) -> i64 {
    connection
        .query_row(sql, [skill], |row| row.get::<_, i64>(0))
        .unwrap_or_else(|error| panic!("count failed for {sql}: {error}"))
}

#[test]
fn remove_sync_clears_the_full_skill_chain_under_foreign_keys() {
    let db = Database::open_in_memory().expect("migrated in-memory database");
    let fixture = ChainFixture {
        doomed: "00000000-0000-0000-0000-0000000000d0",
        survivor: "00000000-0000-0000-0000-000000000050",
        version_doomed: "00000000-0000-0000-0000-0000000000d1",
        version_survivor: "00000000-0000-0000-0000-000000000051",
    };
    seed_chain(db.connection_for_test(), &fixture);
    let doomed = fixture.doomed;
    let survivor = fixture.survivor;

    let repo = CatalogRepositorySqlite::new(&db).expect("catalog repository");
    repo.remove_sync(doomed.parse().expect("skill id"))
        .expect("remove_sync must clear the full chain in one transaction");

    let connection = db.connection_for_test();
    // 主体名下全部行清空：关系边、导入链、投影与审计行一个不留。
    for (table, sql) in [
        (
            "current_pointers",
            "SELECT COUNT(*) FROM current_pointers WHERE skill_id=?1",
        ),
        (
            "versions",
            "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
        ),
        (
            "deployments",
            "SELECT COUNT(*) FROM deployments WHERE skill_id=?1",
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
            "import_provenance_events_v19",
            "SELECT COUNT(*) FROM import_provenance_events_v19 WHERE skill_id=?1",
        ),
        (
            "source_copy_relations",
            "SELECT COUNT(*) FROM source_copy_relations WHERE skill_id=?1",
        ),
        (
            "original_migrations",
            "SELECT COUNT(*) FROM original_migrations WHERE skill_id=?1",
        ),
        (
            "search_display_names",
            "SELECT COUNT(*) FROM search_display_names WHERE skill_id=?1",
        ),
        (
            "skills_fts",
            "SELECT COUNT(*) FROM skills_fts WHERE skill_id=?1",
        ),
        (
            "translation_records",
            "SELECT COUNT(*) FROM translation_records WHERE skill_id=?1",
        ),
        (
            "security_alerts",
            "SELECT COUNT(*) FROM security_alerts WHERE skill_id=?1",
        ),
        (
            "version_labels",
            "SELECT COUNT(*) FROM version_labels WHERE skill_id=?1",
        ),
        (
            "skill_sources",
            "SELECT COUNT(*) FROM skill_sources WHERE skill_id=?1",
        ),
        (
            "skill_tags",
            "SELECT COUNT(*) FROM skill_tags WHERE skill_id=?1",
        ),
        (
            "catalog_skill_metadata",
            "SELECT COUNT(*) FROM catalog_skill_metadata WHERE skill_id=?1",
        ),
        (
            "check_runs",
            "SELECT COUNT(*) FROM check_runs WHERE skill_id=?1",
        ),
        (
            "check_findings",
            "SELECT COUNT(*) FROM check_findings WHERE run_id=?1",
        ),
        (
            "source_update_checks",
            "SELECT COUNT(*) FROM source_update_checks WHERE skill_id=?1",
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
        (
            "import_batch_items",
            "SELECT COUNT(*) FROM import_batch_items WHERE skill_id=?1",
        ),
        ("skills", "SELECT COUNT(*) FROM skills WHERE id=?1"),
    ] {
        assert_eq!(
            count(connection, sql, doomed),
            0,
            "{table} must not keep rows for the removed skill"
        );
    }
    // 导入批次项按存证/来源关系间接指向主体的行同样清空。
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM import_batch_items WHERE provenance_id IN (SELECT provenance_id FROM import_provenance_events_v19 WHERE skill_id=?1) OR source_relation_id IN (SELECT relation_id FROM source_copy_relations WHERE skill_id=?1)",
            doomed
        ),
        0,
        "import batch items pointing at the removed skill's evidence must be gone"
    );

    // 无悬空边：deployment_relations 不留 SET NULL 空边。
    let dangling_edges: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM deployment_relations WHERE skill_id IS NULL AND active=1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        dangling_edges, 0,
        "no dangling deployment relation edge may survive the subject"
    );

    // 冲突案保留但被删成员降级为 NULL（证据去关联，案件不消失）。
    let (member_skill, member_provenance): (Option<String>, Option<String>) = connection
        .query_row(
            "SELECT skill_id,provenance_id FROM conflict_case_members WHERE member_id='member-doomed'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(member_skill, None, "doomed member degrades to NULL skill");
    assert_eq!(
        member_provenance, None,
        "doomed member degrades to NULL provenance evidence"
    );
    // 批次、组合、标签、来源、目录节点等共享实体行保留。
    for sql in [
        "SELECT COUNT(*) FROM import_batches WHERE batch_id='batch-00000000-0000-0000-0000-0000000000d0'",
        "SELECT COUNT(*) FROM conflict_cases WHERE conflict_id='case-1'",
        "SELECT COUNT(*) FROM combinations WHERE id='combo-00000000-0000-0000-0000-0000000000d0'",
        "SELECT COUNT(*) FROM directory_nodes WHERE node_id='node-00000000-0000-0000-0000-0000000000d0'",
        "SELECT COUNT(*) FROM targets WHERE id='target-00000000-0000-0000-0000-0000000000d0'",
        // 谱系子主体本体行保留（清的是 origin 指向，不是子主体）。
        "SELECT COUNT(*) FROM skills WHERE id='00000000-0000-0000-0000-0000000000c0'",
    ] {
        let kept: i64 = connection.query_row(sql, [], |row| row.get(0)).unwrap();
        assert_eq!(kept, 1, "shared container rows survive: {sql}");
    }

    // 其他技能数据完全不受影响。
    for (table, sql) in [
        ("skills", "SELECT COUNT(*) FROM skills WHERE id=?1"),
        (
            "versions",
            "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
        ),
        (
            "current_pointers",
            "SELECT COUNT(*) FROM current_pointers WHERE skill_id=?1",
        ),
        (
            "deployments",
            "SELECT COUNT(*) FROM deployments WHERE skill_id=?1",
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
            "source_copy_relations",
            "SELECT COUNT(*) FROM source_copy_relations WHERE skill_id=?1",
        ),
        (
            "search_display_names",
            "SELECT COUNT(*) FROM search_display_names WHERE skill_id=?1",
        ),
        (
            "translation_records",
            "SELECT COUNT(*) FROM translation_records WHERE skill_id=?1",
        ),
        (
            "security_alerts",
            "SELECT COUNT(*) FROM security_alerts WHERE skill_id=?1",
        ),
        (
            "skill_lineage",
            "SELECT COUNT(*) FROM skill_lineage WHERE skill_id=?1",
        ),
    ] {
        assert_eq!(
            count(connection, sql, survivor),
            1,
            "the survivor skill keeps its {table} row"
        );
    }
    // 幸存技能名下按三种指向各有一行批次项、两行存证事件，全部保留。
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM import_batch_items WHERE skill_id=?1",
            survivor
        ),
        3,
        "the survivor skill keeps all three batch items"
    );
    // 幸存技能名下有两行存证事件（夹具种两行），全部保留。
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM import_provenance_events_v19 WHERE skill_id=?1",
            survivor
        ),
        2,
        "the survivor skill keeps both provenance events"
    );
    let survivor_provenance: Option<String> = connection
        .query_row(
            "SELECT provenance_id FROM conflict_case_members WHERE member_id='member-survivor'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        survivor_provenance.as_deref(),
        Some("ev1-00000000-0000-0000-0000-000000000050"),
        "the survivor member keeps its evidence link"
    );
}

/// 原子性：清理链任一步被完整性约束拦下时整体回滚，不留半删残局。
/// 交叉引用场景：另一个主体的迁移审计行指向被删技能的来源副本关系
/// （NO ACTION 外键），来源副本关系删除一步必然失败。
#[test]
fn remove_sync_rolls_back_completely_when_a_step_fails() {
    let db = Database::open_in_memory().expect("migrated in-memory database");
    let fixture = ChainFixture {
        doomed: "00000000-0000-0000-0000-0000000000d0",
        survivor: "00000000-0000-0000-0000-000000000050",
        version_doomed: "00000000-0000-0000-0000-0000000000d1",
        version_survivor: "00000000-0000-0000-0000-000000000051",
    };
    seed_chain(db.connection_for_test(), &fixture);
    let doomed = fixture.doomed;
    let connection = db.connection_for_test();
    // 幸存技能的迁移审计行指向被删技能的来源副本关系：清理链删除
    // source_copy_relations 一步触发 NO ACTION 外键失败。
    connection
        .execute(
            "INSERT INTO original_migrations(id,skill_id,original_path,backup_path,content_fingerprint,state,confirmed_at,restored_relation_id) VALUES('mig-cross','00000000-0000-0000-0000-000000000050','C:/x','C:/y','fp','RolledBack',1,?1)",
            rusqlite::params!["sr-00000000-0000-0000-0000-0000000000d0"],
        )
        .unwrap();

    let repo = CatalogRepositorySqlite::new(&db).expect("catalog repository");
    let result = repo.remove_sync(doomed.parse().unwrap());
    assert!(
        result.is_err(),
        "a constraint failure must surface instead of being swallowed"
    );
    // 整体回滚：主体行与链行一个未少。
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM skills WHERE id=?1",
            doomed
        ),
        1,
        "the subject row must roll back with the failed transaction"
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM deployments WHERE skill_id=?1",
            doomed
        ),
        1,
        "chain rows roll back together with the subject"
    );
    assert_eq!(
        count(
            connection,
            "SELECT COUNT(*) FROM source_copy_relations WHERE skill_id=?1",
            doomed
        ),
        1,
        "evidence rows roll back together with the subject"
    );
}
