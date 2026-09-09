//! Contract tests for `HttpLlmTaskRunner` against a local mock server.
//! No test touches a real provider, a real credential or a personal path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use skillhub_adapters::credentials::{
    CredentialBackend, OsCredentialStore, SessionCredentialStore,
};
use skillhub_adapters::llm::HttpLlmTaskRunner;
use skillhub_core::llm::{
    CredentialRef, CustomHeader, LlmDeployment, LlmProfile, LlmProtocolFamily, LlmTaskKind,
    LlmTaskRequest, NetworkGate,
};
use skillhub_core::ErrorCode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A scripted LLM server: serves queued responses in order and records every
/// request (method, path, headers, body) for assertions.
#[derive(Default)]
struct MockLlmServer {
    requests: Mutex<Vec<RecordedRequest>>,
}

#[derive(Clone)]
struct RecordedRequest {
    path: String,
    authorization: String,
    api_key: String,
    x_api_key: String,
    custom: String,
    body: String,
}

struct QueuedResponse {
    status: &'static str,
    headers: Vec<(&'static str, String)>,
    body: String,
    delay_ms: u64,
}

async fn start_server(
    server: Arc<MockLlmServer>,
    responses: Vec<QueuedResponse>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = vec![0_u8; 64 * 1024];
            let mut raw = String::new();
            // Read until the request is complete enough for assertions.
            loop {
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                raw.push_str(&String::from_utf8_lossy(&buffer[..read]));
                if raw.contains("\r\n\r\n") {
                    let header_end = raw.find("\r\n\r\n").unwrap() + 4;
                    let length: Option<usize> = raw
                        .to_ascii_lowercase()
                        .split("content-length:")
                        .nth(1)
                        .and_then(|rest| rest.split_whitespace().next()?.parse().ok());
                    match length {
                        Some(length) => {
                            if raw.len() >= header_end + length {
                                break;
                            }
                        }
                        None => break,
                    }
                }
            }
            let mut lines = raw.split("\r\n");
            let request_line = lines.next().unwrap_or("");
            let path = request_line
                .split_whitespace()
                .nth(1)
                .unwrap_or("")
                .to_owned();
            let mut authorization = String::new();
            let mut api_key = String::new();
            let mut x_api_key = String::new();
            let mut custom = String::new();
            for line in lines {
                let lower = line.to_ascii_lowercase();
                let original_value = |prefix: &str| {
                    if lower.starts_with(prefix) {
                        line[prefix.len()..].trim().to_owned()
                    } else {
                        String::new()
                    }
                };
                let value = original_value("authorization:");
                if !value.is_empty() {
                    authorization = value;
                }
                let value = original_value("api-key:");
                if !value.is_empty() {
                    api_key = value;
                }
                let value = original_value("x-api-key:");
                if !value.is_empty() {
                    x_api_key = value;
                }
                let value = original_value("x-goog-api-key:");
                if !value.is_empty() {
                    x_api_key = value;
                }
                let value = original_value("x-tracing:");
                if !value.is_empty() {
                    custom = value;
                }
            }
            let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_owned();
            server.requests.lock().unwrap().push(RecordedRequest {
                path,
                authorization,
                api_key,
                x_api_key,
                custom,
                body,
            });
            let response_headers = response
                .headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            let wire = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n",
                response.status,
                response.body.len(),
                response_headers
            );
            if response.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(response.delay_ms)).await;
            }
            stream.write_all(wire.as_bytes()).await.unwrap();
            stream.write_all(response.body.as_bytes()).await.unwrap();
        }
    });
    (format!("http://{address}"), handle)
}

fn chat_content(content: &str) -> String {
    json!({"choices": [{"message": {"content": content}}]}).to_string()
}

fn openai_chat(profile_endpoint_base: &str) -> LlmProfile {
    let mut profile = LlmProfile::new(
        "acme",
        format!("{profile_endpoint_base}/v1/chat/completions"),
        "acme-chat",
        Some(CredentialRef::new("cred-1")),
    )
    .unwrap();
    // The mock server answers on loopback http, which is a local deployment.
    profile.deployment = LlmDeployment::Local;
    profile
}

