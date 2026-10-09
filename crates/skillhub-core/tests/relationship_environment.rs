use skillhub_core::agent::AgentDirectoryRole;
use skillhub_core::relationship::{
    analyze_environment_problems, detect_environment_problems, merge_environment_problem_analyses,
    DirectoryRecognition, EnvironmentProblemKind, RelationGovernanceTargetKind, UsageDecision,
    UsageEntryKey, UsageEnvironmentDirectory, UsageEnvironmentEntry, UsageEnvironmentKey,
    UsageEnvironmentProbeLimitationReason, UsageEnvironmentSnapshot, UsageForm, UsageHealthReason,
    UsageManagement, UsageRelationTarget, UsageRelationView,
};
use skillhub_core::{ProjectId, SkillId};

fn environment_key(agent: &str, project: Option<ProjectId>) -> UsageEnvironmentKey {
    UsageEnvironmentKey {
        agent_client_id: agent.to_owned(),
        project_id: project,
    }
}

fn directory(
    id: &str,
    role: AgentDirectoryRole,
    recognition: DirectoryRecognition,
    physical_identity: &str,
    consumers: Vec<UsageEnvironmentKey>,
) -> UsageEnvironmentDirectory {
    UsageEnvironmentDirectory {
        directory_id: id.to_owned(),
        path: format!("/targets/{id}"),
        role,
        recognition,
        physical_identity: Some(physical_identity.to_owned()),
        consumers,
    }
}

fn entry(
    directory_id: &str,
    relative_entry_path: &str,
    runtime_name: &str,
    fingerprint: &str,
    physical_identity: &str,
) -> UsageEnvironmentEntry {
    UsageEnvironmentEntry {
        directory_id: directory_id.to_owned(),
        directory_path: Some(format!("/targets/{directory_id}")),
        directory_role: None,
        relative_entry_path: relative_entry_path.to_owned(),
        runtime_name: Some(runtime_name.to_owned()),
        content_fingerprint: Some(fingerprint.to_owned()),
        physical_identity: Some(physical_identity.to_owned()),
        skill_id: None,
        relation_ids: Vec::new(),
    }
}

fn snapshot(
    environment: UsageEnvironmentKey,
    directories: Vec<UsageEnvironmentDirectory>,
    discovered_entries: Vec<UsageEnvironmentEntry>,
) -> UsageEnvironmentSnapshot {
    UsageEnvironmentSnapshot {
        environment,
        recognized_directories: directories,
        discovered_entries,
        usage_relations: Vec::new(),
        probe_limitations: Vec::new(),
        relationship_revision: "17".to_owned(),
    }
}

#[test]
fn unimported_same_name_is_detected() {
    let environment = environment_key("agent-a", None);
    let input = snapshot(
        environment.clone(),
        vec![
            directory(
                "user",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "directory-user",
                vec![environment.clone()],
            ),
            directory(
                "builtin",
                AgentDirectoryRole::Builtin,
                DirectoryRecognition::Supported,
                "directory-builtin",
                vec![environment],
            ),
        ],
        vec![
            entry("user", "formatter", "formatter", "sha256:a", "entry-user"),
            entry(
                "builtin",
                "formatter",
                "formatter",
                "sha256:b",
                "entry-builtin",
            ),
        ],
    );

    let problems = detect_environment_problems(&input);

    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].kind, EnvironmentProblemKind::NameConflict);
    assert!(problems[0]
        .entries
        .iter()
        .all(|entry| entry.skill_id.is_none()));
}

#[test]
fn physical_alias_is_one_entry() {
    let environment = environment_key("agent-a", None);
    let input = snapshot(
        environment.clone(),
        vec![
            directory(
                "user-original",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "directory-same",
                vec![environment.clone()],
            ),
            directory(
                "user-alias",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "directory-same",
                vec![environment],
            ),
        ],
        vec![
            entry(
                "user-original",
                "formatter",
                "formatter",
                "sha256:same",
                "entry-physical-same",
            ),
            entry(
                "user-alias",
                "FORMATTER",
                "formatter",
                "sha256:same",
                "entry-physical-same",
            ),
        ],
    );

    assert!(detect_environment_problems(&input).is_empty());
}

