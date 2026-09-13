use skillhub_storage::{Database, PersistedConnectionTest};

fn entry(fingerprint: &str) -> PersistedConnectionTest {
    PersistedConnectionTest {
        service_ok: true,
        model_ok: true,
        structured_ok: Some(true),
        tested_at: "1789114968".to_owned(),
        fingerprint: fingerprint.to_owned(),
    }
}

#[test]
fn round_trips_entries_per_provider_and_keeps_other_ids_intact() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.llm_connection_test_repository();

    // 首次读取：没有记录。
    assert_eq!(repository.get("deepseek").unwrap(), None);
    assert_eq!(repository.load().unwrap().len(), 0);

    repository.put("deepseek", &entry("fp-1")).unwrap();
    repository.put("openai", &entry("fp-2")).unwrap();

    let deepseek = repository.get("deepseek").unwrap().expect("deepseek entry");
    assert_eq!(deepseek.fingerprint, "fp-1");
    assert!(deepseek.service_ok && deepseek.model_ok);
    assert_eq!(deepseek.structured_ok, Some(true));
    assert_eq!(deepseek.tested_at, "1789114968");

    // 覆盖同一 provider 只影响该条目。
    repository.put("deepseek", &entry("fp-1b")).unwrap();
    assert_eq!(
        repository
            .get("deepseek")
            .unwrap()
            .expect("updated")
            .fingerprint,
        "fp-1b"
    );
    assert_eq!(
        repository
            .get("openai")
            .unwrap()
            .expect("openai intact")
            .fingerprint,
        "fp-2"
    );
    assert_eq!(repository.load().unwrap().len(), 2);

    // 重新打开数据库后仍在（settings KV 持久化）。
    // （内存库无法重开同一实例，改为直接断言 map 读取一致性。）
    let reloaded = repository.load().unwrap();
    assert_eq!(reloaded["openai"].fingerprint, "fp-2");
}

#[test]
fn remove_drops_only_the_target_provider() {
    let database = Database::open_in_memory().unwrap();
    let repository = database.llm_connection_test_repository();
    repository.put("deepseek", &entry("fp-1")).unwrap();
    repository.put("openai", &entry("fp-2")).unwrap();

    repository.remove("deepseek").unwrap();

    assert_eq!(repository.get("deepseek").unwrap(), None);
    assert!(repository.get("openai").unwrap().is_some());

    // 移除不存在的条目保持幂等。
    repository.remove("deepseek").unwrap();
    assert!(repository.get("openai").unwrap().is_some());
}

#[test]
fn corrupt_json_reads_as_absent_and_is_rebuilt_by_the_next_write() {
    let database = Database::open_in_memory().unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES('llm_connection_test_state','{not valid json',0)",
            [],
        )
        .unwrap();
    let repository = database.llm_connection_test_repository();

    // 损坏 JSON 按无记录处理，绝不阻塞读取方。
    assert_eq!(repository.get("deepseek").unwrap(), None);
    assert_eq!(repository.load().unwrap().len(), 0);

    // 下一次写入重建合法 JSON。
    repository.put("deepseek", &entry("fp")).unwrap();
    assert_eq!(
        repository
            .get("deepseek")
            .unwrap()
            .expect("rebuilt")
            .fingerprint,
        "fp"
    );
}

#[test]
fn wrong_shape_json_reads_as_absent() {
    let database = Database::open_in_memory().unwrap();
    database
        .connection_for_test()
        .execute(
            "INSERT INTO settings(key,value_json,updated_at) VALUES('llm_connection_test_state','[1,2,3]',0)",
            [],
        )
        .unwrap();
    let repository = database.llm_connection_test_repository();

    assert_eq!(repository.get("deepseek").unwrap(), None);
}
