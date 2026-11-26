"use client";

import { useId, useState, type ReactNode } from "react";
import type { Playbook, PlaybookException } from "@/db/schema";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { AGENT_GENDERS, type NameRow } from "@/lib/agent/core/names";
import { CALL_ROLE_MAX, DEFAULT_CALL_ROLE } from "@/lib/agent/core/call-role";
import type { PlaybookPart } from "@/lib/agent/playbook-parts";
import { LocalNames } from "../local-names";
import { dismissHandoffNoticeAction } from "./actions";
import { InfoTip } from "@/components/sas/info-tip";
import { LockTag, enterSaves, growProps } from "./parts";
import { restatesDiscountLimit, shortDate } from "./checks";
import { AddRow, EditRow, PartRows, RowCommand, type ErrorOf } from "./row";
import { focusAfterDelete } from "./focus";
import { useAgentDraft } from "./preview";
import "./playbook.css";

/** `edit`: the row opened first (from `?edit=`). */
type Base = { slug: string; hrefs: Record<PlaybookPart, string>; edit?: string | null };

const val = (form: FormData, name: string) => String(form.get(name) ?? "");

/** An input's error line and its aria attributes. */
function Err({ id, msg }: { id: string; msg?: string }) {
  return msg ? <span className="sas-error" id={`${id}-error`}>{msg}</span> : null;
}
const aria = (id: string, msg?: string) => ({ "aria-invalid": msg ? (true as const) : undefined, "aria-describedby": msg ? `${id}-error` : undefined });

/** A text the seller has not filled yet. */
const Empty = ({ k }: { k: MessageKey }) => <span className="pb-muted">{t(k)}</span>;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export type AgentNamesView = { rows: NameRow[]; source: string; notice: string | null; marketsHref: string };

function NameEditor({ name, names, e }: { name: string; names: AgentNamesView; e: ErrorOf }) {
  const [typed, setTyped] = useState(name);
  const follow = useAgentDraft("name");
  const errors: Record<string, string | undefined> = Object.fromEntries(names.rows.map((r) => [`agentNameLocal.${r.lang}`, e(`agentNameLocal.${r.lang}`)]));
  return (
    <>
      <label className="sas-sr" htmlFor="pb-agentName">{t("playbook.agent_name")}</label>
      <input className="sas-input pb-fit-name" id="pb-agentName" name="agentName" maxLength={60} value={typed} onChange={(ev) => { setTyped(ev.target.value); follow(ev.target.value); }} {...aria("pb-agentName", e("agentName"))} />
      <Err id="pb-agentName" msg={e("agentName")} />
      <LocalNames
        id="pb-names" inputPrefix="agentNameLocal" rows={names.rows} what={t("names.col_agent")} column={t("names.col_agent")} maxLength={60}
        errors={errors} notice={names.notice} typedName={typed} source={names.source}
        hint={<>{t("names.agent_hint_before")} <a href={names.marketsHref}>{t("names.agent_hint_link")}</a> {t("names.agent_hint_after")}</>}
      />
    </>
  );
}

function GenderEditor({ value }: { value: string }) {
  const [gender, setGender] = useState(value);
  const follow = useAgentDraft("gender");
  return (
    <span role="radiogroup" aria-label={t("playbook.agent_speaks")} className="pb-seg pb-seg--lg">
      {AGENT_GENDERS.map((g) => (
        <label key={g} data-gender={g} data-on={gender === g ? "" : undefined}>
          <input type="radio" className="sas-sr" name="agentGender" value={g} checked={gender === g} onChange={() => { setGender(g); follow(g); }} />
          {t(`playbook.agent_gender.${g}`)}
        </label>
      ))}
    </span>
  );
}

