# Surfaces, Sessions and Settings

## Context and compaction
Original session messages remain the authoritative history for browsing, exports and rollback.
Automatic compaction and /compact create a separate, lossy context recap; they do not delete the
original exchanges. A validated recap can be reused next turn, in a newly opened parallel view,
or after restart. Running parallel turns keep their original snapshots until they finish.

Settings > Models exposes an optional early compaction threshold. The default remains 160,000
input tokens; turning early compaction off does not disable capacity protection or manual /compact.
Longer retained context may cost more on low-cache-hit requests. Jupiter does not claim measured
cost savings or lossless summaries. Legacy context overrides remain input caps, not total windows.
The context panel separates the total window, estimated output reservation and usable input limit.
Unknown third-party capacity and output defaults are estimates; matching a DeepSeek model name
does not establish the official service's limits.

An explicit context-overflow failure can trigger one bounded compaction/retry at the same request
boundary. Existing user messages and completed tools are retained, not executed again. Partial
streamed answers are not automatically replayed. Safe failed requests can be retried explicitly;
cancelled requests do not restart themselves. Beta prefix continuation has its own budget check:
when it cannot fit, the generated first part remains available rather than being replayed.

## Voice input
Desktop and the Android local app can expose a microphone in the main composer when
the native host supports dictation. Ordinary Web and CLI do not provide this
microphone. Settings > General > Voice input controls the recognition language;
it is independent of the interface language. Automatic language selection is
available only on a backend that supports it.

Desktop uses a separately downloaded multilingual Whisper model for local
transcription. Downloading needs user confirmation; the model is not included in
the installer. Android uses its installed system recognition service, which may
be absent or may lack the requested language. On-device mode does not silently
fall back to a network provider. Selecting the system-provider mode may send
audio to that provider; Jupiter cannot control the provider's retention.

Click the microphone to start and again to finish. Cancel discards the recording.
Recognized text goes to the draft for review, never directly to the model and
never automatically sends a message. If the draft changed or IME composition is
active, use the temporary Insert/Discard result. Changing tabs, changing session
bindings, sending or queueing a message invalidates old speech results. Recording
is foreground-only and limited to 60 seconds. Jupiter does not save recordings
or include audio/transcripts in diagnostic logs by default. These are dictation
controls, not voice chat, text-to-speech, or Phone Use.

## Scheduled tasks
Desktop and Web expose Settings > Scheduled tasks for the current workspace. Tasks support one-time, fixed-minute intervals, daily and weekly schedules with an IANA time zone. Definitions and the most recent 20 run records are saved locally. Jupiter must be running on the host; this does not install an OS daemon, wake a sleeping computer, or run on the client browser's device. Missed repeating occurrences are coalesced into one run when the host runtime returns. Interrupted runs are not automatically replayed.
Each run creates a separate normal conversation, uses the configured provider and selected model, and incurs API usage. Ask has no tools or workspace context. Agent uses the task's explicitly selected permission mode (default review); pending interactive confirmations stop the run rather than being auto-approved. Full control must be selected explicitly and allows commands and writes without confirmation. Native Computer Use is not started for scheduled runs. Optional Agent budgets and a run time limit bound execution using the existing mechanisms.
Tasks can be edited, paused, resumed, run manually, cancelled and deleted. Pausing affects future runs, not an already running task; use Stop run for that. Deleting a task does not delete its conversation sessions. Results can be opened from run history. Use current task revisions to avoid overwriting newer changes. Public Web is read-only for tasks; LAN task changes require the existing remote high-risk capability. Web dispatch is restricted to the runtime's open workspace roots.
CLI /loop remains an independent temporary foreground loop, not persistent scheduling. The assistant can explain scheduled tasks but has no task-creation tool; direct users to the settings page rather than claiming a schedule was created from chat.
Jupiter has CLI/TUI, Desktop and Web/dashboard surfaces plus configured messaging integrations. Tool availability differs by surface and by session. Desktop supports tabbed sessions; CLI chat/code and run are different entry points. Web/dashboard does not imply native local Computer Use.
Settings cover provider/model, reasoning, permissions, tools/integrations, memory/library and session behavior. Changes may affect the next request or require reconnect/restart for an integration; use the reported live state. Do not expose credentials when describing configuration.
Sessions preserve visible exchanges and provider binding; switching/resuming does not authorize mixing providers, workspaces or foreign histories. CLI offers session selection and /new; desktop provides session navigation. Lightweight side questions use a fresh message list. Host help context is request-only and must not become a persistent user/assistant message.
