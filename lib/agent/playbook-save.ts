/**
 * Saving the structured playbook editor into the draft version (server side).
 * Every rule is checked here (parsePlaybookRows), not in the browser. Scoped
 * by account id.
 */
import type { Db } from "@/db/types";
import type { Playbook } from "@/db/schema";
import { isPlayKey, parsePlaybookRows, parsePlayRow, playbookRowsFromForm, type PlaybookErrors, type PlaybookRowsInput, type PlayRowInput } from "./playbook";
import { ensureDraftVersion, saveDraftPlaybook } from "./service";

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
  await saveDraftPlaybook(db, accountId, { ...rest, ...(Object.keys(plays).length ? { plays } : {}) });
  return { ok: true };
}

/**
 * Parses the editor's form entries and saves them into the account's draft.
 * Approved exceptions are never typed in the editor: when the form showed them
 * (`exceptionsShown`), only the ids still in the form are kept. Opener and
 * plays sent by the form replace the stored ones; a form without them keeps
 * what is stored.
 */
export async function savePlaybookForm(db: Db, accountId: string, entries: [string, string][]): Promise<PlaybookFormSave> {
  const input = playbookRowsFromForm(entries.filter(([k]) => k !== "exceptionId" && k !== "exceptionsShown"));
  const parsed = parsePlaybookRows(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, values: input };
  const current = (await ensureDraftVersion(db, accountId)).playbook;
  const stored = current.exceptions ?? [];
  const shown = entries.some(([k, v]) => k === "exceptionsShown" && v === "1");
  const kept = new Set(entries.filter(([k]) => k === "exceptionId").map(([, v]) => v));
  const exceptions = shown ? stored.filter((x) => kept.has(x.id)) : stored;
  const { exceptions: _x, opener, plays, agentNameLocal, agentGender, ...rest } = parsed.value;
  void _x;
  const keepOpener = input.opener === undefined ? current.opener : opener;
  const keepPlays = input.plays === undefined ? current.plays : plays;
  // The agent's local names and gender (decision 2): a form without them keeps what is stored.
  const keepNames = input.agentNameLocal === undefined ? current.agentNameLocal : agentNameLocal;
  const keepGender = input.agentGender === undefined ? current.agentGender : agentGender;
  await saveDraftPlaybook(db, accountId, {
    ...rest,
    ...(keepNames && Object.keys(keepNames).length ? { agentNameLocal: keepNames } : {}),
    ...(keepGender ? { agentGender: keepGender } : {}),
    ...(exceptions.length ? { exceptions } : {}),
    ...(keepOpener ? { opener: keepOpener } : {}),
    ...(keepPlays ? { plays: keepPlays } : {}),
  });
  return { ok: true };
}
