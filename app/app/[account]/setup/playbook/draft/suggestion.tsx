/**
 * One playbook suggestion: its text, the Hebrew version when offered, the
 * evidence line (links to the source sections) and Accept / Edit / Remove.
 * Shared by the playbook draft page and a call's "Suggested from this call"
 * panel. Server component.
 */
import { Icon } from "@/components/sas/icon";
import { buttonClass, StatusPill } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import type { EvidenceLink, Suggestion } from "@/lib/pipeline/service";
import { decideSuggestionAction, editSuggestionAction } from "./actions";

const STAGE_KEY: Record<string, MessageKey> = {
  before_quote: "playbook.stage.before_quote", before_order_form: "playbook.stage.before_order_form", optional: "playbook.stage.optional",
};

/** The main line and the line under it. */
export function suggestionText(s: Suggestion): { title: string; sub: string | null; he: string | null } {
  const p = s.payload;
  switch (p.kind) {
    case "goal": case "tone": return { title: p.text, sub: null, he: p.textHe || null };
    case "field": return { title: p.label, sub: [t(STAGE_KEY[p.stage] ?? "playbook.stage.optional"), p.example ? `"${p.example}"` : null].filter(Boolean).join(" · "), he: p.exampleHe || p.labelHe || null };
    case "discovery_question": return { title: `"${p.question}"`, sub: p.label, he: p.questionHe || null };
    case "objection": return { title: `"${p.objection}"`, sub: p.answer, he: [p.objectionHe, p.answerHe].filter(Boolean).join(" — ") || null };
    case "limit": return { title: t("draft.never_rule", { rule: p.rule }), sub: p.maxDiscountPercent > 0 ? t("draft.limit.discount", { pct: p.maxDiscountPercent }) : null, he: p.ruleHe || null };
    case "never": return { title: t("draft.never_rule", { rule: p.rule }), sub: null, he: p.ruleHe || null };
  }
}

/** "Asked in 9 of 12 calls · Call 05:52 · Spec.pdf p.2" */
export function EvidenceLine({ s, links, calls }: { s: Suggestion; links: Map<string, EvidenceLink>; calls: number }) {
  const p = s.payload;
  const lead: string[] = [];
  if ((p.kind === "field" || p.kind === "discovery_question") && p.askedInCalls > 0) lead.push(t("draft.asked_in", { n: p.askedInCalls, of: Math.max(calls, p.askedInCalls) }));
  if (p.kind === "objection" && p.outcome) lead.push(p.outcome);
  const ev = s.evidence.slice(0, 3);
  return (
    <span className="sas-small" style={{ overflowWrap: "anywhere" }}>
      {lead.join(" · ")}
      {ev.map((e, i) => {
        const l = links.get(`${e.sourceId}|${e.locator}`);
        return (
          <span key={`${e.sourceId}-${e.locator}`}>
            {lead.length || i ? " · " : ""}
            {l ? <a href={l.href} title={e.quote}>{l.kind === "call" ? e.locator : `${l.title} ${e.locator}`}</a> : <span title={e.quote}>{e.locator}</span>}
          </span>
        );
      })}
    </span>
  );
}

type ItemProps = { s: Suggestion; slug: string; back: string; editing: boolean; links: Map<string, EvidenceLink>; calls: number; editHref: string; cancelHref: string };

const hidden = (slug: string, back: string, id: string) => (
  <>
    <input type="hidden" name="slug" value={slug} />
    <input type="hidden" name="back" value={back} />
    <input type="hidden" name="id" value={id} />
  </>
);

