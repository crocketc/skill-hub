use std::sync::{Arc, Mutex};

use skillhub_application::LocalApplicationFacade;
use skillhub_core::api::{
    AppCommand, AppCommandResult, AppQuery, ClearLlmProviderCredential, DeleteLlmProvider,
    FetchLlmModels, FetchLlmProvider, SaveLlmProvider, SetDefaultLlmProvider,
    SetLlmProviderEnabled, TestLlmConnection,
};
use skillhub_core::llm::{
    ConnectionTestResult, CredentialRef, CredentialStore, EndpointCheckResult, LlmAdmin,
    LlmCompatibilityProfile, LlmDeployment, LlmProfile, LlmProtocolFamily, LlmProviderConfig,
    LlmTaskRequest, LlmTaskResponse, LlmTaskRunner, ModelCheckResult, NetworkGate,
    StructuredCheckResult,
};
use skillhub_core::settings::{DesktopPreferences, LlmCapabilitySettings};
use skillhub_core::{AppResult, ApplicationFacade, SkillId};
use skillhub_storage::Database;

fn provider_config() -> LlmProviderConfig {
    provider_config_for("deepseek", "DeepSeek", "deepseek-chat")
}

fn provider_config_for(id: &str, label: &str, model: &str) -> LlmProviderConfig {
    LlmProviderConfig::new(
        id,
        label,
        LlmProtocolFamily::OpenAiCompatible,
        LlmDeployment::Online,
        format!("https://{id}.test/v1"),
        model,
        None,
    )
    .expect("valid provider config")
}

/// One shared in-memory credential store injected into the facade; tests read
/// it directly to assert credential lifecycle.
#[derive(Default)]
struct SharedCredentialStore {
    values: Mutex<std::collections::HashMap<String, String>>,
}

#[async_trait::async_trait(?Send)]
impl CredentialStore for SharedCredentialStore {
    async fn get(&self, reference: &CredentialRef) -> AppResult<Option<String>> {
        Ok(self.values.lock().unwrap().get(&reference.id).cloned())
    }
    async fn set(&self, reference: &CredentialRef, secret: &str) -> AppResult<()> {
        self.values
            .lock()
            .unwrap()
            .insert(reference.id.clone(), secret.to_owned());
        Ok(())
    }
    async fn delete(&self, reference: &CredentialRef) -> AppResult<()> {
        self.values.lock().unwrap().remove(&reference.id);
        Ok(())
    }
}

impl SharedCredentialStore {
    fn contains(&self, id: &str) -> bool {
        self.values.lock().unwrap().contains_key(id)
    }
}

/// A fake admin that records the profiles it was given.
#[derive(Default)]
struct FakeAdmin {
    seen_profiles: Mutex<Vec<LlmProfile>>,
}

#[async_trait::async_trait(?Send)]
impl LlmAdmin for FakeAdmin {
    async fn fetch_models(
        &self,
        profile: &LlmProfile,
        _credential: Option<String>,
    ) -> AppResult<Vec<String>> {
        self.seen_profiles.lock().unwrap().push(profile.clone());
        Ok(vec!["deepseek-chat".to_owned()])
    }
    async fn check_connection(
        &self,
        profile: &LlmProfile,
        _credential: Option<String>,
    ) -> ConnectionTestResult {
        self.seen_profiles.lock().unwrap().push(profile.clone());
        ConnectionTestResult {
            endpoint: EndpointCheckResult {
                reachable: true,
                latency_ms: Some(12),
            },
            model: Some(ModelCheckResult {
                ok: true,
                latency_ms: Some(30),
            }),
            model_failure_code: None,
            structured: Some(StructuredCheckResult {
                ok: true,
                latency_ms: Some(45),
            }),
            structured_failure_code: None,
        }
    }
}

struct NoopRunner;

#[async_trait::async_trait(?Send)]
impl LlmTaskRunner for NoopRunner {
    async fn run(
        &self,
        _profile: &LlmProfile,
        _request: LlmTaskRequest,
    ) -> AppResult<LlmTaskResponse> {
        Err(skillhub_core::AppError::new(
            skillhub_core::ErrorCode::LlmNotConfigured,
            skillhub_core::Severity::Info,
        ))
    }
}

fn facade_with(
    store: Arc<SharedCredentialStore>,
    admin: Arc<FakeAdmin>,
    gate: NetworkGate,
) -> LocalApplicationFacade {
    let database = Database::open_in_memory().expect("database");
    let root = tempfile::tempdir().expect("library root");
    LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        Arc::new(NoopRunner),
    )
    .with_llm_runtime(gate, store as Arc<dyn CredentialStore>, admin as _)
}

