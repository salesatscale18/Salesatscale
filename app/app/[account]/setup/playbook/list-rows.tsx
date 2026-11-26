"use client";

import { useRef, useState, type ReactNode } from "react";
import type { Playbook, PlaybookField } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import { MAX_OPENER_TOPICS, readOpener } from "@/lib/agent/core/opener";
import { QUESTION_BUDGET, QUESTION_CEILING, questionBudgetOf } from "@/lib/agent/core/stage";
import { MAX_OBJECTION_ATTEMPTS, MIN_OBJECTION_ATTEMPTS, objectionAttemptsOf } from "@/lib/agent/core/objections";
import type { ListKey, PlaybookChange } from "@/lib/agent/playbook-save";
import { isOrderFormField, type PlaybookPart } from "@/lib/agent/playbook-parts";
import { AddRow, EditRow, OtherErrors, PartRows, useRowSave, useRows, type ErrorOf, type RowRefusal } from "./row";
import { SortHelp, moved, useSortable } from "./sortable";
import { usePreview } from "./preview";
import { focusAfterDelete } from "./focus";
import { InfoTip } from "@/components/sas/info-tip";
import { enterSaves, growProps } from "./parts";
import "./playbook.css";

/** `edit`: the row opened first (from `?edit=`). */
type Base = { slug: string; hrefs: Record<PlaybookPart, string>; edit?: string | null };

/** Limits mirrored from lib/agent/playbook.ts (the server checks them again). */
const TOPIC_MAX = 120;
const QUESTION_MAX = 200;

const val = (form: FormData, name: string) => String(form.get(name) ?? "");
function Err({ id, msg }: { id: string; msg?: string }) {
  return msg ? <span className="sas-error" id={`${id}-error`}>{msg}</span> : null;
}
const aria = (id: string, msg?: string) => ({ "aria-invalid": msg ? (true as const) : undefined, "aria-describedby": msg ? `${id}-error` : undefined });

/** Stable row keys from the rows' content (a repeated text gets #2, #3): a row keeps its element when it moves. */
export function rowKeys(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((x) => {
    const n = (seen.get(x) ?? 0) + 1;
    seen.set(x, n);
    return n === 1 ? x : `${x}#${n}`;
  });
}

// ---------------------------------------------------------------------------
// Moves (drag or ↑ / ↓): ONE `move` change, shown in the new order while it saves
// ---------------------------------------------------------------------------

/**
 * A sortable list's moves. `rows` are the list's rows as saved; `serverIndex`
 * maps a row's place in this list to its index in the stored list (questions:
 * the two groups share one list). While the move saves the rows show in the
 * new order; a refusal puts them back and the error shows at the moved row.
 */
function useMoves<T>({ rows, keys, list, serverIndex, what, helpId }: {
  rows: readonly T[]; keys: readonly string[]; list: ListKey; serverIndex: (i: number) => number; what: (row: T) => string; helpId: string;
}) {
  const rowsCtx = useRows();
  const sig = keys.join("\n");
  const [optimistic, setOptimistic] = useState<{ sig: string; order: number[] } | null>(null);
  const [movedKey, setMovedKey] = useState<string | null>(null);
  const save = useRowSave(() => {}, () => setOptimistic(null));
  const order = optimistic && optimistic.sig === sig ? optimistic.order : rows.map((_, i) => i);
  const shown = order.map((i) => rows[i]);
  const sort = useSortable({
    count: rows.length, busy: save.pending || rowsCtx.open !== null, helpId,
    what: (i) => what(shown[i]),
    onMove: (from, to) => {
      const change: PlaybookChange = { kind: "move", list, index: serverIndex(order[from]), to: serverIndex(order[to]) };
      setMovedKey(keys[order[from]]);
      setOptimistic({ sig, order: moved(order, from, to) });
      save.run(change);
    },
  });
  /** The pending line or the refusal, under the moved row. */
  const status = (key: string): ReactNode => {
    if (key !== movedKey) return null;
    if (save.pending) return <span className="sas-small pb-pending" role="status">{t("playbook.sort.saving")}</span>;
    return save.errors ? <OtherErrors errors={save.errors} own={[]} /> : null;
  };
  return { order, shown, sort, status, pending: save.pending };
}

/** The drag handle (six dots): pointer drag, or ↑ / ↓ on the keyboard. */
function Handle(props: ReturnType<ReturnType<typeof useSortable>["handleProps"]>) {
  return <button {...props}><span className="pb-handle__dots" aria-hidden="true" /></button>;
}

