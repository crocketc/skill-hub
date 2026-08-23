use async_trait::async_trait;
use skillhub_core::application::{CatalogService, VersionCapture, VersionService};
use skillhub_core::catalog::{CatalogRepository, Skill};
use skillhub_core::versioning::{VersionRecord, VersionRepository};
use skillhub_core::{AppResult, SkillId, VersionDiff, VersionId};
use std::path::Path;
use tempfile::tempdir;

struct FakeCatalog(std::sync::Mutex<Option<Skill>>);
#[async_trait(?Send)]
impl CatalogRepository for FakeCatalog {
    async fn insert(&self, skill: &Skill) -> AppResult<()> {
        *self.0.lock().unwrap() = Some(skill.clone());
        Ok(())
    }
    async fn get(&self, id: SkillId) -> AppResult<Option<Skill>> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .filter(|s| s.id() == id)
            .cloned())
    }
    async fn remove(&self, _id: SkillId) -> AppResult<()> {
        *self.0.lock().unwrap() = None;
        Ok(())
    }
}

struct FakeVersions {
    records: std::sync::Mutex<Vec<VersionRecord>>,
    fail_current: std::sync::atomic::AtomicBool,
    discarded: std::sync::Mutex<Vec<VersionId>>,
}
#[async_trait]
impl VersionRepository for FakeVersions {
    async fn current(&self, _: SkillId) -> AppResult<Option<VersionId>> {
        Ok(self.records.lock().unwrap().last().map(|v| v.id.clone()))
    }
    async fn set_current(&self, _: SkillId, _: &VersionId) -> AppResult<()> {
        if self
            .fail_current
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(skillhub_core::AppError::new(
                skillhub_core::ErrorCode::InternalError,
                skillhub_core::Severity::Error,
            ));
        }
        Ok(())
    }
    async fn diff(&self, _: &VersionId, _: &VersionId) -> AppResult<VersionDiff> {
        Ok(Default::default())
    }
    async fn list(&self, _: SkillId) -> AppResult<Vec<VersionRecord>> {
        Ok(self.records.lock().unwrap().clone())
    }
}
#[async_trait]
impl VersionCapture for FakeVersions {
    async fn capture(&self, skill_id: SkillId, source: &Path) -> AppResult<VersionRecord> {
        assert!(source.join("SKILL.md").exists());
        let id = VersionId::parse(&format!(
            "sha256:{:064x}",
            self.records.lock().unwrap().len() + 1
        ))
        .unwrap();
        let record = VersionRecord {
            id,
            manifest: skillhub_core::VersionManifest {
                format_version: 1,
                skill_id,
                tree_hash: "sha256:tree".into(),
                entries: vec![],
            },
        };
        self.records.lock().unwrap().push(record.clone());
        Ok(record)
    }
    async fn discard(&self, record: &VersionRecord) -> AppResult<()> {
        self.records
            .lock()
            .unwrap()
            .retain(|item| item.id != record.id);
        self.discarded.lock().unwrap().push(record.id.clone());
        Ok(())
    }
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn noop(_: *const ()) {}
    fn clone(_: *const ()) -> RawWaker {
        RawWaker::new(std::ptr::null(), &VTABLE)
    }
    static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, noop, noop, noop);
    let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
    let mut cx = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
    }
}

#[test]
fn create_save_and_rename_preserve_identity() {
    let source = tempdir().unwrap();
    std::fs::write(source.path().join("SKILL.md"), "# PDF").unwrap();
    let catalog = std::sync::Arc::new(FakeCatalog(std::sync::Mutex::new(None)));
    let versions = std::sync::Arc::new(FakeVersions {
        records: std::sync::Mutex::new(vec![]),
        fail_current: std::sync::atomic::AtomicBool::new(false),
        discarded: std::sync::Mutex::new(vec![]),
    });
    let app = CatalogService::new(catalog.clone(), VersionService::new(versions.clone()));
    let skill = block_on(app.create_skill("pdf", source.path())).unwrap();
    assert!(block_on(app.current_version(skill.id())).unwrap().is_some());
    block_on(app.rename_skill(skill.id(), "pdf-tools")).unwrap();
    assert_eq!(
        block_on(app.get_skill(skill.id()))
            .unwrap()
            .unwrap()
            .display_name(),
        "pdf-tools"
    );
}

#[test]
fn invalid_skill_file_is_rejected_without_catalog_write() {
    let source = tempdir().unwrap();
    let catalog = std::sync::Arc::new(FakeCatalog(std::sync::Mutex::new(None)));
    let versions = std::sync::Arc::new(FakeVersions {
        records: std::sync::Mutex::new(vec![]),
        fail_current: std::sync::atomic::AtomicBool::new(false),
        discarded: std::sync::Mutex::new(vec![]),
    });
    let app = CatalogService::new(catalog.clone(), VersionService::new(versions));
    assert!(block_on(app.create_skill("pdf", source.path())).is_err());
    assert!(catalog.0.lock().unwrap().is_none());
}

#[test]
fn current_failure_discards_captured_version_and_removes_new_skill() {
    let source = tempdir().unwrap();
    std::fs::write(source.path().join("SKILL.md"), "# PDF").unwrap();
    let catalog = std::sync::Arc::new(FakeCatalog(std::sync::Mutex::new(None)));
    let versions = std::sync::Arc::new(FakeVersions {
        records: std::sync::Mutex::new(vec![]),
        fail_current: std::sync::atomic::AtomicBool::new(true),
        discarded: std::sync::Mutex::new(vec![]),
    });
    let app = CatalogService::new(catalog.clone(), VersionService::new(versions.clone()));
    assert!(block_on(app.create_skill("pdf", source.path())).is_err());
    assert!(catalog.0.lock().unwrap().is_none());
    assert!(versions.records.lock().unwrap().is_empty());
    assert_eq!(versions.discarded.lock().unwrap().len(), 1);
}
