import { useId, useState } from "react";
import type { ActivePlan } from "../App";
import { Markdown } from "../Markdown";
import { I } from "../icons";
import { t, useLang } from "../i18n";

export function PlanProgressOverlay({
  plan,
  onDismiss,
}: {
  plan: ActivePlan;
  onDismiss?: () => void;
}) {
  useLang();
  const [open, setOpen] = useState(false);
  const id = useId();
  const completed = new Set(plan.completedStepIds);
  const done = plan.steps.filter((step) => completed.has(step.id)).length;
  const current = plan.steps.find((step) => !completed.has(step.id));
  return (
    <div className="plan-progress-anchor">
      <section className="plan-progress-overlay" aria-label={t("thread.activePlan")}>
        <div className="plan-progress-toolbar">
          <button
            type="button"
            className="plan-progress-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((value) => !value)}
          >
            <I.chev size={14} />
            <span className="plan-progress-title">
              {current?.title || plan.summary || t("thread.activePlan")}
            </span>
            <span aria-live="polite">
              {done}/{plan.steps.length}
            </span>
          </button>
          {onDismiss ? (
            <button
              type="button"
              className="plan-progress-close"
              aria-label={t("about.close")}
              title={t("about.close")}
              onClick={onDismiss}
            >
              <I.x size={14} />
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="plan-progress-details" id={id}>
            {plan.steps.length ? (
              <ol>
                {plan.steps.map((step) => (
                  <li
                    key={step.id}
                    data-completed={completed.has(step.id)}
                    aria-current={current?.id === step.id ? "step" : undefined}
                  >
                    <span>{completed.has(step.id) ? <I.check size={14} /> : null}</span>
                    <div>
                      {step.title}
                      {plan.stepResults[step.id] ? <p>{plan.stepResults[step.id]}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <Markdown source={plan.plan} />
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