#[test]
fn shared_consumers_are_not_duplicates() {
    let environment = environment_key("agent-a", None);
    let consumer_b = environment_key("agent-b", None);
    let input = snapshot(
        environment.clone(),
        vec![directory(
            "shared",
            AgentDirectoryRole::SharedDirectory,
            DirectoryRecognition::Supported,
            "shared-physical",
            vec![environment, consumer_b],
        )],
        vec![entry(
            "shared",
            "formatter",
            "formatter",
            "sha256:same",
            "shared-entry",
        )],
    );

    assert!(detect_environment_problems(&input).is_empty());
}

#[test]
fn agent_project_scope_is_separate() {
    let project_id = ProjectId::new();
    let agent_environment = environment_key("agent-a", None);
    let project_environment = environment_key("agent-a", Some(project_id));
    let agent_snapshot = snapshot(
        agent_environment.clone(),
        vec![directory(
            "agent-user",
            AgentDirectoryRole::AgentUser,
            DirectoryRecognition::Supported,
            "agent-user-physical",
            vec![agent_environment],
        )],
        vec![entry(
            "agent-user",
            "reviewer",
            "reviewer",
            "sha256:a",
            "agent-entry",
        )],
    );
    let project_snapshot = snapshot(
        project_environment.clone(),
        vec![directory(
            "project-skills",
            AgentDirectoryRole::Project,
            DirectoryRecognition::Supported,
            "project-physical",
            vec![project_environment],
        )],
        vec![entry(
            "project-skills",
            "reviewer",
            "reviewer",
            "sha256:b",
            "project-entry",
        )],
    );

    assert!(detect_environment_problems(&agent_snapshot).is_empty());
    assert!(detect_environment_problems(&project_snapshot).is_empty());
}

#[test]
fn same_content_builtin_user_shared_is_problem() {
    let environment = environment_key("agent-a", None);
    let input = snapshot(
        environment.clone(),
        vec![
            directory(
                "builtin",
                AgentDirectoryRole::Builtin,
                DirectoryRecognition::Supported,
                "directory-builtin",
                vec![environment.clone()],
            ),
            directory(
                "user",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "directory-user",
                vec![environment.clone()],
            ),
            directory(
                "shared",
                AgentDirectoryRole::SharedDirectory,
                DirectoryRecognition::Supported,
                "directory-shared",
                vec![environment.clone(), environment_key("agent-b", None)],
            ),
        ],
        vec![
            entry(
                "builtin",
                "formatter",
                "formatter",
                "sha256:same",
                "entry-builtin",
            ),
            entry(
                "user",
                "formatter",
                "formatter",
                "sha256:same",
                "entry-user",
            ),
            entry(
                "shared",
                "formatter",
                "formatter",
                "sha256:same",
                "entry-shared",
            ),
        ],
    );

    let problems = detect_environment_problems(&input);

    assert_eq!(problems.len(), 1, "same root cause is one problem group");
    assert_eq!(problems[0].kind, EnvironmentProblemKind::SameSkill);
    assert_eq!(problems[0].entries.len(), 3);
    assert_eq!(problems[0].consumers.len(), 2);

    let mut reordered = input.clone();
    reordered.discovered_entries.reverse();
    assert_eq!(
        detect_environment_problems(&reordered)[0].problem_id,
        problems[0].problem_id,
        "problem identity must not depend on scan row order"
    );
}

