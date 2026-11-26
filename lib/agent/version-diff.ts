/**
 * Compare versions (Versions and test lab › Compare; board VersionCompare): a pure
 * comparison of what two stored agent versions hold (the playbook, the model and
 * effort, the voice settings) and of their stored scenario results. Nothing here
 * reads the database or calls a model.
 *
 * Lists are matched item by item so a reorder never reads as a removal plus an
 * addition: by a stable key where the playbook has one (deal-detail fields by
 * `key`, approved exceptions by `id`), else by the item's own text. An item that
 * only moved gives one "Moved" row (its old and new position). Unmatched items
 * between two matched ones are paired in order and shown as an edit (word diff);
 * what is left over is an addition or a removal.
 */
import { PLAY_KEYS, type Playbook, type PlaybookField, type PlayKey, type VoiceSettings } from "@/db/schema";
import { DEFAULT_PLAYS, playFacts } from "@/lib/agent/core/plays";
import { objectionAttemptsOf } from "@/lib/agent/core/objections";
import { questionBudgetOf } from "@/lib/agent/core/stage";
import { UNPAID_STEPS, unpaidRemindersOf } from "@/lib/orders/unpaid-reminders";
import { t, type MessageKey } from "@/lib/i18n";
import { callLimitShort } from "@/lib/voice/lab";
import { callVoice, resolveVoiceSettings, voiceCapabilities, voiceModelLabel } from "@/lib/voice/settings";

// ---------------------------------------------------------------------------
// Word diff
// ---------------------------------------------------------------------------

/** A piece of text in a diff: kept, removed (old side only) or added (new side only). */
export type Seg = { op: "same" | "del" | "ins"; text: string };

/** Words with the whitespace after them ("Say ", "yes, "); leading whitespace is its own token. */
function tokens(s: string): string[] {
  return s.match(/^\s+|\S+\s*/g) ?? [];
}

/** Longest common subsequence of two lists under `eq`: the matched index pairs, in order. */
function lcs<A, B>(a: readonly A[], b: readonly B[], eq: (x: A, y: B) => boolean): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = eq(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j])) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

function merge(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.op === s.op) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Readability cleanup: a lone short word ("to", "a") kept in the middle of a
 * rewritten stretch splits one change into two. Such a match, with changes on
 * both sides of it, is dropped so the stretch reads as one removal and one addition.
 */
function dropStrayWords(pairs: [number, number][], a: readonly string[], n: number, m: number): [number, number][] {
  return pairs.filter(([i, j], k) => {
    const prev = pairs[k - 1] ?? [-1, -1];
    const next = pairs[k + 1] ?? [n, m];
    const gapBefore = i - prev[0] > 1 || j - prev[1] > 1;
    const gapAfter = next[0] - i > 1 || next[1] - j > 1;
    return !(gapBefore && gapAfter && a[i].trim().length <= 3);
  });
}

/** Above this many words on a side the texts are shown as replaced whole (keeps the table O(n·m) small). */
const MAX_DIFF_WORDS = 1500;

/**
 * Word-level diff of two texts. Words are compared without their trailing
 * whitespace. Returns the old side (same + del) and the new side (same + ins).
 */
export function wordDiff(before: string, after: string): { before: Seg[]; after: Seg[] } {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > MAX_DIFF_WORDS || b.length > MAX_DIFF_WORDS) {
    return { before: merge([{ op: "del", text: before }]), after: merge([{ op: "ins", text: after }]) };
  }
  const pairs = dropStrayWords(lcs(a, b, (x, y) => x.trimEnd() === y.trimEnd()), a, a.length, b.length);
  const left: Seg[] = [];
  const right: Seg[] = [];
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    for (; i < pi; i++) left.push({ op: "del", text: a[i] });
    for (; j < pj; j++) right.push({ op: "ins", text: b[j] });
    if (pi < a.length && pj < b.length) {
      left.push({ op: "same", text: a[pi] });
      right.push({ op: "same", text: b[pj] });
      i = pi + 1;
      j = pj + 1;
    }
  }
  return { before: merge(left), after: merge(right) };
}

// ---------------------------------------------------------------------------
// List alignment
// ---------------------------------------------------------------------------

