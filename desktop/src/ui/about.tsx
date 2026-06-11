import { useEffect } from "react";
import { t } from "../i18n";
import { I } from "../icons";
import type { UpdateCheckEvent, UpdateReleaseUrls } from "../protocol";

export type AboutUpdateCheck =
  | UpdateCheckEvent
  | {
      type?: "$update_check";
      mode: "manual";
      status: "idle";
      currentVersion: string;
      releaseUrls?: UpdateReleaseUrls;
    };

export function AboutModal({
  onClose,
  updateCheck,
  onCheckUpdates,
  onOpenRelease,
}: {
  onClose: () => void;
  updateCheck: AboutUpdateCheck;
  onCheckUpdates: (manual: boolean) => void;
  onOpenRelease: (source: keyof UpdateReleaseUrls) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const checking = updateCheck.mode === "manual" && updateCheck.status === "checking";

  return (
    <div className="about-mask" onClick={onClose} onKeyDown={(e) => e.stopPropagation()}>
      <div
        className="about-modal"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="about-close"
          onClick={onClose}
          aria-label={t("about.close")}
        >
          <I.x size={14} />
        </button>
        <div className="about-brand">
          <div className="about-name">Jupiter</div>
          <div className="about-tagline">{t("about.tagline")}</div>
        </div>
        <div className="about-meta">
          <div className="about-row">
            <span className="about-label">{t("about.version")}</span>
            <code className="about-value">{__APP_VERSION__}</code>
          </div>
          <div className="about-row">
            <span className="about-label">{t("about.developer")}</span>
            <span className="about-value">{t("about.developerLine")}</span>
          </div>
        </div>
        <div className="about-actions">
          <button
            type="button"
            className="about-check"
            onClick={() => onCheckUpdates(true)}
            disabled={checking}
          >
            <I.rotate size={12} />
            <span>{checking ? t("about.checking") : t("about.checkUpdates")}</span>
          </button>
          <CheckStatus check={updateCheck} onOpenRelease={onOpenRelease} />
        </div>
      </div>
    </div>
  );
}

function CheckStatus({
  check,
  onOpenRelease,
}: {
  check: AboutUpdateCheck;
  onOpenRelease: (source: keyof UpdateReleaseUrls) => void;
}) {
  if (check.mode !== "manual") return null;
  if (check.status === "idle" || check.status === "checking") return null;
  if (check.status === "suppressed") return null;
  if (check.status === "up_to_date") {
    return (
      <div className="about-status ok">
        <I.check size={12} />
        <span>{t("about.upToDate", { version: check.latestVersion })}</span>
      </div>
    );
  }
  if (check.status === "available") {
    return (
      <div className="about-status warn about-status-update">
        <span>{t("about.updateAvailable", { version: check.latestVersion })}</span>
        <span className="about-release-actions">
          <button type="button" className="about-link" onClick={() => onOpenRelease("gitee")}>
            {t("about.openGitee")}
          </button>
          <button type="button" className="about-link" onClick={() => onOpenRelease("github")}>
            {t("about.openGithub")}
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className="about-status err">
      <span>{t("about.checkFailed", { message: check.message })}</span>
    </div>
  );
}
