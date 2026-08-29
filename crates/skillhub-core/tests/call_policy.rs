use async_trait::async_trait;
use skillhub_core::application::{CallPolicyBackend, CallPolicyService};
use skillhub_core::catalog::CallPolicy;
use skillhub_core::{AppError, AppResult, CallPolicyCapability, ErrorCode, SkillId};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct FakeCallPolicyBackend {
    skill_id: SkillId,
    capability: CallPolicyCapability,
    current: Arc<Mutex<CallPolicy>>,
    applied: Arc<Mutex<Vec<CallPolicy>>>,
    restored: Arc<Mutex<usize>>,
}

#[async_trait]
impl CallPolicyBackend for FakeCallPolicyBackend {
    async fn inspect(&self, skill_id: SkillId) -> AppResult<(CallPolicyCapability, CallPolicy)> {
        if skill_id != self.skill_id {
            return Err(AppError::new(
                ErrorCode::ObjectNotFound,
                skillhub_core::Severity::Error,
            ));
        }
        Ok((self.capability, self.current.lock().unwrap().clone()))
    }

    async fn apply(&self, _skill_id: SkillId, policy: CallPolicy) -> AppResult<()> {
        self.applied.lock().unwrap().push(policy.clone());
        *self.current.lock().unwrap() = policy;
        Ok(())
    }

    async fn restore_original(&self, _skill_id: SkillId) -> AppResult<()> {
        *self.restored.lock().unwrap() += 1;
        *self.current.lock().unwrap() = CallPolicy::AutomaticAndManual;
        Ok(())
    }
}

#[test]
fn supported_target_previews_change_and_restores_original() {
    block_on(async {
        let backend = FakeCallPolicyBackend {
            skill_id: SkillId::new(),
            capability: CallPolicyCapability::Editable,
            current: Arc::new(Mutex::new(CallPolicy::AutomaticAndManual)),
            applied: Arc::new(Mutex::new(Vec::new())),
            restored: Arc::new(Mutex::new(0)),
        };
        let service = CallPolicyService::new(Arc::new(backend.clone()));
        let plan = service
            .prepare(backend.skill_id, CallPolicy::ManualOnly)
            .await
            .unwrap();
        assert_eq!(plan.before, CallPolicy::AutomaticAndManual);
        assert_eq!(plan.after, CallPolicy::ManualOnly);
        service.commit(plan.id).await.unwrap();
        service.restore_original(backend.skill_id).await.unwrap();
        assert_eq!(*backend.restored.lock().unwrap(), 1);
        assert_eq!(
            *backend.current.lock().unwrap(),
            CallPolicy::AutomaticAndManual
        );
    });
}

#[test]
fn unsupported_target_is_displayable_but_not_mutated() {
    block_on(async {
        let backend = FakeCallPolicyBackend {
            skill_id: SkillId::new(),
            capability: CallPolicyCapability::ReadOnlyRecognized,
            current: Arc::new(Mutex::new(CallPolicy::ModelOnly)),
            applied: Arc::new(Mutex::new(Vec::new())),
            restored: Arc::new(Mutex::new(0)),
        };
        let service = CallPolicyService::new(Arc::new(backend.clone()));
        let error = service
            .prepare(backend.skill_id, CallPolicy::ManualOnly)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::CallPolicyNotSupported);
        assert!(backend.applied.lock().unwrap().is_empty());
    });
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}