export type ListStep<T> =
  | { kind: "same"; a: T; b: T; ai: number; bi: number }
  | { kind: "moved"; a: T; b: T; ai: number; bi: number }
  | { kind: "paired"; a: T; b: T; ai: number; bi: number }
  | { kind: "removed"; a: T; ai: number }
  | { kind: "added"; b: T; bi: number };

/**
 * Matches two lists item by item. `key` identifies an item (a stable id, or its
 * own text). Items with the same key in the same relative order are "same";
 * an item whose key is on both sides but out of order is "moved". With
 * `pairGaps`, unmatched items between the same two anchors are paired in order
 * ("paired": an edited item); the rest are "added" or "removed".
 */
export function alignList<T>(before: readonly T[], after: readonly T[], key: (x: T) => string, pairGaps: boolean): ListStep<T>[] {
  const ka = before.map(key);
  const kb = after.map(key);
  const anchors = lcs(ka, kb, (x, y) => x === y);
  const steps: ListStep<T>[] = [];
  const usedA = new Set(anchors.map(([i]) => i));
  const usedB = new Set(anchors.map(([, j]) => j));
  // Moved: a key on both sides that the in-order match left out (first unused occurrence each side).
  const moved: [number, number][] = [];
  for (let i = 0; i < before.length; i++) {
    if (usedA.has(i)) continue;
    const j = kb.findIndex((k, jj) => k === ka[i] && !usedB.has(jj));
    if (j >= 0) { usedA.add(i); usedB.add(j); moved.push([i, j]); }
  }
  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...anchors, [before.length, after.length] as [number, number]]) {
    const gapA: number[] = [];
    const gapB: number[] = [];
    for (; i < pi; i++) if (!usedA.has(i)) gapA.push(i);
    for (; j < pj; j++) if (!usedB.has(j)) gapB.push(j);
    const pairs = pairGaps ? Math.min(gapA.length, gapB.length) : 0;
    for (let k = 0; k < pairs; k++) steps.push({ kind: "paired", a: before[gapA[k]], b: after[gapB[k]], ai: gapA[k], bi: gapB[k] });
    for (const x of gapA.slice(pairs)) steps.push({ kind: "removed", a: before[x], ai: x });
    for (const y of gapB.slice(pairs)) steps.push({ kind: "added", b: after[y], bi: y });
    if (pi < before.length && pj < after.length) {
      steps.push({ kind: "same", a: before[pi], b: after[pj], ai: pi, bi: pj });
      i = pi + 1;
      j = pj + 1;
    }
  }
  for (const [mi, mj] of moved) steps.push({ kind: "moved", a: before[mi], b: after[mj], ai: mi, bi: mj });
  return steps;
}

// ---------------------------------------------------------------------------
// Version diff
// ---------------------------------------------------------------------------

/** The areas of a version, in the order the page shows them. */
export const DIFF_AREAS = ["plays", "questions", "limits", "never", "agent", "opening", "objections", "close", "other", "model", "voice"] as const;
export type DiffArea = (typeof DIFF_AREAS)[number];

/**
 * One change. `before` / `after`: the old and the new text as diff pieces; null
 * when the item is not in that version (shown as "Not asked" / "Not set", see
 * `missing`). `note`: a muted hint after the new text (the voice model's cost).
 * `tag`: a muted line under the item ("now your own card"). A moved row holds the item's
 * own text on both sides, and `positions` its place before and after (1-based).
 */
export type ChangeRow = {
  area: DiffArea;
  item: string;
  kind: "changed" | "added" | "removed" | "moved";
  before: Seg[] | null;
  after: Seg[] | null;
  missing: "not_asked" | "not_set";
  note?: string;
  tag?: string;
  positions?: { before: number; after: number };
};

/** What a version holds, as far as the comparison reads it (an agent_versions row). */
export type VersionContent = { playbook: Playbook; model: string; effort: string; voiceSettings: VoiceSettings | null };

export type DiffOptions = {
  /** Show the text model and effort (platform details: super admins and acting-as only). */
  platformDetails: boolean;
  /** The realtime model each side's calls use (lib/voice/settings.ts versionModelId, which reads the env). */
  voiceModel: { before: string; after: string };
  /** The new voice model's cost per minute against the old one's, or null when unknown. */
  voiceCostRatio?: (from: string, to: string) => number | null;
};

const L = (k: MessageKey, v?: Record<string, string | number>) => t(k, v);
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const plain = (s: string, op: Seg["op"]): Seg[] => (s ? [{ op, text: s }] : []);

