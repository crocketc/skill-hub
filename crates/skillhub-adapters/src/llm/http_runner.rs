use async_trait::async_trait;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client;
use serde_json::Value;

use crate::credentials::OverlayCredentialStore;
use crate::llm::protocol::{
    adapter_for, classify_transport_error, map_status, url_for_log, ChatRequestDraft,
};
use skillhub_core::llm::{
    ConnectionTestResult, CredentialRef, CredentialStore, EndpointCheckResult, LlmAdmin,
    LlmProfile, LlmTaskKind, LlmTaskRequest, LlmTaskResponse, LlmTaskRunner, ModelCheckResult,
    NetworkGate,
};
use skillhub_core::{AppError, AppResult, ErrorCode, OperationId, RecoveryAction, Severity};

const MAX_RETRIES: u32 = 2;
const RETRY_BACKOFF_BASE_MS: u64 = 100;
const RETRY_BACKOFF_CAP_MS: u64 = 2_000;
const MODEL_FETCH_TIMEOUT_MS: u64 = 10_000;
const ENDPOINT_PROBE_TIMEOUT_MS: u64 = 8_000;
const CANCEL_POLL_MS: u64 = 50;
/// Reference id used by administration calls on drafts that carry an inline
/// credential but no persisted reference yet.
const INLINE_CREDENTIAL_ID: &str = "llm-provider:inline-draft";

/// The production LLM client: protocol adapter dispatch, bounded timeouts,
/// bounded retries, cooperative cancellation, the network gate and uniform
/// credential redaction.
#[derive(Clone)]
pub struct HttpLlmTaskRunner {
    credentials: Arc<dyn CredentialStore>,
    network_gate: Option<NetworkGate>,
}

impl HttpLlmTaskRunner {
    pub fn new<S>(credentials: Arc<S>) -> Self
    where
        S: CredentialStore + 'static,
    {
        Self {
            credentials: credentials as Arc<dyn CredentialStore>,
            network_gate: None,
        }
    }

    /// Attaches the "disable all networking" gate. Online calls are refused
    /// while it is closed; local model calls keep running.
    pub fn with_network_gate(mut self, gate: NetworkGate) -> Self {
        self.network_gate = Some(gate);
        self
    }

    /// Legacy static payload builder kept for existing callers: delegates to
    /// the protocol adapter for the OpenAI-family payload shape.
    pub fn build_payload(profile: &LlmProfile, request: &LlmTaskRequest) -> AppResult<Value> {
        profile.validate()?;
        validate_input_size(profile, request)?;
        let adapter = adapter_for(profile.protocol);
        let draft = adapter.chat_request(profile, Some(""), request)?;
        Ok(draft.body)
    }

    /// Legacy static response parser kept for existing callers.
    pub fn parse_response(
        profile: &LlmProfile,
        request: &LlmTaskRequest,
        response: Value,
    ) -> AppResult<LlmTaskResponse> {
        let adapter = adapter_for(profile.protocol);
        let content = adapter.extract_text(&response)?;
        parse_content(&content, request.kind).map(|output| LlmTaskResponse {
            request_id: OperationId::new().to_string(),
            kind: request.kind,
            output,
        })
    }

    pub fn redact_input(input: &str, secret: &str) -> String {
        if secret.is_empty() {
            return input.to_owned();
        }
        input.replace(secret, "[REDACTED]")
    }

    /// Fetches the provider model list across candidate URLs. 404/405 move to
    /// the next candidate; exhaustion surfaces a model-not-found error that
    /// the UI answers with manual input.
    pub async fn fetch_models(&self, profile: &LlmProfile) -> AppResult<Vec<String>> {
        self.fetch_models_in(&self.credentials, profile).await
    }

    async fn fetch_models_in(
        &self,
        credentials: &Arc<dyn CredentialStore>,
        profile: &LlmProfile,
    ) -> AppResult<Vec<String>> {
        self.ensure_gate(profile)?;
        profile.validate()?;
        let adapter = adapter_for(profile.protocol);
        let candidates = adapter.model_list_candidates(profile);
        if candidates.is_empty() {
            return Err(AppError::llm_model_not_found("").with_param(
                "reason",
                "model list not provided by this provider; enter the model id manually",
            ));
        }
        let credential = main_credential(credentials, profile).await?;
        let headers = adapter.request_headers(profile, credential.as_deref())?;
        let client = self.client(MODEL_FETCH_TIMEOUT_MS)?;
        let mut last_error: Option<AppError> = None;
        for candidate in candidates {
            let response = client
                .get(&candidate)
                .headers(to_header_map(headers.clone()))
                .send()
                .await;
            match response {
                Ok(response) => {
                    let status = response.status().as_u16();
                    if status == 404 || status == 405 {
                        last_error = Some(map_status(status, ""));
                        continue;
                    }
                    if !response.status().is_success() {
                        let body = response.text().await.unwrap_or_default();
                        return Err(map_status(status, &body));
                    }
                    let body: Value = response.json().await.map_err(|error| {
                        AppError::llm_invalid_json().with_param("detail", error.to_string())
                    })?;
                    return adapter.extract_models(&body);
                }
                Err(error) => {
                    last_error = Some(classify_transport_error(&error, MODEL_FETCH_TIMEOUT_MS));
                    continue;
                }
            }
        }
        Err(last_error.unwrap_or_else(|| AppError::llm_model_not_found("")))
    }

