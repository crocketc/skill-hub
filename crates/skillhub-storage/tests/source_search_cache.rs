use skillhub_core::source::{SourceSearchPage, SourceSearchQuery};
use skillhub_storage::Database;

#[test]
fn cache_round_trip_is_keyed_by_query_and_expiry_is_explicit() {
    let database = Database::open_in_memory().unwrap();
    let query = SourceSearchQuery::new("pdf");
    let page = SourceSearchPage {
        items: vec![],
        query: "pdf".into(),
        count: 0,
        search_type: None,
        duration_ms: None,
        cache_max_age_seconds: Some(30),
    };
    database
        .source_search_cache()
        .put(&query, &page, 1_000)
        .unwrap();
    assert_eq!(
        database.source_search_cache().get(&query, 1_029).unwrap(),
        Some(page.clone())
    );
    assert_eq!(
        database.source_search_cache().get(&query, 1_030).unwrap(),
        None
    );
    assert_eq!(
        database
            .source_search_cache()
            .get(&SourceSearchQuery::new("react"), 1_029)
            .unwrap(),
        None
    );
}
