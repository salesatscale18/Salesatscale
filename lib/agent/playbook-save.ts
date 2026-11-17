/**
 * Saving the structured playbook editor into the draft version (server side).
 * Every rule is checked here (parsePlaybookRows), not in the browser. Scoped
 * by account id.
 */
import type { Db } from "@/db/types";
import { parsePlaybookRows, playbookRowsFromForm, type PlaybookErrors, type PlaybookRowsInput } from "./playbook";
import { ensureDraftVersion, saveDraftPlaybook } from "./service";

export type PlaybookFormSave = { ok: true } | { ok: false; errors: PlaybookErrors; values: PlaybookRowsInput };

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
  const { exceptions: _x, opener, plays, ...rest } = parsed.value;
  void _x;
  const keepOpener = input.opener === undefined ? current.opener : opener;
  const keepPlays = input.plays === undefined ? current.plays : plays;
  await saveDraftPlaybook(db, accountId, {
    ...rest,
    ...(exceptions.length ? { exceptions } : {}),
    ...(keepOpener ? { opener: keepOpener } : {}),
    ...(keepPlays ? { plays: keepPlays } : {}),
  });
  return { ok: true };
}
