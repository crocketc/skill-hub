use skillhub_core::pending::PendingKind;
use skillhub_core::{
    BootstrapSnapshot, DeploymentDimension, OperationId, SkillId, StartupRecoveryState,
};
use skillhub_storage::Database;

#[test]
fn snapshot_round_trips_from_settings_before_filesystem_scan() {
    let db = Database::open_in_memory().unwrap();
    let repo = db.bootstrap_repository();
    assert!(repo.load().unwrap().is_none());
    let mut snapshot = BootstrapSnapshot::empty();
    snapshot.skill_count = 300;
    snapshot.recovery_state = StartupRecoveryState::NeedsRecovery;
    repo.save(&snapshot).unwrap();
    assert_eq!(repo.load().unwrap(), Some(snapshot));
}

#[test]
fn snapshot_build_contains_typed_cache_sections_without_localized_text() {
    let db = Database::open_in_memory().unwrap();
    let snapshot = db
        .bootstrap_repository()
        .build_snapshot((2026, 8, 23))
        .unwrap();
    assert_eq!(snapshot.skill_count, 0);
    assert_eq!(snapshot.deployment_categories.len(), 0);
    assert_eq!(snapshot.pending.total, 0);
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains("试用"));
    assert!(!serialized.contains("安全"));
}

#[test]
fn deployment_chart_can_aggregate_by_agent_and_project() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let project = "project-1";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','chart','chart',0,0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version}','{skill}','hash','{{}}',0);
             INSERT INTO projects (id,name,path,created_at,updated_at) VALUES ('{project}','Project','C:/project',0,0);
             INSERT INTO targets (id,agent_id,project_id,scope,path,created_at) VALUES ('target-a','codex','{project}','project','C:/target-a',0);
             INSERT INTO targets (id,agent_id,project_id,scope,path,created_at) VALUES ('target-b','claude','{project}','project','C:/target-b',0);
             INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,runtime_name,expected_hash,created_at,updated_at) VALUES ('deployment-a','{skill}','{version}','target-a','deployed','symlink','chart','hash',0,0);
             INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,runtime_name,expected_hash,created_at,updated_at) VALUES ('deployment-b','{skill}','{version}','target-b','deployed','symlink','chart','hash',0,0);
             INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,runtime_name,expected_hash,created_at,updated_at) VALUES ('deployment-failed','{skill}','{version}','target-a','failed','symlink','chart-failed','hash',0,0);
             INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,runtime_name,expected_hash,created_at,updated_at) VALUES ('deployment-removed','{skill}','{version}','target-b','removed','symlink','chart-removed','hash',0,0);"
        ))
        .unwrap();

    let by_agent = db
        .bootstrap_repository()
        .deployment_chart(DeploymentDimension::Agent)
        .unwrap();
    let by_project = db
        .bootstrap_repository()
        .deployment_chart(DeploymentDimension::Project)
        .unwrap();
    assert_eq!(by_agent.iter().map(|item| item.count).sum::<u32>(), 2);
    assert_eq!(
        by_project,
        vec![skillhub_core::DeploymentChartCategory {
            dimension: DeploymentDimension::Project,
            key: project.into(),
            label_code: "deployment.dimension.project".into(),
            count: 2,
        }]
    );
    assert!(by_agent
        .iter()
        .all(|item| item.label_code == "deployment.dimension.agent"));
    assert_eq!(by_agent.iter().map(|item| item.count).sum::<u32>(), 2);
    let snapshot = db
        .bootstrap_repository()
        .build_snapshot((2026, 8, 23))
        .unwrap();
    assert_eq!(snapshot.deployed_count, 2);
    assert_eq!(
        snapshot
            .deployment_categories
            .iter()
            .map(|item| item.count)
            .sum::<u32>(),
        4
    );
}

#[test]
#[test]
fn tag_chart_aggregates_skill_counts_per_tag() {
    let db = Database::open_in_memory().unwrap();
    let skill_a = SkillId::new();
    let skill_b = SkillId::new();
    let skill_c = SkillId::new();
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_a}','a','a',0,0);
             INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_b}','b','b',0,0);
             INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_c}','c','c',0,0);
             INSERT INTO tags (id,name) VALUES ('tag-writing','writing');
             INSERT INTO tags (id,name) VALUES ('tag-pdf','pdf');
             INSERT INTO skill_tags (skill_id,tag_id) VALUES ('{skill_a}','tag-writing');
             INSERT INTO skill_tags (skill_id,tag_id) VALUES ('{skill_b}','tag-writing');
             INSERT INTO skill_tags (skill_id,tag_id) VALUES ('{skill_c}','tag-pdf');"
        ))
        .unwrap();

    let snapshot = db
        .bootstrap_repository()
        .build_snapshot((2026, 8, 23))
        .unwrap();

    let mut tags: Vec<(String, u32)> = snapshot
        .tag_categories
        .iter()
        .map(|category| (category.key.clone(), category.count))
        .collect();
    tags.sort();
    assert_eq!(
        tags,
        vec![("pdf".to_string(), 1), ("writing".to_string(), 2)]
    );
}

