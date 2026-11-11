# Native Dictation

The six existing macOS/Windows/Linux x64/ARM64 targets remain enabled. Other
OS/architecture combinations return `available: false` and reject model/capture
commands. Only macOS ARM64 has been compiled and tested locally. No microphone
recording, signed-package permission acceptance, or Windows/Linux runtime
acceptance has been performed.

## Interface

- Commands and camelCase arguments match the shared `speech_*` contract.
  Desktop `speech_start` additionally requires `onEvent: Channel<SpeechEvent>`.
- Only the main webview can invoke speech commands. The invoking webview owns
  its Channel; all status/transcript messages go only through that session's
  Channel, never an app/window event broadcast. Android's transport is unchanged.
- Every serialized message is strictly smaller than 8192 UTF-8 bytes, preventing
  Tauri's application-wide large-message queue fallback. Only large results are
  fragmented: `state: "result"`, `text` at most 1024 UTF-8 bytes per piece,
  zero-based `part`, and `last: false/true` with true only on the final piece.
  Short messages omit `part`/`last` and retain their original format. The frontend
  must reassemble one session in sequence and consume only the final whole text.
- Session IDs must be unique for the lifetime of the host, 1-128 ASCII letters,
  digits, underscores, or hyphens. UUIDs work. Reuse is rejected. The host bounds
  its ID registry at 65,536 requests, after which a restart is required.
- Start/finish/cancel do not wait for permission, capture, or inference. A
  cancelled worker retains its lease until all native teardown finishes; retry
  with a new ID after `speech_busy_cleanup_pending`.
- Language accepts Whisper codes, `auto`, and BCP47 primary subtags. `zh-HK` and
  `yue` are explicitly rejected; Mandarin is not a Cantonese quality claim.
- `modelBytes` is the expected artifact size (147,951,465), even before install.
  `modelProgress` is a fraction in [0, 1]. Cached models are initially not ready
  until background SHA verification completes.
- Download waits for completion and rejects on failure/cancellation. Capabilities
  can be polled while it is pending. Remove cancels a download and invalidates
  publication, but refuses removal while any recording/loading/decoding worker
  still owns the model. No model is shipped in resources or downloaded at startup.

Close-to-tray cancels synchronously before hiding. Focus loss cancels
conservatively, and a 50 ms native visibility/minimize/focus guard covers other
hide paths. Main-page load start/navigation cancels even without focus loss;
new starts are rejected until page load finishes, with no automatic resumption.
Windows additionally checks the input desktop; macOS listens for a
lock notice. Linux lock behavior currently relies on focus loss and requires
desktop-environment runtime acceptance. Permission approval never resurrects a
cancelled request; the user may need to start again after the first OS prompt.

Audio stays in memory, is bounded to 60 seconds, downmixed and bandlimited to
16 kHz mono PCM. Whisper runs CPU-only, transcription (not translation), with at
most four threads and one context. Contexts are released after each request.
Silence suppression is not a validated VAD or an accuracy guarantee.

## Build

Run Cargo from `desktop/src-tauri` so its `.cargo/config.toml` is applied.
The exact engine pins are `whisper-rs = 0.16.0` and `whisper-rs-sys = 0.15.0`.
CMake and a C++ compiler are required. Linux also needs `libasound2-dev`.
The local CPAL 0.16.0 source patches CoreAudio construction, ALSA input
construction/read gating, and WASAPI actual-Start acknowledgement; see
`vendor/cpal/JUPITER-PATCH.md`. Only permission-request/activation calls hold the
native cancellation gate, not device construction or permission waits. WASAPI
play waits for actual Start completion, not just enqueueing. Linux/Windows
platform builds and hardware behavior remain unverified, with all six targets
still enabled. The host tests include the real pure-Rust gate/ack helpers.
Windows targets use target-scoped clang-cl/Ninja to avoid ggml's unsupported
ARM MSVC compiler and non-OpenMP MSVC codegen; their builds and runtime library
packaging still need CI verification. No GPU toolkit is required.

macOS uses legacy LP64 Accelerate. The CMake hook undefines
`ACCELERATE_NEW_LAPACK` and `ACCELERATE_LAPACK_ILP64` after ggml's definitions,
avoiding the newer macOS 13.3 symbols without raising the existing deployment
minimum. The binding unconditionally links `ggml-blas` on macOS, so disabling
BLAS alone is not a valid build configuration for this pinned binding.

For this review's local QA, use `CARGO_TARGET_DIR=target/speech-review-v2` and
`MACOSX_DEPLOYMENT_TARGET=11.0` on ARM64. It was built fresh, retaining the older
target directory. Do not reuse old native CMake objects for the new LP64 checks;
the dependency does not track edits to this project's CMake include. Fresh CI
builds naturally pick up the compatibility hook. The exact current test harness
is `target/speech-review-v2/debug/deps/Jupiter-e9354e2ef7082f4a`; this path is not
the actual application. The safety regression suite subsequently passed 60
tests with one explicitly ignored file-inference test and zero retries.

```sh
cargo check --locked --bin Jupiter -j 4
cargo build --locked --bin Jupiter -j 4
cargo test --locked --bin Jupiter -j 4 -- --test-threads=1
```

Tests have no retry mechanism and fake capture/recognition never access hardware.
For local QA where CMake is not installed, `CMAKE` can point at an isolated
CMake executable. Do not select the newest `target/debug/deps/Jupiter-*` by mtime:
Cargo also puts the actual application there. Use `cargo test`, or obtain the
test executable from Cargo's `--message-format=json` compiler-artifact with
`profile.test == true`.

## Explicit Offline File QA

This ignored test is not a production command or a file-path IPC endpoint.
It never downloads or opens a microphone. Supply a complete pinned model and a
licensed/approved 16-bit mono WAV of at most 60 seconds:

```sh
JUPITER_SPEECH_MODEL=/absolute/path/ggml-base.bin \
JUPITER_SPEECH_WAV=/absolute/path/en.wav \
JUPITER_SPEECH_LANGUAGE=en \
JUPITER_SPEECH_REPEAT=1 \
cargo test --locked --bin Jupiter speech::tests::file_inference \
  -- --ignored --exact --nocapture --test-threads=1
```

Use `en`, `zh`, `ja`, `ko`, `de`, `fr`, `es`, `ru`, or `auto` as appropriate.
`REPEAT` accepts 1-10. Each JSON measurement includes text, sample count,
language, engine version, artifact hash, elapsed time, OS, and architecture.
The timer includes model hash verification, fresh-context load, and decoding;
the OS page cache is uncontrolled. These are development-profile synthetic
fixture baselines, not microphone quality, warm-context latency, or p95 claims.
The `silence.wav` fixture additionally asserts an empty transcript.

Pinned model metadata:
https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1

Binding and capture API references:
https://docs.rs/whisper-rs/0.16.0/whisper_rs/
https://docs.rs/cpal/0.16.0/cpal/
