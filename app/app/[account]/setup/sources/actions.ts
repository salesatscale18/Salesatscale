"use server";

import { after } from "next/server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { actorOf, appDb, requireAccount } from "@/lib/auth/account";
import { writeAudit } from "@/lib/accounts/audit";
import { t } from "@/lib/i18n";
import { isUuid } from "@/lib/security/ids";
import { FileRejected } from "@/lib/sources/files";
import { UnsafeUrlError } from "@/lib/sources/ssrf";
import {
  addCall, addFile, addNote, addWebsite, deleteSource, markWebsiteForReread, readWebsite, SourceInputError, updateNote, type UploadedFile,
} from "@/lib/sources/service";

export type FormState = { error: string | null };

const str = (form: FormData, k: string) => String(form.get(k) ?? "");
const page = (slug: string) => `/app/${slug}/setup/sources`;

function back(slug: string, q: Record<string, string>, path = page(slug)): never {
  revalidatePath(page(slug), "layout");
  const s = new URLSearchParams(q).toString();
  redirect(`${path}${s ? `?${s}` : ""}`);
}

/** Plain-words message for errors the seller can fix; anything else is rethrown. */
function inputError(e: unknown): string {
  if (e instanceof SourceInputError || e instanceof UnsafeUrlError || e instanceof FileRejected) return e.message;
  throw e;
}

async function fileFrom(v: FormDataEntryValue | null): Promise<UploadedFile | null> {
  if (!v || typeof v === "string" || v.size === 0) return null;
  return { name: v.name, type: v.type, bytes: new Uint8Array(await v.arrayBuffer()) };
}

/** Paths typed with spaces, commas or new lines between them. */
const pathList = (raw: string) => raw.split(/[\s,]+/).filter(Boolean);

export async function addWebsiteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const a = await requireAccount(str(form, "slug"));
  let id: string;
  try {
    id = (await addWebsite(appDb, actorOf(a), a.account.id, { url: str(form, "url"), paths: pathList(str(form, "paths")) })).id;
  } catch (e) {
    return { error: inputError(e) };
  }
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.added", targetType: "source", targetId: id, details: { kind: "website" } });
  // Reading up to 30 pages takes a while: do it after the response.
  after(() => readWebsite(appDb, a.account.id, id));
  back(a.account.slug, { done: "website" });
}

/** At most this many files per upload, and stop starting new ones after this long. */
const MAX_FILES = 10;
const UPLOAD_BUDGET_MS = 40_000;

export async function uploadFilesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const a = await requireAccount(str(form, "slug"));
  const entries = form.getAll("files");
  if (entries.length > MAX_FILES) return { error: t("sources.error.too_many", { n: MAX_FILES }) };
  const started = Date.now();
  const errors: string[] = [];
  let added = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (Date.now() - started > UPLOAD_BUDGET_MS) { skipped++; continue; }
    const file = await fileFrom(entry);
    if (!file) continue;
    try {
      const s = await addFile(appDb, actorOf(a), a.account.id, file);
      await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.added", targetType: "source", targetId: s.id, details: { kind: "file", size: file.bytes.byteLength } });
      added++;
    } catch (e) {
      errors.push(inputError(e));
    }
  }
  if (added === 0) return { error: errors.join(" ") || (skipped ? t("sources.error.too_slow") : t("sources.error.no_file")) };
  back(a.account.slug, { done: "files", n: String(added), ...(errors.length + skipped ? { failed: String(errors.length + skipped) } : {}) });
}

export async function addNoteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const a = await requireAccount(str(form, "slug"));
  let id: string;
  try {
    id = (await addNote(appDb, actorOf(a), a.account.id, { title: str(form, "title"), body: str(form, "body") })).id;
  } catch (e) {
    return { error: inputError(e) };
  }
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.added", targetType: "source", targetId: id, details: { kind: "text" } });
  back(a.account.slug, { done: "note" });
}

export async function updateNoteAction(_prev: FormState, form: FormData): Promise<FormState> {
  const a = await requireAccount(str(form, "slug"));
  const id = str(form, "sourceId");
  if (!isUuid(id)) return { error: t("sources.error.note_missing") };
  try {
    const s = await updateNote(appDb, a.account.id, id, { title: str(form, "title"), body: str(form, "body") });
    if (!s) return { error: t("sources.error.note_missing") };
  } catch (e) {
    return { error: inputError(e) };
  }
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.edited", targetType: "source", targetId: id });
  back(a.account.slug, { done: "saved" }, `${page(a.account.slug)}/${id}`);
}

export async function addCallAction(_prev: FormState, form: FormData): Promise<FormState> {
  const a = await requireAccount(str(form, "slug"));
  let id: string;
  try {
    const s = await addCall(appDb, actorOf(a), a.account.id, {
      title: str(form, "title"), rep: str(form, "rep"), callDate: str(form, "callDate"),
      consent: form.get("consent") === "on", text: str(form, "text"), file: (await fileFrom(form.get("file"))) ?? undefined,
    });
    id = s.id;
  } catch (e) {
    return { error: inputError(e) };
  }
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.added", targetType: "source", targetId: id, details: { kind: "call", consentConfirmed: true } });
  back(a.account.slug, { done: "call" }, `${page(a.account.slug)}/${id}`);
}

export async function rereadWebsiteAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const id = str(form, "sourceId");
  const to = str(form, "from") === "detail" && isUuid(id) ? `${page(a.account.slug)}/${id}` : page(a.account.slug);
  if (!isUuid(id) || !(await markWebsiteForReread(appDb, a.account.id, id))) back(a.account.slug, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.reread", targetType: "source", targetId: id });
  after(() => readWebsite(appDb, a.account.id, id));
  back(a.account.slug, { done: "reread" }, to);
}

export async function deleteSourceAction(form: FormData) {
  const a = await requireAccount(str(form, "slug"));
  const id = str(form, "sourceId");
  if (!isUuid(id) || !(await deleteSource(appDb, a.account.id, id))) back(a.account.slug, { error: "missing" });
  await writeAudit(appDb, actorOf(a), { accountId: a.account.id, action: "source.deleted", targetType: "source", targetId: id });
  back(a.account.slug, { done: "deleted" });
}
