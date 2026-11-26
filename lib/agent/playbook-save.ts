/**
 * Saving the structured playbook editor into the draft version (server side).
 * Every rule is checked here (parsePlaybookRows), not in the browser. Scoped
 * by account id.
 */
import type { Db } from "@/db/types";
import type { Playbook } from "@/db/schema";
import { isPlayKey, parsePlaybookRows, parsePlayRow, playbookRowsFromForm, type PlaybookErrors, type PlaybookRowsInput, type PlayRowInput } from "./playbook";
import { ensureDraftVersion, saveDraftPlaybook } from "./service";
import { moveField } from "./playbook-parts";
import { refreshAgentNameAuto } from "./names-auto";
import { UNPAID_DEFAULTS, UNPAID_STEPS, unpaidRemindersOf, type PlaybookWithUnpaid, type UnpaidRowsInput } from "@/lib/orders/unpaid-reminders";
import { readOpener } from "./core/opener";
import { questionBudgetOf } from "./core/stage";
import { objectionAttemptsOf } from "./core/objections";
import type { LlmClient } from "./llm";
import type { Actor } from "@/lib/accounts/audit";

export type PlaybookFormSave = { ok: true } | { ok: false; errors: PlaybookErrors; values: PlaybookRowsInput };

export type PlayFormSave = { ok: true } | { ok: false; errors: PlaybookErrors; values: PlayRowInput };

/**
 * Saves one sales play from its page into the account's draft: the seller's
 * facts and the own card (`play.<key>.fact.<i>.text|source`, `play.<key>.own`
 * and the card parts). `restore` drops the own card (back to the default
 * card) and keeps the facts as sent. The other plays and the rest of the
 * playbook are left as stored. Unknown play keys are refused.
 */
export async function savePlayForm(db: Db, accountId: string, key: string, entries: [string, string][], opts: { restore?: boolean } = {}): Promise<PlayFormSave> {
  if (!isPlayKey(key)) return { ok: false, errors: { play: "Unknown play." }, values: {} };
  const prefix = `play.${key}.`;
  const sent = playbookRowsFromForm(entries.filter(([k]) => k.startsWith(prefix))).plays?.[key] ?? { facts: [] };
  const row: PlayRowInput = { ...sent, ...(opts.restore ? { own: null } : {}) };
  const errors: PlaybookErrors = {};
  const play = parsePlayRow(key, row, errors);
  if (Object.keys(errors).length) return { ok: false, errors, values: row };
  const current = (await ensureDraftVersion(db, accountId)).playbook;
  const plays: NonNullable<Playbook["plays"]> = { ...(current.plays ?? {}) };
  if (play) plays[key] = play;
  else delete plays[key];
  const { plays: _old, ...rest } = current;
  void _old;
  await saveDraftPlaybook(db, accountId, withoutDefaultUnpaid({ ...rest, ...(Object.keys(plays).length ? { plays } : {}) }));
  return { ok: true };
}

type SaveOpts = { names?: LlmClient | null; actor?: Actor | null };

/**
 * Parses the editor's form entries and saves them into the account's draft.
 * Approved exceptions are never typed in the editor: when the form showed them
 * (`exceptionsShown`), only the ids still in the form are kept. Opener and
 * plays sent by the form replace the stored ones; a form without them keeps
 * what is stored.
 */
export async function savePlaybookForm(db: Db, accountId: string, entries: [string, string][], opts: SaveOpts = {}): Promise<PlaybookFormSave> {
  const input = playbookRowsFromForm(entries.filter(([k]) => k !== "exceptionId" && k !== "exceptionsShown"));
  const shown = entries.some(([k, v]) => k === "exceptionsShown" && v === "1");
  const kept = shown ? new Set(entries.filter(([k]) => k === "exceptionId").map(([, v]) => v)) : null;
  return saveRowsInput(db, accountId, input, kept, opts);
}

/**
 * Validates the whole playbook as typed (`input`) with today's validator and
 * writes it into the draft, as the editor's save always has. `keptExceptions`:
 * the approved exceptions still shown (null: keep every stored one).
 */
async function saveRowsInput(db: Db, accountId: string, input: PlaybookRowsInput, keptExceptions: ReadonlySet<string> | null, opts: SaveOpts): Promise<PlaybookFormSave> {
  const current: PlaybookWithUnpaid = (await ensureDraftVersion(db, accountId)).playbook;
  const built = buildRowsDraft(current, input, keptExceptions);
  if (!built.ok) return { ok: false, errors: built.errors, values: input };
  await saveDraftPlaybook(db, accountId, withoutDefaultUnpaid(built.value));
  // Automatic versions for a new name or new market languages, once, on save (retrying earlier failures).
  if (opts.names !== undefined) await refreshAgentNameAuto(db, accountId, opts.names, { actor: opts.actor ?? null, retry: true });
  return { ok: true };
}

