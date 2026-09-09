use skillhub_core::llm::translation::{
    TranslationOrigin, TranslationProvenance, TranslationRecord,
};
use skillhub_core::SkillId;
use skillhub_storage::Database;

fn skill_id(tag: &str) -> SkillId {
    format!("00000000-0000-0000-0000-00000000000{tag}")
        .parse()
        .expect("skill id")
}

fn generated_record(skill_id: SkillId, text: &str) -> TranslationRecord {
    TranslationRecord {
        skill_id,
        language: "zh-CN".to_owned(),
        text: text.to_owned(),
        provenance: TranslationProvenance {
            source_description_hash: "hash-1".to_owned(),
            provider: "deepseek".to_owned(),
            model: "deepseek-chat".to_owned(),
            origin: TranslationOrigin::Generated,
        },
        origin: TranslationOrigin::Generated,
    }
}

fn persisted(record: TranslationRecord) -> skillhub_storage::PersistedTranslation {
    skillhub_storage::PersistedTranslation {
        record,
        version_id: Some("sha256:abc".to_owned()),
        created_at: 1_000,
        updated_at: 2_000,
    }
}

#[test]
fn save_then_get_round_trips_provenance_and_version() {
    let database = Database::open_in_memory().expect("database");
    let id = skill_id("a");
    let record = generated_record(id, "提取 PDF 文本");
    database
        .translation_record_repository()
        .save(&persisted(record.clone()))
        .expect("save translation");

    let loaded = database
        .translation_record_repository()
        .get(&id, "zh-CN")
        .expect("get translation")
        .expect("translation stored");
    assert_eq!(loaded.record, record);
    assert_eq!(loaded.version_id.as_deref(), Some("sha256:abc"));
    assert_eq!(loaded.created_at, 1_000);
    assert_eq!(loaded.updated_at, 2_000);
}

#[test]
fn upsert_replaces_text_and_keeps_one_row_per_language() {
    let database = Database::open_in_memory().expect("database");
    let id = skill_id("b");
    let repository = database.translation_record_repository();
    repository
        .save(&persisted(generated_record(id, "第一版译文")))
        .expect("save first");
    let mut updated = generated_record(id, "第二版译文");
    updated.provenance.source_description_hash = "hash-2".to_owned();
    let mut row = persisted(updated);
    row.created_at = 1_000;
    row.updated_at = 3_000;
    repository.save(&row).expect("save second");

    let loaded = repository.get(&id, "zh-CN").expect("get").expect("row");
    assert_eq!(loaded.record.text, "第二版译文");
    assert_eq!(loaded.record.provenance.source_description_hash, "hash-2");
    assert_eq!(repository.list_for_skill(&id).expect("list").len(), 1);

    let user_revision = TranslationRecord {
        skill_id: id,
        language: "en-US".to_owned(),
        text: "Extract PDF text".to_owned(),
        provenance: TranslationProvenance {
            source_description_hash: "hash-1".to_owned(),
            provider: "user".to_owned(),
            model: "user_revision".to_owned(),
            origin: TranslationOrigin::UserRevision,
        },
        origin: TranslationOrigin::UserRevision,
    };
    repository
        .save(&persisted(user_revision))
        .expect("save revision");
    assert_eq!(repository.list_for_skill(&id).expect("list").len(), 2);
}

#[test]
fn list_for_skill_is_scoped_and_delete_is_idempotent() {
    let database = Database::open_in_memory().expect("database");
    let id = skill_id("c");
    let other = skill_id("d");
    let repository = database.translation_record_repository();
    repository
        .save(&persisted(generated_record(id, "目标技能译文")))
        .expect("save target");
    repository
        .save(&persisted(generated_record(other, "其他技能译文")))
        .expect("save other");

    let listed = repository.list_for_skill(&id).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].record.skill_id, id);

    repository.delete(&id, "zh-CN").expect("delete");
    assert!(repository
        .get(&id, "zh-CN")
        .expect("get after delete")
        .is_none());
    // Deleting an absent record stays idempotent.
    repository.delete(&id, "zh-CN").expect("delete again");
    assert_eq!(repository.list_for_skill(&other).expect("list").len(), 1);
}
