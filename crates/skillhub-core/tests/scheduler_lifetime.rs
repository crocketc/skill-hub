use skillhub_core::RuntimeScheduler;
use std::time::Duration;

#[tokio::test]
async fn scheduler_stops_jobs_with_application_and_has_no_service_marker() {
    let scheduler = RuntimeScheduler::start();
    scheduler
        .schedule(async { tokio::time::sleep(Duration::from_secs(60)).await })
        .await;
    assert_eq!(scheduler.running_jobs().await, 1);
    scheduler.stop().await;
    assert_eq!(scheduler.running_jobs().await, 0);
}
