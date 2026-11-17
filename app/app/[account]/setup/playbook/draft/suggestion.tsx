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
import type { LimitPreview } from "@/lib/pipeline/limits";
import { DEFAULT_PLAYS } from "@/lib/agent/core/plays";
import { APPLIED_ON_APPROVAL } from "@/lib/pipeline/service";
import { limitSetting, openerPayloadTopics } from "@/lib/pipeline/validate";
import { VALUE_LINE_INPUT_MAX } from "@/lib/catalog/rules";
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
    case "limit": return { title: p.rule, sub: null, he: p.ruleHe || null };
    case "never": return { title: t("draft.never_rule", { rule: p.rule }), sub: null, he: p.ruleHe || null };
    case "opener": {
      const topics = openerPayloadTopics(p);
      return {
        title: topics.length ? t("draft.opener.topics") : t("draft.f.opening_question"),
        sub: topics.length ? topics.map((x) => x.en).join(" · ") : `"${p.openingQuestion}"`,
        he: [topics.map((x) => x.he).filter(Boolean).join(" · "), p.openingQuestionHe ?? ""].filter(Boolean).join(" — ") || null,
      };
    }
    case "play_content": return { title: p.content, sub: null, he: null };
    case "play_card": return {
      title: t("draft.play.own_card", { play: DEFAULT_PLAYS[p.play]?.title ?? p.play }),
      sub: [p.when, p.do.map((m, i) => `${i + 1}. ${m}`).join(" "), `"${p.example}"`, t("draft.play.not_this", { text: p.notThis })].join(" · "), he: null,
    };
    case "catalog_item": return {
      title: p.plainName ? t("draft.catalog.names", { sku: p.sku, name: p.plainName }) : p.sku,
      sub: p.valueLine ? t("draft.catalog.value", { text: p.valueLine }) : null, he: null,
    };
  }
}

/**
 * Where a suggested own card came from when no call backs it (board
 * DraftPlays: cards normally come from the calls): "From your documents",
 * "From your website", both, or "From your sources". Null when a call is among
 * its evidence (the evidence line says which).
 */