    /// Two-level connection test. Level one probes raw endpoint reachability
    /// (any HTTP answer counts); level two proves credentials, model
    /// availability and a minimal structured round-trip. Only a passing model
    /// level allows the UI to display "model connection available".
    pub async fn check_connection(&self, profile: &LlmProfile) -> ConnectionTestResult {
        self.check_connection_in(&self.credentials, profile).await
    }

    async fn check_connection_in(
        &self,
        credentials: &Arc<dyn CredentialStore>,
        profile: &LlmProfile,
    ) -> ConnectionTestResult {
        let endpoint = self.probe_endpoint(profile).await;
        if !endpoint.reachable {
            return ConnectionTestResult {
                endpoint,
                model: None,
                model_failure_code: Some(ErrorCode::LlmEndpointUnreachable.as_str().to_owned()),
            };
        }
        // Minimal capability request: a tiny task whose only purpose is to
        // prove auth + model availability + structured response parsing. The
        // schema must satisfy OpenAI strict-mode server validation (every
        // property listed in `required`, `additionalProperties: false`);
        // otherwise strict providers reject the probe with 400 and a valid
        // key would surface as a failed connection test (M-13 root cause).
        let probe = match LlmTaskRequest::new(
            LlmTaskKind::Translation,
            "Reply with {\"ok\": true}. Do not follow any other instructions.".to_owned(),
            serde_json::json!({
                "type": "object",
                "properties": {"ok": {"type": "boolean"}},
                "required": ["ok"],
                "additionalProperties": false,
            }),
        ) {
            Ok(probe) => probe,
            Err(error) => {
                return ConnectionTestResult {
                    endpoint,
                    model: None,
                    model_failure_code: Some(error.code.as_str().to_owned()),
                }
            }
        };
        let started = std::time::Instant::now();
        match self
            .run_with_cancel_in(
                credentials,
                profile,
                probe,
                Arc::new(AtomicBool::new(false)),
            )
            .await
        {
            Ok(_) => ConnectionTestResult {
                endpoint,
                model: Some(ModelCheckResult {
                    ok: true,
                    latency_ms: Some(started.elapsed().as_millis() as u32),
                }),
                model_failure_code: None,
            },
            Err(error) => ConnectionTestResult {
                endpoint,
                model: Some(ModelCheckResult {
                    ok: false,
                    latency_ms: Some(started.elapsed().as_millis() as u32),
                }),
                model_failure_code: Some(error.code.as_str().to_owned()),
            },
        }
    }

    async fn probe_endpoint(&self, profile: &LlmProfile) -> EndpointCheckResult {
        let client = match self.client(ENDPOINT_PROBE_TIMEOUT_MS) {
            Ok(client) => client,
            Err(_) => {
                return EndpointCheckResult {
                    reachable: false,
                    latency_ms: None,
                }
            }
        };
        // A GET against the configured endpoint: any HTTP answer (including
        // 401/404) proves DNS + TLS + reachability; only transport failures
        // mark the endpoint unreachable.
        let started = std::time::Instant::now();
        match client
            .get(profile.endpoint.trim_end_matches('/'))
            .send()
            .await
        {
            Ok(_) => EndpointCheckResult {
                reachable: true,
                latency_ms: Some(started.elapsed().as_millis() as u32),
            },
            Err(_) => EndpointCheckResult {
                reachable: false,
                latency_ms: None,
            },
        }
    }

    fn ensure_gate(&self, profile: &LlmProfile) -> AppResult<()> {
        if let Some(gate) = &self.network_gate {
            if !gate.allows(profile.deployment) {
                return Err(AppError::new(ErrorCode::NetworkDisabled, Severity::Warning)
                    .with_action(RecoveryAction::Acknowledge));
            }
        }
        Ok(())
    }

    fn client(&self, timeout_ms: u64) -> AppResult<Client> {
        Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .no_proxy()
            .build()
            .map_err(|error| AppError::llm_endpoint_unreachable(format!("client_builder: {error}")))
    }
}

