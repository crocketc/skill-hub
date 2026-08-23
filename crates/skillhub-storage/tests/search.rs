use skillhub_core::search::{SearchDocument, SearchField, SearchQuery};
use skillhub_core::SkillId;
use skillhub_storage::{Database, SearchRepository};

fn document(
    id: &str,
    name: &str,
    description: &str,
    note: &str,
    tags: &[&str],
    markdown: &str,
) -> SearchDocument {
    SearchDocument {
        skill_id: id.parse().unwrap(),
        display_name: name.to_owned(),
        runtime_name: name.to_owned(),
        original_description: description.to_owned(),
        translated_description: Some("PDF table extraction 中文说明".to_owned()),
        user_note: Some(note.to_owned()),
        tags: tags.iter().map(|value| (*value).to_owned()).collect(),
        author: Some("SkillHub".to_owned()),
        license: Some("MIT".to_owned()),
        requirements: vec!["Python".to_owned()],
        markdown: markdown.to_owned(),
    }
}

fn indexed_catalog_fixture() -> SearchRepository<'static> {
    let database = Box::leak(Box::new(Database::open_in_memory().unwrap()));
    let repository = SearchRepository::new(database);
    repository
        .reindex_skill(&document(
            "00000000-0000-0000-0000-000000000001",
            "pdf-extractor",
            "Extract PDF tables",
            "PDF 表格提取",
            &["pdf", "table"],
            "# PDF\nExtract PDF tables into CSV.",
        ))
        .unwrap();
    repository
        .reindex_skill(&document(
            "00000000-0000-0000-0000-000000000002",
            "audio-notes",
            "Meeting transcript helper",
            "会议记录",
            &["audio", "meeting"],
            "# Meeting transcript\nConvert audio to notes.",
        ))
        .unwrap();
    repository
}

fn indexed_catalog_fixture_with_pdf_only() -> SearchRepository<'static> {
    let repo = indexed_catalog_fixture();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000006",
        "pdf-only",
        "PDF utility",
        "unrelated note",
        &["pdf"],
        "# Utility",
    ))
    .unwrap();
    repo
}

#[test]
fn bm25_searches_name_note_translation_tags_and_markdown() {
    let repo = indexed_catalog_fixture();
    assert_eq!(
        repo.search(SearchQuery::new("pdf")).unwrap()[0].skill_name,
        "pdf-extractor"
    );
    assert_eq!(
        repo.search(SearchQuery::new("PDF 表格")).unwrap()[0].skill_name,
        "pdf-extractor"
    );
    assert_eq!(
        repo.search(SearchQuery::new("meeting transcript")).unwrap()[0].skill_name,
        "audio-notes"
    );
}

#[test]
fn bm25_rank_is_populated_and_orders_more_relevant_hits_first() {
    let repo = indexed_catalog_fixture();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000005",
        "generic-tool",
        "A generic utility",
        "PDF",
        &["misc"],
        "# Utility\nA generic utility.",
    ))
    .unwrap();
    let hits = repo.search("PDF").unwrap();
    assert!(hits[0].rank <= hits[1].rank);
    assert_ne!(hits[0].rank, 0.0);
}

#[test]
fn fallback_keeps_multi_word_queries_as_and() {
    let repo = indexed_catalog_fixture_with_pdf_only();
    let hits = repo.search("pdf 表格").unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].skill_name, "pdf-extractor");
}

#[test]
fn fallback_like_escapes_percent_and_underscore_literals() {
    let repo = indexed_catalog_fixture();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000007",
        "literal-markers",
        "Literal marker search",
        "100% complete _draft",
        &["literal"],
        "# Markers",
    ))
    .unwrap();
    let percent_hits = repo.search("%").unwrap();
    assert_eq!(percent_hits.len(), 1);
    assert_eq!(percent_hits[0].skill_name, "literal-markers");
    let underscore_hits = repo.search("_").unwrap();
    assert_eq!(underscore_hits.len(), 1);
    assert_eq!(underscore_hits[0].skill_name, "literal-markers");
}

#[test]
fn search_preserves_original_display_name_and_indexes_translation_and_tags() {
    let database = Box::leak(Box::new(Database::open_in_memory().unwrap()));
    let repo = SearchRepository::new(database);
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000004",
        "PDF Extractor",
        "Extract documents",
        "用户备注",
        &["文档处理"],
        "# Extract\ncontent",
    ))
    .unwrap();
    assert_eq!(repo.search("pdf").unwrap()[0].skill_name, "PDF Extractor");
    assert!(!repo.search("中文说明").unwrap().is_empty());
    assert!(!repo.search("文档处理").unwrap().is_empty());
}

#[test]
fn updating_one_skill_does_not_rebuild_unrelated_rows() {
    let repo = indexed_catalog_fixture();
    let before = repo
        .index_revision(&"00000000-0000-0000-0000-000000000002".parse().unwrap())
        .unwrap();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000001",
        "pdf-extractor",
        "Changed PDF table extractor",
        "PDF 表格提取",
        &["pdf", "table"],
        "# PDF\nChanged content.",
    ))
    .unwrap();
    assert_eq!(
        repo.index_revision(&"00000000-0000-0000-0000-000000000002".parse().unwrap())
            .unwrap(),
        before
    );
}

#[test]
fn search_returns_field_codes_for_highlights() {
    let repo = indexed_catalog_fixture();
    let hit = &repo.search(SearchQuery::new("表格")).unwrap()[0];
    assert!(hit.highlighted_fields.contains(&SearchField::UserNote));
}

#[test]
fn highlight_fields_are_calculated_per_query_term() {
    let repo = indexed_catalog_fixture();
    let hit = &repo.search("PDF").unwrap()[0];
    assert!(hit
        .highlighted_fields
        .contains(&SearchField::OriginalDescription));
    assert!(hit.highlighted_fields.contains(&SearchField::UserNote));
    assert!(hit.highlighted_fields.contains(&SearchField::Tags));
}

#[test]
fn duplicate_candidates_are_deterministic_and_metadata_based() {
    let repo = indexed_catalog_fixture();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000003",
        "pdf-extractor-copy",
        "Extract PDF tables",
        "PDF 表格提取",
        &["pdf", "table"],
        "# PDF\nExtract PDF tables into CSV.",
    ))
    .unwrap();
    let first = repo.duplicate_candidates().unwrap();
    let second = repo.duplicate_candidates().unwrap();
    assert_eq!(first, second);
    assert_eq!(
        first[0].left_skill_id,
        "00000000-0000-0000-0000-000000000001"
            .parse::<SkillId>()
            .unwrap()
    );
    assert_eq!(
        first[0].right_skill_id,
        "00000000-0000-0000-0000-000000000003"
            .parse::<SkillId>()
            .unwrap()
    );
}

#[test]
fn duplicate_candidates_survive_small_markdown_changes() {
    let repo = indexed_catalog_fixture();
    repo.reindex_skill(&document(
        "00000000-0000-0000-0000-000000000003",
        "pdf-extractor-copy",
        "Extract PDF tables",
        "PDF 表格提取",
        &["pdf", "table"],
        "# PDF\nExtract PDF tables into CSV with a note.",
    ))
    .unwrap();
    assert!(repo
        .duplicate_candidates()
        .unwrap()
        .iter()
        .any(|candidate| candidate.right_skill_id
            == "00000000-0000-0000-0000-000000000003"
                .parse::<SkillId>()
                .unwrap()));
}