fn request() -> LlmTaskRequest {
    LlmTaskRequest::new(
        LlmTaskKind::Translation,
        "Translate the description containing sk-super-secret-value please.".into(),
        json!({"type": "object", "properties": {"translation": {"type": "string"}}}),
    )
    .unwrap()
}

fn stored_runner() -> HttpLlmTaskRunner {
    runner_with_seeded_credential("sk-live-credential-42")
}

fn runner_with_seeded_credential(secret: &str) -> HttpLlmTaskRunner {
    let backend = Arc::new(FixtureBackend::default());
    backend.seed("cred-1", secret);
    HttpLlmTaskRunner::new(Arc::new(OsCredentialStore::with_backend(backend)))
}

#[derive(Default, Clone)]
struct FixtureBackend {
    values: Arc<Mutex<std::collections::HashMap<String, String>>>,
    fail: Arc<AtomicBool>,
}

impl FixtureBackend {
    fn seed(&self, account: &str, secret: &str) {
        self.values
            .lock()
            .unwrap()
            .insert(account.to_owned(), secret.to_owned());
    }
}

impl CredentialBackend for FixtureBackend {
    fn set(&self, account: &str, secret: &str) -> skillhub_core::AppResult<()> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(skillhub_core::AppError::llm_credential_read_failed());
        }
        self.values
            .lock()
            .unwrap()
            .insert(account.to_owned(), secret.to_owned());
        Ok(())
    }
    fn get(&self, account: &str) -> skillhub_core::AppResult<Option<String>> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(skillhub_core::AppError::llm_credential_read_failed());
        }
        Ok(self.values.lock().unwrap().get(account).cloned())
    }
    fn delete(&self, account: &str) -> skillhub_core::AppResult<()> {
        self.values.lock().unwrap().remove(account);
        Ok(())
    }
}

async fn run_once(
    runner: &HttpLlmTaskRunner,
    profile: &LlmProfile,
) -> skillhub_core::AppResult<skillhub_core::llm::LlmTaskResponse> {
    runner
        .run_with_cancel(profile, request(), Arc::new(AtomicBool::new(false)))
        .await
}

#[tokio::test]
async fn openai_happy_path_parses_structured_output_and_masks_the_credential() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let content = chat_content("{\"translation\": \"hola\", \"language\": \"es\"}");
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: content,
            delay_ms: 0,
        }],
    )
    .await;
    let profile = openai_chat(&base);
    // The description contains the credential value itself, simulating a
    // user Skill that quoted the key: the payload must redact it.
    let leaked = LlmTaskRequest::new(
        LlmTaskKind::Translation,
        "Translate the description quoting sk-live-credential-42 please.".into(),
        json!({"type": "object", "properties": {"translation": {"type": "string"}}}),
    )
    .unwrap();

    let response = runner
        .run_with_cancel(&profile, leaked, Arc::new(AtomicBool::new(false)))
        .await
        .expect("run");
    assert_eq!(response.output["translation"], json!("hola"));

    let requests = server.requests.lock().unwrap();
    let recorded = &requests[0];
    assert_eq!(recorded.path, "/v1/chat/completions");
    assert_eq!(recorded.authorization, "Bearer sk-live-credential-42");
    assert!(
        !recorded.body.contains("sk-live-credential-42"),
        "credential material must never enter the request payload"
    );
    assert!(recorded.body.contains("[REDACTED]"));
    handle.abort();
}