export function cardOrigin(s: Pick<Suggestion, "evidence">, links: Map<string, EvidenceLink>): MessageKey | null {
  const kinds = new Set(s.evidence.map((e) => links.get(`${e.sourceId}|${e.locator}`)?.kind ?? "unknown"));
  if (kinds.has("call")) return null;
  const docs = kinds.has("file") || kinds.has("text");
  const site = kinds.has("website");
  return docs && site ? "draft.play.from_docs_website" : docs ? "draft.play.from_docs" : site ? "draft.play.from_website" : "draft.play.from_sources";
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

type ItemProps = {
  s: Suggestion; slug: string; back: string; editing: boolean; links: Map<string, EvidenceLink>; calls: number; editHref: string; cancelHref: string;
  /** Limits: what approving changes. */
  limit?: LimitPreview;
};

const SETTING_LABEL: Record<string, MessageKey> = {
  discount: "draft.limit.setting.discount", custom_pricing: "draft.limit.setting.custom_pricing",
  offer_meeting: "draft.limit.setting.offer_meeting", hand_off: "draft.limit.setting.hand_off",
};

/** "Updates setting: Discount without approval: 5% → 7%" or "Approved exception, needs approval per quote". */
export function LimitNote({ preview, applied }: { preview: LimitPreview; applied: boolean }) {
  if (preview.kind === "exception") {
    return <span className="sas-small" style={{ display: "block", color: "var(--ink)" }}>{applied ? t("draft.limit.exception_applied") : t("draft.limit.exception")}</span>;
  }
  const label = t(SETTING_LABEL[preview.setting], { sku: preview.sku ?? "", list: preview.listName ?? "" });
  // Numbers read best in the numeric font; conditions are sentences.
  const num = preview.setting === "discount" || preview.setting === "custom_pricing" ? "sas-num" : undefined;
  return (
    <span className="sas-small" style={{ display: "block", color: "var(--ink)", overflowWrap: "anywhere" }}>
      {/* Once applied, "before" is today's value: show only the setting as it is now. */}
      {applied
        ? <>{t("draft.limit.updated")} {label}: <strong className={num}>{preview.after}</strong></>
        : <>{t("draft.limit.updates")} {label}: <span className={num}>{preview.before}</span> → <strong className={num}>{preview.after}</strong></>}
    </span>
  );
}

const hidden = (slug: string, back: string, id: string) => (
  <>
    <input type="hidden" name="slug" value={slug} />
    <input type="hidden" name="back" value={back} />
    <input type="hidden" name="id" value={id} />
  </>
);

function EditForm({ s, slug, back, cancelHref, limit }: Pick<ItemProps, "s" | "slug" | "back" | "cancelHref" | "limit">) {
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
      {s.payload.kind === "never" ? field("rule", "draft.f.rule", 200) : null}
      {s.payload.kind === "opener" ? (
        <>
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor={`sg-e-${s.id}-topics`}>{t("draft.f.topics")}</label>
            <textarea className="sas-textarea" id={`sg-e-${s.id}-topics`} name="topics" rows={4} maxLength={6 * 121} defaultValue={openerPayloadTopics(s.payload).map((x) => x.en).join("\n")} aria-describedby={`sg-e-${s.id}-topics-h`} />
            <span className="sas-hint" id={`sg-e-${s.id}-topics-h`}>{t("draft.f.topics_hint")}</span>
          </div>
          {field("openingQuestion", "draft.f.opening_question", 200)}
          {field("openingQuestionHe", "draft.f.opening_question_he", 200)}
        </>
      ) : null}
      {s.payload.kind === "play_content" ? field("content", "draft.f.play_content", 600, true) : null}
      {s.payload.kind === "play_card" ? (
        <>
          {field("when", "draft.f.play_when", 200)}
          <div className="sas-input-group">
            <label className="sas-input-label" htmlFor={`sg-e-${s.id}-do`}>{t("draft.f.play_do")}</label>
            <textarea className="sas-textarea" id={`sg-e-${s.id}-do`} name="do" rows={4} maxLength={1100} defaultValue={s.payload.do.join("\n")} aria-describedby={`sg-e-${s.id}-do-h`} />
            <span className="sas-hint" id={`sg-e-${s.id}-do-h`}>{t("playbook.play.do_hint")}</span>
          </div>
          {field("example", "draft.f.play_example", 300, true)}
          {field("notThis", "draft.f.play_not_this", 300, true)}
        </>
      ) : null}
      {s.payload.kind === "catalog_item" ? <>{field("plainName", "catalog.edit.plain_name", 60)}{field("valueLine", "catalog.edit.value_line", VALUE_LINE_INPUT_MAX, true)}</> : null}
      {s.payload.kind === "limit" ? field("rule", "draft.f.limit_rule", 200) : null}
      {s.payload.kind === "limit" && limitSetting(s.payload) === "discount" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor={`sg-e-${s.id}-pct`}>{t("draft.f.discount")}</label>
          <input className="sas-input sas-num" id={`sg-e-${s.id}-pct`} name="maxDiscountPercent" type="number" min={0.1} max={50} step="0.1" required defaultValue={String(s.payload.maxDiscountPercent || "")} style={{ maxWidth: 140 }} aria-describedby={`sg-e-${s.id}-pct-h`} />
          <span className="sas-hint" id={`sg-e-${s.id}-pct-h`}>{t("draft.f.discount_hint")}</span>
        </div>
      ) : null}
      {s.payload.kind === "limit" && limit?.kind === "setting" && limit.setting === "custom_pricing" ? (
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor={`sg-e-${s.id}-qty`}>{t("draft.f.qty", { sku: limit.sku ?? "" })}</label>
          <input className="sas-input sas-num" id={`sg-e-${s.id}-qty`} name="qty" type="number" min={1} max={100000} step={1} required defaultValue={String(s.payload.qty ?? "")} style={{ maxWidth: 140 }} />
        </div>
      ) : null}
      {s.payload.kind === "limit" && (limitSetting(s.payload) === "offer_meeting" || limitSetting(s.payload) === "hand_off") ? field("when", "draft.f.when", 300) : null}
      {s.payload.kind === "limit" && limit ? <LimitNote preview={limit} applied={false} /> : null}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" className={buttonClass("primary", "sm")}>{s.kind === "limit" ? t("draft.approve_rule") : s.kind === "catalog_item" ? t("draft.catalog.save_apply") : t("draft.save_accept")}</button>
        <a className={buttonClass("ghost", "sm")} href={cancelHref}>{t("draft.cancel")}</a>
      </div>
    </form>
  );
}

