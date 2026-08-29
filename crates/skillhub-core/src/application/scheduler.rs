use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

/// In-process scheduler boundary. Jobs are owned by the application and stop
/// with it; no OS service, telemetry agent, or background daemon is installed.
pub struct RuntimeScheduler {
    stop: Arc<Notify>,
    jobs: Arc<Mutex<Vec<JoinHandle<()>>>>,
}

impl RuntimeScheduler {
    pub fn start() -> Self {
        Self {
            stop: Arc::new(Notify::new()),
            jobs: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn schedule<F>(&self, job: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let stop = self.stop.clone();
        let handle = tokio::spawn(async move {
            tokio::select! {
                _ = job => {},
                _ = stop.notified() => {},
            }
        });
        self.jobs.lock().expect("scheduler jobs lock").push(handle);
    }

    pub async fn running_jobs(&self) -> usize {
        let mut jobs = self.jobs.lock().expect("scheduler jobs lock");
        jobs.retain(|job| !job.is_finished());
        jobs.len()
    }

    pub async fn stop(&self) {
        self.stop.notify_waiters();
        let jobs = self
            .jobs
            .lock()
            .expect("scheduler jobs lock")
            .drain(..)
            .collect::<Vec<_>>();
        for job in jobs {
            job.abort();
            let _ = job.await;
        }
    }
}

impl Drop for RuntimeScheduler {
    fn drop(&mut self) {
        self.stop.notify_waiters();
        if let Ok(mut jobs) = self.jobs.lock() {
            for job in jobs.drain(..) {
                job.abort();
            }
        }
    }
}