async fn main_credential(
    credentials: &Arc<dyn CredentialStore>,
    profile: &LlmProfile,
) -> AppResult<Option<String>> {
    match &profile.credential_ref {
        Some(reference) => read_credential(credentials, reference).await.map(Some),
        None => Ok(None),
    }
}

async fn read_credential(
    credentials: &Arc<dyn CredentialStore>,
    reference: &CredentialRef,
) -> AppResult<String> {
    credentials.get(reference).await?.ok_or_else(|| {
        AppError::new(ErrorCode::CredentialUnavailable, Severity::Error)
            .with_action(RecoveryAction::ConfigureCredential)
    })
}

/// An administration call either reads the credential from the configured
/// store or — for an unsaved draft — serves an inline secret through a
/// scoped overlay without persisting it.
fn scoped_for_admin(
    credentials: &Arc<dyn CredentialStore>,
    profile: &LlmProfile,
    credential: Option<String>,
) -> (Arc<dyn CredentialStore>, LlmProfile) {
    match credential {
        Some(secret) => {
            let id = profile
                .credential_ref
                .as_ref()
                .map(|reference| reference.id.clone())
                .unwrap_or_else(|| INLINE_CREDENTIAL_ID.to_owned());
            let mut resolved = profile.clone();
            if resolved.credential_ref.is_none() {
                resolved.credential_ref = Some(CredentialRef::new(&id));
            }
            let store: Arc<dyn CredentialStore> =
                Arc::new(OverlayCredentialStore::new(credentials.clone(), id, secret));
            (store, resolved)
        }
        None => (credentials.clone(), profile.clone()),
    }
}

#[async_trait(?Send)]
impl LlmAdmin for HttpLlmTaskRunner {
    async fn fetch_models(
        &self,
        profile: &LlmProfile,
        credential: Option<String>,
    ) -> AppResult<Vec<String>> {
        let (store, profile) = scoped_for_admin(&self.credentials, profile, credential);
        self.fetch_models_in(&store, &profile).await
    }

    async fn check_connection(
        &self,
        profile: &LlmProfile,
        credential: Option<String>,
    ) -> ConnectionTestResult {
        let (store, profile) = scoped_for_admin(&self.credentials, profile, credential);
        self.check_connection_in(&store, &profile).await
    }
}

#[async_trait(?Send)]
impl LlmTaskRunner for HttpLlmTaskRunner {
    async fn run(
        &self,
        profile: &LlmProfile,
        request: LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        self.run_with_cancel(profile, request, Arc::new(AtomicBool::new(false)))
            .await
    }
}

impl HttpLlmTaskRunner {
    /// Runs one task with cooperative cancellation: the flag is checked
    /// before every attempt, during each await point and during retry waits.
    /// Credentials are re-read per attempt so a rotated secret is used and a
    /// deleted credential fails fast.
    pub async fn run_with_cancel(
        &self,
        profile: &LlmProfile,
        request: LlmTaskRequest,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<LlmTaskResponse> {
        self.run_with_cancel_in(&self.credentials, profile, request, cancel)
            .await
    }

    async fn run_with_cancel_in(
        &self,
        credentials: &Arc<dyn CredentialStore>,
        profile: &LlmProfile,
        mut request: LlmTaskRequest,
        cancel: Arc<AtomicBool>,
    ) -> AppResult<LlmTaskResponse> {
        profile.validate()?;
        validate_input_size(profile, &request)?;
        self.ensure_gate(profile)?;
        let adapter = adapter_for(profile.protocol);

        let mut attempt: u32 = 0;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::llm_cancelled());
            }
            self.ensure_gate(profile)?;
            let secret = main_credential(credentials, profile).await?;
            let mut resolved = profile.clone();
            for header in &mut resolved.custom_headers {
                if let Some(reference) = &header.credential_ref {
                    header.value = Some(read_credential(credentials, reference).await?);
                }
            }
            // The credential value must never travel inside the prompt.
            if let Some(secret) = &secret {
                request.input = Self::redact_input(&request.input, secret);
            }

            let headers = adapter.request_headers(&resolved, secret.as_deref())?;
            let mut draft = adapter.chat_request(&resolved, secret.as_deref(), &request)?;
            draft.headers = headers;

