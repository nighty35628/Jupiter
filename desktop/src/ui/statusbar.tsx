import { useState } from "react";
import { I } from "../icons";
import { t } from "../i18n";
import type { Balance, UsageStats } from "../App";
import type { JobInfo } from "../protocol";
import { THEME, THEME_STYLES, type Theme, type ThemeStyle, themeForStyle } from "../theme";

const USD_TO_CNY = 7.2;

function formatMoney(amountUsd: number, currency: "CNY" | "USD"): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  const amount = currency === "CNY" ? amountUsd * USD_TO_CNY : amountUsd;
  return `${symbol} ${amount.toFixed(4)}`;
}

function tokenLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/** Format a 0-100 percentage to 2 decimal places.
 *  100.00 is shown only when the value is exactly 100; values that would round
 *  to 100.00 are capped at 99.99. */
function formatPct(value: number): string {
  if (value === 100) return "100.00";
  const rounded = Math.round(value * 100) / 100;
  if (rounded >= 100) return "99.99";
  return rounded.toFixed(2);
}

function balanceValue(balance: Balance | null): string {
  if (!balance) return "-";
  if (balance.infos.length > 0) {
    return balance.infos
      .map((info) => `${info.currency === "USD" ? "$" : "¥"} ${info.total.toFixed(2)}`)
      .join(" / ");
  }
  return `${balance.currency === "USD" ? "$" : "¥"} ${balance.total.toFixed(2)}`;
}

export function SettingsStatusCard({
  balance,
  usage,
  currency,
  theme,
  themeStyle,
  jobs,
  jobsOpen,
  onToggleJobs,
  onSetThemeStyle,
  onToggleTheme,
  onToggleCurrency,
  onOpenSettings,
  onClose,
}: {
  balance: Balance | null;
  usage: UsageStats;
  currency: "CNY" | "USD";
  theme: Theme;
  themeStyle: ThemeStyle;
  jobs: JobInfo[];
  jobsOpen: boolean;
  onToggleJobs: () => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  onToggleTheme: () => void;
  onToggleCurrency: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const sessionPromptTokens =
    usage.totalPromptTokens || usage.cacheHitTokens + usage.cacheMissTokens;
  const liveContextTokens = usage.reservedTokens + usage.liveLogTokens;
  const totalTokens = Math.max(sessionPromptTokens, liveContextTokens);
  const cacheDenom = usage.cacheHitTokens + usage.cacheMissTokens;
  const cacheHitRaw = cacheDenom > 0 ? (usage.cacheHitTokens / cacheDenom) * 100 : 0;
  const cacheHitPctDisplay = formatPct(cacheHitRaw);
  const cacheHitDetail =
    cacheDenom > 0
      ? `${usage.cacheHitTokens.toLocaleString()} / ${cacheDenom.toLocaleString()} tokens (${cacheHitPctDisplay}%)`
      : t("statusbar.cacheHit");
  const runningJobs = jobs.filter((j) => j.running).length;
  const spent = formatMoney(usage.totalCostUsd, currency);
  const balanceLabel = balanceValue(balance);
  const [styleOpen, setStyleOpen] = useState(false);

  return (
    <div className="settings-card-layer" onMouseDown={onClose}>
      <section className="settings-card" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-card-head">
          <div>
            <div className="settings-card-title">Jupiter</div>
            <div className="settings-card-sub">{t("settings.title")}</div>
          </div>
          <button type="button" className="settings-card-close" onClick={onClose} aria-label={t("settings.close")}>
            <I.x size={14} />
          </button>
        </div>

        <div className="settings-card-grid">
          <button
            type="button"
            className="settings-stat settings-stat-balance"
            title={t("statusbar.switchCurrency")}
            onClick={onToggleCurrency}
          >
            <span className="ico"><I.coin size={14} /></span>
            <span className="k">{t("statusbar.balance")}</span>
            <span className="v ok">{balanceLabel}</span>
          </button>
          <div className="settings-stat">
            <span className="ico"><I.zap size={14} /></span>
            <span className="k">{t("statusbar.cache")}</span>
            <span className="v acc" title={cacheHitDetail}>{cacheHitPctDisplay}%</span>
          </div>
          <div className="settings-stat">
            <span className="ico"><I.cpu size={14} /></span>
            <span className="k">{t("statusbar.tokens")}</span>
            <span className="v">{tokenLabel(totalTokens)}</span>
          </div>
          <div className="settings-stat">
            <span className="ico"><I.coin size={14} /></span>
            <span className="k">{t("statusbar.thisTurn")}</span>
            <span className="v ok">{spent}</span>
          </div>
        </div>

        <button
          type="button"
          className="settings-card-row"
          title={t("statusbar.jobsTip")}
          data-active={jobsOpen || runningJobs > 0}
          onClick={onToggleJobs}
        >
          <span className="ico"><I.cpu size={14} /></span>
          <span>{t("statusbar.jobs")}</span>
          <span className={runningJobs > 0 ? "value acc" : "value"}>{runningJobs}</span>
        </button>

        <div className="settings-card-actions">
          <button type="button" className="settings-card-row settings-card-primary" onClick={onOpenSettings}>
            <span className="ico"><I.cog size={14} /></span>
            <span>{t("settings.title")}</span>
          </button>
          <button
            type="button"
            className="settings-icon-action"
            title={theme === THEME.DARK ? t("statusbar.themeLight") : t("statusbar.themeDark")}
            onClick={onToggleTheme}
          >
            {theme === THEME.DARK ? <I.sun size={15} /> : <I.moon size={15} />}
          </button>
          <button
            type="button"
            className="settings-icon-action"
            data-active={styleOpen}
            title={t("settings.themeStyle")}
            onClick={() => setStyleOpen((open) => !open)}
          >
            <I.layers size={15} />
            <I.chev size={10} className="settings-style-chev" />
          </button>
        </div>

        {styleOpen ? (
          <div className="settings-card-theme" aria-label={t("settings.themeStyle")}>
            <div className="settings-theme-options">
              {THEME_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  className="settings-theme-option"
                  data-on={themeStyle === style}
                  data-style={style}
                  title={`${t(`statusbar.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)} · ${
                    themeForStyle(style) === THEME.DARK ? t("statusbar.themeDark") : t("statusbar.themeLight")
                  }`}
                  onClick={() => onSetThemeStyle(style)}
                >
                  <span className="style-swatches" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="nm">
                    {t(`statusbar.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)}
                  </span>
                  {themeStyle === style ? <I.check size={13} /> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
