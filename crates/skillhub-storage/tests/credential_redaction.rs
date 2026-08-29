use rusqlite::params;
use skillhub_core::llm::{CredentialRef, LlmProfile};
use skillhub_storage::Database;

#[test]
fn database_backup_and_logs_contain_credential_reference_not_secret() {
    let db = Database::open_in_memory().unwrap();
    let profile = LlmProfile::new(
        "provider",
        "https://api.example.test/v1/chat/completions",
        "model",
        Some(CredentialRef::new("credential-1")),
    )
    .unwrap();
    db.llm_profile_repository().save(&profile).unwrap();
    let stored: String = db
        .connection_for_test()
        .query_row(
            "SELECT profile_json FROM llm_profiles WHERE id = ?1",
            params![profile.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!stored.contains("sk-secret-value"));
    assert!(stored.contains("credential-1"));
}