class Rows {
  readonly list: ChangeRow[] = [];
  constructor(private area: DiffArea, private missing: ChangeRow["missing"] = "not_set") {}
  in(area: DiffArea, missing: ChangeRow["missing"] = "not_set") { this.area = area; this.missing = missing; return this; }
  /** A text that may change, appear or disappear. */
  text(item: string, before: string | null | undefined, after: string | null | undefined, note?: string) {
    const a = norm(before);
    const b = norm(after);
    if (a === b) return;
    const base = { area: this.area, item, missing: this.missing, ...(note ? { note } : {}) };
    if (!a) this.list.push({ ...base, kind: "added", before: null, after: plain(b, "ins") });
    else if (!b) this.list.push({ ...base, kind: "removed", before: plain(a, "del"), after: null });
    else { const d = wordDiff(a, b); this.list.push({ ...base, kind: "changed", before: d.before, after: d.after }); }
  }
  /** A whole new or removed item: its main text highlighted, the rest plain after " · ". */
  whole(item: string, side: "added" | "removed", main: string, rest: string[] = []) {
    const op = side === "added" ? "ins" : "del";
    const segs: Seg[] = [...plain(norm(main), op), ...rest.filter(Boolean).map((r): Seg => ({ op: "same", text: ` · ${norm(r)}` }))];
    this.list.push({ area: this.area, item, missing: this.missing, kind: side, before: side === "removed" ? segs : null, after: side === "added" ? segs : null });
  }
  /** An item that only moved: its text on both sides (the page shows the positions above it). */
  moved(item: string, from: number, to: number, text: string) {
    const segs = plain(norm(text), "same");
    this.list.push({ area: this.area, item, missing: this.missing, kind: "moved", before: segs, after: [...segs], positions: { before: from + 1, after: to + 1 } });
  }
}

const STAGE_KEY: Record<PlaybookField["stage"], MessageKey> = {
  before_quote: "playbook.stage.before_quote",
  before_order_form: "playbook.stage.before_order_form",
  optional: "playbook.stage.optional",
};
const stageText = (s: PlaybookField["stage"] | undefined) => (s && STAGE_KEY[s] ? L(STAGE_KEY[s]) : String(s ?? ""));
const yesNo = (v: boolean | undefined) => L(v ? "compare.value.yes" : "compare.value.no");
const pct = (bp: number | undefined) => (typeof bp === "number" ? `${Math.round(bp) / 100}%` : "");