function EditForm({ s, slug, back, cancelHref }: Pick<ItemProps, "s" | "slug" | "back" | "cancelHref">) {
  const p = s.payload as unknown as Record<string, unknown>;
  const field = (name: string, label: MessageKey, max: number, area = false) => (
    <div className="sas-input-group" key={name}>
      <label className="sas-input-label" htmlFor={`sg-e-${s.id}-${name}`}>{t(label)}</label>
      {area
        ? <textarea className="sas-textarea" id={`sg-e-${s.id}-${name}`} name={name} rows={3} maxLength={max} defaultValue={String(p[name] ?? "")} dir="auto" />
        : <input className="sas-input" id={`sg-e-${s.id}-${name}`} name={name} maxLength={max} defaultValue={String(p[name] ?? "")} dir="auto" />}
    </div>
  );
  return (
    <form action={editSuggestionAction} className="sas-stack-4" aria-label={t("draft.edit")}>
      {hidden(slug, back, s.id)}
      <input type="hidden" name="kind" value={s.kind} />
      {s.payload.kind === "goal" ? field("text", "draft.f.goal", 1000, true) : null}
      {s.payload.kind === "tone" ? field("text", "draft.f.tone", 300) : null}
      {s.payload.kind === "field" ? (
        <>
          {field("label", "draft.f.label", 60)}
          {field("example", "draft.f.example", 200)}
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor={`sg-e-${s.id}-stage`}>{t("draft.f.stage")}</label>
            <select className="sas-select" id={`sg-e-${s.id}-stage`} name="stage" defaultValue={s.payload.stage}>
              {Object.entries(STAGE_KEY).map(([v, k]) => <option key={v} value={v}>{t(k)}</option>)}
            </select>
          </div>
        </>
      ) : null}
      {s.payload.kind === "discovery_question" ? <>{field("label", "draft.f.label", 60)}{field("question", "draft.f.question", 200)}</> : null}
      {s.payload.kind === "objection" ? <>{field("objection", "draft.f.objection", 200)}{field("answer", "draft.f.answer", 600, true)}</> : null}
      {s.payload.kind === "limit" || s.payload.kind === "never" ? field("rule", "draft.f.rule", 200) : null}
      {s.payload.kind === "limit" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor={`sg-e-${s.id}-pct`}>{t("draft.f.discount")}</label>
          <input className="sas-input sas-num" id={`sg-e-${s.id}-pct`} name="maxDiscountPercent" type="number" min={0} max={50} step="0.1" defaultValue={String(s.payload.maxDiscountPercent || "")} style={{ maxWidth: 140 }} aria-describedby={`sg-e-${s.id}-pct-h`} />
          <span className="sas-hint" id={`sg-e-${s.id}-pct-h`}>{t("draft.f.discount_hint")}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className={buttonClass("primary", "sm")}>{s.kind === "limit" ? t("draft.approve_rule") : t("draft.save_accept")}</button>
        <a className={buttonClass("ghost", "sm")} href={cancelHref}>{t("draft.cancel")}</a>
      </div>
    </form>
  );
}

/** One suggestion row: text, status, evidence and actions. Limits use the warning style and "Approve rule". */
export function SuggestionItem({ s, slug, back, editing, links, calls, editHref, cancelHref }: ItemProps) {
  const { title, sub, he } = suggestionText(s);
  const decided = s.status === "accepted" || s.status === "edited";
  const limit = s.kind === "limit";
  const decide = (status: "accepted" | "rejected" | "suggested", label: string, variant: "secondary" | "ghost") => (
    <form action={decideSuggestionAction}>
      {hidden(slug, back, s.id)}
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={buttonClass(variant, "sm")} aria-label={`${label}: ${title.slice(0, 60)}`}>{label}</button>
    </form>
  );
  return (
    <li style={{ padding: "12px 20px", background: limit && !decided ? "var(--warning-soft)" : undefined }} className="sas-stack-2">
      {editing ? <EditForm s={s} slug={slug} back={back} cancelHref={cancelHref} /> : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
          <span style={{ flex: "1 1 280px", minWidth: 0, overflowWrap: "anywhere" }}>
            <strong dir="auto">{title}</strong>{" "}
            <StatusPill object="generated_suggestion" state={decided ? "accepted" : s.status === "rejected" ? "rejected" : "suggested"} />
            {s.status === "edited" ? <span className="sas-small"> · {t("draft.edited")}</span> : null}
            {sub ? <span className="sas-small" style={{ display: "block" }} dir="auto">{sub}</span> : null}
            {he ? <span className="sas-small" style={{ display: "block" }}><span>{t("draft.hebrew")}: </span><span lang="he" dir="rtl">{he}</span></span> : null}
            {limit && !decided ? <span className="sas-small" style={{ display: "block", color: "var(--ink)" }}><Icon name="alert-triangle" /> {t("draft.limit.warning")}</span> : null}
          </span>
          <span style={{ flex: "1 1 200px", minWidth: 0 }}><EvidenceLine s={s} links={links} calls={calls} /></span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {s.status === "suggested" ? decide("accepted", limit ? t("draft.approve_rule") : t("draft.accept"), "secondary") : null}
            {s.status !== "rejected" ? <a className={buttonClass("ghost", "sm")} href={editHref} aria-label={`${t("draft.edit")}: ${title.slice(0, 60)}`}>{t("draft.edit")}</a> : null}
            {s.status !== "rejected" ? decide("rejected", t("draft.remove"), "ghost") : decide("suggested", t("draft.undo"), "ghost")}
          </span>
        </div>
      )}
    </li>
  );
}
