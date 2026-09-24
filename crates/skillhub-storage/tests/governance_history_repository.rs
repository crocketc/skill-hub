use skillhub_storage::{Database, GovernanceHistoryEvent};

#[test]
fn history_preserves_display_snapshots_and_distinct_actions_without_live_entities() {
    let db = Database::open_in_memory().unwrap();
    for (index, action) in [
        "cleaned_by_skillhub",
        "external_removed",
        "deployment_removed",
        "retain_released",
        "rolled_back",
        "terminal_failure",
    ]
    .iter()
    .enumerate()
    {
        let event = GovernanceHistoryEvent {
            event_id: format!("history-{index}"),
            relation_id: "deleted-relation".into(),
            skill_id: Some("deleted-skill".into()),
            skill_display_name: "Notes".into(),
            agent_presentation: serde_json::json!({"brand": "Codex", "display_types": ["terminal"]}),
            path: "/source/notes".into(),
            scope: "source_copy".into(),
            project_id: None,
            action: (*action).into(),
            result: if index == 5 { "failed" } else { "succeeded" }.into(),
            reason: Some("Recorded reason".into()),
            operation_id: None,
            occurred_at: index as i64,
        };
        db.governance_history_repository().append(&event).unwrap();
    }
    let history = db
        .governance_history_repository()
        .list_for_relation("deleted-relation")
        .unwrap();
    assert_eq!(history.len(), 6);
    assert_eq!(history[0].action, "terminal_failure");
    assert_eq!(history[0].result, "failed");
    assert_eq!(history[5].skill_display_name, "Notes");
    assert!(history.iter().all(|event| event.operation_id.is_none()));
}