/** A play's name as the Where column shows it: the default card's title without its quotes ("Too expensive"). */
export function playName(key: PlayKey): string {
  return DEFAULT_PLAYS[key].title.replace(/["\u201c\u201d]/g, "").trim();
}

function diffPlays(r: Rows, a: Playbook, b: Playbook) {
  r.in("plays");
  for (const key of PLAY_KEYS as readonly PlayKey[]) {
    const title = playName(key);
    const pa = a.plays?.[key];
    const pb = b.plays?.[key];
    const ca = pa?.own ?? DEFAULT_PLAYS[key];
    const cb = pb?.own ?? DEFAULT_PLAYS[key];
    const first = r.list.length;
    r.text(`${title} · ${L("playbook.play.when")}`, ca.when, cb.when);
    for (const s of alignList(ca.do ?? [], cb.do ?? [], norm, true)) {
      const at = (n: number) => `${title} · ${L("compare.item.step", { n: n + 1 })}`;
      if (s.kind === "paired") r.text(at(s.bi), s.a, s.b);
      else if (s.kind === "added") r.whole(at(s.bi), "added", s.b);
      else if (s.kind === "removed") r.whole(at(s.ai), "removed", s.a);
      else if (s.kind === "moved") r.moved(at(s.bi), s.ai, s.bi, s.b);
    }
    r.text(`${title} · ${L("playbook.play.example")}`, ca.example, cb.example);
    r.text(`${title} · ${L("playbook.play.not_this")}`, ca.notThis, cb.notThis);
    const fa = playFacts(pa);
    const fb = playFacts(pb);
    for (const s of alignList(fa, fb, (f) => norm(f.text), true)) {
      const at = (n: number) => `${title} · ${L("compare.item.fact", { n: n + 1 })}`;
      if (s.kind === "same" || s.kind === "paired" || s.kind === "moved") {
        if (s.kind === "moved") r.moved(at(s.bi), s.ai, s.bi, s.b.text);
        r.text(at(s.bi), s.a.text, s.b.text);
        r.text(`${at(s.bi)} · ${L("playbook.objection.source")}`, s.a.source, s.b.source);
      } else if (s.kind === "added") r.whole(at(s.bi), "added", s.b.text, [s.b.source ?? ""]);
      else r.whole(at(s.ai), "removed", s.a.text, [s.a.source ?? ""]);
    }
    // A switch between the default card and the seller's own: a tag on the play's first changed row,
    // or its own row when nothing else in the play changed.
    if (!!pa?.own !== !!pb?.own) {
      if (r.list.length > first) r.list[first].tag = L(pb?.own ? "compare.tag.own_card" : "compare.tag.default_card");
      else r.text(`${title} · ${L("compare.item.card")}`, L(pa?.own ? "playbook.play.own" : "playbook.play.default_card"), L(pb?.own ? "playbook.play.own" : "playbook.play.default_card"));
    }
  }
}

function diffQuestions(r: Rows, a: Playbook, b: Playbook) {
  r.in("questions", "not_asked");
  r.text(L("playbook.questions.budget"), String(questionBudgetOf(a)), String(questionBudgetOf(b)));
  const deal = L("compare.item.deal_details");
  for (const s of alignList(a.fields ?? [], b.fields ?? [], (f) => f.key, false)) {
    if (s.kind === "added") r.whole(deal, "added", s.b.label, [stageText(s.b.stage), s.b.example ?? ""]);
    else if (s.kind === "removed") r.whole(deal, "removed", s.a.label, [stageText(s.a.stage), s.a.example ?? ""]);
    else if (s.kind === "same" || s.kind === "moved" || s.kind === "paired") {
      const name = norm(s.b.label) || norm(s.a.label);
      if (s.kind === "moved") r.moved(name, s.ai, s.bi, s.b.label);
      r.text(deal, s.a.label, s.b.label);
      r.text(`${name} · ${L("playbook.field.needed")}`, stageText(s.a.stage), stageText(s.b.stage));
      r.text(`${name} · ${L("playbook.field.example")}`, s.a.example, s.b.example);
      r.text(`${name} · ${L("compare.item.hint")}`, s.a.hint, s.b.hint);
    }
  }
}

function diffLimits(r: Rows, a: Playbook, b: Playbook) {
  r.in("limits");
  r.text(L("playbook.max_discount"), pct(a.maxDiscountBp), pct(b.maxDiscountBp));
  r.text(L("playbook.meeting_when"), a.offerMeetingWhen, b.offerMeetingWhen);
  r.text(L("playbook.handoff_when"), a.handOffWhen, b.handOffWhen);
  const exc = L("playbook.exceptions");
  for (const s of alignList(a.exceptions ?? [], b.exceptions ?? [], (x) => x.id, false)) {
    if (s.kind === "added") r.whole(exc, "added", s.b.text);
    else if (s.kind === "removed") r.whole(exc, "removed", s.a.text);
    else if (s.kind !== "paired") {
      if (s.kind === "moved") r.moved(exc, s.ai, s.bi, s.b.text);
      r.text(exc, s.a.text, s.b.text);
    }
  }
  r.in("never");
  const never = L("playbook.never");
  for (const s of alignList(a.neverDo ?? [], b.neverDo ?? [], norm, true)) {
    const at = (n: number) => `${never} · ${L("playbook.never.rule", { n: n + 1 })}`;
    if (s.kind === "paired") r.text(at(s.bi), s.a, s.b);
    else if (s.kind === "added") r.whole(at(s.bi), "added", s.b);
    else if (s.kind === "removed") r.whole(at(s.ai), "removed", s.a);
    else if (s.kind === "moved") r.moved(at(s.bi), s.ai, s.bi, s.b);
  }
}

/** How a deal closes: the sales goal and the ways a sale can end. */
function diffClose(r: Rows, a: Playbook, b: Playbook) {
  r.in("close");
  r.text(L("playbook.goal"), a.goal, b.goal);
  const outcomes: [keyof Playbook["outcomes"], MessageKey][] = [
    ["orderForm", "playbook.outcome.order_form"], ["bankTransfer", "playbook.outcome.bank_transfer"], ["meeting", "playbook.outcome.meeting"],
  ];
  for (const [k, label] of outcomes) {
    if (!!a.outcomes?.[k] !== !!b.outcomes?.[k]) r.text(`${L("playbook.outcomes")} · ${L(label)}`, yesNo(a.outcomes?.[k]), yesNo(b.outcomes?.[k]));
  }
}

const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };

function diffAgent(r: Rows, a: Playbook, b: Playbook) {
  r.in("agent");
  r.text(L("playbook.agent_name"), a.agentName, b.agentName);
  const langs = [...new Set([...Object.keys(a.agentNameLocal ?? {}), ...Object.keys(b.agentNameLocal ?? {})])].sort();
  for (const l of langs) r.text(`${L("playbook.agent_name")} · ${LANG_NAME[l] ?? l}`, a.agentNameLocal?.[l], b.agentNameLocal?.[l]);
  const gender = (g: Playbook["agentGender"]) => L(`playbook.agent_gender.${g ?? "neutral"}` as MessageKey);
  r.text(L("compare.item.gender"), gender(a.agentGender), gender(b.agentGender));
  r.text(L("playbook.tone"), a.tone, b.tone);
  r.text(L("playbook.call_role"), a.callRole, b.callRole);
}

function diffOpening(r: Rows, a: Playbook, b: Playbook) {
  r.in("opening");
  const oa = a.opener ?? {};
  const ob = b.opener ?? {};
  const topicText = (x: { en: string; he?: string }) => [x.en, x.he ?? ""].map(norm).filter(Boolean).join(" · ");
  for (const s of alignList(oa.topics ?? [], ob.topics ?? [], (x) => norm(x.en), true)) {
    const at = (n: number) => L("playbook.opening.topic_n", { n: n + 1 });
    if (s.kind === "added") r.whole(at(s.bi), "added", topicText(s.b));
    else if (s.kind === "removed") r.whole(at(s.ai), "removed", topicText(s.a));
    else {
      if (s.kind === "moved") r.moved(L("playbook.opening.topic_n", { n: s.bi + 1 }), s.ai, s.bi, topicText(s.b));
      r.text(at(s.bi), topicText(s.a), topicText(s.b));
    }
  }
  const defA = oa.topics?.[oa.defaultTopic ?? 0]?.en;
  const defB = ob.topics?.[ob.defaultTopic ?? 0]?.en;
  r.text(L("playbook.opening.default"), defA, defB);
  r.text(L("playbook.opener.question"), oa.question?.en ?? oa.openingQuestion, ob.question?.en ?? ob.openingQuestion);
  r.text(L("playbook.opening.question_he"), oa.question?.he, ob.question?.he);
  r.text(L("playbook.opener.leads_ask"), oa.leadsAskAbout, ob.leadsAskAbout);
}

function diffObjections(r: Rows, a: Playbook, b: Playbook) {
  r.in("objections");
  r.text(L("playbook.objections.attempts"), String(objectionAttemptsOf(a)), String(objectionAttemptsOf(b)));
  const obj = L("playbook.objection.text");
  for (const s of alignList(a.objections ?? [], b.objections ?? [], (x) => norm(x.objection), true)) {
    if (s.kind === "added") r.whole(obj, "added", s.b.objection, [s.b.answer]);
    else if (s.kind === "removed") r.whole(obj, "removed", s.a.objection, [s.a.answer]);
    else {
      const name = norm(s.b.objection);
      if (s.kind === "moved") r.moved(obj, s.ai, s.bi, `${name} · ${norm(s.b.answer)}`);
      r.text(obj, s.a.objection, s.b.objection);
      r.text(`${name} · ${L("playbook.objection.answer")}`, s.a.answer, s.b.answer);
      r.text(`${name} · ${L("playbook.objection.source")}`, s.a.source, s.b.source);
    }
  }
}

/**
 * After the order: "Signed, not paid yet", compared as the reminder runner reads
 * it (unpaidRemindersOf: missing = the defaults 2 / 5 / 7, all on). So a version
 * without the setting and one that holds exactly the defaults compare equal
 * (also drafts where the S1 row save wrote the defaults by mistake).
 */
function diffAfter(r: Rows, a: Playbook, b: Playbook) {
  r.in("close");
  const ua = unpaidRemindersOf(a);
  const ub = unpaidRemindersOf(b);
  const value = (s: { days: number; on: boolean }) => (s.on ? `${s.days} ${L("playbook.unpaid.days_after")}` : L("playbook.unpaid.off"));
  for (const step of UNPAID_STEPS) {
    if (ua[step].on === ub[step].on && ua[step].days === ub[step].days) continue;
    r.text(`${L("playbook.unpaid.title")} · ${L(`playbook.unpaid.${step}`)}`, value(ua[step]), value(ub[step]));
  }
}

/** Playbook keys the areas above cover. `agentNameAuto` is derived from the name (made automatically), so not compared. */
const COVERED = new Set<string>([
  "agentName", "agentNameLocal", "agentNameAuto", "agentGender", "questionBudget", "objectionAttempts", "goal", "tone", "outcomes", "fields",
  "objections", "maxDiscountBp", "offerMeetingWhen", "handOffWhen", "callRole", "neverDo", "exceptions", "opener", "plays", "unpaidReminders",
]);

/** Anything else a playbook holds (a part added later): compared as its stored value. */
function diffOther(r: Rows, a: Playbook, b: Playbook) {
  r.in("other");
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => !COVERED.has(k)).sort();
  const show = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v));
  for (const k of keys) r.text(k, show(ra[k]), show(rb[k]));
}

