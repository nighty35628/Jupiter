import { createInterface } from "node:readline";
const emit = (event) => process.stdout.write(`${JSON.stringify({ tabId: "t1", ...event })}\n`);
emit({ type: "$session_loaded", name: "synthetic-session" });
emit({ type: "$ready" });
const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const command = JSON.parse(raw);
  if (command.cmd === "abort") {
    emit({ type: "$turn_complete" });
    return;
  }
  if (command.text === "wait") return;
  if (command.text === "gate") {
    emit({ type: "$confirm_required", id: 1, command: "synthetic" });
    return;
  }
  if (command.text === "failure") {
    emit({ type: "$error", message: "synthetic offline" });
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