#[tokio::test]
async fn saving_a_provider_stores_the_credential_and_reports_status() {
    let store = Arc::new(SharedCredentialStore::default());
    let facade = facade_with(
        store.clone(),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );

    let result = facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config(),
            credential: Some("sk-admin-fixture-secret".to_owned()),
        }))
        .await
        .expect("save provider");
    let AppCommandResult::LlmProviderView(view) = result else {
        panic!("expected a provider view");
    };
    assert_eq!(view.config.id, "deepseek");
    assert!(view.credential_configured);
    assert!(!view.is_default);

    // The credential lives in the store under the provider reference.
    assert!(store.contains("llm-provider:deepseek"));

    let listing = facade
        .query(AppQuery::ListLlmProviders)
        .await
        .expect("list providers");
    let skillhub_core::api::AppQueryResult::LlmProviders(providers) = listing else {
        panic!("expected providers");
    };
    assert_eq!(providers.len(), 1);
    assert!(providers[0].credential_configured);
    assert!(!providers[0].is_default);

    let presets = facade
        .query(AppQuery::ListLlmProviderPresets)
        .await
        .expect("presets");
    let skillhub_core::api::AppQueryResult::LlmProviderPresets(presets) = presets else {
        panic!("expected presets");
    };
    assert!(presets.len() >= 15, "the confirmed provider baseline");
}

#[tokio::test]
async fn the_compatibility_profile_survives_save_list_and_administration() {
    let store = Arc::new(SharedCredentialStore::default());
    let admin = Arc::new(FakeAdmin::default());
    let facade = facade_with(store.clone(), admin.clone(), NetworkGate::open());

    let mut config = provider_config_for("zhipu-glm-coding-chat", "GLM Coding Plan", "glm-5");
    config.compatibility_profile = LlmCompatibilityProfile::GlmCoding;
    config.endpoint = "https://open.bigmodel.cn/api/coding/paas/v4".to_owned();

    let saved = facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: config,
            credential: Some("sk-glm-fixture".to_owned()),
        }))
        .await
        .expect("save");
    let AppCommandResult::LlmProviderView(view) = saved else {
        panic!("expected a provider view");
    };
    assert_eq!(
        view.config.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
    assert!(view.config.enabled);
    assert!(view.credential_configured);

    // Listing re-reads storage and keeps the profile.
    let listing = facade
        .query(AppQuery::ListLlmProviders)
        .await
        .expect("list providers");
    let skillhub_core::api::AppQueryResult::LlmProviders(providers) = listing else {
        panic!("expected providers");
    };
    assert_eq!(
        providers[0].config.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );

    // Administration hands the profile to the runner unchanged.
    facade
        .execute(AppCommand::TestLlmConnection(TestLlmConnection {
            provider: FetchLlmProvider::Saved {
                id: "zhipu-glm-coding-chat".to_owned(),
            },
            credential: None,
        }))
        .await
        .expect("connection test");
    let seen = admin.seen_profiles.lock().unwrap().last().unwrap().clone();
    assert_eq!(
        seen.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
    assert_eq!(seen.protocol, LlmProtocolFamily::OpenAiCompatible);

    // Clearing the credential changes only the credential status.
    let cleared = facade
        .execute(AppCommand::ClearLlmProviderCredential(
            ClearLlmProviderCredential {
                id: "zhipu-glm-coding-chat".to_owned(),
            },
        ))
        .await
        .expect("clear credential");
    let AppCommandResult::LlmProviderView(view) = cleared else {
        panic!("expected a provider view");
    };
    assert!(
        view.config.enabled,
        "clearing a credential must never disable the provider"
    );
    assert!(!view.credential_configured);
    assert_eq!(view.config.model, "glm-5");
    assert_eq!(
        view.config.endpoint,
        "https://open.bigmodel.cn/api/coding/paas/v4"
    );
    assert_eq!(
        view.config.compatibility_profile,
        LlmCompatibilityProfile::GlmCoding
    );
}

/// A record stored before the compatibility field existed is listed through
/// the facade with its migrated profile, and nothing else about it changes.
#[tokio::test]
async fn a_legacy_provider_row_is_listed_with_its_migrated_profile() {
    let database = Database::open_in_memory().expect("database");
    database
        .connection_for_test()
        .execute(
            "INSERT INTO llm_provider_configs(id,config_json,created_at,updated_at) VALUES(?1,?2,0,0)",
            rusqlite::params![
                "zhipu-glm",
                r#"{"id":"zhipu-glm","label":"Zhipu GLM API (OpenAI)",
                    "protocol":"open_ai_compatible","deployment":"online",
                    "endpoint":"https://open.bigmodel.cn/api/paas/v4","model":"glm-5",
                    "custom_headers":[],"enabled":true,"timeout_ms":30000,
                    "max_input_bytes":262144}"#
            ],
        )
        .expect("insert a legacy row");

    let root = tempfile::tempdir().expect("library root");
    let facade = LocalApplicationFacade::new_with_library_and_llm_runner(
        database,
        root.path(),
        Arc::new(NoopRunner),
    )
    .with_llm_runtime(
        NetworkGate::open(),
        Arc::new(SharedCredentialStore::default()) as Arc<dyn CredentialStore>,
        Arc::new(FakeAdmin::default()) as _,
    );

    let listing = facade
        .query(AppQuery::ListLlmProviders)
        .await
        .expect("list providers");
    let skillhub_core::api::AppQueryResult::LlmProviders(providers) = listing else {
        panic!("expected providers");
    };
    assert_eq!(providers.len(), 1);
    let provider = &providers[0].config;
    assert_eq!(
        provider.compatibility_profile,
        LlmCompatibilityProfile::Glm,
        "a known built-in id migrates to its product line"
    );
    assert_eq!(provider.endpoint, "https://open.bigmodel.cn/api/paas/v4");
    assert_eq!(provider.model, "glm-5");
    assert!(provider.enabled, "migration must not change enablement");
}