#[test]
fn released_files_still_form_problem() {
    let environment = environment_key("agent-a", None);
    let retained_entry = entry(
        "user",
        "formatter",
        "formatter",
        "sha256:a",
        "entry-released",
    );
    let relation_id = "released-relation".to_owned();
    let skill_id = SkillId::new();
    let mut input = snapshot(
        environment.clone(),
        vec![
            directory(
                "user",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "directory-user",
                vec![environment.clone()],
            ),
            directory(
                "builtin",
                AgentDirectoryRole::Builtin,
                DirectoryRecognition::Supported,
                "directory-builtin",
                vec![environment.clone()],
            ),
        ],
        vec![
            retained_entry,
            entry(
                "builtin",
                "formatter",
                "formatter",
                "sha256:b",
                "entry-builtin",
            ),
        ],
    );
    input.usage_relations.push(UsageRelationView {
        relation_id: relation_id.clone(),
        skill_id: Some(skill_id),
        target: UsageRelationTarget {
            kind: RelationGovernanceTargetKind::Agent,
            directory_id: Some("user".to_owned()),
            agent_client_id: Some("agent-a".to_owned()),
            directory_role: Some(AgentDirectoryRole::AgentUser),
            recognition: Some(DirectoryRecognition::Supported),
        },
        entry_key: Some(UsageEntryKey {
            directory_id: "user".to_owned(),
            relative_entry_path: "formatter".to_owned(),
        }),
        form: Some(UsageForm::FullCopy),
        management: UsageManagement::Unmanaged,
        health_reasons: vec![UsageHealthReason::Normal],
        decision: Some(UsageDecision::Released),
        decision_history_ids: vec!["decision-released".to_owned()],
        active: false,
        file_representation: skillhub_core::relationship::FileRepresentation::Directory,
        link_target_path: None,
        link_target_path_key: None,
        link_target_directory_id: None,
        physical_source_ids_evidence: vec!["entry-released".to_owned()],
        evidence_relation_ids: vec![relation_id],
    });

    let problems = detect_environment_problems(&input);

    assert_eq!(problems.len(), 1);
    assert_eq!(problems[0].kind, EnvironmentProblemKind::NameConflict);
    assert!(problems[0]
        .entries
        .iter()
        .any(|entry| entry.relation_ids.contains(&"released-relation".to_owned())));
    assert!(problems[0].entries.iter().any(|entry| {
        entry.relative_entry_path == "formatter" && entry.skill_id == Some(skill_id)
    }));
}

#[test]
fn unknown_recognition_is_not_guessed() {
    let environment = environment_key("agent-a", None);
    let input = snapshot(
        environment.clone(),
        vec![directory(
            "unknown",
            AgentDirectoryRole::AgentUser,
            DirectoryRecognition::Unknown,
            "directory-unknown",
            vec![environment],
        )],
        vec![
            entry("unknown", "formatter-a", "formatter", "sha256:a", "entry-a"),
            entry("unknown", "formatter-b", "formatter", "sha256:b", "entry-b"),
        ],
    );

    let analysis = analyze_environment_problems(&input);

    assert!(analysis.problems.is_empty());
    assert!(analysis.probe_limitations.iter().any(|limitation| {
        limitation.reason == UsageEnvironmentProbeLimitationReason::RecognitionNotConfirmed
            && limitation.directory_id.as_deref() == Some("unknown")
    }));
}

#[test]
fn shared_root_problem_merges_across_agent_environments() {
    let agent_a = environment_key("agent-a", None);
    let agent_b = environment_key("agent-b", None);
    let shared = directory(
        "shared",
        AgentDirectoryRole::SharedDirectory,
        DirectoryRecognition::Supported,
        "shared-directory-physical",
        vec![agent_a.clone(), agent_b.clone()],
    );
    let first = snapshot(
        agent_a.clone(),
        vec![
            shared.clone(),
            directory(
                "agent-a-user",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "agent-a-user-physical",
                vec![agent_a.clone()],
            ),
        ],
        vec![
            entry(
                "shared",
                "formatter",
                "formatter",
                "sha256:same",
                "shared-entry",
            ),
            entry(
                "agent-a-user",
                "formatter",
                "formatter",
                "sha256:same",
                "agent-a-entry",
            ),
        ],
    );
    let second = snapshot(
        agent_b.clone(),
        vec![
            shared,
            directory(
                "agent-b-user",
                AgentDirectoryRole::AgentUser,
                DirectoryRecognition::Supported,
                "agent-b-user-physical",
                vec![agent_b.clone()],
            ),
        ],
        vec![
            entry(
                "shared",
                "formatter",
                "formatter",
                "sha256:same",
                "shared-entry",
            ),
            entry(
                "agent-b-user",
                "formatter",
                "formatter",
                "sha256:same",
                "agent-b-entry",
            ),
        ],
    );

    let analyses = [
        analyze_environment_problems(&first),
        analyze_environment_problems(&second),
    ];
    let merged = merge_environment_problem_analyses(&analyses);

    assert_eq!(merged.problems.len(), 1);
    assert_eq!(merged.problems[0].entries.len(), 3);
    assert_eq!(merged.problems[0].consumers.len(), 2);
    assert_eq!(merged.problems[0].environment_results.len(), 2);
    assert!(merged.problems[0]
        .environment_results
        .iter()
        .any(|result| result.environment == agent_a));
    assert!(merged.problems[0]
        .environment_results
        .iter()
        .any(|result| result.environment == agent_b));
}
