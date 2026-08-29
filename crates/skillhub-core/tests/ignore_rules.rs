use async_trait::async_trait;
use skillhub_core::application::{IgnoreBackend, IgnoreService};
use skillhub_core::{AppResult, ErrorCode, IgnoreRule, IgnoreSubject, SkillId};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct FakeIgnoreBackend {
    rules: Arc<Mutex<Vec<IgnoreRule>>>,
}

#[async_trait]
impl IgnoreBackend for FakeIgnoreBackend {
    async fn create(&self, rule: IgnoreRule) -> AppResult<IgnoreRule> {
        self.rules.lock().unwrap().push(rule.clone());
        Ok(rule)
    }

    async fn remove(&self, id: String) -> AppResult<()> {
        self.rules.lock().unwrap().retain(|rule| rule.id != id);
        Ok(())
    }

    async fn list(&self) -> AppResult<Vec<IgnoreRule>> {
        Ok(self.rules.lock().unwrap().clone())
    }
}

#[test]
fn exact_path_and_exact_skill_ignore_do_not_match_neighbors() {
    block_on(async {
        let backend = FakeIgnoreBackend::default();
        let service = IgnoreService::new(Arc::new(backend));
        let path = IgnoreSubject::exact_path("skills/pdf").unwrap();
        service
            .create(path.clone(), "known local copy".into(), None)
            .await
            .unwrap();
        assert!(service.is_ignored(&path).await.unwrap());
        assert!(!service
            .is_ignored(&IgnoreSubject::exact_path("skills/pdf-tools").unwrap())
            .await
            .unwrap());

        let skill = IgnoreSubject::exact_skill(SkillId::new());
        assert!(!service.is_ignored(&skill).await.unwrap());
    });
}

#[test]
fn wildcard_regex_script_and_nested_rules_are_rejected() {
    block_on(async {
        let service = IgnoreService::new(Arc::new(FakeIgnoreBackend::default()));
        for value in [
            "skills/*",
            "regex:^pdf",
            "if unsafe then ignore",
            "skills/../pdf",
        ] {
            let error = service.create_raw(value, "test".into()).await.unwrap_err();
            assert_eq!(error.code, ErrorCode::IgnoreOnlyExactSubjectsSupported);
        }
    });
}

#[test]
fn removing_an_ignore_rule_is_reversible() {
    block_on(async {
        let backend = FakeIgnoreBackend::default();
        let service = IgnoreService::new(Arc::new(backend));
        let rule = service
            .create(
                IgnoreSubject::exact_pending("pending-1"),
                "later".into(),
                Some("2030-01-01".into()),
            )
            .await
            .unwrap();
        assert_eq!(service.list().await.unwrap().len(), 1);
        service.remove(rule.id).await.unwrap();
        assert!(service.list().await.unwrap().is_empty());
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
