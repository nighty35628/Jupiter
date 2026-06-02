import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { I } from "../icons";
import { checkJupiterUpdate, jupiterUpdatesEnabled } from "../update-policy";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "disabled" }
  | { kind: "up-to-date"; latest: string }
  | { kind: "outdated"; latest: string }
  | { kind: "error"; message: string };

export function AboutModal({ onClose }: { onClose: () => void }) {
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
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });

  const checkForUpdates = useCallback(async () => {
    if (!jupiterUpdatesEnabled()) {
      setCheck({ kind: "disabled" });
      return;
    }
    setCheck({ kind: "checking" });
    try {
      const update = await checkJupiterUpdate();
      if (!update) {
        setCheck({ kind: "up-to-date", latest: __APP_VERSION__ });
      } else {
        setCheck({ kind: "outdated", latest: update.version });
      }
    } catch (err) {
      setCheck({ kind: "error", message: (err as Error).message });
    }
  }, []);

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
            onClick={checkForUpdates}
            disabled={check.kind === "checking"}
          >
            <I.rotate size={12} />
            <span>{check.kind === "checking" ? t("about.checking") : t("about.checkUpdates")}</span>
          </button>
          <CheckStatus check={check} />
        </div>
      </div>
    </div>
  );
}

function CheckStatus({ check }: { check: CheckState }) {
  if (check.kind === "idle" || check.kind === "checking") return null;
  if (check.kind === "disabled") {
    return (
      <div className="about-status">
        <span>{t("about.updateChannelDisabled")}</span>
      </div>
    );
  }
  if (check.kind === "up-to-date") {
    return (
      <div className="about-status ok">
        <I.check size={12} />
        <span>{t("about.upToDate", { version: check.latest })}</span>
      </div>
    );
  }
  if (check.kind === "outdated") {
    return (
      <div className="about-status warn">
        <span>{t("about.updateAvailable", { version: check.latest })}</span>
      </div>
    );
  }
  return (
    <div className="about-status err">
      <span>{t("about.checkFailed", { message: check.message })}</span>
    </div>
  );
}