#[tokio::test]
async fn auth_and_model_and_server_errors_map_onto_the_taxonomy() {
    let runner = stored_runner();

    for (status, expected) in [
        ("401 Unauthorized", ErrorCode::LlmAuthFailed),
        ("403 Forbidden", ErrorCode::LlmAuthFailed),
        ("404 Not Found", ErrorCode::LlmModelNotFound),
    ] {
        let server = Arc::new(MockLlmServer::default());
        let (base, handle) = start_server(
            server,
            vec![QueuedResponse {
                status,
                headers: vec![],
                body: "{\"error\": {}}".into(),
                delay_ms: 0,
            }],
        )
        .await;
        let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
        assert_eq!(error.code, expected, "status {status}");
        handle.abort();
    }

    // A persistent 5xx exhausts the bounded retries and surfaces server_error.
    let server = Arc::new(MockLlmServer::default());
    let responses: Vec<QueuedResponse> = (0..3)
        .map(|_| QueuedResponse {
            status: "500 Internal Server Error",
            headers: vec![],
            body: "{\"error\": \"down\"}".into(),
            delay_ms: 0,
        })
        .collect();
    let (base, handle) = start_server(server.clone(), responses).await;
    let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmServerError);
    assert_eq!(
        server.requests.lock().unwrap().len(),
        3,
        "one initial attempt plus at most two bounded retries"
    );
    handle.abort();
}

#[tokio::test]
async fn rate_limit_retries_within_bounds_and_honours_retry_after() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let content = chat_content("{\"translation\": \"bonjour\"}");
    let (base, handle) = start_server(
        server.clone(),
        vec![
            QueuedResponse {
                status: "429 Too Many Requests",
                headers: vec![("Retry-After", "0".into())],
                body: "{}".into(),
                delay_ms: 0,
            },
            QueuedResponse {
                status: "200 OK",
                headers: vec![],
                body: content,
                delay_ms: 0,
            },
        ],
    )
    .await;
    let response = run_once(&runner, &openai_chat(&base))
        .await
        .expect("retry succeeds");
    assert_eq!(response.output["translation"], json!("bonjour"));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    handle.abort();
}

#[tokio::test]
async fn timeout_is_classified_not_swallowed() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server,
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: chat_content("{}"),
            delay_ms: 2_000,
        }],
    )
    .await;
    let mut profile = openai_chat(&base);
    profile.timeout_ms = 80;
    let error = run_once(&runner, &profile).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmRequestTimeout);
    handle.abort();
}

#[tokio::test]
async fn invalid_json_and_interrupted_responses_are_distinguished() {
    let runner = stored_runner();

    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server,
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: "<html>not json</html>".into(),
            delay_ms: 0,
        }],
    )
    .await;
    let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmInvalidJson);
    handle.abort();

    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server,
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: chat_content(""),
            delay_ms: 0,
        }],
    )
    .await;
    let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmResponseInterrupted);
    handle.abort();
}

#[tokio::test]
async fn cancel_before_the_request_never_hits_the_server() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(server.clone(), vec![]).await;
    let cancelled = Arc::new(AtomicBool::new(true));
    let error = runner
        .run_with_cancel(&openai_chat(&base), request(), cancelled)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmCancelled);
    assert!(server.requests.lock().unwrap().is_empty());
    handle.abort();
}

#[tokio::test]
async fn cancel_during_a_slow_request_aborts_it() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: chat_content("{}"),
            delay_ms: 5_000,
        }],
    )
    .await;
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let profile = openai_chat(&base);
    let mut run = std::pin::pin!(runner.run_with_cancel(&profile, request(), cancelled));
    let mut setter_spent = false;
    let result = loop {
        let setter = async {
            if setter_spent {
                std::future::pending::<()>().await;
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
            flag.store(true, Ordering::SeqCst);
        };
        tokio::select! {
            biased;
            result = &mut run => break result,
            _ = setter => { setter_spent = true; }
        }
    };
    let error = result.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmCancelled);
    handle.abort();
}

#[tokio::test]
async fn network_gate_blocks_online_but_never_local_calls() {
    let runner = stored_runner().with_network_gate(NetworkGate::closed());
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(server.clone(), vec![]).await;

    let mut online = openai_chat(&base);
    online.deployment = LlmDeployment::Online;
    let error = run_once(&runner, &online).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NetworkDisabled);
    assert!(server.requests.lock().unwrap().is_empty());

    // A local model on loopback keeps working with all networking disabled.
    let content = chat_content("{\"translation\": \"hallo\"}");
    let (local_base, local_handle) = start_server(
        Arc::new(MockLlmServer::default()),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: content,
            delay_ms: 0,
        }],
    )
    .await;
    let mut local_profile = openai_chat(&local_base);
    local_profile.deployment = LlmDeployment::Local;
    local_profile.credential_ref = None;
    let response = run_once(&runner, &local_profile).await.expect("local run");
    assert_eq!(response.output["translation"], json!("hallo"));
    drop(local_handle);
    handle.abort();
}

