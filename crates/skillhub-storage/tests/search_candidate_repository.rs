//! P1-05：搜索候选的持久化语义。候选只是"待确认"记录——
//! 绝不写入 sources/skill_sources，重复保存不改变既有状态
//! （dismissed 的候选不会因再次搜索被重置回 pending）。

use skillhub_core::source::{
    SearchHitOrigin, SourceDescriptor, SourceKind, SourceLocator, SourceSearchHit, SourceSearchPage,
};
use skillhub_storage::Database;

fn hit(source_id: &str, name: &str) -> SourceSearchHit {
    SourceSearchHit {
        source_id: source_id.into(),
        name: name.into(),
        source: SourceDescriptor::new(
            SourceKind::Git,
            SourceLocator::git_url(format!("https://github.com/{source_id}")),
        ),
        install_url: Some(format!("https://skills.sh/skills/{source_id}/install")),
        page_url: format!("https://skills.sh/skills/{source_id}"),
        installs: 7,
        is_duplicate: false,
        via: SearchHitOrigin::OriginalQuery,
    }
}

fn page(items: Vec<SourceSearchHit>) -> SourceSearchPage {
    SourceSearchPage {
        items,
        query: "pdf".into(),
        count: 0,
        search_type: Some("keyword".into()),
        duration_ms: Some(12),
        cache_max_age_seconds: Some(600),
        ai_assisted: false,
        expanded_query: None,
    }
}

#[test]
fn saving_a_page_persists_pending_candidates_without_touching_sources() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.search_candidate_repository();

    let saved = repository
        .save_page(&page(vec![hit("acme/pdf", "PDF skill")]), 1_000)
        .unwrap();
    assert_eq!(saved.len(), 1);
    let candidate = &saved[0];
    assert_eq!(candidate.provider, "skills_sh");
    assert_eq!(candidate.provider_source_id, "acme/pdf");
    assert_eq!(candidate.name, "PDF skill");
    assert_eq!(
        candidate.status,
        skillhub_core::SearchCandidateStatus::Pending
    );
    assert_eq!(candidate.via, SearchHitOrigin::OriginalQuery);
    assert_eq!(candidate.first_seen_at, "1000");
    assert!(!candidate.id.is_empty());

    // 候选绝不写 sources/skill_sources。
    let sources: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM sources", [], |row| row.get(0))
        .unwrap();
    let relations: i64 = database
        .connection_for_test()
        .query_row("SELECT COUNT(*) FROM skill_sources", [], |row| row.get(0))
        .unwrap();
    assert_eq!(sources, 0);
    assert_eq!(relations, 0);

    let listed = repository.list().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, candidate.id);
}

#[test]
fn resaving_keeps_existing_status_and_does_not_duplicate_rows() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.search_candidate_repository();

    let first = repository
        .save_page(&page(vec![hit("acme/pdf", "PDF skill")]), 1_000)
        .unwrap();
    repository
        .set_status(
            &first[0].id,
            skillhub_core::SearchCandidateStatus::Dismissed,
        )
        .unwrap();

    let second = repository
        .save_page(&page(vec![hit("acme/pdf", "PDF skill")]), 2_000)
        .unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].id, first[0].id);
    assert_eq!(
        second[0].status,
        skillhub_core::SearchCandidateStatus::Dismissed,
        "再次搜索不得把已拒绝的候选重置回 pending"
    );
    assert_eq!(second[0].first_seen_at, "1000", "首次发现时间保持不变");
    assert_eq!(repository.list().unwrap().len(), 1);
}

#[test]
fn status_transitions_are_explicit_and_idempotent() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.search_candidate_repository();
    let saved = repository
        .save_page(&page(vec![hit("acme/pdf", "PDF skill")]), 1_000)
        .unwrap();
    let id = saved[0].id.clone();

    let confirmed = repository
        .set_status(&id, skillhub_core::SearchCandidateStatus::Confirmed)
        .unwrap();
    assert_eq!(
        confirmed.status,
        skillhub_core::SearchCandidateStatus::Confirmed
    );
    // 幂等：已确认再次确认仍成功。
    let again = repository
        .set_status(&id, skillhub_core::SearchCandidateStatus::Confirmed)
        .unwrap();
    assert_eq!(
        again.status,
        skillhub_core::SearchCandidateStatus::Confirmed
    );
    // 拒绝已确认的候选：允许（用户可以反悔）。
    let dismissed = repository
        .set_status(&id, skillhub_core::SearchCandidateStatus::Dismissed)
        .unwrap();
    assert_eq!(
        dismissed.status,
        skillhub_core::SearchCandidateStatus::Dismissed
    );
    // 幂等：已拒绝再次拒绝仍成功。
    let again = repository
        .set_status(&id, skillhub_core::SearchCandidateStatus::Dismissed)
        .unwrap();
    assert_eq!(
        again.status,
        skillhub_core::SearchCandidateStatus::Dismissed
    );

    let unknown = repository
        .set_status(&id, skillhub_core::SearchCandidateStatus::Confirmed)
        .unwrap_err();
    assert_eq!(unknown.code, skillhub_core::ErrorCode::OperationConflict);

    let missing = repository
        .set_status(
            "candidate:does-not-exist",
            skillhub_core::SearchCandidateStatus::Confirmed,
        )
        .unwrap_err();
    assert_eq!(missing.code, skillhub_core::ErrorCode::ObjectNotFound);
}
