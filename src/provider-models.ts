export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
export const DEEPSEEK_VISION_MODEL = DEEPSEEK_DEFAULT_MODEL;
export const DEEPSEEK_MODELS: readonly string[] = [DEEPSEEK_DEFAULT_MODEL, "deepseek-v4-pro"];
export const DEEPSEEK_FLASH_ALIASES = new Set([
  "deepseek-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

/** Apply only at the official endpoint; relays own their model namespaces. */
export function normalizeOfficialDeepSeekModel(model: string): string {
  const id = model.trim();
  return DEEPSEEK_FLASH_ALIASES.has(id) || id === "deepseek-chat" || id === "deepseek-reasoner"
    ? DEEPSEEK_DEFAULT_MODEL
    : id;
}
