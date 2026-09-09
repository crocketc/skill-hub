use skillhub_core::llm::{LlmDeployment, NetworkGate};
use skillhub_core::settings::DesktopPreferences;

#[test]
fn preferences_gain_llm_capability_fields_with_safe_defaults() {
    let preferences = DesktopPreferences::default();

    // Defaults must not enable any online LLM capability: the product never
    // calls a model without an explicit user decision (requirement 5.42).
    assert!(!preferences.llm_capabilities.safety_check);
    assert!(!preferences.llm_capabilities.semantic_duplicate);
    assert!(!preferences.llm_capabilities.description_translation);
    assert!(!preferences.llm_capabilities.online_search_assist);
    assert!(!preferences.import_auto_ai_check);
    assert_eq!(preferences.default_llm_provider_id, None);
    assert_eq!(preferences.ai_output_language, "system");
}

#[test]
fn older_preference_payloads_load_without_new_llm_fields() {
    let legacy = r#"{
        "network_enabled": true,
        "llm_provider": "",
        "data_scope": "explicit_selection",
        "language": "system",
        "theme": "moss-neutral",
        "density": "standard",
        "automation_per_skill": false,
        "automation_batch": false,
        "automation_global": false,
        "backup_location": "",
        "backup_retention_days": 30
    }"#;
    let preferences: DesktopPreferences =
        serde_json::from_str(legacy).expect("legacy payload must keep loading");
    assert!(preferences.network_enabled);
    assert!(!preferences.llm_capabilities.safety_check);
    assert_eq!(preferences.default_llm_provider_id, None);
}

fn with_output_language(language: &str) -> DesktopPreferences {
    DesktopPreferences {
        ai_output_language: language.to_owned(),
        ..DesktopPreferences::default()
    }
}

#[test]
fn ai_output_language_validates_against_supported_values() {
    let preferences = with_output_language("en-US");
    preferences.validate().expect("english output language");
    assert!(with_output_language("zh-CN").validate().is_ok());
    assert!(with_output_language("system").validate().is_ok());
    assert!(with_output_language("klingon").validate().is_err());
}

#[test]
fn network_gate_stops_online_calls_but_never_local_models() {
    let gate = NetworkGate::with_state(false);
    assert!(!gate.allows(LlmDeployment::Online));
    assert!(
        gate.allows(LlmDeployment::Local),
        "local inference stays available with all networking disabled"
    );

    gate.set_open(true);
    assert!(gate.allows(LlmDeployment::Online));
    assert!(gate.allows(LlmDeployment::Local));

    gate.set_open(false);
    assert!(!gate.allows(LlmDeployment::Online));
}
