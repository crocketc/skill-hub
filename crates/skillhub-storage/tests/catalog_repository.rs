use skillhub_core::{
    catalog::{CatalogRepository, Skill},
    SkillId,
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
