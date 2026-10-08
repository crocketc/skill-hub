//! #10 第 4 项（2026-10-07 定稿）：历史观察行当初被记成
//! relationship=Unknown，且比对「未变化」永不改写，导致治理清单里的这些
//! 行被「不可转换」硬阻塞。初始化/重新扫描/Agent 再发现的比对阶段按现行
//! ownership×表示 口径对扫描范围内的 Unknown 行做一次再推导；探测失败或
//! 仍推不出（不猜）时保持原样，扫描范围之外的行不动。

use skillhub_application::LocalApplicationFacade;
use skillhub_core::agent::{
    ClientInstance, ClientKind, ClientPresence, DirectoryObservationStatus, DirectoryPrecedence,
    DiscoverySnapshot, LogicalTarget, OperatingSystem, TargetScope,
};
use skillhub_core::api::{AppQuery, AppQueryResult, ListRelationGovernance};
use skillhub_core::deployment::{ObservedMatchState, ObservedOrigin};
use skillhub_core::relationship::{
    DeploymentRelationFact, DirectoryNodeFact, DirectoryRole, FileRepresentation, OwnershipState,
    RelationGovernanceAction, RelationGovernanceBlocker, RelationshipType,
};
use skillhub_core::ApplicationFacade;
use skillhub_storage::{CentralLibrary, Database};

const CLIENT_ID: &str = "agent.demo";

/// 非内置（builtin: false）Agent 目录基座：行不落在只读集合里，走通用
/// 事实路径（只读边界另在 facade_relationship_governance 覆盖）。
fn scan_facade(workspace: &std::path::Path) -> (LocalApplicationFacade, std::path::PathBuf) {
    let agent_root = workspace.join("agents/demo/skills");
    std::fs::create_dir_all(&agent_root).expect("agent root");
    let database = Database::open(workspace.join("db.sqlite")).expect("database");
    database
        .connection_for_test()
        .execute_batch(
            "INSERT INTO skills(id,display_name,runtime_name,created_at,updated_at) VALUES \
             ('00000000-0000-0000-0000-0000000000b1','Notes','notes',1,1);",
        )
        .expect("skill row");
    database
        .agent_repository()
        .replace(&DiscoverySnapshot {
            generation: "1".into(),
            observed_at: "2026-10-07T00:00:00Z".into(),
            instances: vec![ClientInstance {
                profile_id: "demo".into(),
                client_id: CLIENT_ID.into(),
                kind: ClientKind::IdeExtension,
                display_name: "Demo IDE".into(),
                supported_os: vec![OperatingSystem::Windows],
                client_presence: ClientPresence::Unknown,
            }],
            logical_targets: vec![LogicalTarget {
                id: "target-1".into(),
                profile_id: "demo".into(),
                client_id: CLIENT_ID.into(),
                scope: TargetScope::Global,
                path: agent_root.to_string_lossy().into_owned(),
                agent_root_id: "fixture-root".into(),
                marker: "SKILL.md".into(),
                precedence: DirectoryPrecedence::Preferred,
                shared_reference: false,
                builtin: false,
                exists: true,
                readable: true,
                writable: true,
                available: true,
                physical_id: skillhub_core::physical_id_for_path(&agent_root).expect("physical id"),
                status: DirectoryObservationStatus::Existing,
                physical_identity_verified: true,
            }],
            physical_targets: Vec::new(),
            agent_roots: Vec::new(),
        })
        .expect("agent snapshot");
    database
        .directory_repository()
        .upsert_node(&DirectoryNodeFact {
            node_id: "target-1".into(),
            path: agent_root.to_string_lossy().into_owned(),
            path_key: String::new(),
            role: DirectoryRole::AgentNative,
            profile_id: Some("demo".into()),
            agent_client_id: Some(CLIENT_ID.into()),
            exists: true,
            observed_at: 1,
            scan_source: Some("fixture".into()),
        })
        .expect("directory node");
    let library_root = workspace.join("library");
    CentralLibrary::initialize(&library_root).expect("library");
    let facade = LocalApplicationFacade::new_with_library(database, &library_root);
    (facade, agent_root)
}

/// 历史观察行的落库形状：relationship=Unknown、表示 Unknown、健康、
/// 活跃——正是「未变化」永不改写的存量行。
fn seed_unknown_relation(
    facade: &LocalApplicationFacade,
    path: &std::path::Path,
    relation_id: &str,
) {
    let fact = DeploymentRelationFact {
        relation_id: relation_id.to_owned(),
        skill_id: Some("00000000-0000-0000-0000-0000000000b1".parse().unwrap()),
        agent_client_id: CLIENT_ID.into(),
        path: path.to_string_lossy().into_owned(),
        path_key: String::new(),
        directory_node_id: Some("target-1".into()),
        relationship: RelationshipType::Unknown,
        file_representation: FileRepresentation::Unknown,
        ownership: OwnershipState::ObservedUnmanaged,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        content_fingerprint: "sha256:fixture".into(),
        origin: ObservedOrigin::Import,
        match_state: ObservedMatchState::ContentVerified,
        health_reasons: Some(Vec::new()),
        active: true,
        observed_at: 1,
        released_at: None,
    };
    {
        let database = facade.database_for_tests();
        let database = database.lock().expect("database");
        database
            .relationship_repository()
            .upsert_deployment_relation(&fact)
            .expect("seed unknown relation");
    }
}

