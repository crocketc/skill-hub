use skillhub_core::{
    catalog::{
        CallPolicy, CatalogRepository, DeclaredRequirement, InvocationPolicySource,
        RequirementKind, Skill,
    },
    source::SourceState,
    ListSkills, SkillId, SkillVersionFilter,
};
use skillhub_storage::{CatalogRepositorySqlite, Database};

#[test]
fn catalog_round_trip_preserves_original_and_user_metadata() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let skill = Skill::new(SkillId::new(), "pdf")
        .with_description("Extract PDF tables")
        .with_note("用于提取 PDF 表格")
        .with_tag("document")
        .with_author("Ada")
        .with_license("MIT");
    block_on(repo.insert(&skill)).unwrap();
    let before: (i64, i64) = db
        .connection_for_test()
        .query_row(
            "SELECT created_at,updated_at FROM skills WHERE id=?1",
            [skill.id().to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(before.0 > 0 && before.1 > 0);
    assert_eq!(block_on(repo.get(skill.id())).unwrap().unwrap(), skill);
}

#[test]
fn repeated_insert_preserves_existing_version_relationships_and_timestamps() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let skill = Skill::new(SkillId::new(), "pdf");
    block_on(repo.insert(&skill)).unwrap();
    let before: (i64, i64) = db
        .connection_for_test()
        .query_row(
            "SELECT created_at,updated_at FROM skills WHERE id=?1",
            [skill.id().to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(before.0 > 0 && before.1 > 0);
    db.connection_for_test().execute("INSERT INTO versions(id,skill_id,content_hash,manifest_json,created_at) VALUES ('v',?1,'h','{}',1)", [skill.id().to_string()]).unwrap();
    block_on(repo.insert(&skill.clone().with_note("updated"))).unwrap();
    let after: (i64, i64) = db
        .connection_for_test()
        .query_row(
            "SELECT created_at,updated_at FROM skills WHERE id=?1",
            [skill.id().to_string()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(after.0, before.0);
    assert!(after.1 >= before.1);
    let count: i64 = db
        .connection_for_test()
        .query_row(
            "SELECT COUNT(*) FROM versions WHERE skill_id=?1",
            [skill.id().to_string()],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn set_metadata_persists_user_purpose_independently_of_descriptions() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let mut skill = Skill::new(SkillId::new(), "pdf")
        .with_description("Extract PDF tables")
        .with_note("keep near docs");
    skill
        .set_metadata(
            None,
            Some("keep near docs".to_owned()),
            Default::default(),
            None,
            None,
            Some("用于 PDF 表格提取".to_owned()),
        )
        .unwrap();
    block_on(repo.insert(&skill)).unwrap();

    let reloaded = block_on(repo.get(skill.id())).unwrap().unwrap();
    assert_eq!(reloaded.user_purpose(), Some("用于 PDF 表格提取"));
    assert_eq!(reloaded.original_description(), "Extract PDF tables");
    assert_eq!(reloaded.note(), Some("keep near docs"));

    // 清空用途后原文与备注不受影响。
    skill
        .set_metadata(None, None, Default::default(), None, None, None)
        .unwrap();
    block_on(repo.insert(&skill)).unwrap();
    let reloaded = block_on(repo.get(skill.id())).unwrap().unwrap();
    assert_eq!(reloaded.user_purpose(), None);
    assert_eq!(reloaded.original_description(), "Extract PDF tables");
}

#[test]
fn catalog_round_trip_preserves_extended_invocation_policy() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let skill = Skill::from_parts(
        SkillId::new(),
        "model-only".to_owned(),
        "model-only".to_owned(),
        "Description".to_owned(),
        None,
        None,
        None,
        Default::default(),
        None,
        None,
        CallPolicy::ModelOnly,
        skillhub_core::catalog::SkillLifecycle::Normal,
        Vec::new(),
        None,
    )
    .unwrap();

    block_on(repo.insert(&skill)).unwrap();
    assert_eq!(
        block_on(repo.get(skill.id()))
            .unwrap()
            .unwrap()
            .call_policy(),
        CallPolicy::ModelOnly
    );
}

#[test]
fn list_and_detail_project_invocation_and_declared_requirements_consistently() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let mut requirement = DeclaredRequirement::new(RequirementKind::OtherTool, "poppler");
    requirement.version = Some("24".to_owned());
    requirement.source = "requires poppler >= 24".to_owned();
    let skill = Skill::from_parts(
        SkillId::new(),
        "PDF reader".to_owned(),
        "pdf-reader".to_owned(),
        "Extract PDF text".to_owned(),
        None,
        None,
        None,
        Default::default(),
        None,
        None,
        CallPolicy::ManualOnly,
        skillhub_core::catalog::SkillLifecycle::Normal,
        vec![requirement],
        None,
    )
    .unwrap()
    .with_invocation(
        CallPolicy::ManualOnly,
        InvocationPolicySource::Explicit,
        Some("invocation".to_owned()),
    );
    block_on(repo.insert(&skill)).unwrap();

    let page = repo
        .list_page(&ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        })
        .unwrap();
    let listed = page.items.iter().find(|item| item.skill_id == skill.id()).unwrap();
    let detailed = repo.get_detail(skill.id()).unwrap().unwrap();

    for item in [listed, &detailed] {
        let policy = item.invocation_policy.as_ref().unwrap();
        assert_eq!(policy.mode, skillhub_core::catalog::InvocationMode::UserOnly);
        assert_eq!(policy.source, InvocationPolicySource::Explicit);
        assert_eq!(policy.field.as_deref(), Some("invocation"));
        assert_eq!(item.declared_requirements.len(), 1);
        assert_eq!(item.declared_requirements[0].name, "poppler");
        assert_eq!(item.declared_requirements[0].version.as_deref(), Some("24"));
        assert_eq!(item.declared_requirements[0].source, "requires poppler >= 24");
    }
}

#[test]
fn list_page_projects_user_tags_and_purpose_into_list_items() {
    // DEV-16：列表行的用户字段投影。get_detail 会 attach_tags，list_page
    // 此前从未调用 → 技能库「标签」列恒为空（用途列却有值），同一份数据
    // 在不同视图的投影不一致。
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let mut skill = Skill::new(SkillId::new(), "pdf")
        .with_description("Extract PDF tables")
        .with_tag("document");
    skill
        .set_metadata(
            None,
            None,
            ["document".to_owned()].into_iter().collect(),
            None,
            None,
            Some("用于 PDF 表格提取".to_owned()),
        )
        .unwrap();
    block_on(repo.insert(&skill)).unwrap();
    let untagged = Skill::new(SkillId::new(), "notes").with_description("Notes");
    block_on(repo.insert(&untagged)).unwrap();

    let page = repo
        .list_page(&ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        })
        .unwrap();
    assert_eq!(page.items.len(), 2);
    let tagged = page
        .items
        .iter()
        .find(|item| item.skill_id == skill.id())
        .unwrap();
    assert_eq!(tagged.tags, vec!["document".to_owned()]);
    assert_eq!(tagged.user_purpose.as_deref(), Some("用于 PDF 表格提取"));
    let plain = page
        .items
        .iter()
        .find(|item| item.skill_id == untagged.id())
        .unwrap();
    assert!(plain.tags.is_empty());
}

#[test]
fn list_page_projects_persisted_upstream_state_and_filters_updates() {
    let db = Database::open_in_memory().unwrap();
    let repo = CatalogRepositorySqlite::new(&db).unwrap();
    let available = Skill::new(SkillId::new(), "available");
    let unchanged = Skill::new(SkillId::new(), "unchanged");
    block_on(repo.insert(&available)).unwrap();
    block_on(repo.insert(&unchanged)).unwrap();

    db.connection_for_test()
        .execute(
            "INSERT INTO source_update_checks(skill_id,state,upstream_label,checked_at) VALUES (?1,'update_available','v2',100)",
            [available.id().to_string()],
        )
        .unwrap();
    db.connection_for_test()
        .execute(
            "INSERT INTO source_update_checks(skill_id,state,upstream_label,checked_at) VALUES (?1,'up_to_date',NULL,100)",
            [unchanged.id().to_string()],
        )
        .unwrap();

    let all = repo
        .list_page(&ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: Default::default(),
            sort: Default::default(),
        })
        .unwrap();
    assert_eq!(
        all.items
            .iter()
            .find(|item| item.skill_id == available.id())
            .unwrap()
            .upstream_state,
        Some(SourceState::UpdateAvailable)
    );

    let updates = repo
        .list_page(&ListSkills {
            text: String::new(),
            page: 1,
            page_size: 10,
            filters: skillhub_core::api::SkillListFilters {
                version: SkillVersionFilter::UpgradeAvailable,
                ..Default::default()
            },
            sort: Default::default(),
        })
        .unwrap();
    assert_eq!(updates.total, 1);
    assert_eq!(updates.items[0].skill_id, available.id());
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::{
        future::Future,
        pin::Pin,
        task::{Context, Poll, RawWaker, RawWakerVTable, Waker},
    };
    fn no_op(_: *const ()) {}
    fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, no_op, no_op, no_op);
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let mut cx = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        if let Poll::Ready(value) = Pin::new(&mut future).poll(&mut cx) {
            return value;
        }
    }
}
