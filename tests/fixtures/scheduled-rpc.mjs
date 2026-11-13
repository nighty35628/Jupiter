import { createInterface } from "node:readline";
const emit = (event) => process.stdout.write(`${JSON.stringify({ tabId: "t1", ...event })}\n`);
emit({ type: "$session_loaded", name: "synthetic-session" });
const model = process.argv[process.argv.indexOf("--model") + 1];
if (process.env.JUPITER_SCHEDULE_COMPUTER_USE === "1" && model !== "no-status") {
  emit({
    type: "$settings",
    computerUseEnabled: true,
    computerUseStatus: {
      state: model === "nonvisual" ? "unsupported-model" : "idle",
      reason: model === "nonvisual" ? "Select a visual model" : undefined,
    },
  });
}
emit({ type: "$ready" });
const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const command = JSON.parse(raw);
  if (command.cmd === "session_load") {
    emit({
      type: "$session_loaded",
      name: command.name,
      snapshot: { requestId: command.requestId },
    });
    emit({ type: "$ready" });
    return;
  }
  if (command.cmd === "scheduled_context") {
    emit({ type: "$scheduled_context_ready", requestId: command.requestId });
    return;
  }
  if (command.text?.startsWith("Audit the execution")) {
    emit({
      type: "model.final",
      content: JSON.stringify({
        criteria: [
          {
            index: 0,
            met: true,
            evidence: "Synthetic report file verified",
            evidenceIds: ["verify-file"],
          },
        ],
        remaining: [],
        scopeRespected: true,
      }),
    });
    emit({ type: "$turn_complete" });
    return;
  }
  if (command.cmd === "abort") {
    emit({ type: "$turn_complete" });
    return;
  }
  if (command.text === "wait") return;
  if (command.text?.startsWith("gate")) {
    emit({ type: "$confirm_required", id: 1, command: "synthetic" });
    return;
  }
  if (command.text === "failure") {
    emit({ type: "$error", message: "synthetic offline" });
    emit({ type: "$turn_complete" });
    return;
  }
  if (command.text?.includes("Objective:")) {
    emit({
      type: "tool.intent",
      callId: "verify-file",
      name: "read_file",
      args: '{"path":"report.txt"}',
    });
    emit({
      type: "tool.result",
      callId: "verify-file",
      output: "Verified report contents",
      ok: true,
    });
    emit({
      type: "$scheduled_checkpoint",
      checkpoint: {
        at: Date.now(),
        step: "Report created",
        evidence: ["Verified report contents"],
        remaining: [],
      },
    });
  }
  if (command.text?.includes("Resume context:") && command.cmd === "ask_light") {
    emit({ type: "model.final", content: "Resumed existing session" });
    emit({ type: "$turn_complete" });
    return;
  }
  emit({
    type: "model.final",
    content:
      process.env.JUPITER_SCHEDULE_CHILD === "1" &&
      process.env.JUPITER_SCHEDULE_EDIT_MODE === "review"
        ? `OK ${command.cmd}`
        : "INVALID PERMISSIONS",
  });
  emit({ type: "$session_renamed", name: "synthetic-renamed" });
  emit({ type: "$turn_complete" });
});