function diffVoice(r: Rows, a: VoiceSettings | null, b: VoiceSettings | null, opts: DiffOptions) {
  r.in("voice");
  const va = resolveVoiceSettings(a);
  const vb = resolveVoiceSettings(b);
  const ma = opts.voiceModel.before;
  const mb = opts.voiceModel.after;
  if (ma !== mb) {
    const ratio = opts.voiceCostRatio?.(ma, mb) ?? null;
    const times = ratio === null || !Number.isFinite(ratio) ? null : ratio >= 10 ? String(Math.round(ratio)) : String(Math.round(ratio * 10) / 10);
    r.text(L("voice.settings.model"), voiceModelLabel(ma), voiceModelLabel(mb), times && times !== "1" ? L("compare.voice_cost", { times }) : undefined);
  }
  r.text(L("voice.settings.voice"), callVoice(va.voice, ma), callVoice(vb.voice, mb));
  const capA = voiceCapabilities(ma);
  const capB = voiceCapabilities(mb);
  r.text(L("voice.settings.pace"), L(`voice.settings.pace.${va.pace}` as MessageKey), L(`voice.settings.pace.${vb.pace}` as MessageKey));
  if (capA.style || capB.style) {
    r.text(L("voice.settings.style"), capA.style ? L(`voice.settings.style.${va.style}` as MessageKey) : "", capB.style ? L(`voice.settings.style.${vb.style}` as MessageKey) : "");
  }
  r.text(L("voice.settings.pause"), va.pauseMs === null ? "" : `${va.pauseMs} ms`, vb.pauseMs === null ? "" : `${vb.pauseMs} ms`);
  r.text(L("voice.settings.interrupt"), va.interrupt ? L(`voice.settings.${va.interrupt}` as MessageKey) : "", vb.interrupt ? L(`voice.settings.${vb.interrupt}` as MessageKey) : "");
  r.text(L("voice.settings.fillers"), yesNo(va.fillers), yesNo(vb.fillers));
  r.text(L("voice.settings.max"), callLimitShort(va.maxCallSec), callLimitShort(vb.maxCallSec));
}

