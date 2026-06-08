import type { DeepSeekClient } from "../client.js";
import type { ChatMessage } from "../types.js";

export type DesktopNaturalCommandIntent = { command: "compact_history" | "none" };

const SYSTEM_PROMPT = [
  "You classify whether a desktop chat message is a command for the app itself.",
  'Return JSON only: {"command":"compact_history"} or {"command":"none"}.',
  "Choose compact_history only when the user clearly asks Jupiter to compact, compress, fold, or reduce the current conversation context/history.",
  "Choose none for ordinary requests to summarize, analyze, search, explain, or discuss the conversation/history.",
  "Choose none when the user is negating, asking about the command, or mentioning compaction hypothetically.",
].join(" ");

export async function classifyDesktopNaturalCommandIntent(
  client: DeepSeekClient,
  opts: { model: string; text: string; signal?: AbortSignal },
): Promise<DesktopNaturalCommandIntent> {
  const text = opts.text.trim();
  if (!text) return { command: "none" };
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: text.slice(0, 2000) },
  ];
  try {
    const response = await client.chat({
      model: opts.model,
      messages,
      responseFormat: { type: "json_object" },
      thinking: "disabled",
      temperature: 0,
      maxTokens: 32,
      signal: opts.signal,
    });
    const parsed = JSON.parse(response.content.trim()) as Partial<DesktopNaturalCommandIntent>;
    return parsed.command === "compact_history"
      ? { command: "compact_history" }
      : { command: "none" };
  } catch {
    return { command: "none" };
  }
}
