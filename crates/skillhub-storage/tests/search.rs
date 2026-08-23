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
        translated_description: None,
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

#[test]
fn bm25_searches_name_note_translation_tags_and_markdown() {
    let repo = indexed_catalog_fixture();
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