#[tokio::test]
async fn missing_and_unreadable_credentials_are_actionable() {
    let runner = HttpLlmTaskRunner::new(Arc::new(SessionCredentialStore::default()));
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(server, vec![]).await;
    let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::CredentialUnavailable);
    handle.abort();

    let backend = FixtureBackend::default();
    backend.fail.store(true, Ordering::SeqCst);
    let runner =
        HttpLlmTaskRunner::new(Arc::new(OsCredentialStore::with_backend(Arc::new(backend))));
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(server, vec![]).await;
    let error = run_once(&runner, &openai_chat(&base)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::LlmCredentialReadFailed);
    handle.abort();
}

#[tokio::test]
async fn anthropic_gemini_and_azure_speak_their_own_dialect() {
    let runner = stored_runner();

    // Anthropic: x-api-key + /v1/messages.
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: json!({"content": [{"type": "text", "text": "{\"translation\": \"hi\"}"}]})
                .to_string(),
            delay_ms: 0,
        }],
    )
    .await;
    let mut profile = LlmProfile::new(
        "claude",
        format!("{base}/v1/messages"),
        "claude-x",
        Some(CredentialRef::new("cred-1")),
    )
    .unwrap();
    profile.deployment = LlmDeployment::Local;
    profile = profile.with_protocol(LlmProtocolFamily::Anthropic).unwrap();
    let response = run_once(&runner, &profile).await.expect("anthropic run");
    let recorded = server.requests.lock().unwrap()[0].clone();
    assert_eq!(recorded.x_api_key, "sk-live-credential-42");
    assert!(recorded.path.ends_with("/v1/messages"));
    assert_eq!(response.output["translation"], json!("hi"));
    handle.abort();

    // Gemini: x-goog-api-key + :generateContent.
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: json!({"candidates": [{"content": {"parts": [{"text": "{\"translation\": \"ciao\"}"}]}}]})
                .to_string(),
            delay_ms: 0,
        }],
    )
    .await;
    let mut profile = LlmProfile::new(
        "gemini",
        &base,
        "gemini-x",
        Some(CredentialRef::new("cred-1")),
    )
    .unwrap();
    profile.deployment = LlmDeployment::Local;
    profile = profile.with_protocol(LlmProtocolFamily::Gemini).unwrap();
    let response = run_once(&runner, &profile).await.expect("gemini run");
    let recorded = server.requests.lock().unwrap()[0].clone();
    assert_eq!(recorded.x_api_key, "sk-live-credential-42");
    assert!(recorded.path.contains(":generateContent"));
    assert_eq!(response.output["translation"], json!("ciao"));
    handle.abort();

    // Azure: api-key + deployment path.
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: chat_content("{\"translation\": \"ola\"}"),
            delay_ms: 0,
        }],
    )
    .await;
    let mut profile = LlmProfile::new(
        "azure",
        &base,
        "acme-chat",
        Some(CredentialRef::new("cred-1")),
    )
    .unwrap();
    profile.deployment = LlmDeployment::Local;
    profile = profile
        .with_protocol(LlmProtocolFamily::AzureOpenAi)
        .unwrap();
    let response = run_once(&runner, &profile).await.expect("azure run");
    let recorded = &server.requests.lock().unwrap()[0];
    assert_eq!(recorded.api_key, "sk-live-credential-42");
    assert!(recorded.path.contains("/openai/deployments/acme-chat/"));
    assert_eq!(response.output["translation"], json!("ola"));
    handle.abort();
}