/**
 * The playbook the editor's save writes for `input` over the stored draft
 * `current` (pure): every value as parsed, with what the form did not show
 * kept as stored. Only the editor's keys are written (EDITOR_KEYS).
 */
function buildRowsDraft(current: PlaybookWithUnpaid, input: PlaybookRowsInput, keptExceptions: ReadonlySet<string> | null): { ok: true; value: PlaybookWithUnpaid } | { ok: false; errors: PlaybookErrors } {
  const parsed = parsePlaybookRows(input);
  if (!parsed.ok) return parsed;
  const stored = current.exceptions ?? [];
  const exceptions = keptExceptions ? stored.filter((x) => keptExceptions.has(x.id)) : stored;
  const { exceptions: _x, opener, plays, agentNameLocal, agentGender, questionBudget, objectionAttempts, callRole, unpaidReminders, ...rest } = parsed.value;
  void _x;
  const keepOpener = input.opener === undefined ? current.opener : opener;
  const keepPlays = input.plays === undefined ? current.plays : plays;
  // The seller's own name versions (C2): the languages sent replace the stored ones ("" = Reset); the others are kept.
  const keepNames: Partial<Record<string, string>> = { ...(current.agentNameLocal ?? {}) };
  for (const lang of Object.keys(input.agentNameLocal ?? {})) delete keepNames[lang];
  Object.assign(keepNames, agentNameLocal ?? {});
  for (const [k, v] of Object.entries(keepNames)) if (!v?.trim()) delete keepNames[k];
  // Gender and question budget: a form without them keeps what is stored.
  const keepGender = input.agentGender === undefined ? current.agentGender : agentGender;
  const keepBudget = input.questionBudget === undefined ? current.questionBudget : questionBudget;
  // Attempts per objection (O1 part 3): likewise.
  const keepAttempts = input.objectionAttempts === undefined ? current.objectionAttempts : objectionAttempts;
  // Who takes calls (O6): a form without it keeps what is stored; sent empty, it goes back to the default.
  const keepRole = input.callRole === undefined ? current.callRole : callRole;
  // "Signed, not paid yet" (After the order): likewise; a playbook that never had them reads the defaults.
  const keepUnpaid = input.unpaidReminders === undefined ? current.unpaidReminders : unpaidReminders;
  // Automatic name versions are kept; they are stale (and remade) when the name changed (lib/agent/names-auto.ts).
  const keepAuto = current.agentNameAuto;
  return {
    ok: true,
    value: {
      ...rest,
      ...(Object.keys(keepNames).length ? { agentNameLocal: keepNames } : {}),
      ...(keepAuto ? { agentNameAuto: keepAuto } : {}),
      ...(keepGender ? { agentGender: keepGender } : {}),
      ...(keepBudget !== undefined ? { questionBudget: keepBudget } : {}),
      ...(keepAttempts !== undefined ? { objectionAttempts: keepAttempts } : {}),
      ...(keepRole ? { callRole: keepRole } : {}),
      ...(exceptions.length ? { exceptions } : {}),
      ...(keepOpener ? { opener: keepOpener } : {}),
      ...(keepPlays ? { plays: keepPlays } : {}),
      ...(keepUnpaid ? { unpaidReminders: keepUnpaid } : {}),
    },
  };
}

/** Keys the editor's save writes (buildRowsDraft); a stored playbook can hold others (a part added later). */
const EDITOR_KEYS = new Set<string>([
  "agentName", "agentNameLocal", "agentNameAuto", "agentGender", "questionBudget", "objectionAttempts", "goal", "tone", "outcomes", "fields",
  "objections", "maxDiscountBp", "offerMeetingWhen", "handOffWhen", "callRole", "neverDo", "exceptions", "opener", "plays", "unpaidReminders",
]);

/** Structural equality of stored JSON values; a property set to undefined counts as missing. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameJson(x, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => rb[k] !== undefined && sameJson(ra[k], rb[k]));
}

/**
 * "Signed, not paid yet" stored with exactly the default values is dropped
 * (the key goes away). A playbook without the key reads the same defaults
 * (unpaidRemindersOf), and the setting is read only by the reminder runner,
 * never by the agent's prompt, so for the buyer, the team and the agent it is
 * the same whether the key is there or not: a seller who picks 2 / 5 / 7, all
 * on, on purpose gets exactly that. Dropping it also heals drafts where the
 * first row save of the new Playbook (S1) wrote the defaults by mistake.
 */