fn relations(facade: &LocalApplicationFacade) -> Vec<DeploymentRelationFact> {
    let database = facade.database_for_tests();
    let database = database.lock().expect("database");
    database
        .relationship_repository()
        .list_relations()
        .expect("relations")
}

async fn ledger(
    facade: &LocalApplicationFacade,
) -> skillhub_core::relationship::RelationGovernanceLedger {
    match facade
        .query(AppQuery::ListRelationGovernance(
            ListRelationGovernance::default(),
        ))
        .await
        .expect("governance ledger")
    {
        AppQueryResult::RelationGovernanceLedger(ledger) => ledger,
        other => panic!("expected relationship governance ledger, got {other:?}"),
    }
}

#[tokio::test]
async fn scan_rederives_unknown_relationships_inside_the_scanned_roots() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, agent_root) = scan_facade(workspace.path());
    let notes = agent_root.join("notes");
    std::fs::create_dir_all(&notes).expect("notes dir");
    seed_unknown_relation(&facade, &notes, "observed:scanned");
    // 范围外的同名结构：扫描不覆盖就不动。
    let outside = workspace.path().join("outside/notes");
    std::fs::create_dir_all(&outside).expect("outside dir");
    seed_unknown_relation(&facade, &outside, "observed:outside");

    let rederived = facade
        .rederive_unknown_relationships_for_tests(&[agent_root.to_string_lossy().into_owned()])
        .expect("rederivation runs");
    assert_eq!(rederived, 1, "only the scanned row is re-derived");

    let facts = relations(&facade);
    let scanned = facts
        .iter()
        .find(|fact| fact.relation_id == "observed:scanned")
        .expect("scanned row");
    assert_eq!(scanned.relationship, RelationshipType::ObservedCopy);
    assert_eq!(scanned.file_representation, FileRepresentation::Directory);
    assert!(scanned.active, "re-derivation never releases the row");
    let outside = facts
        .iter()
        .find(|fact| fact.relation_id == "observed:outside")
        .expect("outside row");
    assert_eq!(outside.relationship, RelationshipType::Unknown);
    assert_eq!(outside.file_representation, FileRepresentation::Unknown);
}

#[tokio::test]
async fn rederivation_lets_healthy_import_originals_complete_in_the_ledger() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, agent_root) = scan_facade(workspace.path());
    let notes = agent_root.join("notes");
    std::fs::create_dir_all(&notes).expect("notes dir");
    seed_unknown_relation(&facade, &notes, "observed:scanned");

    // 再推导前：关系未知 → 「不可转换」硬阻塞，行到不了健康完成。
    let before = ledger(&facade).await;
    let row = before
        .rows
        .iter()
        .find(|row| row.relation_id() == "observed:scanned")
        .expect("governance row");
    assert!(
        row.blockers
            .contains(&RelationGovernanceBlocker::RelationshipNotConvertible),
        "unknown relationship is blocked before re-derivation: {:?}",
        row.blockers
    );

    facade
        .rederive_unknown_relationships_for_tests(&[agent_root.to_string_lossy().into_owned()])
        .expect("rederivation runs");

    // 再推导后：健康导入原件（origin=import）按第 1 项自动归已完成，
    // 不再受阻；记录出口保持可达。目录识别（能力研究）是另一份事实，
    // 不在再推导的职责内。
    let after = ledger(&facade).await;
    let row = after
        .rows
        .iter()
        .find(|row| row.relation_id() == "observed:scanned")
        .expect("governance row");
    assert!(
        !row.blockers
            .contains(&RelationGovernanceBlocker::RelationshipNotConvertible),
        "relationship is derived after re-derivation: {:?}",
        row.blockers
    );
    assert!(
        !row.blockers
            .contains(&RelationGovernanceBlocker::UnverifiableRepresentation),
        "representation is derived after re-derivation: {:?}",
        row.blockers
    );
    assert_eq!(
        row.governance.governance_status,
        skillhub_core::relationship::RelationGovernanceClassification::Completed
    );
    assert_eq!(
        row.governance.decision,
        skillhub_core::relationship::RelationGovernanceDecision::RetainedIndependentCopy
    );
    let end = row
        .governance
        .action_conditions
        .iter()
        .find(|condition| condition.action == RelationGovernanceAction::EndRelationship)
        .expect("record exit stays reachable");
    assert!(end.available);
}

#[tokio::test]
async fn probe_failures_keep_the_row_unknown() {
    let workspace = tempfile::tempdir().expect("workspace");
    let (facade, agent_root) = scan_facade(workspace.path());
    // 行路径指向不存在的位置：探测失败不猜，保持 Unknown。
    let missing = agent_root.join("vanished");
    seed_unknown_relation(&facade, &missing, "observed:missing");

    let rederived = facade
        .rederive_unknown_relationships_for_tests(&[agent_root.to_string_lossy().into_owned()])
        .expect("rederivation runs");
    assert_eq!(rederived, 0, "probe failures never invent a relationship");
    let facts = relations(&facade);
    let row = facts
        .iter()
        .find(|fact| fact.relation_id == "observed:missing")
        .expect("row");
    assert_eq!(row.relationship, RelationshipType::Unknown);
    assert!(row.active);
}
