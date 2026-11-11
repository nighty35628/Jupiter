// Jupiter addition: returning from play must acknowledge the actual Start call,
// not enqueueing it. A timeout must not leave a queued Start behind.
use std::sync::mpsc::Receiver;

pub(super) fn wait_for_start<E>(
    completion: Receiver<Result<(), E>>,
    disconnected: E,
) -> Result<(), E> {
    completion.recv().unwrap_or(Err(disconnected))
}
