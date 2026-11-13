import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { setLang } from "../src/i18n";
import { PageScheduledTasks } from "../src/ui/scheduled-tasks";
import type { ScheduledCommand, ScheduledTask, ScheduledTasksEvent } from "../../src/scheduler/types";
import "../src/styles.css";

setLang("zh-CN");
document.documentElement.dataset.theme = "light";
const sample: ScheduledTask = {
  id: crypto.randomUUID(), workspaceDir: "C:/work/reports", revision: 1, createdAt: Date.now(),
  title: "每日工作晨报", prompt: "读取工作记录，生成有证据支持的晨报。", mode: "agent", editMode: "review",
  model: "deepseek-v4-flash", reasoningEffort: "high", enabled: true, timeoutMinutes: 30,
  schedule: { kind: "daily", time: "09:30", timezone: "Asia/Shanghai" }, nextRunAt: Date.now() + 3600000,
  goal: { objective: "完成本周工作报告", completionCriteria: ["报告已生成", "各项结论附有来源"], allowedScope: "仅工作目录内的记录和报告" },
  runs: [{ id: crypto.randomUUID(), ownerPid: 1, startedAt: Date.now() - 60000, status: "running", session: "report-run",
    progress: { updatedAt: Date.now(), currentStep: "核对报告中的来源", recentActions: [{ at: Date.now(), text: "tool.result: read_file" }],
      checkpoints: [{ at: Date.now(), step: "整理工作记录", evidence: ["已读取本周五份记录"], remaining: ["核对来源", "保存报告"] }] } }],
};
function Fixture() {
  const [result, setResult] = useState<ScheduledTasksEvent>({ type: "$scheduled_tasks", workspaceDir: sample.workspaceDir, requestId: "initial", tasks: [sample] });
  const send = useCallback(async (command: ScheduledCommand) => setResult((previous) => {
    const tasks = structuredClone(previous.tasks);
    if (command.cmd === "scheduled_save") {
      const index = tasks.findIndex((task) => task.id === command.id);
      const task: ScheduledTask = { ...command.task, id: command.id ?? crypto.randomUUID(), workspaceDir: sample.workspaceDir,
        revision: (index >= 0 ? tasks[index]!.revision : 0) + 1, createdAt: Date.now(), nextRunAt: Date.now() + 3600000, runs: index >= 0 ? tasks[index]!.runs : [] };
      if (index >= 0) tasks[index] = task; else tasks.push(task);
    }
    if (command.cmd === "scheduled_action") {
      const task = tasks.find((item) => item.id === command.id);
      if (task && command.action === "pause") { task.enabled = false; task.nextRunAt = null; task.runs[0]!.status = "paused"; }
      if (task && command.action === "resume") { task.enabled = true; task.runs[0]!.status = "running"; }
      if (task && command.action === "cancel") task.runs[0]!.status = "cancelled";
    }
    return { ...previous, requestId: command.requestId, tasks };
  }), []);
  return <main style={{ height: "100vh", overflow: "auto", background: "var(--bg)", color: "var(--fg)", padding: 24 }}>
    <h1>自动化任务</h1>
    <PageScheduledTasks workspaceDir={sample.workspaceDir} model={sample.model} active result={result} send={send} onOpenSession={() => {}} writable />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