export function withoutDefaultUnpaid<T extends PlaybookWithUnpaid>(p: T): T {
  if (p.unpaidReminders === undefined || !sameJson(p.unpaidReminders, UNPAID_DEFAULTS)) return p;
  const { unpaidReminders: _u, ...rest } = p;
  void _u;
  return rest as T;
}

/**
 * The draft after one row change, keeping everything the change did not touch
 * exactly as stored (pure). `baseline` is what the editor's save writes for
 * the stored draft unchanged, `next` what it writes with the change. A
 * top-level key where they agree is kept as stored (also when it is missing,
 * and keys the editor does not know); one where they differ takes the new
 * value, and in a list the items the change left alone keep their stored form.
 * So the editor's own filling-in (the defaults for the budget, attempts,
 * gender, outcomes and reminders; trimming; the opener's shape) never reaches
 * a key the seller did not change.
 */
export function keepUntouched(current: PlaybookWithUnpaid, baseline: PlaybookWithUnpaid, next: PlaybookWithUnpaid): PlaybookWithUnpaid {
  const cur = current as unknown as Record<string, unknown>;
  const base = baseline as unknown as Record<string, unknown>;
  const nxt = next as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(base), ...Object.keys(nxt)])) {
    if (sameJson(base[k], nxt[k])) {
      if (cur[k] !== undefined) out[k] = cur[k];
    } else if (nxt[k] !== undefined) {
      out[k] = keepUntouchedItems(cur[k], base[k], nxt[k]);
    }
  }
  return out as unknown as PlaybookWithUnpaid;
}

/** A list's new items: each one that is (as written) one of the old items is taken as stored. */
function keepUntouchedItems(cur: unknown, base: unknown, nxt: unknown): unknown {
  if (!Array.isArray(cur) || !Array.isArray(base) || !Array.isArray(nxt) || cur.length !== base.length) return nxt;
  const used = new Set<number>();
  return nxt.map((x) => {
    const i = base.findIndex((b, j) => !used.has(j) && sameJson(b, x));
    if (i < 0) return x;
    used.add(i);
    return cur[i];
  });
}

/**
 * A stored draft that the validator refuses unchanged (an older value today's
 * rules no longer accept) has no baseline: a change that makes it valid is
 * written as the whole form, keeping the keys the editor does not know.
 */
function withUnknownKeys(current: PlaybookWithUnpaid, next: PlaybookWithUnpaid): PlaybookWithUnpaid {
  const unknown = Object.fromEntries(Object.entries(current).filter(([k]) => !EDITOR_KEYS.has(k)));
  return { ...unknown, ...next } as PlaybookWithUnpaid;
}

// ---------------------------------------------------------------------------
// One change at a time (Playbook parts: read first, edit one row)
// ---------------------------------------------------------------------------

/** Single values a row can set, named as the editor's inputs. */
export const SCALAR_KEYS = ["agentName", "agentGender", "tone", "goal", "maxDiscount", "offerMeetingWhen", "handOffWhen", "callRole", "questionBudget", "objectionAttempts"] as const;
export type ScalarKey = (typeof SCALAR_KEYS)[number];

/** Lists a row can change one item of. */
export const LIST_KEYS = ["neverDo", "objections", "fields", "openerTopics"] as const;
export type ListKey = (typeof LIST_KEYS)[number];
export type ListItem = {
  neverDo: string;
  objections: { objection: string; answer: string; source?: string };
  fields: { key?: string; label: string; stage: string; example?: string; hint?: string };
  openerTopics: { en: string; he: string };
};

/** Parts that save with their whole editor (their own inputs, named as in the one-page form). */
export const ENTRY_PARTS = ["name", "opening", "asks", "objections", "after"] as const;
export type EntryPart = (typeof ENTRY_PARTS)[number];

/**
 * One typed change to the draft playbook. `set`: single values (and the
 * outcome checkboxes, the opener's first question in both languages);
 * `add` / `edit` / `delete` / `move`: one item of a list (a question moves
 * among the questions of its own group: see moveField);
 * `setDefault`: the opener's default topic; `removeException`: one approved
 * exception (they are never typed); `part`: a part's whole editor as form
 * entries (the one-page form's inputs, read by playbookRowsFromForm).
 */
