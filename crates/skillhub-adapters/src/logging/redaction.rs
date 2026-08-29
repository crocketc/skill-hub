use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
pub struct LogEvent {
    pub event_code: String,
    pub operation_id: Option<String>,
    pub phase: Option<String>,
    pub duration_ms: Option<u64>,
    pub counts: BTreeMap<String, u64>,
    pub params: BTreeMap<String, String>,
    pub skill_body: Option<String>,
}

pub struct RedactingWriter<W> {
    inner: W,
}

impl<W: Write> RedactingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }

    pub fn write_event(&mut self, event: &LogEvent) -> io::Result<()> {
        let mut params = BTreeMap::new();
        for (key, value) in &event.params {
            let lower = key.to_ascii_lowercase();
            let safe = if lower.contains("secret")
                || lower.contains("token")
                || lower.contains("password")
                || lower.contains("credential")
                || lower.contains("api_key")
            {
                "[REDACTED]".to_owned()
            } else {
                redact_value(value)
            };
            params.insert(key.clone(), safe);
        }
        let safe = serde_json::json!({
            "event_code": event.event_code,
            "operation_id": event.operation_id,
            "phase": event.phase,
            "duration_ms": event.duration_ms,
            "counts": event.counts,
            "params": params,
        });
        serde_json::to_writer(&mut self.inner, &safe).map_err(io::Error::other)?;
        self.inner.write_all(b"\n")
    }
}

pub struct LocalLogConfig {
    pub directory: PathBuf,
    pub max_bytes: u64,
}

impl LocalLogConfig {
    pub fn write_event(&self, event: &LogEvent) -> io::Result<()> {
        fs::create_dir_all(&self.directory)?;
        let path = self.directory.join("skillhub.log");
        if path.exists() && fs::metadata(&path)?.len() >= self.max_bytes {
            let rotated = self.directory.join("skillhub.log.1");
            let _ = fs::remove_file(&rotated);
            fs::rename(&path, rotated)?;
        }
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        RedactingWriter::new(file).write_event(event)
    }
}

fn redact_value(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if lower.contains("sk-")
        || lower.contains("bearer ")
        || lower.contains("api_key=")
        || lower.contains("skill.md")
    {
        "[REDACTED]".into()
    } else {
        value.to_owned()
    }
}