#[test]
fn pending_query_derives_due_trial_and_unresolved_finding_from_facts() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    let run = "run-1";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','trial','trial',0,0);
             INSERT INTO catalog_skill_metadata (skill_id,requirements_json,trial_due) VALUES ('{skill}','[]','2026-08-01');
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version}','{skill}','hash','{{}}',0);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill}','{version}',0);
             INSERT INTO check_runs (id,skill_id,version_id,kind,state,started_at) VALUES ('{run}','{skill}','{version}','basic','completed',0);
             INSERT INTO check_findings (id,run_id,code,severity,disposition) VALUES ('finding-1','{run}','basic.secret','high','actionable');"
        ))
        .unwrap();
    let pending = db
        .bootstrap_repository()
        .list_pending((2026, 8, 23))
        .unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.iter().all(|item| item.subject == skill));
}

#[test]
fn pending_items_expose_due_date_risk_and_deployment_impact() {
    // N9：待处理事项必须带时间（试用到期日）、风险（严重级别映射）
    // 与影响面（当前生效部署关系数）三个真实字段。
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let run = "run-impact";
    let target = "target-impact";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','impact','impact',0,0);
             INSERT INTO catalog_skill_metadata (skill_id,requirements_json,trial_due) VALUES ('{skill}','[]','2026-08-01');
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version}','{skill}','hash','{{}}',0);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill}','{version}',0);
             INSERT INTO check_runs (id,skill_id,version_id,kind,state,started_at) VALUES ('{run}','{skill}','{version}','basic','completed',0);
             INSERT INTO check_findings (id,run_id,code,severity,disposition) VALUES ('finding-impact','{run}','basic.secret','critical','actionable');
             INSERT INTO targets (id,agent_id,scope,path,created_at) VALUES ('{target}','agent-impact','global','C:/agent-impact',0);
             INSERT INTO deployments (id,skill_id,version_id,target_id,state,method,managed,runtime_name,expected_hash,created_at,updated_at) VALUES ('dep-impact','{skill}','{version}','{target}','deployed','managed_copy',1,'impact','hash',0,0);"
        ))
        .unwrap();

    let pending = db
        .bootstrap_repository()
        .list_pending((2026, 8, 23))
        .unwrap();
    assert_eq!(pending.len(), 2);

    let trial = pending
        .iter()
        .find(|item| item.kind == PendingKind::TrialDue)
        .expect("trial item");
    assert_eq!(trial.due_date.as_deref(), Some("2026-08-01"));
    assert_eq!(trial.risk, None);
    assert_eq!(trial.affected_deployments, Some(1));

    let finding = pending
        .iter()
        .find(|item| item.kind == PendingKind::SecurityFinding)
        .expect("finding item");
    assert_eq!(finding.due_date, None);
    assert_eq!(
        finding.risk,
        Some(skillhub_core::pending::PendingRisk::High),
        "critical 发现必须映射为高风险"
    );
    assert_eq!(finding.affected_deployments, Some(1));
}

#[test]
fn pending_query_ignores_findings_from_superseded_check_runs() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let version = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','current','current',0,0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version}','{skill}','hash','{{}}',0);
             INSERT INTO check_runs (id,skill_id,version_id,kind,generation,state,started_at,ended_at) VALUES ('old-run','{skill}','{version}','basic',1,'failed',10,10);
             INSERT INTO check_findings (id,run_id,code,severity,disposition) VALUES ('old-finding','old-run','security.secret','error','actionable');
             INSERT INTO check_runs (id,skill_id,version_id,kind,generation,state,started_at,ended_at) VALUES ('current-run','{skill}','{version}','basic',2,'passed',20,20);"
        ))
        .unwrap();

    let pending = db
        .bootstrap_repository()
        .list_pending((2026, 8, 24))
        .unwrap();
    assert!(pending.is_empty());
}