#[tokio::test]
async fn deleting_a_provider_removes_its_credential_and_clears_the_default() {
    let store = Arc::new(SharedCredentialStore::default());
    let facade = facade_with(
        store.clone(),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );

    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config(),
            credential: Some("sk-to-be-removed".to_owned()),
        }))
        .await
        .expect("save");
    facade
        .execute(AppCommand::SetDefaultLlmProvider(SetDefaultLlmProvider {
            id: Some("deepseek".to_owned()),
        }))
        .await
        .expect("set default");

    facade
        .execute(AppCommand::DeleteLlmProvider(DeleteLlmProvider {
            id: "deepseek".to_owned(),
        }))
        .await
        .expect("delete");

    assert!(
        !store.contains("llm-provider:deepseek"),
        "deleting a provider must delete its credential"
    );
    let listing = facade
        .query(AppQuery::ListLlmProviders)
        .await
        .expect("list");
    let skillhub_core::api::AppQueryResult::LlmProviders(providers) = listing else {
        panic!("expected providers");
    };
    assert!(providers.is_empty());
    // The default pointer cleared with the provider.
    let preferences = facade
        .query(AppQuery::GetDesktopPreferences)
        .await
        .expect("preferences");
    let skillhub_core::api::AppQueryResult::DesktopPreferences(preferences) = preferences else {
        panic!("expected preferences");
    };
    assert_eq!(preferences.default_llm_provider_id, None);
}

#[tokio::test]
async fn clearing_a_provider_credential_keeps_configuration_isolates_others_and_is_idempotent() {
    let store = Arc::new(SharedCredentialStore::default());
    let facade = facade_with(
        store.clone(),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );

    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config(),
            credential: Some("sk-clear-fixture-secret".to_owned()),
        }))
        .await
        .expect("save first provider");
    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config_for("openai", "OpenAI", "gpt-test"),
            credential: Some("sk-other-fixture-secret".to_owned()),
        }))
        .await
        .expect("save second provider");

    let clear = || {
        facade.execute(AppCommand::ClearLlmProviderCredential(
            ClearLlmProviderCredential {
                id: "deepseek".to_owned(),
            },
        ))
    };
    let result = clear().await.expect("clear first provider credential");
    let AppCommandResult::LlmProviderView(view) = result else {
        panic!("expected provider view");
    };
    assert_eq!(view.config.id, "deepseek");
    assert_eq!(view.config.model, "deepseek-chat");
    assert!(!view.credential_configured);
    assert!(!store.contains("llm-provider:deepseek"));
    assert!(store.contains("llm-provider:openai"));

    clear().await.expect("repeated clear is idempotent");

    let listing = facade
        .query(AppQuery::ListLlmProviders)
        .await
        .expect("list providers");
    let skillhub_core::api::AppQueryResult::LlmProviders(providers) = listing else {
        panic!("expected providers");
    };
    assert_eq!(providers.len(), 2);
    let first = providers
        .iter()
        .find(|item| item.config.id == "deepseek")
        .unwrap();
    assert_eq!(first.config.endpoint, "https://deepseek.test/v1");
    assert!(!first.credential_configured);
    let other = providers
        .iter()
        .find(|item| item.config.id == "openai")
        .unwrap();
    assert_eq!(other.config.model, "gpt-test");
    assert!(other.credential_configured);
}