export type PlaybookChange =
  | { kind: "set"; values: Partial<Record<ScalarKey, string>>; outcomes?: Playbook["outcomes"]; openerQuestion?: { en: string; he: string } }
  | { [L in ListKey]: { kind: "add"; list: L; item: ListItem[L] } }[ListKey]
  | { [L in ListKey]: { kind: "edit"; list: L; index: number; item: ListItem[L] } }[ListKey]
  | { kind: "delete"; list: ListKey; index: number }
  | { kind: "move"; list: ListKey; index: number; to: number }
  | { kind: "setDefault"; index: number }
  | { kind: "removeException"; id: string }
  | { kind: "part"; part: EntryPart; entries: [string, string][] };

/**
 * What the one-page editor sent for a stored playbook, unchanged: every value
 * it showed, as its inputs held them (question budget, attempts and gender as
 * shown, the opener rows, the "Signed, not paid yet" card). Sales plays, the
 * own name versions and the approved exceptions were kept as stored, so they
 * are left out here too.
 */
export function storedRowsInput(p: Playbook): PlaybookRowsInput {
  const o = readOpener(p.opener);
  const unpaid = unpaidRemindersOf(p);
  return {
    agentName: p.agentName,
    questionBudget: String(questionBudgetOf(p)),
    objectionAttempts: String(objectionAttemptsOf(p)),
    agentGender: p.agentGender ?? "neutral",
    goal: p.goal,
    tone: p.tone,
    outcomes: { orderForm: !!p.outcomes?.orderForm, bankTransfer: !!p.outcomes?.bankTransfer, meeting: !!p.outcomes?.meeting },
    fields: p.fields.map((f) => ({ key: f.key || undefined, label: f.label, stage: f.stage, example: f.example ?? "", hint: f.hint || undefined })),
    objections: p.objections.map((x) => ({ objection: x.objection, answer: x.answer, source: x.source ?? "" })),
    maxDiscount: String(p.maxDiscountBp / 100),
    offerMeetingWhen: p.offerMeetingWhen,
    handOffWhen: p.handOffWhen,
    callRole: p.callRole ?? "",
    neverDo: [...p.neverDo],
    opener: {
      topics: o.topics.map((x) => ({ en: x.en, he: x.he ?? "" })),
      defaultTopic: String(o.defaultTopic),
      question: { en: o.question?.en ?? "", he: o.question?.he ?? "" },
    },
    unpaidReminders: Object.fromEntries(UNPAID_STEPS.map((s) => [s, { days: String(unpaid[s].days), on: unpaid[s].on }])) as UnpaidRowsInput,
  };
}

type ListAccess = { get: (input: PlaybookRowsInput) => unknown[]; put: (input: PlaybookRowsInput, rows: unknown[]) => PlaybookRowsInput };
const LISTS: Record<ListKey, ListAccess> = {
  neverDo: { get: (i) => i.neverDo, put: (i, rows) => ({ ...i, neverDo: rows as string[] }) },
  objections: { get: (i) => i.objections, put: (i, rows) => ({ ...i, objections: rows as PlaybookRowsInput["objections"] }) },
  fields: { get: (i) => i.fields, put: (i, rows) => ({ ...i, fields: rows as PlaybookRowsInput["fields"] }) },
  openerTopics: {
    get: (i) => i.opener?.topics ?? [],
    put: (i, rows) => ({ ...i, opener: { ...(i.opener ?? { defaultTopic: "0", question: { en: "", he: "" } }), topics: rows as { en: string; he: string }[] } }),
  },
};

/** The input name of a list item, as parsePlaybookRows reports its errors (`never.2`, `objection.0`, `field.1`, `opener.topic.3`). */
export const listItemKey = (list: ListKey, index: number): string =>
  list === "neverDo" ? `never.${index}` : list === "objections" ? `objection.${index}` : list === "fields" ? `field.${index}` : `opener.topic.${index}`;

const NOT_FOUND = "This row changed in the meantime. Reload the page and try again.";

/**
 * Applies one change to the editor's input. Pure. The opener's default topic
 * follows its row when topics move or are removed (as the editor's radio did).
 * An index outside the list is refused (the page was out of date).
 */
