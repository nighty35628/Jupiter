import { Cron } from "croner";
import type { TaskSchedule } from "./types.js";

export function nextScheduledTime(schedule: TaskSchedule, after: number): number | null {
  if (schedule.kind === "once")
    return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : null;
  if (schedule.kind === "interval") return after + schedule.minutes * 60_000;
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(after);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const cron = new Cron(
    `${minute} ${hour} * * ${schedule.kind === "weekly" ? schedule.day : "*"}`,
    { timezone: schedule.timezone, paused: true },
  );
  try {
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } finally {
    cron.stop();
  }
}
