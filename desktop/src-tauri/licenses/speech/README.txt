Jupiter Desktop Native Speech: Third-Party License Texts

These files are included in the application resource directory at
licenses/speech on macOS, Windows, and Linux. They supplement the project's
top-level THIRD_PARTY_NOTICES; this directory is not a complete dependency SBOM.

Component                     License       Included file
CPAL 0.16.0                   Apache-2.0    CPAL-0.16.0-APACHE-2.0.txt
CPAL local input patch        Change notice CPAL-0.16.0-JUPITER-PATCH.txt
whisper.cpp 1.8.3 / ggml       MIT           WHISPER-CPP-1.8.3-MIT.txt
whisper-rs 0.16.0             Unlicense     WHISPER-RUST-BINDINGS-UNLICENSE.txt
whisper-rs-sys 0.15.0         Unlicense     WHISPER-RUST-BINDINGS-UNLICENSE.txt
rubato 0.16.2                 MIT           RUBATO-0.16.2-MIT.txt
coreaudio-rs 0.13.0           MIT option    COREAUDIO-RS-0.13.0-MIT.txt
reqwest 0.12.24               MIT option    REQWEST-0.12.24-MIT.txt
fs2 0.4.3                    MIT option    FS2-0.4.3-MIT.txt

License texts and copyright notices are copied verbatim from the exact crate
source artifacts used in Cargo.lock, not reconstructed summaries. The
whisper.cpp/ggml text is the LICENSE shipped inside whisper-rs-sys 0.15.0.
The Rust bindings declare Unlicense separately from the engine's MIT license.

CPAL is based on the crates.io 0.16.0 source (Apache-2.0), with the documented
CoreAudio paused-input-construction backport. Its modified source file carries
a prominent Jupiter change comment; the separate patch notice is included here.

Sources:
https://crates.io/crates/cpal/0.16.0
https://crates.io/crates/whisper-rs/0.16.0
https://crates.io/crates/whisper-rs-sys/0.15.0
https://crates.io/crates/rubato/0.16.2
https://crates.io/crates/coreaudio-rs/0.13.0
https://crates.io/crates/reqwest/0.12.24
https://crates.io/crates/fs2/0.4.3

No model weights are included in the installer or application resources.
