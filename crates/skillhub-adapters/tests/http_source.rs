use skillhub_adapters::source::{HttpsSourceFetcher, SourceFetchErrorCode};

#[tokio::test]
async fn http_fetch_rejects_non_https_sources_before_connecting() {
    let error = HttpsSourceFetcher::default()
        .fetch("http://127.0.0.1/private")
        .await
        .unwrap_err();

    assert_eq!(error.code, SourceFetchErrorCode::HttpsRequired);
}

#[test]
fn redirect_policy_rejects_private_and_non_https_destinations() {
    use skillhub_adapters::source::RedirectPolicy;
    use url::Url;

    let policy = RedirectPolicy::default();
    assert_eq!(
        policy.validate(&Url::parse("http://example.com").unwrap()),
        Err(SourceFetchErrorCode::HttpsRequired)
    );
    assert_eq!(
        policy.validate(&Url::parse("https://127.0.0.1/private").unwrap()),
        Err(SourceFetchErrorCode::RedirectBlocked)
    );
    assert_eq!(
        policy.validate(&Url::parse("https://[::ffff:127.0.0.1]/private").unwrap()),
        Err(SourceFetchErrorCode::RedirectBlocked)
    );
    assert_eq!(
        policy.resolve(
            &Url::parse("https://public.example/source").unwrap(),
            "http://127.0.0.1/private"
        ),
        Err(SourceFetchErrorCode::RedirectBlocked)
    );
}
