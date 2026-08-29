use skillhub_adapters::logging::{LogEvent, RedactingWriter};
use std::collections::BTreeMap;

#[test]
fn logs_keep_operation_context_and_remove_secrets_and_skill_body() {
    let mut params = BTreeMap::new();
    params.insert("api_key".into(), "sk-secret".into());
    params.insert("message".into(), "entire SKILL.md body".into());
    let event = LogEvent {
        event_code: "operation.finished".into(),
        operation_id: Some("op-1".into()),
        phase: Some("commit".into()),
        duration_ms: Some(42),
        counts: BTreeMap::new(),
        params,
        skill_body: Some("entire SKILL.md body".into()),
    };
    let mut output = Vec::new();
    RedactingWriter::new(&mut output)
        .write_event(&event)
        .unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(text.contains("operation_id"));
    assert!(text.contains("operation.finished"));
    assert!(!text.contains("sk-secret"));
    assert!(!text.contains("entire SKILL.md body"));
}
