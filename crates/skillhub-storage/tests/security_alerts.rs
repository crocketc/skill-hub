//! W3-1（FB-003 裁决第 1 节）：安全预警状态（security_alerts）语义。
//!
//! 预警绑定内容版本；同版本不重复提示；完全信任解除后同版本不再重新
//! 预警；版本内容变化产生新行即重新预警；"稍后处理"期间持续不可派发
//! （留在待办）。唯一性设计：(skill_id, version_id, decision_source)
//! 为主键——导入来源一行、信任留痕一行。

use skillhub_core::check::ProductLevel;
use skillhub_core::{SkillId, VersionId};
use skillhub_storage::{Database, SecurityAlertSource};

fn version_id(seed: u8) -> VersionId {
    let hex: String = std::iter::repeat_n(format!("{seed:02x}"), 32).collect();
    VersionId::parse(&format!("sha256:{hex}")).expect("version id")
}

#[test]
fn import_alert_is_active_and_not_duplicated_for_the_same_version() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let repository = database.security_alert_repository();
    let version = version_id(1);

    repository
        .record_import_alert(skill, &version, ProductLevel::Danger)
        .unwrap();
    assert_eq!(
        repository.active_alert_level(skill, &version).unwrap(),
        Some(ProductLevel::Danger)
    );

    // 同版本重复导入（删除后重装同内容、重试导入）不新增行、不重复提示。
    repository
        .record_import_alert(skill, &version, ProductLevel::Danger)
        .unwrap();
    let rows = repository.alerts_for_skill(skill).unwrap();
    assert_eq!(rows.len(), 1, "same version must not duplicate alert rows");

    // 预警只绑定内容版本：其他版本不受影响。
    assert_eq!(
        repository
            .active_alert_level(skill, &version_id(2))
            .unwrap(),
        None
    );
}

#[test]
fn trust_closes_the_alert_and_survives_reimport_of_the_same_version() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let repository = database.security_alert_repository();
    let version = version_id(3);

    repository
        .record_import_alert(skill, &version, ProductLevel::Warning)
        .unwrap();
    repository.record_trust(skill, &version).unwrap();
    assert_eq!(
        repository.active_alert_level(skill, &version).unwrap(),
        None,
        "完全信任解除预警，恢复可派发"
    );

    // 同版本再次导入不复活预警（同版本不重复提示）。
    repository
        .record_import_alert(skill, &version, ProductLevel::Warning)
        .unwrap();
    assert_eq!(
        repository.active_alert_level(skill, &version).unwrap(),
        None
    );
}

#[test]
fn trust_is_idempotent_per_version() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let repository = database.security_alert_repository();
    let version = version_id(4);

    repository.record_trust(skill, &version).unwrap();
    repository.record_trust(skill, &version).unwrap();

    let rows = repository.alerts_for_skill(skill).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.source == SecurityAlertSource::Trust)
            .count(),
        1,
        "同版本重复信任只保留一行留痕"
    );
    assert_eq!(
        repository.active_alert_level(skill, &version).unwrap(),
        None
    );
}

#[test]
fn version_change_realerts_while_the_old_version_stays_trusted() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let repository = database.security_alert_repository();
    let old_version = version_id(5);
    let new_version = version_id(6);

    repository
        .record_import_alert(skill, &old_version, ProductLevel::Danger)
        .unwrap();
    repository.record_trust(skill, &old_version).unwrap();

    // 版本内容变化：新版本导入后重新进入预警。
    repository
        .record_import_alert(skill, &new_version, ProductLevel::Danger)
        .unwrap();
    assert_eq!(
        repository.active_alert_level(skill, &new_version).unwrap(),
        Some(ProductLevel::Danger)
    );
    assert_eq!(
        repository.active_alert_level(skill, &old_version).unwrap(),
        None,
        "信任绑定旧版本，不牵连新版本的预警判断"
    );
}

#[test]
fn dismissed_later_keeps_the_dispatch_gate_closed() {
    let database = Database::open_in_memory().unwrap();
    let skill = SkillId::new();
    let repository = database.security_alert_repository();
    let version = version_id(7);

    repository
        .record_import_alert(skill, &version, ProductLevel::Warning)
        .unwrap();
    repository.mark_dismissed_later(skill, &version).unwrap();

    // 裁决第 1 节："稍后处理：留在待办，期间持续不可派发。"
    assert_eq!(
        repository.active_alert_level(skill, &version).unwrap(),
        Some(ProductLevel::Warning)
    );
}
