import { type ReactNode, useEffect, useState } from "react";
import { t, useLang } from "../../desktop/src/i18n";
import { WebSessionError, authenticateWebSession } from "./lib/runtime-transport";
import "./web-session-gate.css";

function connectionError(error: unknown): string {
  return error instanceof WebSessionError ? t(`webAuth.${error.code}`) : t("webAuth.unavailable");
}

export function WebSessionGate({ children }: { children: ReactNode }) {
  useLang();
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [link, setLink] = useState("");

  useEffect(() => {
    let cancelled = false;
    authenticateWebSession().then(
      () => { if (!cancelled) setReady(true); },
      (err) => { if (!cancelled) { setError(err); setPending(false); } },
    );
    return () => { cancelled = true; };
  }, []);

  async function connect(pairingLink?: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await authenticateWebSession(pairingLink);
      setLink("");
      setReady(true);
    } catch (err) {
      setError(err);
    } finally {
      setPending(false);
    }
  }

  if (ready) return children;
  return (
    <main className="web-session-gate">
      <section className="web-session-content" aria-labelledby="web-session-title" aria-busy={pending}>
        <div className="empty-logo" aria-hidden="true" />
        <h1 id="web-session-title">Jupiter</h1>
        {pending && !error && !link ? <p role="status">{t("webAuth.connecting")}</p> : (
          <>
            <h2>{t("webAuth.title")}</h2>
            <p id="web-session-hint">{t("webAuth.hint")}</p>
            <form onSubmit={(event) => { event.preventDefault(); void connect(link); }}>
              <label htmlFor="web-session-link">{t("webAuth.linkLabel")}</label>
              <input
                id="web-session-link"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={link}
                onChange={(event) => setLink(event.target.value)}
                aria-describedby="web-session-hint web-session-error"
                aria-invalid={error instanceof WebSessionError && (error.code === "invalidLink" || error.code === "wrongServer")}
                disabled={pending}
              />
              <p id="web-session-error" role="alert">{error ? connectionError(error) : ""}</p>
              <div className="web-session-actions">
                <button className="web-session-connect" type="submit" disabled={pending || !link.trim()}>
                  {t(pending ? "webAuth.connecting" : "webAuth.connect")}
                </button>
                <button type="button" disabled={pending} onClick={() => void connect()}>
                  {t("app.startupFailedRetry")}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
