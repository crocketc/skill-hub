use skillhub_adapters::logging::{LogEvent, LogLevel, RedactingWriter};
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
        level: LogLevel::Info,
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

#[test]
fn param_keys_carrying_secrets_are_redacted_whole() {
    let mut params = BTreeMap::new();
    params.insert("api_token".into(), "innocent-value".into());
    params.insert("client_secret".into(), "innocent-value".into());
    params.insert("password".into(), "innocent-value".into());
    params.insert("user_credential".into(), "innocent-value".into());
    params.insert("api_key".into(), "innocent-value".into());
    params.insert("message".into(), "keeps its content".into());
    let event = LogEvent {
        event_code: "storage.error".into(),
        operation_id: None,
        phase: None,
        duration_ms: None,
        counts: BTreeMap::new(),
        params,
        skill_body: None,
        level: LogLevel::Info,
    };
    let mut output = Vec::new();
    RedactingWriter::new(&mut output)
        .write_event(&event)
        .unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(
        text.matches("[REDACTED]").count() >= 5,
        "every secret-named param must be redacted: {text}"
    );
    assert!(!text.contains("innocent-value"));
    assert!(text.contains("keeps its content"));
}

#[test]
fn secret_shaped_values_are_redacted_even_under_plain_keys() {
    let mut params = BTreeMap::new();
    params.insert("detail".into(), "token sk-abc123 rejected".into());
    params.insert("header".into(), "Bearer abc.def".into());
    params.insert("query".into(), "http://x/?api_key=zzz".into());
    params.insert("body_ref".into(), "content copied from SKILL.md".into());
    let event = LogEvent {
        event_code: "journal.record".into(),
        operation_id: Some("op-2".into()),
        phase: Some("applying".into()),
        duration_ms: None,
        counts: BTreeMap::new(),
        params,
        skill_body: None,
        level: LogLevel::Info,
    };
    let mut output = Vec::new();
    RedactingWriter::new(&mut output)
        .write_event(&event)
        .unwrap();
    let text = String::from_utf8(output).unwrap();
    assert!(
        !text.contains("sk-abc123"),
        "key material must be masked: {text}"
    );
    assert!(!text.contains("Bearer abc.def"));
    assert!(!text.contains("api_key=zzz"));
    assert!(!text.contains("content copied from SKILL.md"));
    assert!(
        text.matches("[REDACTED]").count() >= 4,
        "each secret-shaped value becomes [REDACTED]: {text}"
    );
}
