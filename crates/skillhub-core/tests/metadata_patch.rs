use skillhub_core::catalog::{CallPolicy, Skill, SkillLifecycle};
use skillhub_core::{PatchField, SkillId, SkillMetadataPatch};
use std::collections::BTreeSet;

#[test]
fn metadata_patch_keeps_omitted_null_and_value_distinct_on_the_wire() {
    let patch: SkillMetadataPatch = serde_json::from_value(serde_json::json!({
        "display_name": null,
        "note": "reviewed",
        "tags": [],
        "author": null
    }))
    .expect("deserialize metadata patch");

    assert_eq!(patch.display_name, PatchField::Clear);
    assert_eq!(patch.note, PatchField::Set("reviewed".to_owned()));
    assert_eq!(patch.tags, PatchField::Set(Vec::new()));
    assert_eq!(patch.author, PatchField::Clear);
    assert_eq!(patch.license, PatchField::Unchanged);

    let encoded = serde_json::to_value(patch).expect("serialize metadata patch");
    assert_eq!(encoded["display_name"], serde_json::Value::Null);
    assert_eq!(encoded["note"], "reviewed");
    assert_eq!(encoded["tags"], serde_json::json!([]));
    assert_eq!(encoded["author"], serde_json::Value::Null);
    assert!(encoded.get("license").is_none());

    let omitted: SkillMetadataPatch = serde_json::from_value(serde_json::json!({}))
        .expect("omitted patch members default to unchanged");
    assert_eq!(omitted.display_name, PatchField::Unchanged);
    assert_eq!(omitted.tags, PatchField::Unchanged);
}

#[test]
fn metadata_patch_command_preserves_the_same_wire_contract() {
    let command: skillhub_core::AppCommand = serde_json::from_value(serde_json::json!({
        "type": "patch_skill_metadata",
        "payload": {
            "skill_id": SkillId::new(),
            "patch": { "display_name": null, "note": "memo" }
        }
    }))
    .expect("decode patch command");

    let skillhub_core::AppCommand::PatchSkillMetadata(request) = command else {
        panic!("expected patch metadata command");
    };
    assert_eq!(request.patch.display_name, PatchField::Clear);
    assert_eq!(request.patch.note, PatchField::Set("memo".to_owned()));
    assert_eq!(request.patch.tags, PatchField::Unchanged);
}

#[test]
fn clearing_alias_returns_to_runtime_name_without_changing_identity() {
    let mut skill = Skill::from_parts(
        SkillId::new(),
        "PDF helper".to_owned(),
        "pdf-reader".to_owned(),
        "Extract tables".to_owned(),
        None,
        Some("keep this note".to_owned()),
        Some("table extraction".to_owned()),
        BTreeSet::from(["documents".to_owned()]),
        Some("Author".to_owned()),
        Some("MIT".to_owned()),
        CallPolicy::AutomaticAndManual,
        SkillLifecycle::Normal,
        Vec::new(),
        None,
    )
    .expect("skill builds");

    skill
        .patch_metadata(SkillMetadataPatch {
            display_name: PatchField::Clear,
            ..Default::default()
        })
        .expect("clear alias");

    assert_eq!(skill.display_name(), "pdf-reader");
    assert_eq!(skill.runtime_name(), "pdf-reader");
    assert_eq!(skill.note(), Some("keep this note"));
    assert_eq!(skill.user_purpose(), Some("table extraction"));
    assert_eq!(skill.tags(), &BTreeSet::from(["documents".to_owned()]));
    assert_eq!(skill.author(), Some("Author"));
    assert_eq!(skill.license(), Some("MIT"));
}

#[test]
fn invalid_metadata_patch_is_atomic() {
    let mut skill = Skill::new(SkillId::new(), "pdf")
        .with_note("existing")
        .with_tag("documents");
    let original = skill.clone();

    let result = skill.patch_metadata(SkillMetadataPatch {
        display_name: PatchField::Set("  ".to_owned()),
        note: PatchField::Clear,
        tags: PatchField::Clear,
        ..Default::default()
    });

    assert_eq!(
        result.expect_err("empty alias is invalid").code.as_str(),
        "input.invalid"
    );
    assert_eq!(skill, original);
}
