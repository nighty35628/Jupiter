import type { ImageAttachment } from "../attachments/types.js";

export type SessionMarkdownSegment =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | {
      kind: "tool";
      name: string;
      args: string;
      result?: string;
    }
  | { kind: "elision"; segmentCount: number; charCount: number };

export type SessionMarkdownMessage =
  | { kind: "user"; text: string; turn: number; attachments?: ImageAttachment[] }
  | { kind: "assistant"; segments: SessionMarkdownSegment[]; turn: number };

export interface SessionMarkdownLabels {
  user: string;
  assistant: string;
  reasoning: string;
  tool: string;
}

function codeFence(value: string, language = ""): string {
  const longest = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${value}\n${fence}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSessionMarkdown(
  messages: readonly SessionMarkdownMessage[],
  labels: SessionMarkdownLabels,
): string {
  return messages
    .map((message) => {
      if (message.kind === "user")
        return `### ${labels.user}\n\n${message.text}${(message.attachments ?? []).map((image) => `\n\n[Image attachment: ${escapeHtml(JSON.stringify(image.name))}; ${image.width}x${image.height}; ${image.id}. Image bytes are not included in this Markdown export.]`).join("")}`;
      const body = message.segments
        .map((segment) => {
          if (segment.kind === "text") return segment.text;
          if (segment.kind === "reasoning") {
            return `<details>\n<summary>${escapeHtml(labels.reasoning)}</summary>\n\n${segment.text}\n\n</details>`;
          }
          if (segment.kind === "tool") {
            const args = segment.args ? `\n\n${codeFence(segment.args, "json")}` : "";
            const result = segment.result ? `\n\n${codeFence(segment.result)}` : "";
            return `> **${labels.tool} · \`${segment.name}\`**${args}${result}`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n\n");
      return `### ${labels.assistant}\n\n${body}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function assistantTextForTurn(
  messages: readonly SessionMarkdownMessage[],
  turn: number,
): string {
  return messages
    .filter((message) => message.kind === "assistant" && message.turn === turn)
    .flatMap((message) =>
      message.kind === "assistant"
        ? message.segments
            .filter((segment): segment is { kind: "text"; text: string } => segment.kind === "text")
            .map((segment) => segment.text)
        : [],
    )
    .filter(Boolean)
    .join("\n\n");
}