#[tokio::test]
async fn custom_headers_and_sensitive_header_values_travel_correctly() {
    let backend = Arc::new(FixtureBackend::default());
    backend.seed("header-ref", "sk-header-secret-99");
    backend.seed("cred-1", "sk-live-credential-42");
    let runner = HttpLlmTaskRunner::new(Arc::new(OsCredentialStore::with_backend(backend.clone())));

    let server = Arc::new(MockLlmServer::default());
    let content = chat_content("{\"translation\": \"hej\"}");
    let (base, handle) = start_server(
        server.clone(),
        vec![QueuedResponse {
            status: "200 OK",
            headers: vec![],
            body: content,
            delay_ms: 0,
        }],
    )
    .await;
    let mut profile = openai_chat(&base);
    profile
        .custom_headers
        .push(CustomHeader::new("X-Tracing", "trace-77", false).unwrap());
    profile
        .custom_headers
        .push(CustomHeader::sensitive("X-Api-Key", CredentialRef::new("header-ref")).unwrap());

    let response = run_once(&runner, &profile).await.expect("run");
    assert_eq!(response.output["translation"], json!("hej"));
    let recorded = &server.requests.lock().unwrap()[0];
    assert_eq!(recorded.custom, "trace-77");
    assert!(
        !recorded.body.contains("sk-header-secret-99"),
        "sensitive header values are sent as headers only"
    );
    handle.abort();
}

#[tokio::test]
async fn model_list_fetch_tries_candidates_and_returns_sorted_ids() {
    let runner = stored_runner();
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![
            // First candidate 404s, second answers.
            QueuedResponse {
                status: "404 Not Found",
                headers: vec![],
                body: "{}".into(),
                delay_ms: 0,
            },
            QueuedResponse {
                status: "200 OK",
                headers: vec![],
                body: json!({"data": [{"id": "z-model"}, {"id": "a-model"}]}).to_string(),
                delay_ms: 0,
            },
        ],
    )
    .await;
    let mut profile = openai_chat(&base);
    // A chat path without a version segment yields two candidates:
    // {base}/models then {base}/v1/models.
    profile.endpoint = format!("{base}/chat/completions");
    let models = runner.fetch_models(&profile).await.expect("models");
    assert_eq!(models, vec!["a-model".to_string(), "z-model".to_string()]);
    let paths: Vec<String> = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|request| request.path.clone())
        .collect();
    assert_eq!(paths, vec!["/models".to_string(), "/v1/models".to_string()]);
    handle.abort();
}

#[tokio::test]
async fn connection_test_reports_endpoint_and_model_levels_separately() {
    let runner = stored_runner();

    // Model check fails with 401 while the endpoint is still reachable.
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![
            QueuedResponse {
                status: "200 OK",
                headers: vec![],
                body: "{}".into(),
                delay_ms: 0,
            },
            QueuedResponse {
                status: "401 Unauthorized",
                headers: vec![],
                body: "{}".into(),
                delay_ms: 0,
            },
        ],
    )
    .await;
    let report = runner.check_connection(&openai_chat(&base)).await;
    assert!(
        report.endpoint.reachable,
        "any HTTP answer counts as reachable"
    );
    assert!(
        !report.model_ok(),
        "model level must gate the usable verdict"
    );
    assert_eq!(
        report.model_failure_code.as_deref(),
        Some("llm.auth_failed")
    );
    handle.abort();

    // Fully working endpoint and model.
    let server = Arc::new(MockLlmServer::default());
    let (base, handle) = start_server(
        server.clone(),
        vec![
            QueuedResponse {
                status: "200 OK",
                headers: vec![],
                body: "{}".into(),
                delay_ms: 0,
            },
            QueuedResponse {
                status: "200 OK",
                headers: vec![],
                body: chat_content("{\"ok\": true}"),
                delay_ms: 0,
            },
        ],
    )
    .await;
    let report = runner.check_connection(&openai_chat(&base)).await;
    assert!(report.endpoint.reachable);
    assert!(report.model_ok(), "model capability check passed");
    handle.abort();
}
