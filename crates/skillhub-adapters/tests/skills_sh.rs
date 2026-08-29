use skillhub_adapters::source::SkillsShProvider;
use skillhub_core::source::{SourceKind, SourceSearchQuery};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

#[test]
fn maps_skills_sh_search_results_to_importable_source_hits() {
    let server = fixture_server(
        200,
        r#"{"data":[{"id":"anthropics/skills/pdf","slug":"pdf","name":"PDF","source":"anthropics/skills","installs":42,"sourceType":"github","installUrl":"https://github.com/anthropics/skills","url":"https://skills.sh/anthropics/skills/pdf","isDuplicate":false}],"query":"pdf","searchType":"semantic","count":1,"durationMs":12}"#,
    );
    let page =
        block_on(SkillsShProvider::new(server.as_ref()).search(SourceSearchQuery::new("pdf")))
            .unwrap();
    assert_eq!(page.items[0].source_id, "anthropics/skills/pdf");
    assert_eq!(page.items[0].source.kind, SourceKind::Git);
    assert!(page.items[0].page_url.starts_with("https://skills.sh/"));
}

#[test]
fn respects_retry_after_and_never_falls_back_to_scraping() {
    let server =
        fixture_server_with_headers(429, "{\"error\":\"rate_limited\"}", "Retry-After: 30\r\n");
    let error =
        block_on(SkillsShProvider::new(server.as_ref()).search(SourceSearchQuery::new("pdf")))
            .unwrap_err();
    assert_eq!(error.code.as_str(), "source.search_rate_limited");
    assert_eq!(error.params["retry_after_seconds"], 30);
}

struct FixtureServer {
    base_url: String,
    handle: Option<thread::JoinHandle<()>>,
}

impl FixtureServer {
    fn url(&self) -> &str {
        &self.base_url
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            handle.join().unwrap();
        }
    }
}

fn fixture_server(status: u16, body: &str) -> FixtureServer {
    fixture_server_with_headers(status, body, "")
}

fn fixture_server_with_headers(status: u16, body: &str, headers: &str) -> FixtureServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let body = body.to_owned();
    let headers = headers.to_owned();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0_u8; 4096];
        let _ = stream.read(&mut request);
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nCache-Control: max-age=30\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
    });
    FixtureServer {
        base_url: format!("http://{address}"),
        handle: Some(handle),
    }
}

impl AsRef<str> for FixtureServer {
    fn as_ref(&self) -> &str {
        self.url()
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
