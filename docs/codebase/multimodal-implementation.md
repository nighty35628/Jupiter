# Multimodal implementation

## Scope

Implement the reviewed direct-image Desktop/Web workflow, durable attachments,
image-aware compaction, safe retries, DeepSeek Files reuse and tool images.
Keep the existing Jupiter UI and protocols. Pro vision-helper routing is deferred.

## Delivery checklist

- [x] Portable image worker, input/request budgets, durable content objects.
- [x] One attachment reference contract across events, history and RPC.
- [x] Explicit model vision capability; no implied prefix/Files capabilities.
- [x] Request-only image serialization, tool-image projection, Files fallback.
- [x] Durable submission IDs; no model execution after image persistence failure.
- [x] Complete drafts for queues, retries, edits and lightweight ask.
- [x] Session-bound asynchronous attachment intake and persistent previews.
- [x] Compaction with image budgets, source references and same-provider vision.
- [x] Authorized image rereading and browser/tool screenshots.
- [x] Safe binary Web previews, concurrent upload quotas and snapshot reads.
- [x] Conservative reference-aware cleanup, imports and exports.
- [x] Regression tests, type checks, builds and packaged-worker smoke test.
- [x] Desktop/Web visual and interaction verification, isolated local launch.

## Design constraints

History never contains image bytes or remote provider file IDs. Request encoding
is transient. Uploaded originals are normalized snapshots, not live source paths.
An acknowledged message must reference durable objects. Unknown delivery is
reconciled by its original submission ID, not retried as a new user turn.
Archives, recoverable backups, drafts and active operations retain references.
Third-party endpoints never inherit the official Files protocol by model name.

## Baseline

Before implementation, 19 existing compaction, timeout and session-rebind tests
passed. The working tree already contained unrelated changes; preserve them.

## Resource and retention policy

- Input: PNG/JPEG/WebP/GIF, 20 MiB per image, 16 megapixels, 16,384-pixel maximum side.
- Intake: one isolated WASM worker at a time, queue of at most 8 and 40 MiB, 30-second timeout.
- Storage: normalized image at most 4 megapixels/4 MiB; thumbnail at most 320 pixels/128 KiB.
- Request: derivative at most 640,000 pixels/1 MiB; at most 32 images and 12 MiB image bytes.
- One submitted message: at most 12 images. Current images fail explicitly rather than being omitted.
- Older images may be omitted to fit the request budget, with explicit placeholders and diagnostics.
- Store: 2 GiB quota, including a reserve for request variants. No startup deletion.
- Manual cleanup removes only unreferenced objects older than 30 days after a fresh reference scan.
- Sessions, archives, backups and persisted drafts pin images. Unreadable references stop reclamation.
- Official Files mappings are isolated by endpoint and credential hash and never exported in history.
  Expired mappings get one inline recovery within the existing chat retry budget, not a new retry loop.

## Verification (2026-08-30)

- Full Vitest run: 447 files, 4,848 tests passed, 9 existing skips.
- TypeScript: root, Desktop and Dashboard checks passed.
- Rust: 29 tests passed, including canonical-root aliases and escaped image paths.
- Builds: CLI/library, Dashboard, Desktop and macOS app bundles passed.
- Packaging: worker executed outside the checkout using only the shipped Photon WASM and image-size dependencies.
- Browser: file picker, real PNG clipboard paste, thumbnails/full preview, reload, edit restoration,
  pure-image Ask, busy-turn queue auto-drain, preserved Ask mode, no leftover queued image in the draft.
- Browser layouts: desktop and 390-pixel viewport; loaded images, bounded preview and no horizontal overflow.
- macOS app: isolated bundle identifier and HOME, bundled Node/CLI, native file picker, asset-protocol thumbnail,
  full preview, Escape close and pure-image Ask; attachment filename becomes the new conversation title.
- All interactive requests used a synthetic image and a local mock provider. No user API credit was used.

### Regressions found and fixed during acceptance

- Optimistic busy state was cleared after queue draining, leaving queued image turns stuck.
- Pending-delivery recovery could run on a live send and put a queued image back into the draft.
- Empty pending assistant rows could trigger a zero-height virtual-list measurement.
- Finder image icons could be mistaken for the copied file; file-path probing retains priority.
- Image preview Escape needed local handling to avoid the global task-interruption shortcut.
- Comparing canonical asset paths against a noncanonical root rejected valid aliased/Windows paths.
- Follow-up: the default official configuration model allowlist omitted Vision, so settings readback
  silently reverted its label to Flash. The allowlist now uses the shared Vision model constant.
  New tests cover save/readback without a custom base URL and repeated Flash/Pro/Vision switches.
  The fix passed 190 focused tests and a real Web switch/reload check; no model request was sent.

## Explicit limits

This is direct-image Beta, not video, OCR-only ingestion or Pro vision-helper routing. A third-party model must
explicitly opt into Chat Completions image input; this is a capability declaration, not a guarantee about that service.
Real DeepSeek/gateway responses and Windows UI were not exercised in this environment. Windows-sensitive path logic
has portable tests, but a Windows release still requires native acceptance. Markdown exports contain placeholders,
not a portable image archive. Conservative offline draft pins may retain unused objects until references are cleared.
An empty session that has never sent a message can receive a new ID after a Web backend restart; its saved draft
is not automatically rebound to that new session. Browser reloads against the same running backend retain the draft.

For repeatable interactive QA, build the project and run `node scripts/multimodal-web-smoke.mjs`. Its output includes
an isolated temporary HOME, workspace, synthetic image, local provider and one-time Web pairing token. Keep that token
private and stop the process after testing. The mock records image counts and tool counts, never real credentials.
