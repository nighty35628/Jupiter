# CPAL Input Activation Patches

Source: crates.io `cpal` 0.16.0, Apache-2.0.
Original crate checksum:
`cbd307f43cc2a697e2d1f8bc7a1d824b5269e052209e28883e5bc04d095aaa3f`.

Local source changes:

- `src/host/coreaudio/macos/mod.rs`: input construction initializes `playing`
  to `false` and no longer calls `audio_unit.start()`. Explicit `play()` is the
  input activation path. This backports the paused-construction behavior
  inspected in CPAL 0.18.2 without its newer macOS process-tap APIs.
- `src/host/alsa/mod.rs` and new `capture_gate.rs`: input construction does not
  call `PCM::start`. Workers wait for explicit play, and read/pause/close share a
  gate. The ALSA start threshold is set to its software boundary so reads cannot
  start capture implicitly. Overruns stop/report instead of autonomously
  preparing/restarting. Drop uses an atomic flag and wakes paused workers.
- `src/host/wasapi/stream.rs` and new `start_ack.rs`: `play()` waits for the
  consumer's actual `IAudioClient::Start` result instead of only enqueueing it.
  This keeps Jupiter's native activation/cancellation gate held until Start
  finishes, preventing a queued late Start after cancellation commits. There is
  intentionally no timeout that could abandon a pending Start. Termination
  stops a playing client, joins the consumer, and always closes its event handle.
- `src/error.rs`: the play-error documentation reflects synchronous start
  confirmation on these patched backends.

The copy preserves the upstream source, manifests, examples, build script, and
license. Modified files carry Jupiter change notices. Host tests exercise the
same gate and acknowledgement helpers with fake side effects and also assert
the platform source uses them. Linux ALSA and Windows WASAPI OS-specific code
still require their own platform compilation/runtime acceptance; macOS tests
are not evidence of either. No target is disabled by these patches.