#[test]
fn pending_query_ignores_findings_from_non_current_versions() {
    let db = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let old_version = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    let current_version = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill}','versions','versions',0,0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{old_version}','{skill}','old','{{}}',0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{current_version}','{skill}','current','{{}}',1);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill}','{current_version}',1);
             INSERT INTO check_runs (id,skill_id,version_id,kind,generation,state,started_at,ended_at) VALUES ('old-version-run','{skill}','{old_version}','basic',99,'failed',99,99);
             INSERT INTO check_findings (id,run_id,code,severity,disposition) VALUES ('old-version-finding','old-version-run','security.secret','error','actionable');
             INSERT INTO check_runs (id,skill_id,version_id,kind,generation,state,started_at,ended_at) VALUES ('current-version-run','{skill}','{current_version}','basic',1,'passed',1,1);"
        ))
        .unwrap();

    assert!(db
        .bootstrap_repository()
        .list_pending((2026, 8, 24))
        .unwrap()
        .is_empty());
}

#[test]
fn sqlite_pending_query_handles_three_hundred_skills_under_threshold() {
    let db = Database::open_in_memory().unwrap();
    for index in 0..300 {
        let skill = SkillId::new();
        db.connection_for_test()
            .execute(
                "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES (?1,?2,?2,0,0)",
                rusqlite::params![skill.to_string(), format!("skill-{index}")],
            )
            .unwrap();
        db.connection_for_test()
            .execute(
                "INSERT INTO catalog_skill_metadata (skill_id,requirements_json,trial_due) VALUES (?1,'[]',NULL)",
                [skill.to_string()],
            )
            .unwrap();
    }
    let started = std::time::Instant::now();
    let pending = db
        .bootstrap_repository()
        .list_pending((2026, 8, 23))
        .unwrap();
    assert!(started.elapsed() < std::time::Duration::from_millis(100));
    assert!(pending.is_empty());
}

#[test]
fn unfinished_operation_is_reported_as_in_progress_recovery_state() {
    let db = Database::open_in_memory().unwrap();
    let operation = OperationId::new();
    db.connection_for_test()
        .execute(
            "INSERT INTO operations (operation_id,kind,state,phase,request_fingerprint,created_at,updated_at) VALUES (?1,'scan','running','applying','fingerprint',0,0)",
            [operation.to_string()],
        )
        .unwrap();
    let snapshot = db
        .bootstrap_repository()
        .build_snapshot((2026, 8, 23))
        .unwrap();
    assert_eq!(snapshot.recovery_state, StartupRecoveryState::InProgress);
}

#[test]
fn deterministic_duplicates_match_by_current_version_content_hash() {
    // N12：两个 Skill 的当前版本内容哈希相同时互为确定性重复；
    // 哈希不同或未部署指针的不计入。
    let db = Database::open_in_memory().unwrap();
    let skill_a = SkillId::new();
    let skill_b = SkillId::new();
    let skill_c = SkillId::new();
    let version_a = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    let version_b = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    let version_c = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    db.connection_for_test()
        .execute_batch(&format!(
            "INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_a}','Notes A','notes-a',0,0);
             INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_b}','Notes B','notes-b',0,0);
             INSERT INTO skills (id,display_name,runtime_name,created_at,updated_at) VALUES ('{skill_c}','Other','other',0,0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version_a}','{skill_a}','hash-a','{{}}',0);
             INSERT INTO versions (id,skill_id,content_hash,manifest_json,created_at) VALUES ('{version_c}','{skill_c}','hash-c','{{}}',0);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill_a}','{version_a}',0);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill_b}','{version_a}',0);
             INSERT INTO current_pointers (skill_id,version_id,updated_at) VALUES ('{skill_c}','{version_c}',0);"
        ))
        .unwrap();

    let direct: Vec<(String, String, String)> = db
        .connection_for_test()
        .prepare("SELECT v.skill_id, s.display_name, v.content_hash FROM current_pointers cp JOIN versions v ON v.id = cp.version_id JOIN skills s ON s.id = v.skill_id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    eprintln!("DEBUG rows: {direct:?}");
    let duplicates = db
        .bootstrap_repository()
        .list_deterministic_duplicates(&skill_a.to_string())
        .unwrap();
    assert_eq!(duplicates.len(), 1, "只应命中内容哈希相同的 Notes B");
    assert_eq!(duplicates[0].0, skill_b.to_string());
    assert_eq!(duplicates[0].1, "Notes B");
    assert_eq!(duplicates[0].2, "hash-a");
}