/**
 * One list item: its edit row, a delete icon and other one-click changes
 * (Make default), with their pending state and refusal at the row.
 */
function ListItem({ id, what, read, editor, toChange, own, remove, lead, aside, command, status, rowAttrs, nextFocus }: {
  id: string; what: string; read: ReactNode; editor: (e: ErrorOf) => ReactNode; toChange: (form: FormData) => PlaybookChange | null; own: readonly string[];
  remove: PlaybookChange; lead?: ReactNode; aside?: ReactNode;
  /** A one-click change in the read state (Make default). */
  command?: { change: PlaybookChange; label: string; ariaLabel: string };
  status?: ReactNode;
  rowAttrs?: Record<string, string | number | undefined>;
  /** Where focus goes after a delete (focus.ts focusAfterDelete): the next row's edit control, else the previous one's, else the Add button. */
  nextFocus: string;
}) {
  const rows = useRows();
  const lastRun = useRef<"remove" | "command" | null>(null);
  const save = useRowSave(() => rows.focusTo(lastRun.current === "remove" ? nextFocus : id));
  return (
    <EditRow
      id={id} label={what} item={{ what }} read={read} editor={editor} toChange={toChange} own={own} lead={lead} rowAttrs={rowAttrs}
      aside={(
        <>
          {aside}
          {command ? <button type="button" className="pb-link" disabled={save.pending} aria-label={command.ariaLabel} onClick={() => { lastRun.current = "command"; save.run(command.change); }} data-command="">{command.label}</button> : null}
        </>
      )}
      extra={(
        <button type="button" className="pb-icon-btn" disabled={save.pending} aria-label={t("playbook.row.remove", { what })} title={t("playbook.row.remove_short")} onClick={() => { lastRun.current = "remove"; save.run(remove); }} data-remove="">
          <Icon name={save.pending ? "loader" : "trash"} />
        </button>
      )}
      after={save.pending || save.errors || status ? (
        <>
          {status}
          {save.pending ? <span className="sas-small pb-pending" role="status">{t("playbook.saving")}</span> : null}
          {save.errors ? <OtherErrors errors={save.errors} own={[]} /> : null}
        </>
      ) : null}
    />
  );
}

/**
 * A − n + stepper that saves on each change like a row (one `set` change),
 * with its pending state and the refusal at the stepper.
 */
