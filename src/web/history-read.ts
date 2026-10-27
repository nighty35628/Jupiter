/** Read-only history queries never acquire or advance a writer lease. */
export function isHistoryReadCommand(value: Record<string, unknown>): boolean {
  if (value.cmd !== "session_history_page" && value.cmd !== "session_turn_load") return false;
  if (
    typeof value.name !== "string" ||
    !value.name ||
    value.name.length > 256 ||
    typeof value.sessionId !== "string" ||
    !value.sessionId ||
    value.sessionId.length > 256 ||
    !Number.isSafeInteger(value.bindingId) ||
    Number(value.bindingId) < 0 ||
    typeof value.requestId !== "string" ||
    !value.requestId ||
    value.requestId.length > 256
  )
    return false;
  if (
    value.generation !== undefined &&
    (typeof value.generation !== "string" || value.generation.length > 512)
  )
    return false;
  if (value.cmd === "session_turn_load")
    return Number.isSafeInteger(value.turn) && Number(value.turn) >= 1;
  return (
    value.cursor === undefined || (typeof value.cursor === "string" && value.cursor.length <= 2048)
  );
}