/** Agent (board PlaybookAgent): name with its versions per language, how it speaks about itself, tone, who takes calls, the voice line. */
export function AgentRows({ slug, hrefs, edit, p, names, voice }: Base & {
  p: Pick<Playbook, "agentName" | "agentGender" | "tone" | "callRole">;
  names: AgentNamesView;
  /** The draft's voice settings in one line, with the link to them (only where voice calls are on). */
  voice: { line: string; href: string } | null;
}) {
  const gender = p.agentGender ?? "neutral";
  return (
    <PartRows slug={slug} part="agent" hrefs={hrefs} edit={edit}>
      <EditRow
        id="name" label={t("playbook.agent_name")} own={["agentName", "agentNameLocal"]}
        read={(
          <span className="sas-stack-2" style={{ gap: 6 }}>
            <strong dir="auto">{p.agentName}</strong>
            {names.rows.length ? (
              <span className="pb-chips" data-name-versions="">
                {names.rows.map((r) => (
                  <span key={r.lang} className="pb-chip" data-lang={r.lang}>
                    {r.label} <bdi dir="auto">{r.own || r.fallback}</bdi> <span className="pb-muted" data-tag={r.own ? "own" : r.tag}>{t(r.own ? "names.tag.own" : r.tag === "automatic" ? "names.tag.automatic" : "names.tag.as_written")}</span>
                  </span>
                ))}
              </span>
            ) : null}
            {names.notice ? <span className="sas-small" data-names-notice="">{names.notice}</span> : null}
          </span>
        )}
        hint={t("playbook.agent_name_hint")}
        editor={(e) => <NameEditor name={p.agentName} names={names} e={e} />}
        toChange={(form) => ({ kind: "part", part: "name", entries: [...form.entries()].map(([k, v]) => [k, String(v)] as [string, string]) })}
      />
      <EditRow
        id="gender" label={t("playbook.agent_speaks_short")} own={["agentGender"]}
        read={<span data-gender-read={gender}>{t(`playbook.agent_gender.${gender}` as MessageKey)}</span>}
        hint={t("playbook.agent_speaks_hint")} info={t("playbook.agent_speaks_read")}
        editor={() => <GenderEditor value={gender} />}
        toChange={(form) => ({ kind: "set", values: { agentGender: val(form, "agentGender") } })}
      />
      <EditRow
        id="tone" label={t("playbook.tone")} own={["tone"]}
        read={p.tone.trim() ? <span dir="auto">{p.tone}</span> : <Empty k="playbook.not_set" />}
        hint={t("playbook.tone_hint")}
        editor={(e) => (
          <>
            <label className="sas-sr" htmlFor="pb-tone">{t("playbook.tone")}</label>
            <textarea className="sas-textarea pb-grow pb-fit-line" id="pb-tone" name="tone" rows={1} maxLength={300} defaultValue={p.tone} onKeyDown={enterSaves} {...growProps()} {...aria("pb-tone", e("tone"))} />
            <Err id="pb-tone" msg={e("tone")} />
          </>
        )}
        toChange={(form) => ({ kind: "set", values: { tone: val(form, "tone") } })}
      />
      <EditRow
        id="callRole" label={t("playbook.call_role")} own={["callRole"]}
        read={p.callRole?.trim() ? <span dir="auto">{p.callRole}</span> : <span><span dir="auto">{DEFAULT_CALL_ROLE}</span> <span className="pb-muted">· {t("playbook.default_value")}</span></span>}
        hint={t("playbook.call_role_hint", { role: DEFAULT_CALL_ROLE })}
        editor={(e) => (
          <>
            <label className="sas-sr" htmlFor="pb-callRole">{t("playbook.call_role")}</label>
            <input className="sas-input pb-fit-name" id="pb-callRole" name="callRole" maxLength={CALL_ROLE_MAX} defaultValue={p.callRole ?? ""} placeholder={DEFAULT_CALL_ROLE} {...aria("pb-callRole", e("callRole"))} />
            <Err id="pb-callRole" msg={e("callRole")} />
          </>
        )}
        toChange={(form) => ({ kind: "set", values: { callRole: val(form, "callRole") } })}
      />
      {voice ? (
        <EditRow
          id="voice" label={t("playbook.voice")} editable={false}
          read={<span>{voice.line} <span className="pb-muted">· {t("playbook.voice_where")}</span></span>}
          extra={<a className="pb-link" href={voice.href} data-voice-settings-link="">{t("playbook.voice_open")}</a>}
        />
      ) : null}
    </PartRows>
  );
}