export function applyPlaybookChange(input: PlaybookRowsInput, change: PlaybookChange): { ok: true; input: PlaybookRowsInput } | { ok: false; errors: PlaybookErrors } {
  switch (change.kind) {
    case "set": {
      const next: PlaybookRowsInput = { ...input };
      for (const k of SCALAR_KEYS) if (typeof change.values[k] === "string") (next as Record<ScalarKey, string | undefined>)[k] = change.values[k];
      if (change.outcomes) next.outcomes = { orderForm: !!change.outcomes.orderForm, bankTransfer: !!change.outcomes.bankTransfer, meeting: !!change.outcomes.meeting };
      if (change.openerQuestion) next.opener = { ...(input.opener ?? { topics: [], defaultTopic: "0" }), question: { en: change.openerQuestion.en, he: change.openerQuestion.he } };
      return { ok: true, input: next };
    }
    case "add":
      return { ok: true, input: LISTS[change.list].put(input, [...LISTS[change.list].get(input), change.item]) };
    case "edit": case "delete": case "move": {
      const rows = [...LISTS[change.list].get(input)];
      const bad = { ok: false as const, errors: { [listItemKey(change.list, change.index)]: NOT_FOUND } };
      if (!Number.isInteger(change.index) || change.index < 0 || change.index >= rows.length) return bad;
      // Positions before → after, so the opener's default stays on its topic.
      const order = [...rows.keys()];
      if (change.kind === "edit") rows[change.index] = change.item;
      else if (change.kind === "delete") { rows.splice(change.index, 1); order.splice(change.index, 1); }
      else {
        if (!Number.isInteger(change.to) || change.to < 0 || change.to >= rows.length) return bad;
        if (change.list === "fields") {
          const moved = moveField(rows as PlaybookRowsInput["fields"], change.index, change.to);
          return moved ? { ok: true, input: LISTS.fields.put(input, moved) } : bad;
        }
        const [row] = rows.splice(change.index, 1);
        rows.splice(change.to, 0, row);
        const [at] = order.splice(change.index, 1);
        order.splice(change.to, 0, at);
      }
      let next = LISTS[change.list].put(input, rows);
      if (change.list === "openerTopics" && next.opener) {
        const now = order.indexOf(Number(input.opener?.defaultTopic ?? 0));
        next = { ...next, opener: { ...next.opener, defaultTopic: String(Math.max(0, now)) } };
      }
      return { ok: true, input: next };
    }
    case "setDefault": {
      const n = input.opener?.topics.length ?? 0;
      if (!input.opener || !Number.isInteger(change.index) || change.index < 0 || change.index >= n) return { ok: false, errors: { [listItemKey("openerTopics", change.index)]: NOT_FOUND } };
      return { ok: true, input: { ...input, opener: { ...input.opener, defaultTopic: String(change.index) } } };
    }
    case "removeException":
      return { ok: true, input };
    case "part": {
      const sent = playbookRowsFromForm(change.entries);
      const has = (k: string) => change.entries.some(([name]) => name === k);
      switch (change.part) {
        case "name":
          return { ok: true, input: { ...input, agentName: sent.agentName, ...(sent.agentNameLocal ? { agentNameLocal: sent.agentNameLocal } : {}) } };
        case "opening":
          return { ok: true, input: { ...input, opener: sent.opener ?? { topics: [], defaultTopic: "0", question: { en: "", he: "" } } } };
        case "asks":
          return { ok: true, input: { ...input, fields: sent.fields, ...(has("questionBudget") ? { questionBudget: sent.questionBudget } : {}) } };
        case "objections":
          return { ok: true, input: { ...input, objections: sent.objections, ...(has("objectionAttempts") ? { objectionAttempts: sent.objectionAttempts } : {}) } };
        case "after":
          return { ok: true, input: sent.unpaidReminders ? { ...input, unpaidReminders: sent.unpaidReminders } : input };
      }
    }
  }
}

export type PlaybookChangeSave = { ok: true } | { ok: false; errors: PlaybookErrors; values?: PlaybookRowsInput };

/**
 * Applies ONE change to the latest draft playbook and saves it (Playbook
 * parts). The whole playbook is checked again with the editor's validator
 * (parsePlaybookRows); what the change touched is written as the one-page
 * save wrote it, and everything else stays exactly as stored (keepUntouched:
 * no defaults filled in, unknown keys kept). The same draft creation and
 * automatic name versions as the one-page save. An error
 * anywhere (also in another part) refuses the change; its keys are input names,
 * so the caller can say which part needs the fix (partOfKey).
 */