function SavedStepper({ id, field, label, info, infoWide, value, min, max, fewer, more, testId }: {
  id: string; field: "questionBudget" | "objectionAttempts"; label: MessageKey;
  /** The stepper's explanation, behind the (i) after its label (also its group's description). */
  info: ReactNode; infoWide?: boolean; value: number; min: number; max: number;
  fewer: MessageKey; more: MessageKey; testId: string;
}) {
  const [shown, setShown] = useState<{ saved: number; n: number } | null>(null);
  const save = useRowSave(() => {}, () => setShown(null));
  const n = shown && shown.saved === value ? shown.n : value;
  const go = (next: number) => {
    if (next === n || next < min || next > max) return;
    setShown({ saved: value, n: next });
    save.run({ kind: "set", values: { [field]: String(next) } });
  };
  const own = save.errors?.[field];
  return (
    <div className="pb-row pb-row--stepper" data-testid={testId} data-row={field} aria-busy={save.pending || undefined} data-info-scope="">
      <div className="sas-stack-2" style={{ flex: "1 1 260px", gap: 2, minWidth: 0 }}>
        <span className="pb-stepper__label"><span id={`${id}-label`}>{t(label)}</span><InfoTip label={t(label)} wide={infoWide} popoverId={`${id}-hint`}>{info}</InfoTip></span>
        {own ? <span className="sas-error" id={`${id}-error`} role="alert">{own}</span> : null}
        {save.errors ? <OtherErrors errors={save.errors} own={[field]} /> : null}
      </div>
      <span role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="pb-stepper" data-info-avoid="" data-testid={testId === "question-budget" ? "budget-stepper" : "attempts-stepper"}>
        <button type="button" onClick={() => go(n - 1)} disabled={n <= min || save.pending} aria-label={t(fewer)}><Icon name="minus" /></button>
        <output id={id} aria-live="polite" aria-labelledby={`${id}-label`} data-value={n}>{n}</output>
        <button type="button" onClick={() => go(n + 1)} disabled={n >= max || save.pending} aria-label={t(more)}><Icon name="plus" /></button>
      </span>
      {save.pending ? <span className="sas-small pb-pending" role="status">{t("playbook.saving")}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Opening (board PlaybookOpening2)
// ---------------------------------------------------------------------------

/** A topic in English and Hebrew. `at`: the inputs' id; `errAt`: its error keys (`opener.topic.<i>`). */
function TopicEditor({ at, errAt, en, he, e }: { at: string; errAt: string; en: string; he: string; e: ErrorOf }) {
  return (
    <>
      {(["en", "he"] as const).map((l) => (
        <span key={l} className="sas-stack-2" style={{ gap: 4, width: "100%" }}>
          <label className="sas-input-label" htmlFor={`pb-${at}.${l}`}>{t(l === "he" ? "playbook.opening.hebrew" : "playbook.opening.english")}</label>
          <textarea
            className="sas-textarea pb-grow pb-fit-line" id={`pb-${at}.${l}`} name={l} rows={1} maxLength={TOPIC_MAX} lang={l} dir={l === "he" ? "rtl" : "ltr"} defaultValue={l === "he" ? he : en}
            placeholder={t(l === "he" ? "playbook.opening.he_placeholder" : "playbook.opening.topic_placeholder")} onKeyDown={enterSaves} {...growProps()} {...aria(`pb-${at}.${l}`, e(`${errAt}.${l}`))}
          />
          <Err id={`pb-${at}.${l}`} msg={e(`${errAt}.${l}`)} />
        </span>
      ))}
    </>
  );
}

/** A topic or question in both languages, read first: the English, and the Hebrew version under it when there is one. */
function TwoLanguages({ en, he }: { en: string; he: string }) {
  return (
    <span className="sas-stack-2" style={{ gap: 2 }}>
      <span dir="auto">{en || he}</span>
      {en && he ? <span className="sas-small" lang="he" dir="rtl" data-he="" style={{ alignSelf: "flex-start" }}>{he}</span> : null}
    </span>
  );
}

/**
 * Opening (board PlaybookOpening2): the topics as rows (drag or ↑ / ↓, exactly
 * one Default, Make default, change, delete, add up to 6), the first question
 * as one row and the hint that each lead page picks a topic. The preview is
 * the part's right column (preview.tsx): picking a topic's text shows its message.
 */
export function OpeningRows({ slug, hrefs, edit, p }: Base & { p: Pick<Playbook, "opener"> }) {
  const o = readOpener(p.opener);
  const topics = o.topics.map((x) => ({ en: x.en, he: x.he ?? "" }));
  const question = { en: o.question?.en ?? "", he: o.question?.he ?? "" };
  return (
    <PartRows slug={slug} part="opening" hrefs={hrefs} edit={edit}>
      <TopicList topics={topics} defaultTopic={o.defaultTopic} />
      <EditRow
        id="question" label={t("playbook.opening.first_question")} own={["opener.question"]}
        read={question.en || question.he ? <TwoLanguages en={question.en} he={question.he} /> : <span className="pb-muted">{t("playbook.not_set")}</span>}
        hint={t("playbook.opener.question_hint")}
        editor={(e) => (
          <>
            {(["en", "he"] as const).map((l) => (
              <span key={l} className="sas-stack-2" style={{ gap: 4, width: "100%" }}>
                <label className="sas-input-label" htmlFor={`pb-opener.question.${l}`}>{t(l === "he" ? "playbook.opening.question_he" : "playbook.opener.question")}</label>
                <input
                  className="sas-input pb-fit-line" id={`pb-opener.question.${l}`} name={l} maxLength={QUESTION_MAX} lang={l} dir={l === "he" ? "rtl" : "ltr"} defaultValue={question[l]}
                  {...aria(`pb-opener.question.${l}`, e(`opener.question.${l}`))}
                />
                {l === "he" ? <span className="sas-hint">{t("playbook.opening.he_hint")}</span> : null}
                <Err id={`pb-opener.question.${l}`} msg={e(`opener.question.${l}`)} />
              </span>
            ))}
          </>
        )}
        toChange={(form) => ({ kind: "set", values: {}, openerQuestion: { en: val(form, "en"), he: val(form, "he") } })}
      />
    </PartRows>
  );
}

function TopicList({ topics, defaultTopic }: { topics: { en: string; he: string }[]; defaultTopic: number }) {
  const keys = rowKeys(topics.map((x) => `${x.en}|${x.he}`));
  const name = (x: { en: string; he: string }) => x.en || x.he;
  const m = useMoves({ rows: topics, keys, list: "openerTopics", serverIndex: (i) => i, what: name, helpId: "pb-sort-help-topics" });
  const pv = usePreview();
  const shownTopic = pv.topic !== null && pv.topic < topics.length ? pv.topic : defaultTopic;
  return (
    <>
      <div className="pb-list-head">
        <span id="pb-topics-h">{t("playbook.opening.topics_head", { n: topics.length, max: MAX_OPENER_TOPICS })}</span>
        <span data-topic-hint=""><InfoTip label={t("playbook.opener.leads_ask")}>{t("playbook.opening.lead_page_hint")}</InfoTip></span>
      </div>
      {topics.length === 0 ? <div className="pb-row pb-row--wide"><span className="pb-muted">{t("playbook.opening.no_topics")}</span></div> : null}
      <SortHelp id="pb-sort-help-topics" announce={m.sort.announce} />
      <div className="pb-sortable" ref={m.sort.listRef} role="list" aria-labelledby="pb-topics-h" data-dragging={m.sort.dragging !== null ? "" : undefined}>
        {m.shown.map((x, pos) => {
          const i = m.order[pos];
          const isDefault = i === defaultTopic;
          return (
            <div key={keys[i]} role="listitem" data-sort-row="" className="pb-sortable__item">
              <ListItem
                id={`topic.${i}`} what={name(x)} own={[`opener.topic.${i}`, "opener.topics"]}
                lead={<Handle {...m.sort.handleProps(pos)} />}
                read={(
                  <button
                    type="button" className="pb-pick" aria-pressed={i === shownTopic} onClick={() => pv.setTopic(i)}
                    aria-label={t("playbook.preview.show_topic", { topic: name(x) })} data-pick-topic={i}
                  >
                    <TwoLanguages en={x.en} he={x.he} />
                  </button>
                )}
                aside={isDefault ? <span className="sas-pill sas-pill--info" data-default="">{t("playbook.opening.default")}</span> : null}
                command={isDefault ? undefined : { change: { kind: "setDefault", index: i }, label: t("playbook.opening.make_default_short"), ariaLabel: t("playbook.opening.make_default", { topic: name(x) }) }}
                editor={(e) => <TopicEditor at={`opener.topic.${i}`} errAt={`opener.topic.${i}`} en={x.en} he={x.he} e={e} />}
                toChange={(form) => ({ kind: "edit", list: "openerTopics", index: i, item: { en: val(form, "en"), he: val(form, "he") } })}
                remove={{ kind: "delete", list: "openerTopics", index: i }}
                nextFocus={focusAfterDelete(m.order, pos, (j) => `topic.${j}`, "topic.add")}
                status={m.status(keys[i])}
                rowAttrs={{ "data-topic": i, "data-is-default": isDefault ? "" : undefined }}
              />
            </div>
          );
        })}
      </div>
      <AddRow
        id="topic.add" label={t("playbook.opening.add_topic")} own={[`opener.topic.${topics.length}`, "opener.topics"]}
        disabled={topics.length >= MAX_OPENER_TOPICS} note={t("playbook.opening.topics_max", { n: MAX_OPENER_TOPICS })}
        editor={(e) => <TopicEditor at="opener.topic.new" errAt={`opener.topic.${topics.length}`} en="" he="" e={e} />}
        newId={`topic.${topics.length}`}
        toChange={(form) => (val(form, "en").trim() || val(form, "he").trim()
          ? { kind: "add", list: "openerTopics", item: { en: val(form, "en"), he: val(form, "he") } }
          : { refuse: { [`opener.topic.${topics.length}.en`]: t("playbook.opening.topic_required") } })}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// What it asks (board PlaybookAsks)
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote",
  before_order_form: "playbook.stage.before_order_form",
  optional: "playbook.stage.optional",
};
const STAGE_HELP: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote_help",
  before_order_form: "playbook.stage.before_order_form_help",
  optional: "playbook.stage.optional_help",
};
/** Questions asked in chat take these roles; an order-form field may also become one. */
const MAIN_STAGES: PlaybookField["stage"][] = ["before_quote", "optional"];
const FORM_STAGES: PlaybookField["stage"][] = ["before_order_form", ...MAIN_STAGES];

function RoleTag({ stage }: { stage: string }) {
  const known = stage in STAGE_LABEL;
  return (
    <span className={`sas-pill${stage === "before_quote" ? " sas-pill--info" : ""}`} data-role-tag={stage}>
      {known ? t(STAGE_LABEL[stage as PlaybookField["stage"]]) : stage}
    </span>
  );
}

function FieldEditor({ at, label, example, stage, stages, e, errAt }: { at: string; label: string; example: string; stage: string; stages: PlaybookField["stage"][]; e: ErrorOf; errAt: string }) {
  return (
    <>
      <label className="sas-input-label" htmlFor={`pb-${at}.label`}>{t("playbook.field.label")}</label>
      <input className="sas-input pb-fit-name" id={`pb-${at}.label`} name="label" maxLength={60} defaultValue={label} {...aria(`pb-${at}.label`, e(`${errAt}.label`))} />
      <Err id={`pb-${at}.label`} msg={e(`${errAt}.label`)} />
      <label className="sas-input-label" htmlFor={`pb-${at}.example`}>{t("playbook.field.example")}</label>
      <textarea
        className="sas-textarea pb-grow pb-fit-line" id={`pb-${at}.example`} name="example" rows={1} maxLength={200} defaultValue={example}
        placeholder={t("playbook.field.example_placeholder")} onKeyDown={enterSaves} {...growProps()} {...aria(`pb-${at}.example`, e(`${errAt}.example`))}
      />
      <Err id={`pb-${at}.example`} msg={e(`${errAt}.example`)} />
      <label className="sas-input-label" htmlFor={`pb-${at}.stage`}>{t("playbook.field.where_used")}</label>
      <select className="sas-select pb-fit-name" id={`pb-${at}.stage`} name="stage" defaultValue={stage} {...aria(`pb-${at}.stage`, e(`${errAt}.stage`))}>
        {[...new Set([...stages, ...(stage in STAGE_LABEL ? [stage as PlaybookField["stage"]] : [])])].map((s) => <option key={s} value={s}>{t(STAGE_LABEL[s])}</option>)}
      </select>
      <Err id={`pb-${at}.stage`} msg={e(`${errAt}.stage`)} />
    </>
  );
}

type FieldAt = { f: Playbook["fields"][number]; i: number };

/** An added question; with no name it is refused at the row with the message an emptied question gets. */
const addField = (f: FormData, n: number): PlaybookChange | RowRefusal => (val(f, "label").trim()
  ? { kind: "add", list: "fields", item: { label: val(f, "label"), stage: val(f, "stage"), example: val(f, "example") } }
  : { refuse: { [`field.${n}.label`]: t("playbook.field.name_required") } });

/** One group of questions (asked in chat, or filled in the order form) as sortable rows with a column header. */
/** The column header of the questions; `info`: what each role means, behind an (i) on "Where the answer is used" (then also shown on a phone). */
function FieldHead({ info }: { info?: ReactNode }) {
  return (
    <div className={`pb-row pb-row--item pb-item-head${info ? " pb-item-head--info" : ""}`}>
      <span className="pb-row__lead" />
      <span className="pb-row__value" aria-hidden="true">{t("playbook.field.label")}</span>
      <span className="pb-row__actions">
        <span className="pb-item__tag"><span aria-hidden="true">{t("playbook.field.where_used")}</span>{info ? <InfoTip label={t("playbook.field.where_used")} wide prefer="above" explains="[data-role-tag]">{info}</InfoTip> : null}</span>
        <span className="pb-item__icons" />
      </span>
    </div>
  );
}

function FieldList({ rows, stages, helpId, headId, addId, head = true }: { rows: FieldAt[]; stages: PlaybookField["stage"][]; helpId: string; headId: string; addId: string; head?: boolean }) {
  const keys = rowKeys(rows.map((r) => r.f.key || r.f.label));
  const m = useMoves({ rows, keys, list: "fields", serverIndex: (pos) => rows[pos].i, what: (r) => r.f.label, helpId });
  return (
    <>
      {head ? <FieldHead /> : null}
      <SortHelp id={helpId} announce={m.sort.announce} />
      <div className="pb-sortable" ref={m.sort.listRef} role="list" aria-labelledby={headId} data-dragging={m.sort.dragging !== null ? "" : undefined}>
        {m.shown.map((r, pos) => {
          const k = keys[m.order[pos]];
          const at = `field.${r.i}`;
          return (
            <div key={k} role="listitem" data-sort-row="" className="pb-sortable__item">
              <ListItem
                id={at} what={r.f.label} own={[at]}
                lead={<Handle {...m.sort.handleProps(pos)} />}
                read={(
                  <span className="sas-stack-2" style={{ gap: 2 }}>
                    <span dir="auto">{r.f.label}</span>
                    {r.f.example?.trim()
                      ? <span className="sas-small" dir="auto" data-example="">{t("playbook.field.example_read", { text: r.f.example })}</span>
                      : <span className="sas-small pb-warn-text" data-example-missing="">{t("playbook.field.no_example")}</span>}
                  </span>
                )}
                aside={<span className="pb-item__tag"><RoleTag stage={r.f.stage} /></span>}
                editor={(e) => <FieldEditor at={at} label={r.f.label} example={r.f.example ?? ""} stage={r.f.stage} stages={stages} e={e} errAt={at} />}
                toChange={(form) => ({ kind: "edit", list: "fields", index: r.i, item: { key: r.f.key || undefined, label: val(form, "label"), stage: val(form, "stage"), example: val(form, "example"), hint: r.f.hint || undefined } })}
                remove={{ kind: "delete", list: "fields", index: r.i }}
                nextFocus={focusAfterDelete(m.order.map((o) => rows[o].i), pos, (j) => `field.${j}`, addId)}
                status={m.status(k)}
                rowAttrs={{ "data-field": r.i, "data-stage": r.f.stage }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * How counting works (canvas: PlaybookQuestions, right panel), on a neutral
 * example chat: only the questions the agent starts count.
 */
function QuestionCounting({ max }: { max: number }) {
  // Inside the stepper's (i) popover: no box of its own.
  const bubble = (who: "agent" | "buyer", text: string) => (
    <span style={{ flex: "1 1 auto", minWidth: 0, padding: "2px 8px", borderRadius: 8, fontSize: 12, lineHeight: "17px", background: who === "agent" ? "var(--agent-soft)" : "var(--surface-raised)", border: who === "buyer" ? "1px solid var(--line)" : 0 }}>{text}</span>
  );
  const mark = (n: number | null, arrow = false) => (
    <span aria-label={n ? t("playbook.count.counted", { n }) : t("playbook.count.not_counted")} style={{ flex: "0 0 18px", height: 18, marginTop: 1, borderRadius: 9, display: "inline-grid", placeItems: "center", fontSize: 11, fontWeight: 700, background: n ? "var(--primary)" : "transparent", color: n ? "var(--on-primary)" : "var(--ink-muted)" }}>{n ?? (arrow ? "→" : "–")}</span>
  );
  const row = (n: number | null, who: "agent" | "buyer", text: string, arrow = false) => (
    <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>{mark(n, arrow)}{bubble(who, text)}</div>
  );
  return (
    <span data-testid="question-counting" style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
      <span><strong>{t("playbook.count.title", { max })}</strong> <span className="pb-muted">{t("playbook.count.sub")}</span></span>
      {row(1, "agent", t("playbook.count.ex_agent_1"))}
      {row(null, "buyer", t("playbook.count.ex_buyer_1"))}
      {row(2, "agent", t("playbook.count.ex_agent_2"))}
      <span className="pb-muted" style={{ paddingInlineStart: 24, fontSize: 12, lineHeight: "16px" }}>{t("playbook.count.ex_note")}</span>
      {row(null, "buyer", t("playbook.count.ex_buyer_2"))}
      {row(null, "agent", t("playbook.count.ex_agent_3"), true)}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8, marginTop: 3, borderTop: "1px solid var(--line)" }}>
        <span><b>{t("playbook.count.asap_b")}</b> {t("playbook.count.asap")}</span>
        <span><b>{t("playbook.count.signal_b")}</b> {t("playbook.count.signal")}</span>
        <span><b>{t("playbook.count.pace_b")}</b> {t("playbook.count.pace")}</span>
        <span className="pb-muted">{t("playbook.count.ceiling", { ceiling: QUESTION_CEILING })}</span>
      </div>
    </span>
  );
}

/**
 * What it asks (board PlaybookAsks): "Questions before it recommends" on top
 * (saves on change), one row per question (question, example, role tag; drag
 * or ↑ / ↓; change, delete), Add question, the order-form fields. How the
 * count works is behind the stepper's (i), what each role means behind the (i)
 * on "Where the answer is used".
 */
export function AsksRows({ slug, hrefs, edit, p, orderFormHref }: Base & { p: Pick<Playbook, "fields" | "questionBudget">; orderFormHref: string }) {
  const budget = questionBudgetOf(p);
  const all: FieldAt[] = p.fields.map((f, i) => ({ f, i }));
  const main = all.filter((r) => !isOrderFormField(r.f));
  const form = all.filter((r) => isOrderFormField(r.f));
  const before = p.fields.filter((f) => f.stage === "before_quote" && f.label.trim()).length;
  const n = p.fields.length;
  // The order-form group opens by itself when one of its rows is opened from a link.
  const formOpen = !!edit && form.some((r) => edit === `field.${r.i}`);
  return (
    <PartRows slug={slug} part="asks" hrefs={hrefs} edit={edit}>
      <SavedStepper
        id="pb-questionBudget" field="questionBudget" label="playbook.questions.budget_short" value={budget} infoWide
        info={<><span>{t("playbook.questions.budget_hint_short")}</span><QuestionCounting max={budget} /></>}
        min={QUESTION_BUDGET.min} max={QUESTION_BUDGET.max} fewer="playbook.questions.fewer" more="playbook.questions.more" testId="question-budget"
      />
      {before > budget ? (
        <div className="pb-rows__note"><div className="sas-alert sas-alert--warning" role="status" data-testid="budget-warning"><Icon name="alert-triangle" /><span>{t(before - budget === 1 ? "playbook.fields.too_many" : "playbook.fields.too_many_other", { n: before, max: budget, extra: before - budget })}</span></div></div>
      ) : null}
      <span className="sas-sr" id="pb-asks-h">{t("playbook.fields")}</span>
      <FieldHead info={(
        <span className="sas-stack-2" data-testid="field-roles-info" style={{ display: "flex", gap: 8 }}>
          <span data-roles-intro="">{t("playbook.field.roles_intro")}</span>
          <ul data-testid="field-roles" style={{ listStyle: "none", padding: 0 }}>
            {(["before_quote", "optional", "before_order_form"] as const).map((s) => (
              <li key={s} data-role={s}><strong>{t(STAGE_LABEL[s])}</strong>: {t(STAGE_HELP[s])}</li>
            ))}
          </ul>
        </span>
      )} />
      {main.length === 0 ? <div className="pb-row pb-row--wide"><span className="pb-muted">{t("playbook.fields_empty")}</span></div> : <FieldList rows={main} stages={MAIN_STAGES} helpId="pb-sort-help-asks" headId="pb-asks-h" addId="field.add" head={false} />}
      <AddRow
        id="field.add" label={t("playbook.field.add")} own={[`field.${n}`, "fields"]}
        editor={(e) => <FieldEditor at="field.new" label="" example="" stage="before_quote" stages={MAIN_STAGES} e={e} errAt={`field.${n}`} />}
        newId={`field.${n}`} toChange={(f) => addField(f, n)}
      />
      <div className="pb-rows__note sas-stack-2" data-testid="order-form-fields">
        <div className="pb-form-head">
          <span><strong>{t("playbook.stage.before_order_form")}</strong><InfoTip label={t("playbook.stage.before_order_form")} wide>{t("playbook.fields.order_form_body")}</InfoTip></span>
          <a className="sas-small" href={orderFormHref} style={{ whiteSpace: "nowrap" }}>{t("playbook.fields.order_form_link")}</a>
        </div>
        <details className="pb-order-fields" open={formOpen || undefined}>
          <summary className="sas-small" style={{ cursor: "pointer" }} id="pb-form-fields-h" data-own-fields={form.length}>{t("playbook.fields.order_form_count", { n: form.length })}</summary>
          <span className="sas-hint" style={{ display: "block", paddingBlock: 8 }}>{t("playbook.fields.order_form_own_hint")}</span>
          <div className="pb-rows pb-rows--inset">
            {form.length ? <FieldList rows={form} stages={FORM_STAGES} helpId="pb-sort-help-form" headId="pb-form-fields-h" addId="field.add_form" /> : null}
            <AddRow
              id="field.add_form" label={t("playbook.fields.order_form_add")} own={[`field.${n}`, "fields"]}
              editor={(e) => <FieldEditor at="field.new_form" label="" example="" stage="before_order_form" stages={FORM_STAGES} e={e} errAt={`field.${n}`} />}
              newId={`field.${n}`} toChange={(f) => addField(f, n)}
            />
          </div>
        </details>
      </div>
    </PartRows>
  );
}

// ---------------------------------------------------------------------------
// Objections (board PlaybookObjections)
// ---------------------------------------------------------------------------

function ObjectionEditor({ at, errAt, o, e }: { at: string; errAt: string; o: { objection: string; answer: string; source: string }; e: ErrorOf }) {
  return (
    <>
      <label className="sas-input-label" htmlFor={`pb-${at}.objection`}>{t("playbook.objections.col_buyer")}</label>
      <input className="sas-input pb-fit-line" id={`pb-${at}.objection`} name="objection" maxLength={200} defaultValue={o.objection} {...aria(`pb-${at}.objection`, e(`${errAt}.objection`))} />
      <Err id={`pb-${at}.objection`} msg={e(`${errAt}.objection`)} />
      <label className="sas-input-label" htmlFor={`pb-${at}.answer`}>{t("playbook.objection.answer")}</label>
      <textarea className="sas-textarea pb-grow pb-grow--3 pb-fit-long" id={`pb-${at}.answer`} name="answer" rows={3} maxLength={600} defaultValue={o.answer} {...growProps()} {...aria(`pb-${at}.answer`, e(`${errAt}.answer`))} />
      <Err id={`pb-${at}.answer`} msg={e(`${errAt}.answer`)} />
      <label className="sas-input-label" htmlFor={`pb-${at}.source`}>{t("playbook.objection.source")}</label>
      <input className="sas-input pb-fit-name" id={`pb-${at}.source`} name="source" maxLength={120} defaultValue={o.source} {...aria(`pb-${at}.source`, e(`${errAt}.source`))} />
      <Err id={`pb-${at}.source`} msg={e(`${errAt}.source`)} />
    </>
  );
}

const objectionOf = (form: FormData) => ({ objection: val(form, "objection"), answer: val(form, "answer"), source: val(form, "source") });

/**
 * Objections (board PlaybookObjections): "Tries per objection" on top (saves
 * on change), one row per objection (what the buyer says, the approved
 * answer, "From: …" only when filled; change, delete), Add objection. No drag:
 * the order of objections does not matter.
 */
export function ObjectionsRows({ slug, hrefs, edit, p, prefill }: Base & {
  p: Pick<Playbook, "objections" | "objectionAttempts">;
  /** The buyer's words "Add an answer" opens the add row with (`?words=`). */
  prefill?: string | null;
}) {
  const n = p.objections.length;
  return (
    <PartRows slug={slug} part="objections" hrefs={hrefs} edit={edit}>
      <SavedStepper
        id="pb-objectionAttempts" field="objectionAttempts" label="playbook.objections.tries" info={t("playbook.objections.attempts_hint_short")} value={objectionAttemptsOf(p)}
        min={MIN_OBJECTION_ATTEMPTS} max={MAX_OBJECTION_ATTEMPTS} fewer="playbook.objections.attempts_fewer" more="playbook.objections.attempts_more" testId="objection-attempts"
      />
      {n === 0 ? <div className="pb-row pb-row--wide"><span className="pb-muted">{t("playbook.objections_empty")}</span></div> : (
        <>
          <div className="pb-row pb-row--item pb-item-head pb-obj-head" aria-hidden="true">
            <span className="pb-row__value pb-obj"><span>{t("playbook.objections.col_buyer")}</span><span>{t("playbook.objection.answer")}</span></span>
            <span className="pb-row__actions"><span className="pb-item__icons" /></span>
          </div>
          <div role="list" aria-label={t("playbook.objections")}>
            {p.objections.map((o, i) => {
              const at = `objection.${i}`;
              const source = o.source?.trim() ?? "";
              return (
                <div key={`${i}:${o.objection}`} role="listitem">
                  <ListItem
                    id={at} what={o.objection} own={[at]}
                    read={(
                      <span className="pb-obj">
                        <span className="sas-stack-2" style={{ gap: 2 }}>
                          <strong dir="auto" data-objection="">{t("playbook.sum.quote", { text: o.objection })}</strong>
                          {source ? <span className="sas-small" dir="auto" data-source="">{t("playbook.objection.from", { source })}</span> : null}
                        </span>
                        <span dir="auto" className="pb-long" data-answer="">{o.answer}</span>
                      </span>
                    )}
                    editor={(e) => <ObjectionEditor at={at} errAt={at} o={{ objection: o.objection, answer: o.answer, source }} e={e} />}
                    toChange={(form) => ({ kind: "edit", list: "objections", index: i, item: objectionOf(form) })}
                    remove={{ kind: "delete", list: "objections", index: i }}
                    nextFocus={focusAfterDelete(p.objections.map((_, j) => j), i, (j) => `objection.${j}`, "objection.add")}
                    rowAttrs={{ "data-testid": "objection-row" }}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}
      <AddRow
        id="objection.add" label={t("playbook.objection.add")} own={[`objection.${n}`, "objections"]}
        editor={(e) => <ObjectionEditor at="objection.new" errAt={`objection.${n}`} o={{ objection: prefill ?? "", answer: "", source: "" }} e={e} />}
        newId={`objection.${n}`}
        toChange={(form) => (val(form, "objection").trim()
          ? { kind: "add", list: "objections", item: objectionOf(form) }
          : { refuse: { [`objection.${n}.objection`]: t("playbook.objection.required") } })}
      />
    </PartRows>
  );
}