// ---------------------------------------------------------------------------
// How a deal closes
// ---------------------------------------------------------------------------

const OUTCOMES = [["orderForm", "playbook.outcome.order_form"], ["bankTransfer", "playbook.outcome.bank_transfer"], ["meeting", "playbook.outcome.meeting"]] as const;

/** How a deal closes (board PlaybookClose): the sales goal and the ways a sale can end. */
export function CloseRows({ slug, hrefs, edit, p }: Base & { p: Pick<Playbook, "goal" | "outcomes"> }) {
  const on = OUTCOMES.filter(([k]) => p.outcomes[k]);
  return (
    <PartRows slug={slug} part="close" hrefs={hrefs} edit={edit}>
      <EditRow
        id="goal" label={t("playbook.goal")} own={["goal"]}
        read={<span dir="auto" className="pb-long">{p.goal}</span>}
        hint={t("playbook.goal_label")}
        editor={(e) => (
          <>
            <label className="sas-sr" htmlFor="pb-goal">{t("playbook.goal")}</label>
            <textarea className="sas-textarea pb-grow pb-grow--3 pb-fit-long" id="pb-goal" name="goal" rows={3} maxLength={1000} defaultValue={p.goal} {...growProps()} {...aria("pb-goal", e("goal"))} />
            <Err id="pb-goal" msg={e("goal")} />
          </>
        )}
        toChange={(form) => ({ kind: "set", values: { goal: val(form, "goal") } })}
      />
      <EditRow
        id="outcomes" label={t("playbook.close.ends_with")}
        read={on.length ? <ul className="pb-plain-list">{on.map(([k, label]) => <li key={k} data-outcome={k}>{t(label)}</li>)}</ul> : <Empty k="playbook.sum.close_none" />}
        editor={() => (
          <fieldset className="sas-checks pb-checks">
            <legend className="sas-sr">{t("playbook.close.ends_with")}</legend>
            {OUTCOMES.map(([k, label]) => <label key={k} className="sas-check"><input type="checkbox" name={k} defaultChecked={p.outcomes[k]} />{t(label)}</label>)}
          </fieldset>
        )}
        toChange={(form) => ({ kind: "set", values: {}, outcomes: { orderForm: form.get("orderForm") === "on", bankTransfer: form.get("bankTransfer") === "on", meeting: form.get("meeting") === "on" } })}
      />
    </PartRows>
  );
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Discounts (board PlaybookLimits): set per offer since the Offers part, so
 * Limits only says where they live and links there. Nothing to change here.
 */
export function DiscountsRow({ offersHref }: { offersHref: string }) {
  return (
    <EditRow
      id="discounts" label={t("playbook.limits.discounts")} editable={false}
      info={<><p>{t("playbook.part_sub.offers")}</p><p>{t("playbook.offers.above_hint")}</p></>}
      read={<span data-discounts-read="">{t("playbook.limits.discounts_read")} <span className="pb-muted">· {t("playbook.limits.discounts_where")}</span></span>}
      extra={<a className="pb-link" href={offersHref} data-offers-link="">{t("playbook.limits.discounts_open")}</a>}
    />
  );
}

/**
 * When the agent hands over whatever the seller writes in "Hand over to a person when" (checked 26 Nov
 * against the code): core design and the "The buyer is upset" play (upset, complains, legal or
 * existing-customer issue, insists; on a call the voice rules ask first, and a first request for a person
 * books a call: prompt.ts, voice.ts), a delivery date before the estimate (prompt.ts), numbers that look
 * wrong (design.ts), a second no to the recommendation when meetings are off (design.ts, stage.ts), a yes to
 * the quote when neither the order form nor meetings are on (stage.ts order_form), and no
 * reply at all: a model refusal or an AI budget / spend cap (turn.ts, whatsapp.ts).
 */
export const HANDOFF_ALWAYS: readonly MessageKey[] = [
  "playbook.handoff_always_list.upset", "playbook.handoff_always_list.legal", "playbook.handoff_always_list.delivery",
  "playbook.handoff_always_list.numbers", "playbook.handoff_always_list.second_no", "playbook.handoff_always_list.agrees",
  "playbook.handoff_always_list.cant_reply",
];

function HandoffAlways() {
  return (
    <>
      <span>{t("playbook.handoff_always_list")}</span>
      <ul data-handoff-always-list="">{HANDOFF_ALWAYS.map((k) => <li key={k}>{t(k)}</li>)}</ul>
    </>
  );
}

/** Limits (board PlaybookLimits): when to offer a call, when to hand over, approved exceptions, and where discounts live (Offers). */
export function LimitsRows({ slug, hrefs, edit, p, handOffNotice }: Base & {
  p: Pick<Playbook, "offerMeetingWhen" | "handOffWhen" | "exceptions">;
  /** O1: the notice that unknown questions no longer hand off, with the link to that play (null: not shown). */
  handOffNotice: { playHref: string } | null;
}) {
  const excId = useId();
  const exceptions: PlaybookException[] = p.exceptions ?? [];
  const text = (id: "offerMeetingWhen" | "handOffWhen", label: MessageKey, extra?: ReactNode, readHint?: ReactNode, info?: ReactNode) => (
    <EditRow
      id={id} label={t(label)} own={[id]} readHint={readHint} info={info} infoWide
      read={<span className="sas-stack-2" style={{ gap: 6 }}>{p[id].trim() ? <span dir="auto" className="pb-long">{p[id]}</span> : <Empty k="playbook.not_set" />}</span>}
      editor={(e) => (
        <>
          <label className="sas-sr" htmlFor={`pb-${id}`}>{t(label)}</label>
          <textarea className="sas-textarea pb-grow pb-grow--3 pb-fit-long" id={`pb-${id}`} name={id} rows={3} maxLength={500} defaultValue={p[id]} {...growProps()} {...aria(`pb-${id}`, e(id))} />
          <Err id={`pb-${id}`} msg={e(id)} />
          {extra}
        </>
      )}
      toChange={(form) => ({ kind: "set", values: { [id]: val(form, id) } })}
    />
  );
  return (
    <PartRows slug={slug} part="limits" hrefs={hrefs} edit={edit}>
      {text("offerMeetingWhen", "playbook.meeting_when")}
      {text(
        "handOffWhen", "playbook.handoff_when", <span className="sas-hint" data-handoff-always="">{t("playbook.handoff_always")}</span>,
        // The one fact line, with the full always-on list behind the (i) right after it (it continues there).
        <><span data-handoff-always-read="">{t("playbook.handoff_always_line")}</span>{"⁠"}<InfoTip label={t("playbook.handoff_when")} wide><HandoffAlways /></InfoTip></>,
      )}
      {handOffNotice ? (
        // O1: dismissed per user (cookie). Its own form and action, which do not save the playbook.
        <form action={dismissHandoffNoticeAction} className="sas-alert pb-notice pb-rows__note" role="status" data-testid="handoff-notice">
          <input type="hidden" name="slug" value={slug} />
          <Icon name="info" />
          <span className="pb-notice__text">
            {t("playbook.handoff_notice.short")}{" "}
            <a href={handOffNotice.playHref} aria-label={`${t("playbook.handoff_notice.see")} ${t("playbook.handoff_notice.link")}`}>{t("playbook.handoff_notice.see")}</a>
          </span>
          <button type="submit" className={buttonClass("ghost", "sm")}>{t("playbook.handoff_notice.dismiss")}</button>
        </form>
      ) : null}
      <EditRow
        id="exceptions" label={<span id={excId}>{t("playbook.exceptions")}</span>} editable={false}
        info={t("playbook.exceptions_read")} infoLabel={t("playbook.exceptions")}
        read={exceptions.length === 0 ? <Empty k="playbook.exceptions_empty" /> : (
          <ul className="pb-plain-list pb-exceptions" aria-labelledby={excId}>
            {exceptions.map((x) => (
              <li key={x.id} data-exception="">
                <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  <span dir="auto">{x.text}</span>
                  <span className="sas-small" style={{ display: "block" }}>{t("playbook.exception_meta", { date: shortDate(x.approvedAt) || x.approvedAt.slice(0, 10) })}</span>
                </span>
                <RowCommand change={{ kind: "removeException", id: x.id }} label={t("playbook.row.remove_short")} ariaLabel={t("playbook.row.remove", { what: x.text })} confirmText={t("playbook.exceptions.remove_confirm", { what: x.text })} />
              </li>
            ))}
          </ul>
        )}
      />
      <DiscountsRow offersHref={hrefs.offers} />
    </PartRows>
  );
}

// ---------------------------------------------------------------------------
// Never do
// ---------------------------------------------------------------------------

function RuleEditor({ id, name, value, e, errKey }: { id: string; name: string; value: string; e: ErrorOf; errKey: string }) {
  return (
    <>
      <textarea className="sas-textarea pb-grow pb-fit-line" id={id} name={name} rows={1} maxLength={200} defaultValue={value} onKeyDown={enterSaves} {...growProps()} {...aria(id, e(errKey))} />
      <Err id={id} msg={e(errKey)} />
    </>
  );
}

/** Never do (board PlaybookNever): one row per rule (change, remove), Add rule, and the platform's own rules. */
export function NeverRows({ slug, hrefs, edit, p }: Base & { p: Pick<Playbook, "neverDo" | "maxDiscountBp"> }) {
  const limit = String(p.maxDiscountBp / 100);
  return (
    <PartRows slug={slug} part="never" hrefs={hrefs} edit={edit}>
      {p.neverDo.length === 0 ? <div className="pb-row pb-row--wide"><Empty k="playbook.never_empty" /></div> : null}
      {p.neverDo.map((rule, i) => {
        const covered = restatesDiscountLimit(rule, limit);
        const label = t("playbook.never.rule", { n: i + 1 });
        return (
          <EditRow
            key={`${i}:${rule}`} id={`never.${i}`} label={label} wide own={[`never.${i}`, "never"]}
            read={(
              <span className="pb-never-read" data-covered={covered ? "" : undefined}>
                <span dir="auto">{rule}</span>
                {covered ? <span className="pb-covered" data-never-covered=""><Icon name="info" />{t("playbook.never.covered")}</span> : null}
              </span>
            )}
            editor={(e) => <><label className="sas-sr" htmlFor={`pb-never.${i}`}>{label}</label><RuleEditor id={`pb-never.${i}`} name="rule" value={rule} e={e} errKey={`never.${i}`} /></>}
            toChange={(form) => ({ kind: "edit", list: "neverDo", index: i, item: val(form, "rule") })}
            extra={<RowCommand change={{ kind: "delete", list: "neverDo", index: i }} label={t("playbook.row.remove_short")} ariaLabel={t("playbook.row.remove", { what: rule })} focusAfter={focusAfterDelete(p.neverDo.map((_, j) => j), i, (j) => `never.${j}`, "never.add")} />}
          />
        );
      })}
      <AddRow
        id="never.add" label={t("playbook.never.add")} own={[`never.${p.neverDo.length}`, "never"]}
        editor={(e) => <><label className="sas-sr" htmlFor="pb-never.new">{t("playbook.never.rule", { n: p.neverDo.length + 1 })}</label><RuleEditor id="pb-never.new" name="rule" value="" e={e} errKey={`never.${p.neverDo.length}`} /></>}
        newId={`never.${p.neverDo.length}`}
        toChange={(form) => (val(form, "rule").trim() ? { kind: "add", list: "neverDo", item: val(form, "rule") } : { refuse: { [`never.${p.neverDo.length}`]: t("playbook.never.rule_required") } })}
      />
      {/* The platform's own rules: the tag, and the rules behind its (i). */}
      <div className="pb-rows__note pb-fixed-line" data-platform-fixed=""><LockTag /><InfoTip label={t("playbook.fixed.tag")}>{t("playbook.never_hint")}</InfoTip></div>
    </PartRows>
  );
}