/** One suggestion row: text, status, evidence and actions. Limits use the warning style and "Approve rule". */
export function SuggestionItem({ s, slug, back, editing, links, calls, editHref, cancelHref, limit: preview }: ItemProps) {
  const { title, sub, he } = suggestionText(s);
  const decided = s.status === "accepted" || s.status === "edited";
  const limit = s.kind === "limit";
  // Limits and catalog item texts are applied on approval and final here.
  const final = APPLIED_ON_APPROVAL.has(s.kind);
  const decide = (status: "accepted" | "rejected" | "suggested", label: string, variant: "secondary" | "ghost") => (
    <form action={decideSuggestionAction}>
      {hidden(slug, back, s.id)}
      <input type="hidden" name="status" value={status} />
      <button type="submit" className={buttonClass(variant, "sm")} aria-label={`${label}: ${title.slice(0, 60)}`}>{label}</button>
    </form>
  );
  const p = s.payload;
  const pill = <StatusPill object="generated_suggestion" state={decided ? "accepted" : s.status === "rejected" ? "rejected" : "suggested"} />;
  // A suggested own card (canvas: DraftPlays): the default next to the suggested card, with its own three actions.
  if (p.kind === "play_card" && !editing) {
    const d = DEFAULT_PLAYS[p.play];
    const playHref = `/app/${slug}/setup/playbook/plays/${p.play}`;
    const origin = cardOrigin(s, links);
    return (
      <li style={{ padding: "14px 20px", background: s.status === "suggested" ? "var(--agent-soft)" : undefined }} className="sas-stack-2" data-suggestion="play_card">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "flex-start" }}>
          <div className="sas-stack-2" style={{ flex: "999 1 420px", minWidth: 0, gap: 4 }}>
            <span className="sas-small">{t("draft.play.kicker_card", { play: d?.title ?? p.play })}</span>
            <span><strong>{t("draft.play.suggested_card")}</strong> {pill}{s.status === "edited" ? <span className="sas-small"> · {t("draft.edited")}</span> : null}</span>
            <span className="sas-small" style={{ color: "var(--ink)" }}>{t("draft.play.replaces")}</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12, marginTop: 8, alignItems: "start" }}>
              <div className="sas-stack-2" style={{ gap: 6, padding: 12, borderRadius: 10, background: "var(--surface-raised)", border: "1px solid var(--line)", fontSize: 13, lineHeight: "18px", minWidth: 0 }}>
                <span className="sas-label">{t("playbook.play.default_card")}</span>
                <span style={{ overflowWrap: "anywhere" }}>{d ? d.do.join(" → ") : ""}</span>
                <a href={playHref} style={{ fontSize: 12 }}>{t("draft.play.open_default")}</a>
              </div>
              <div className="sas-stack-2" style={{ gap: 6, padding: 12, borderRadius: 10, background: "var(--surface-raised)", border: "1px dashed var(--agent)", fontSize: 13, lineHeight: "18px", minWidth: 0, overflowWrap: "anywhere" }}>
                <span className="sas-label" style={{ color: "var(--agent)" }}>{t("draft.play.suggested_card")}</span>
                <span><strong>{t("playbook.play.when")}:</strong> {p.when}</span>
                <span><strong>{t("playbook.play.do")}:</strong></span>
                <ol style={{ margin: 0, paddingInlineStart: 18 }}>{p.do.map((m, i) => <li key={i}>{m}</li>)}</ol>
                <span><strong>{t("playbook.play.example")}:</strong></span>
                <span style={{ padding: "6px 10px", borderRadius: 8, background: "var(--agent-soft)" }}>{p.example}</span>
                <span><strong>{t("playbook.play.not_this")}:</strong> &ldquo;{p.notThis}&rdquo;</span>
              </div>
            </div>
            <span style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {s.status === "suggested" ? (
                <>
                  <form action={decideSuggestionAction}>
                    {hidden(slug, back, s.id)}
                    <input type="hidden" name="status" value="accepted" />
                    <button type="submit" className={buttonClass("primary", "sm")}>{t("draft.play.use_as_own")}</button>
                  </form>
                  <a className={buttonClass("secondary", "sm")} href={`${playHref}?from=${s.id}`}>{t("draft.play.edit_first")}</a>
                  {decide("rejected", t("draft.play.keep_default"), "ghost")}
                </>
              ) : s.status === "rejected" ? decide("suggested", t("draft.undo"), "ghost") : (
                <>
                  <a className={buttonClass("ghost", "sm")} href={editHref}>{t("draft.edit")}</a>
                  {decide("rejected", t("draft.play.keep_default"), "ghost")}
                </>
              )}
            </span>
          </div>
          <span className="sas-stack-2" style={{ flex: "1 1 180px", minWidth: 0, gap: 2 }}>
            {origin ? <span className="sas-small" style={{ color: "var(--ink)" }} data-card-origin="">{t(origin)}</span> : null}
            <EvidenceLine s={s} links={links} calls={calls} />
          </span>
        </div>
      </li>
    );
  }
  return (
    <li style={{ padding: "12px 20px", background: limit && !decided ? "var(--warning-soft)" : undefined }} className="sas-stack-2" data-suggestion={p.kind}>
      {editing && !(final && decided) ? <EditForm s={s} slug={slug} back={back} cancelHref={cancelHref} limit={preview} /> : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
          <span style={{ flex: "1 1 280px", minWidth: 0, overflowWrap: "anywhere" }}>
            {p.kind === "play_content" ? <span className="sas-small" style={{ display: "block" }}>{t("draft.play.kicker_fact", { play: DEFAULT_PLAYS[p.play]?.title ?? p.play })}</span> : null}
            <strong dir="auto">{title}</strong>{" "}
            {pill}
            {s.status === "edited" ? <span className="sas-small"> · {t("draft.edited")}</span> : null}
            {sub ? <span className="sas-small" style={{ display: "block" }} dir="auto">{sub}</span> : null}
            {p.kind === "opener" && p.openingQuestion && openerPayloadTopics(p).length ? (
              <span style={{ display: "block", marginBlockStart: 6 }}>
                <strong>{t("draft.f.opening_question")}</strong>
                <span className="sas-small" style={{ display: "block" }}>&ldquo;{p.openingQuestion}&rdquo;</span>
              </span>
            ) : null}
            {he ? <span className="sas-small" style={{ display: "block" }}><span>{t("draft.hebrew")}: </span><span lang="he" dir="rtl">{he}</span></span> : null}
            {limit && preview ? <LimitNote preview={preview} applied={decided} /> : null}
            {limit && !decided ? <span className="sas-small" style={{ display: "block", color: "var(--ink)" }}><Icon name="alert-triangle" /> {t("draft.limit.warning")}</span> : null}
          </span>
          <span style={{ flex: "1 1 200px", minWidth: 0 }}><EvidenceLine s={s} links={links} calls={calls} /></span>
          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {s.status === "suggested" ? decide("accepted", limit ? t("draft.approve_rule") : t("draft.accept"), "secondary") : null}
            {s.kind === "catalog_item" && decided ? (
              <a className="sas-small" href={`/app/${slug}/setup/catalog`} data-applied="catalog">{t("draft.catalog.change_in_catalog")}</a>
            ) : limit && decided ? (
              preview?.kind === "setting" && preview.setting === "custom_pricing"
                ? <a className="sas-small" href={`/app/${slug}/setup/price-lists`} data-limit-lives="price_list">{t("draft.limit.change_in_price_list", { name: preview.listName ?? "" })}</a>
                : <a className="sas-small" href={`/app/${slug}/setup/playbook#pb-lim-h`} data-limit-lives="playbook">{t("draft.limit.change_in_playbook")}</a>
            ) : (
              <>
                {s.status !== "rejected" ? <a className={buttonClass("ghost", "sm")} href={editHref} aria-label={`${t("draft.edit")}: ${title.slice(0, 60)}`}>{t("draft.edit")}</a> : null}
                {s.status !== "rejected" ? decide("rejected", t("draft.remove"), "ghost") : decide("suggested", t("draft.undo"), "ghost")}
              </>
            )}
          </span>
        </div>
      )}
    </li>
  );
}
