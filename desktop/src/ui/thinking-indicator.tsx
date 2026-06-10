import { t } from "../i18n";

export function ThinkingBottomIndicator({
  active,
  label,
}: {
  active: boolean;
  label?: string | null;
}) {
  if (!active) return null;

  return (
    <div
      className="thread-thinking-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="thread-thinking-label">{label?.trim() || t("app.thinkingNow")}</span>
      <span className="thread-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
