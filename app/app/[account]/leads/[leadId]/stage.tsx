/**
 * Conversation stage under the lead summary (canvas: LeadStage): the six
 * steps, done / current / upcoming, and one sentence on what the agent waits
 * for and what happens next. Read-only; the stage comes from lib/leads/stage.ts.
 */
import { TextWithId } from "@/components/sas/id-text";
import { Icon, type IconName } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import { STAGE_STEPS, type LeadStageView, type StageStep } from "@/lib/leads/stage";

export const STEP_LABEL: Record<StageStep, MessageKey> = {
  open: "lead.stage.step.open", understand: "lead.stage.step.understand", recommend: "lead.stage.step.recommend",
  quote: "lead.stage.step.quote", order_form: "lead.stage.step.order_form", after: "lead.stage.step.after",
};

export type StageTone = "now" | "warning" | "human" | "neutral" | "success";

/** The tone of the current step and of the stage chip in the Leads list. */
export function stageTone(v: LeadStageView): StageTone {
  if (v.human) return "human";
  if (v.closed || (v.step === "after" && v.paid)) return "neutral";
  if (v.objection) return "warning";
  return "now";
}

const TONE_STYLE: Record<StageTone, { bg: string; fg: string }> = {
  now: { bg: "var(--primary-soft)", fg: "var(--primary)" },
  warning: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  human: { bg: "var(--human-soft)", fg: "var(--human)" },
  neutral: { bg: "var(--surface-sunken)", fg: "var(--ink-muted)" },
  // The paid banner on the lead page: a win (S1).
  success: { bg: "var(--success-soft)", fg: "var(--success)" },
};

/** "Recommend", "Recommend · objection", "Order form · person handling", "After · paid", … */
export function stageLabel(v: LeadStageView): string {
  const step = t(STEP_LABEL[v.step]);
  if (v.human) return t("lead.stage.chip.human", { step });
  if (v.closed && !v.paid) return t("lead.stage.chip.ended", { step });
  if (v.objection) return t("lead.stage.chip.objection", { step });
  if (v.step === "after" && v.paid) return t("lead.stage.chip.paid", { step });
  if (v.backAfterChange) return t("lead.stage.chip.back", { step });
  if (v.skippedRecommend) return t("lead.stage.chip.skipped", { step });
  return step;
}

/** The stage as a chip (Leads list). */
export function StageChip({ v }: { v: LeadStageView }) {
  const s = TONE_STYLE[stageTone(v)];
  return (
    <span className="sas-pill" data-stage={v.step} data-stage-tone={stageTone(v)} style={{ background: s.bg, color: s.fg }}>{stageLabel(v)}</span>
  );
}

/** What the agent waits for and what happens next, in one sentence (bold first part). Waiting states use the clock. */
export function stageSentence(v: LeadStageView, name: string): { wait: string; next: string; icon: IconName } {
  const k = (key: string) => t(`lead.stage.${key}` as MessageKey, { name, missing: v.missing.join(", "), objection: v.objection ?? "", max: v.questionBudget ?? 3 });
  if (v.human) return { wait: k("human.wait"), next: k("human.next"), icon: "user" };
  if (v.closed && !v.paid) return { wait: k("after.closed_wait"), next: k("after.closed_next"), icon: "x-circle" };
  if (v.objection) return { wait: k("objection.wait"), next: k("objection.next"), icon: "alert-triangle" };
  // The stepper stays on Order form until paid (lib/leads/stage.ts); the sentence follows the agent's stage.
  switch (v.stage === "after" ? "after" : v.step) {
    case "open": return { wait: k("open.wait"), next: k("open.next"), icon: "clock" };
    case "understand": return { wait: k("understand.wait"), next: v.missing.length ? k("understand.next_missing") : k("understand.next"), icon: "clock" };
    case "recommend": return { wait: k("recommend.wait"), next: k("recommend.next"), icon: "clock" };
    case "quote": return v.awaitingApproval
      ? { wait: k("quote.approval_wait"), next: k("quote.approval_next"), icon: "clock" }
      : { wait: k("quote.wait"), next: k("quote.next"), icon: "clock" };
    case "order_form": return { wait: k(v.backAfterChange ? "order_form.back_wait" : "order_form.wait"), next: k("order_form.next"), icon: "clock" };
    case "after":
      if (v.paid) return { wait: k("after.paid_wait"), next: k("after.paid_next"), icon: "check-circle" };
      if (v.closed) return { wait: k("after.closed_wait"), next: k("after.closed_next"), icon: "check-circle" };
      if (v.signed) return { wait: k("after.signed_wait"), next: k("after.signed_next"), icon: "clock" };
      return { wait: k("after.wait"), next: k("after.next"), icon: "clock" };
  }
}