/**
 * Every change from version `a` (the older or base side) to `b`, grouped by area
 * in DIFF_AREAS order. Knowledge, catalog and price lists are shared by all
 * versions and never part of this.
 */
export function diffVersions(a: VersionContent, b: VersionContent, opts: DiffOptions): ChangeRow[] {
  const r = new Rows("plays");
  diffPlays(r, a.playbook, b.playbook);
  diffQuestions(r, a.playbook, b.playbook);
  diffLimits(r, a.playbook, b.playbook);
  diffAgent(r, a.playbook, b.playbook);
  diffOpening(r, a.playbook, b.playbook);
  diffObjections(r, a.playbook, b.playbook);
  diffClose(r, a.playbook, b.playbook);
  diffAfter(r, a.playbook, b.playbook);
  diffOther(r, a.playbook, b.playbook);
  if (opts.platformDetails) {
    r.in("model");
    r.text(L("compare.item.model"), a.model, b.model);
    r.text(L("compare.item.effort"), a.effort, b.effort);
  }
  diffVoice(r, a.voiceSettings, b.voiceSettings, opts);
  const order = new Map(DIFF_AREAS.map((x, i) => [x, i]));
  return r.list.map((row, i) => ({ row, i })).sort((x, y) => order.get(x.row.area)! - order.get(y.row.area)! || x.i - y.i).map((x) => x.row);
}

