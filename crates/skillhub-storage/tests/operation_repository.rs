use skillhub_core::{AppError, OperationId, OperationService};
use skillhub_storage::Database;
use std::future::Future;
use std::sync::Arc;

#[test]
#[allow(clippy::arc_with_non_send_sync)]
fn separate_services_atomically_claim_the_same_operation_id() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operations.sqlite");
    let first_database = Database::open(&path).unwrap();
    let second_database = Database::open(&path).unwrap();
    let first = OperationService::new(Arc::new(first_database.operation_repository()));
    let second = OperationService::new(Arc::new(second_database.operation_repository()));
    let operation_id = OperationId::new();
    let (first_result, second_result) = block_on(join2(
        first.run(operation_id, "same", "fingerprint", |_context| async {
            tokio::task::yield_now().await;
            Ok::<_, AppError>("winner".to_owned())
        }),
        second.run(operation_id, "same", "fingerprint", |_context| async {
            Ok::<_, AppError>("loser".to_owned())
        }),
    ));

    assert_eq!(first_result.unwrap(), "winner");
    assert_eq!(second_result.unwrap(), "winner");
}

fn block_on<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap()
        .block_on(future)
}

async fn join2<A, B>(first: A, second: B) -> (A::Output, B::Output)
where
    A: Future,
    B: Future,
{
    use std::task::Poll;
    let mut first = std::pin::pin!(first);
    let mut second = std::pin::pin!(second);
    let mut first_result = None;
    let mut second_result = None;
    std::future::poll_fn(|cx| {
        if first_result.is_none() {
            if let Poll::Ready(value) = first.as_mut().poll(cx) {
                first_result = Some(value);
            }
        }
        if second_result.is_none() {
            if let Poll::Ready(value) = second.as_mut().poll(cx) {
                second_result = Some(value);
            }
        }
        if first_result.is_some() && second_result.is_some() {
            Poll::Ready((first_result.take().unwrap(), second_result.take().unwrap()))
        } else {
            Poll::Pending
        }
    })
    .await
}