/** The paid order in the stage banner: "Order PD-10001 paid · ₪1,770.00 + ₪106.20/month." */
export type PaidOrder = { label: string; amount: string };

/** The stepper and the sentence. `v` null: no conversation yet. `paidOrder`: the lead's paid order, for the banner. */
export function StageStepper({ v, name, paidOrder, handoffWhy, handoffFull }: {
  v: LeadStageView | null; name: string; paidOrder?: PaidOrder | null;
  /** O35: why the lead needs a person, in one line (lib/leads/handoff-reason.ts); shown while a person handles it. */
  handoffWhy?: string | null;
  /** The whole stored hand-off reason, uncut (the lists cut it): shown under the line when the line does not already say it all. */
  handoffFull?: string | null;
}) {
  const current = v ? STAGE_STEPS.indexOf(v.step) : -1;
  const paidBanner = !!(v && paidOrder && v.paid && v.step === "after" && !v.human && !v.objection);
  // A paid deal: the green success banner, a win (S1); the Leads list chip stays neutral.
  const tone: StageTone = v ? (paidBanner ? "success" : stageTone(v)) : "now";
  const s = TONE_STYLE[tone];
  const sentence = v ? stageSentence(v, name) : null;
  return (
    <section aria-labelledby="cs-h" className="sas-stack-2" style={{ padding: "14px 16px 16px", borderBlockEnd: "1px solid var(--line)", gap: 12 }} data-testid="stage-stepper" data-stage={v?.step ?? "none"} data-stage-tone={v ? tone : "none"}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "2px 10px" }}>
        <h2 id="cs-h" className="sas-heading" style={{ margin: 0 }}>{t("lead.stage.title")}</h2>
        <span className="sas-small">{t("lead.stage.hint")}</span>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(84px, 1fr))", gap: "10px 6px" }}>
        {STAGE_STEPS.map((step, i) => {
          const done = v && i < current && !(step === "recommend" && v.skippedRecommend);
          const now = i === current;
          const bar = now ? s.fg : done ? "color-mix(in srgb, var(--primary) 45%, var(--surface-raised))" : "var(--line)";
          return (
            <li
              key={step} aria-current={now ? "step" : undefined} data-step={step} data-state={now ? "current" : done ? "done" : "upcoming"}
              style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, lineHeight: "18px", minWidth: 0, color: now ? s.fg : done ? "var(--ink)" : "var(--ink-muted)", fontWeight: now ? 700 : 400 }}
            >
              <i aria-hidden="true" style={{ height: 6, borderRadius: 3, background: bar, display: "block" }} />
              <span style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                {done ? <Icon name="check" /> : null}
                {t(STEP_LABEL[step])}
                {done ? <span className="sas-sr"> ({t("lead.stage.done")})</span> : null}
                {!done && v && i < current ? <span className="sas-sr"> ({t("lead.stage.skipped")})</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {v && sentence ? (
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: s.bg, overflowWrap: "anywhere" }} data-testid="stage-sentence">
          <span style={{ color: s.fg, display: "inline-flex", paddingBlockStart: 2 }}><Icon name={sentence.icon} /></span>
          {paidBanner && paidOrder ? (
            <span data-testid="stage-paid"><strong><TextWithId text={t("lead.stage.after.paid_order", { order: paidOrder.label })} id={paidOrder.label} /></strong> · <span className="sas-num">{paidOrder.amount}</span>. {sentence.next}</span>
          ) : (
            <span style={{ minWidth: 0, flex: "1 1 auto" }}>
              {v.human || v.objection || v.closed || (v.step === "after" && v.paid) ? <><strong>{stageLabel(v)}.</strong>{" "}</> : null}
              <strong>{sentence.wait}</strong> {sentence.next}
              {v.human && handoffWhy ? <span className="sas-oneline" data-handoff-why="" dir="auto" title={handoffWhy}>{handoffWhy}</span> : null}
              {v.human && handoffFull && handoffFull !== handoffWhy ? <span className="sas-small" style={{ display: "block", overflowWrap: "anywhere" }} data-handoff-full="" dir="auto">{handoffFull}</span> : null}
            </span>
          )}
        </div>
      ) : (
        <span className="sas-small">{t("lead.stage.none")}</span>
      )}
    </section>
  );
}
