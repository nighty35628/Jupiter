# Third-Party Notices

Jupiter includes portions derived from DeepSeek-Reasonix
(https://github.com/esengine/DeepSeek-Reasonix), used under the MIT License.

Copyright (c) 2026 Reasonix Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Image runtime

- `@silvia-odwyer/photon-node` 0.3.4: Apache-2.0. Its WebAssembly image
  runtime and license are bundled under `dist/node_modules/@silvia-odwyer/photon-node`.
- `image-size` 2.0.2: MIT. Its header parser and license are bundled under
  `dist/node_modules/image-size`.

These packages execute locally in a bounded worker. They do not send images
to an external service.

## Local Voice Input

- `whisper-rs` 0.16.0 / `whisper-rs-sys` 0.15.0: Unlicense; their embedded
  whisper.cpp 1.8.3 engine is MIT. Desktop uses local, CPU-only inference.
- `cpal` 0.16.0: Apache-2.0. The checked-in copy contains a small macOS input
  activation patch documented in `desktop/src-tauri/vendor/cpal/JUPITER-PATCH.md`;
  its upstream license is preserved.
- `rubato` 0.16.2: MIT. Used for local audio resampling.
- The optional multilingual Whisper base model is downloaded separately from
  `ggerganov/whisper.cpp`, with a pinned SHA-256. It is not part of the installer.
  Whisper code and weights are released under the MIT License by OpenAI.

Android uses the device's installed speech-recognition service. That service's
terms and any network processing are independent of Jupiter.