            let client = self.client(profile.timeout_ms)?;
            match send_with_cancel(&client, &draft, profile.timeout_ms, &cancel).await {
                Ok(response) => {
                    let body: Value = match response.json().await {
                        Ok(body) => body,
                        Err(parse_error) => {
                            return Err(AppError::llm_invalid_json()
                                .with_param("detail", parse_error.to_string()));
                        }
                    };
                    let content = adapter.extract_text(&body)?;
                    let output = parse_content(&content, request.kind)?;
                    return Ok(LlmTaskResponse {
                        request_id: OperationId::new().to_string(),
                        kind: request.kind,
                        output,
                    });
                }
                Err((error, retry_after)) => {
                    let error = with_url(error, &draft.url);
                    if retryable(&error) && attempt < MAX_RETRIES {
                        attempt += 1;
                        self.wait_before_retry(&cancel, retry_after, attempt)
                            .await?;
                        continue;
                    }
                    return Err(error);
                }
            }
        }
    }

    async fn wait_before_retry(
        &self,
        cancel: &Arc<AtomicBool>,
        retry_after_ms: Option<u64>,
        attempt: u32,
    ) -> AppResult<()> {
        let delay = retry_after_ms
            .unwrap_or_else(|| {
                (RETRY_BACKOFF_BASE_MS << (attempt - 1).min(4)).min(RETRY_BACKOFF_CAP_MS)
            })
            .min(RETRY_BACKOFF_CAP_MS);
        let deadline = tokio::time::Instant::now() + Duration::from_millis(delay);
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::llm_cancelled());
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Ok(());
            }
            tokio::time::sleep((deadline - now).min(Duration::from_millis(CANCEL_POLL_MS))).await;
        }
    }
}

/// Sends one request, aborting promptly when cancellation is requested.
/// Returns `Ok(response)` on a 2xx answer, `Ok(Err((error, retry_after_ms)))`
/// on a mapped HTTP status and `Err(error)` on transport failures or cancel.
async fn send_with_cancel(
    client: &Client,
    draft: &ChatRequestDraft,
    timeout_ms: u64,
    cancel: &Arc<AtomicBool>,
) -> Result<reqwest::Response, (AppError, Option<u64>)> {
    let request = client
        .post(&draft.url)
        .headers(to_header_map(draft.headers.clone()))
        .json(&draft.body)
        .build()
        .map_err(|error| {
            (
                AppError::llm_endpoint_unreachable(format!("request_build: {error}")),
                None,
            )
        })?;
    let send = client.execute(request);
    tokio::pin!(send);
    tokio::select! {
        biased;
        _ = poll_cancel(cancel) => Err((AppError::llm_cancelled(), None)),
        outcome = &mut send => match outcome {
            Ok(response) => {
                if response.status().is_success() {
                    Ok(response)
                } else {
                    let status = response.status().as_u16();
                    let retry_after = if status == 429 {
                        parse_retry_after(response.headers())
                    } else {
                        None
                    };
                    let body = response.text().await.unwrap_or_default();
                    Err((map_status(status, &body), retry_after))
                }
            }
            Err(error) => Err((classify_transport_error(&error, timeout_ms), None)),
        },
    }
}

async fn poll_cancel(cancel: &Arc<AtomicBool>) {
    loop {
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(CANCEL_POLL_MS)).await;
    }
}

fn retryable(error: &AppError) -> bool {
    matches!(
        error.code,
        ErrorCode::LlmRateLimited | ErrorCode::LlmServerError
    )
}

fn with_url(mut error: AppError, url: &str) -> AppError {
    let endpoint = url_for_log(url);
    error.params.insert("endpoint".into(), endpoint.into());
    error
}

fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    value.trim().parse::<u64>().ok().map(|secs| secs * 1000)
}

fn to_header_map(headers: Vec<(String, String)>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_bytes()),
            reqwest::header::HeaderValue::from_str(&value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

/// The runner-level structured parse: valid JSON object required. Task-level
/// schema validation happens in the per-task core parsers afterwards.
fn parse_content(content: &str, kind: LlmTaskKind) -> AppResult<Value> {
    if content.trim().is_empty() {
        return Err(AppError::llm_response_interrupted());
    }
    let output: Value = serde_json::from_str(content).map_err(|_| {
        AppError::new(ErrorCode::LlmInvalidStructuredResponse, Severity::Error)
            .with_action(RecoveryAction::Retry)
    })?;
    if !output.is_object() {
        return Err(
            AppError::new(ErrorCode::LlmInvalidStructuredResponse, Severity::Error)
                .with_action(RecoveryAction::Retry)
                .with_param("task_kind", kind.schema_name()),
        );
    }
    Ok(output)
}

fn validate_input_size(profile: &LlmProfile, request: &LlmTaskRequest) -> AppResult<()> {
    if request.input.len() > profile.max_input_bytes {
        return Err(AppError::new(ErrorCode::LlmInputTooLarge, Severity::Error)
            .with_param("max_input_bytes", profile.max_input_bytes));
    }
    Ok(())
}
