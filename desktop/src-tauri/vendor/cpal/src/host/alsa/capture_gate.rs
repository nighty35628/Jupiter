// Jupiter addition: capture workers cannot read/start while paused or closing.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Paused,
    Playing,
    Closed,
}

pub(super) struct CaptureGate {
    state: Mutex<State>,
    ready: Condvar,
}

impl CaptureGate {
    pub(super) fn new_paused() -> Self {
        Self {
            state: Mutex::new(State::Paused),
            ready: Condvar::new(),
        }
    }

    pub(super) fn wait_for_play(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        while *state == State::Paused {
            state = self.ready.wait(state).unwrap();
        }
        *state == State::Playing
    }

    pub(super) fn activate<E>(&self, start: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        let mut state = self.state.lock().unwrap();
        match *state {
            State::Closed => return Ok(false),
            State::Playing => return Ok(true),
            State::Paused => {}
        }
        start()?;
        *state = State::Playing;
        self.ready.notify_all();
        Ok(true)
    }

    pub(super) fn read_if_playing<T>(&self, read: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().unwrap();
        if *state == State::Playing {
            Some(read())
        } else {
            None
        }
    }

    pub(super) fn pause<E>(&self, stop: impl FnOnce() -> Result<(), E>) -> Result<bool, E> {
        let mut state = self.state.lock().unwrap();
        if *state == State::Closed {
            return Ok(false);
        }
        if *state == State::Playing {
            stop()?;
        }
        *state = State::Paused;
        Ok(true)
    }

    pub(super) fn close(&self, dropping: &AtomicBool, stop_and_wake: impl FnOnce()) {
        let mut state = self.state.lock().unwrap();
        if *state == State::Closed {
            return;
        }
        *state = State::Closed;
        // A previous play wake may still be queued. Do not let the polling
        // worker observe dropping and close the read end before this last write.
        stop_and_wake();
        dropping.store(true, Ordering::SeqCst);
        self.ready.notify_all();
    }
}
