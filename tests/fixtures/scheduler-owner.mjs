import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { ScheduledTaskEngine } from "../../src/scheduler/engine.ts";
import { ScheduledTaskStore } from "../../src/scheduler/store.ts";

const [storePath, receipts, now] = process.argv.slice(2);
const engine = new ScheduledTaskEngine(
  new ScheduledTaskStore(storePath),
  async () => {
    appendFileSync(receipts, `${process.pid}\n`);
    await sleep(50);
    return { status: "succeeded", summary: "synthetic process test" };
  },
  () => Number(now),
);
for (let i = 0; i < 15; i++) {
  try {
    engine.tick();
  } catch (error) {
    if (error.code !== "SESSION_WRITER_CONFLICT") throw error;
  }
  await sleep(20);
}
await engine.stop();