/** Changes per area (only areas with changes), in DIFF_AREAS order. */
export function areaCounts(rows: readonly ChangeRow[]): { area: DiffArea; count: number }[] {
  return DIFF_AREAS.map((area) => ({ area, count: rows.filter((r) => r.area === area).length })).filter((x) => x.count > 0);
}

// ---------------------------------------------------------------------------
// Scenario results
// ---------------------------------------------------------------------------

export type ScenarioOutcome = "passed" | "not_yet" | "failed" | "not_run";
/**
 * How a scenario's latest result moved from the base version to the compared one.
 * run_it: a result in the base version and none in the compared one (a gap in the newer version);
 * never_run: no result in either version (not a gap, nothing to compare);
 * first: run in the compared version but not in the base (nothing to compare with).
 */
export type ScenarioChange = "worse" | "run_it" | "better" | "first" | "same" | "never_run";
/** Worse first, then Not run, Better, a first result, Same, and never run in either last. */
export const CHANGE_ORDER: readonly ScenarioChange[] = ["worse", "run_it", "better", "first", "same", "never_run"];

const RANK: Record<Exclude<ScenarioOutcome, "not_run">, number> = { failed: 0, not_yet: 1, passed: 2 };

export function classifyScenario(before: ScenarioOutcome, after: ScenarioOutcome): ScenarioChange {
  if (after === "not_run") return before === "not_run" ? "never_run" : "run_it";
  if (before === "not_run") return "first";
  const d = RANK[after] - RANK[before];
  return d > 0 ? "better" : d < 0 ? "worse" : "same";
}

/** Rows with their change, ordered by CHANGE_ORDER (stable within a change). */
export function orderScenarios<T extends { before: ScenarioOutcome; after: ScenarioOutcome }>(rows: readonly T[]): (T & { change: ScenarioChange })[] {
  return rows
    .map((r, i) => ({ r: { ...r, change: classifyScenario(r.before, r.after) }, i }))
    .sort((x, y) => CHANGE_ORDER.indexOf(x.r.change) - CHANGE_ORDER.indexOf(y.r.change) || x.i - y.i)
    .map((x) => x.r);
}

export function changeCounts(rows: readonly { change: ScenarioChange }[]): Record<ScenarioChange, number> {
  const out: Record<ScenarioChange, number> = { worse: 0, run_it: 0, better: 0, first: 0, same: 0, never_run: 0 };
  for (const r of rows) out[r.change]++;
  return out;
}

/**
 * The amber notice (board VersionCompare): scenarios that got worse, and scenarios with a
 * result in the older version but none in the newer. Never-run-in-both scenarios are not
 * part of it. Null when both are zero, and always when both sides are the same version
 * (nothing can be missing from a version compared with itself).
 */
export function scenarioNotice(counts: Record<ScenarioChange, number>, sameVersion = false): { worse: number; notRun: number } | null {
  if (sameVersion) return null;
  const worse = counts.worse;
  const notRun = counts.run_it;
  return worse + notRun > 0 ? { worse, notRun } : null;
}

/** The notice's sentence: "1 scenario got worse and 4 were not run in the draft.", or one part alone when the other is zero. */
export function scenarioNoticeText(n: { worse: number; notRun: number }, where: string): string {
  const worse = n.worse === 1 ? L("compare.notice.worse_one") : L("compare.notice.worse", { n: n.worse });
  if (n.worse && n.notRun) {
    return L("compare.notice.both", { worse, notRun: n.notRun === 1 ? L("compare.notice.not_run_one") : L("compare.notice.not_run", { n: n.notRun }), where });
  }
  const part = n.worse ? worse : n.notRun === 1 ? L("compare.notice.not_run_alone_one") : L("compare.notice.not_run_alone", { n: n.notRun });
  return L("compare.notice.one_part", { part, where });
}