export async function savePlaybookChange(db: Db, accountId: string, change: PlaybookChange, opts: SaveOpts = {}): Promise<PlaybookChangeSave> {
  const current: PlaybookWithUnpaid = (await ensureDraftVersion(db, accountId)).playbook;
  const applied = applyPlaybookChange(storedRowsInput(current), change);
  if (!applied.ok) return applied;
  let kept: ReadonlySet<string> | null = null;
  if (change.kind === "removeException") {
    // Every stored exception but that one (the editor's "remove" before Save).
    const stored = current.exceptions ?? [];
    if (!stored.some((x) => x.id === change.id)) return { ok: false, errors: { exceptions: NOT_FOUND } };
    kept = new Set(stored.map((x) => x.id).filter((id) => id !== change.id));
  }
  const next = buildRowsDraft(current, applied.input, kept);
  if (!next.ok) return { ok: false, errors: next.errors, values: applied.input };
  // Only what the change touched is written; everything else stays exactly as stored.
  const baseline = buildRowsDraft(current, storedRowsInput(current), null);
  const draft = baseline.ok ? keepUntouched(current, baseline.value, next.value) : withUnknownKeys(current, next.value);
  await saveDraftPlaybook(db, accountId, withoutDefaultUnpaid(draft));
  // Automatic versions for a new name or new market languages, once, on save (retrying earlier failures).
  if (opts.names !== undefined) await refreshAgentNameAuto(db, accountId, opts.names, { actor: opts.actor ?? null, retry: true });
  return { ok: true };
}

const str = (v: unknown, max = 5000): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/**
 * Reads a change sent by the browser (untrusted JSON) into a PlaybookChange,
 * or null when it is not one. Only the shapes above pass; strings only.
 */
export function readPlaybookChange(raw: unknown): PlaybookChange | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = typeof r.list === "string" && (LIST_KEYS as readonly string[]).includes(r.list) ? (r.list as ListKey) : null;
  const index = typeof r.index === "number" && Number.isInteger(r.index) ? r.index : null;
  const item = (l: ListKey, v: unknown): ListItem[ListKey] | null => {
    if (l === "neverDo") return str(v);
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (l === "objections") {
      const objection = str(o.objection);
      const answer = str(o.answer);
      return objection === null || answer === null ? null : { objection, answer, source: str(o.source) ?? "" };
    }
    if (l === "fields") {
      const label = str(o.label);
      const stage = str(o.stage);
      return label === null || stage === null ? null : { key: str(o.key) || undefined, label, stage, example: str(o.example) ?? "", hint: str(o.hint) || undefined };
    }
    const en = str(o.en);
    return en === null ? null : { en, he: str(o.he) ?? "" };
  };
  switch (r.kind) {
    case "set": {
      const values: Partial<Record<ScalarKey, string>> = {};
      const v = (r.values && typeof r.values === "object" ? r.values : {}) as Record<string, unknown>;
      for (const k of SCALAR_KEYS) {
        const s = str(v[k]);
        if (s !== null) values[k] = s;
      }
      const o = r.outcomes && typeof r.outcomes === "object" ? (r.outcomes as Record<string, unknown>) : null;
      const q = r.openerQuestion && typeof r.openerQuestion === "object" ? (r.openerQuestion as Record<string, unknown>) : null;
      const qEn = q ? str(q.en) : null;
      return {
        kind: "set", values,
        ...(o ? { outcomes: { orderForm: o.orderForm === true, bankTransfer: o.bankTransfer === true, meeting: o.meeting === true } } : {}),
        ...(q && qEn !== null ? { openerQuestion: { en: qEn, he: str(q.he) ?? "" } } : {}),
      };
    }
    case "add": case "edit": {
      if (!list) return null;
      const it = item(list, r.item);
      if (it === null) return null;
      if (r.kind === "add") return { kind: "add", list, item: it } as PlaybookChange;
      return index === null ? null : ({ kind: "edit", list, index, item: it } as PlaybookChange);
    }
    case "delete":
      return list && index !== null ? { kind: "delete", list, index } : null;
    case "move":
      return list && index !== null && typeof r.to === "number" && Number.isInteger(r.to) ? { kind: "move", list, index, to: r.to } : null;
    case "setDefault":
      return index !== null ? { kind: "setDefault", index } : null;
    case "removeException":
      return typeof r.id === "string" && r.id ? { kind: "removeException", id: r.id.slice(0, 100) } : null;
    case "part": {
      if (typeof r.part !== "string" || !(ENTRY_PARTS as readonly string[]).includes(r.part) || !Array.isArray(r.entries)) return null;
      const entries = r.entries.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string").slice(0, 2000);
      return { kind: "part", part: r.part as EntryPart, entries };
    }
    default:
      return null;
  }
}