#[tokio::test]
async fn disabled_providers_do_not_resolve_for_administration() {
    let facade = facade_with(
        Arc::new(SharedCredentialStore::default()),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );
    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config(),
            credential: Some("sk-x".to_owned()),
        }))
        .await
        .expect("save");
    facade
        .execute(AppCommand::SetLlmProviderEnabled(SetLlmProviderEnabled {
            id: "deepseek".to_owned(),
            enabled: false,
        }))
        .await
        .expect("disable");

    let error = facade
        .execute(AppCommand::FetchLlmModels(FetchLlmModels {
            provider: FetchLlmProvider::Saved {
                id: "deepseek".to_owned(),
            },
            credential: None,
        }))
        .await
        .expect_err("a disabled provider must not resolve");
    assert_eq!(error.code, skillhub_core::ErrorCode::ObjectNotFound);
}

#[tokio::test]
async fn model_fetch_and_connection_test_use_the_configured_protocol() {
    let admin = Arc::new(FakeAdmin::default());
    let facade = facade_with(
        Arc::new(SharedCredentialStore::default()),
        admin.clone(),
        NetworkGate::open(),
    );
    let mut config = provider_config();
    config.protocol = LlmProtocolFamily::Anthropic;
    config.endpoint = "https://api.anthropic.test".to_owned();
    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: config,
            credential: Some("sk-ant".to_owned()),
        }))
        .await
        .expect("save");

    let models = facade
        .execute(AppCommand::FetchLlmModels(FetchLlmModels {
            provider: FetchLlmProvider::Saved {
                id: "deepseek".to_owned(),
            },
            credential: None,
        }))
        .await
        .expect("fetch models");
    let AppCommandResult::LlmModels(models) = models else {
        panic!("expected models");
    };
    assert_eq!(models, vec!["deepseek-chat".to_owned()]);
    let seen = admin.seen_profiles.lock().unwrap().last().unwrap().clone();
    assert_eq!(seen.protocol, LlmProtocolFamily::Anthropic);

    let report = facade
        .execute(AppCommand::TestLlmConnection(TestLlmConnection {
            provider: FetchLlmProvider::Saved {
                id: "deepseek".to_owned(),
            },
            credential: None,
        }))
        .await
        .expect("connection test");
    let AppCommandResult::ConnectionTest(report) = report else {
        panic!("expected a connection report");
    };
    assert!(report.model_ok(), "fake admin reports a working model");
}

#[tokio::test]
async fn capability_switches_gate_the_llm_commands() {
    let facade = facade_with(
        Arc::new(SharedCredentialStore::default()),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );

    // Defaults are off, so a capability call is refused up front.
    let mut preferences = DesktopPreferences::default();
    facade
        .execute(AppCommand::SetDesktopPreferences(preferences.clone()))
        .await
        .expect("preferences");
    let error = facade
        .execute(AppCommand::RunLlmSafetyCheck(
            skillhub_core::api::RunLlmSafetyCheck {
                skill_id: SkillId::new(),
                version_id: skillhub_core::VersionId::parse(
                    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                )
                .expect("fixture version"),
            },
        ))
        .await
        .expect_err("capability disabled");
    assert_eq!(error.code.as_str(), "llm.capability_disabled");
    assert_eq!(error.severity, skillhub_core::Severity::Info);

    // Enabling the capability moves the failure past the gate.
    preferences.llm_capabilities = LlmCapabilitySettings {
        safety_check: true,
        ..LlmCapabilitySettings::default()
    };
    facade
        .execute(AppCommand::SetDesktopPreferences(preferences))
        .await
        .expect("preferences");
    let error = facade
        .execute(AppCommand::RunLlmSafetyCheck(
            skillhub_core::api::RunLlmSafetyCheck {
                skill_id: SkillId::new(),
                version_id: skillhub_core::VersionId::parse(
                    "sha256:0000000000000000000000000000000000000000000000000000000000000000",
                )
                .expect("fixture version"),
            },
        ))
        .await
        .expect_err("nothing configured yet");
    assert_ne!(error.code.as_str(), "llm.capability_disabled");
}

#[tokio::test]
async fn closing_all_networking_refuses_online_admin_calls() {
    let facade = facade_with(
        Arc::new(SharedCredentialStore::default()),
        Arc::new(FakeAdmin::default()),
        NetworkGate::open(),
    );
    facade
        .execute(AppCommand::SaveLlmProvider(SaveLlmProvider {
            provider: provider_config(),
            credential: Some("sk-online".to_owned()),
        }))
        .await
        .expect("save");
    let preferences = DesktopPreferences {
        network_enabled: false,
        ..DesktopPreferences::default()
    };
    facade
        .execute(AppCommand::SetDesktopPreferences(preferences))
        .await
        .expect("preferences");

    let error = facade
        .execute(AppCommand::TestLlmConnection(TestLlmConnection {
            provider: FetchLlmProvider::Saved {
                id: "deepseek".to_owned(),
            },
            credential: None,
        }))
        .await
        .expect_err("online call must be refused");
    assert_eq!(error.code, skillhub_core::ErrorCode::NetworkDisabled);
}
