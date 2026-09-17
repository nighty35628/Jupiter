import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Virtuoso } from "react-virtuoso";
import { AssistantMsg } from "../src/ui/thread";
import { PlanProgressOverlay } from "../src/ui/plan-progress-overlay";
import { elideTranscriptMessages } from "../src/ui/transcript-elision";
import type { AssistantSegment } from "../src/App";
import "../src/styles.css";

document.documentElement.dataset.theme = "light";
document.documentElement.dataset.runtime = "web";
const paragraph =
  "Long transcript regression. A completed response must remain readable when scrolling upwards. ";
const messages = Array.from({ length: 120 }, (_, index) => ({
  kind: "assistant" as const,
  turn: index + 1,
  messageId: `qa-${index}`,
  pending: false,
  segments: [
    { kind: "text", text: `## Turn ${index + 1}\n\n${paragraph.repeat(index === 119 ? 2400 : 4)}` },
  ] as AssistantSegment[],
}));
messages[119].segments = [
  { kind: "text", text: "Before compaction" },
  { kind: "compaction", id: "qa-compact", text: "History compacted", pending: false },
  ...messages[119].segments,
];
function Fixture() {
  const [preserved, setPreserved] = useState(new Set<number>());
  const [done, setDone] = useState<string[]>([]);
  const [pending, setPending] = useState(true);
  const data = useMemo(() => elideTranscriptMessages(messages, preserved), [preserved]);
  return (
    <main
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}
    >
      <div style={{ padding: 12 }}>
        <button onClick={() => setDone(["read"])}>Advance plan</button>
        <button onClick={() => setPending(false)}>Finish stream</button>
      </div>
      <div className="thread">
        <Virtuoso
          style={{ height: "100%" }}
          data={data}
          computeItemKey={(_, item) => item.messageId}
          itemContent={(_, item) => (
            <div className="thread-inner">
              <AssistantMsg
                segments={item.segments}
                pending={item.turn === 120 && pending}
                onApproveConfirm={() => {}}
                onRejectConfirm={() => {}}
                onAlwaysAllowConfirm={() => {}}
                pendingConfirms={[]}
                onLoadFullTurn={() => setPreserved(new Set([...preserved, item.turn]))}
              />
            </div>
          )}
        />
      </div>
      <PlanProgressOverlay
        plan={{
          plan: "QA plan",
          summary: "Rendering checks",
          steps: [
            { id: "read", title: "Inspect transcript", action: "read" },
            { id: "test", title: "Verify scrolling", action: "test" },
          ],
          completedStepIds: done,
          stepResults: {},
        }}
      />
      <textarea aria-label="Message" style={{ margin: 16, height: 70, flexShrink: 0 }} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
