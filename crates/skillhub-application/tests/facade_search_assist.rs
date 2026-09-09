//! Online search assist: the LLM only rewrites/extends the query, the
//! original query always runs against the real provider first, AI-extended
//! hits are marked as such, and any LLM failure falls back to the plain
//! results. The provider is the only source of hits — the LLM cannot invent
//! entries.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::json;
use skillhub_adapters::source::SkillsShProvider;
use skillhub_application::LocalApplicationFacade;
use skillhub_core::source::SearchHitOrigin;
use skillhub_core::{AppCommand, AppQuery, AppQueryResult, ApplicationFacade};
use skillhub_storage::Database;
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Serves one skills.sh-shaped answer per requested query and records every
/// request path, so tests can prove exactly which queries ran.
async fn serve_queries(answers: HashMap<&'static str, String>) -> String {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("listener");
    let address = listener.local_addr().expect("address");
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut request = [0_u8; 4096];
            let read = stream.read(&mut request).await.unwrap_or(0);
            let request_text = String::from_utf8_lossy(&request[..read]).into_owned();
            let answered = answers
                .iter()
                .find(|(query, _)| request_text.contains(&format!("q={query}&")));
            let body = answered
                .map(|(_, body)| body.clone())
                .unwrap_or_else(|| r#"{"skills":[],"count":0}"#.to_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.expect("write");
        }
    });
    format!("http://{address}/")
}

fn page_for(query: &str, ids: &[&str]) -> String {
    let skills: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "skillId": id.split('/').next_back().unwrap_or(id),
                "name": format!("skill {id}"),
                "installs": 7,
                "source": id,
            })
        })
        .collect();
    json!({
        "query": query,
        "searchType": "keyword",
        "skills": skills,
        "count": skills.len(),
        "duration_ms": 1,
    })
    .to_string()
}

/// Rewrites the user text into a broader query; records that it ran.
struct ExpandRunner {
    calls: Mutex<usize>,
    fail: bool,
}

#[async_trait(?Send)]
impl skillhub_core::LlmTaskRunner for ExpandRunner {
    async fn run(
        &self,
        _profile: &skillhub_core::LlmProfile,
        _request: skillhub_core::LlmTaskRequest,
    ) -> skillhub_core::AppResult<skillhub_core::LlmTaskResponse> {
        *self.calls.lock().expect("calls") += 1;
        if self.fail {
            return Err(skillhub_core::AppError::llm_request_timeout(1_000));
        }
        Ok(skillhub_core::LlmTaskResponse {
            request_id: "expand-request".to_owned(),
            kind: skillhub_core::LlmTaskKind::SearchQuery,
            output: json!({"query": "pdf extraction", "source_filters": []}),
        })
    }
}

async fn enable_search_assist(facade: &LocalApplicationFacade) {
    facade
        .execute(AppCommand::SetDesktopPreferences(
            skillhub_core::DesktopPreferences {
                llm_capabilities: skillhub_core::settings::LlmCapabilitySettings {
                    online_search_assist: true,
                    ..skillhub_core::settings::LlmCapabilitySettings::default()
                },
                ..skillhub_core::DesktopPreferences::default()
            },
        ))
        .await
        .expect("enable search assist");
}

fn profile() -> skillhub_core::LlmProfile {
    skillhub_core::LlmProfile::new(
        "test",
        "https://llm.example.test/v1/chat/completions",
        "test-model",
        None,
    )
    .expect("profile")
}

async fn assisted(facade: &LocalApplicationFacade, text: &str) -> AppQueryResult {
    facade
        .query(AppQuery::SearchOnlineSourcesAssisted(
            skillhub_core::api::SearchOnlineSourcesAssisted {
                text: text.to_owned(),
            },
        ))
        .await
        .expect("assisted search")
}

#[tokio::test]
async fn assisted_search_merges_expanded_hits_and_marks_their_origin() {
    let mut answers = HashMap::new();
    answers.insert("pdf", page_for("pdf", &["acme/pdf"]));
    answers.insert(
        "pdf+extraction",
        page_for("pdf extraction", &["other/regex"]),
    );
    let base = serve_queries(answers).await;
    let runner = Arc::new(ExpandRunner {
        calls: Mutex::new(0),
        fail: false,
    });
    let database = Database::open_in_memory().expect("database");
    database
        .llm_profile_repository()
        .save(&profile())
        .expect("save profile");
    let facade = LocalApplicationFacade::new_with_providers(
        database,
        Arc::new(
            skillhub_adapters::app_update::github_releases::GithubReleaseProvider::new()
                .with_network_enabled(false),
        ),
        Arc::new(SkillsShProvider::new(&base)),
    )
    .with_llm_runner(runner.clone());
    enable_search_assist(&facade).await;

    let result = assisted(&facade, "pdf").await;
    let AppQueryResult::SourceSearchPage(page) = result else {
        panic!("expected source search page");
    };
    assert!(page.ai_assisted, "AI extension must be recognizable");
    assert_eq!(page.expanded_query.as_deref(), Some("pdf extraction"));
    assert_eq!(page.items.len(), 2, "only real provider hits, merged");
    assert_eq!(page.items[0].source_id, "acme/pdf");
    assert_eq!(page.items[0].via, SearchHitOrigin::OriginalQuery);
    assert_eq!(page.items[1].source_id, "other/regex");
    assert_eq!(page.items[1].via, SearchHitOrigin::ExpandedQuery);
    assert_eq!(*runner.calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn assisted_search_falls_back_to_base_results_when_llm_fails() {
    let mut answers = HashMap::new();
    answers.insert("pdf", page_for("pdf", &["acme/pdf"]));
    let base = serve_queries(answers).await;
    let database = Database::open_in_memory().expect("database");
    database
        .llm_profile_repository()
        .save(&profile())
        .expect("save profile");
    let facade = LocalApplicationFacade::new_with_providers(
        database,
        Arc::new(
            skillhub_adapters::app_update::github_releases::GithubReleaseProvider::new()
                .with_network_enabled(false),
        ),
        Arc::new(SkillsShProvider::new(&base)),
    )
    .with_llm_runner(Arc::new(ExpandRunner {
        calls: Mutex::new(0),
        fail: true,
    }));
    enable_search_assist(&facade).await;

    let result = assisted(&facade, "pdf").await;
    let AppQueryResult::SourceSearchPage(page) = result else {
        panic!("expected source search page");
    };
    assert!(!page.ai_assisted);
    assert_eq!(page.expanded_query, None);
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].via, SearchHitOrigin::OriginalQuery);
}

#[tokio::test]
async fn assisted_search_without_capability_runs_a_plain_search() {
    let mut answers = HashMap::new();
    answers.insert("pdf", page_for("pdf", &["acme/pdf"]));
    let base = serve_queries(answers).await;
    let runner = Arc::new(ExpandRunner {
        calls: Mutex::new(0),
        fail: false,
    });
    let facade = LocalApplicationFacade::new_with_providers(
        Database::open_in_memory().expect("database"),
        Arc::new(
            skillhub_adapters::app_update::github_releases::GithubReleaseProvider::new()
                .with_network_enabled(false),
        ),
        Arc::new(SkillsShProvider::new(&base)),
    )
    .with_llm_runner(runner.clone());
    // Capability stays off (default).

    let result = assisted(&facade, "pdf").await;
    let AppQueryResult::SourceSearchPage(page) = result else {
        panic!("expected source search page");
    };
    assert!(!page.ai_assisted);
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        *runner.calls.lock().unwrap(),
        0,
        "capability off: no LLM call"
    );
}
