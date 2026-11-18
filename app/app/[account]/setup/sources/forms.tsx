"use client";

import { DateField } from "@/components/sas/date-field";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/sas/icon";
import { Button } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { addCallAction, addNoteAction, addWebsiteAction, updateNoteAction, uploadFilesAction, type FormState } from "./actions";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Vercel refuses a request body over 4.5 MB before it reaches the app, so check the total here. */
const MAX_REQUEST_BYTES = 4.4 * 1024 * 1024;
const idle: FormState = { error: null };

function FormError({ state, id }: { state: FormState; id: string }) {
  if (!state.error) return null;
  return (
    <div className="sas-alert sas-alert--danger" role="alert" id={id}>
      <Icon name="alert-triangle" /><span style={{ overflowWrap: "anywhere" }}>{state.error}</span>
    </div>
  );
}

/** Add a website (canvas: Sources): address and the sections to read. */
export function WebsiteForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(addWebsiteAction, idle);
  return (
    <form action={action} className="sas-stack-4" aria-labelledby="src-web-h">
      <input type="hidden" name="slug" value={slug} />
      <h2 id="src-web-h" className="sas-heading">{t("sources.web.title")}</h2>
      <FormError state={state} id="src-web-err" />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-url">{t("sources.web.url")}</label>
        <input className="sas-input sas-num" id="src-url" name="url" type="url" required maxLength={500} placeholder="https://example.com" inputMode="url" />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-paths">{t("sources.web.paths")}</label>
        <input className="sas-input sas-num" id="src-paths" name="paths" maxLength={1000} placeholder="/products /faq" aria-describedby="src-paths-hint" />
        <span className="sas-hint" id="src-paths-hint">{t("sources.web.paths_hint")}</span>
      </div>
      <span className="sas-hint">{t("sources.web.limits")}</span>
      <div><Button type="submit" disabled={pending}>{pending ? t("sources.web.reading") : t("sources.web.submit")}</Button></div>
    </form>
  );
}

/** Upload files: PDF, DOCX, TXT, MD, CSV, XLSX. Sizes are checked here first and again on the server. */
export function UploadForm({ slug, accept }: { slug: string; accept: string }) {
  const [state, action, pending] = useActionState(uploadFilesAction, idle);
  const [tooBig, setTooBig] = useState<string | null>(null);
  return (
    <form action={action} className="sas-stack-4" aria-labelledby="src-up-h" style={{ alignItems: "center", textAlign: "center" }}>
      <input type="hidden" name="slug" value={slug} />
      <Icon name="upload" />
      <h2 id="src-up-h" className="sas-heading">{t("sources.upload.title")}</h2>
      <span className="sas-small">{t("sources.upload.types")}</span>
      <FormError state={tooBig ? { error: tooBig } : state} id="src-up-err" />
      <label className="sas-sr" htmlFor="src-files">{t("sources.upload.choose")}</label>
      <input
        id="src-files" name="files" type="file" multiple required accept={accept} className="sas-input" style={{ height: "auto", padding: 6, maxWidth: "100%" }}
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          const big = files.find((f) => f.size > MAX_FILE_BYTES);
          const total = files.reduce((n, f) => n + f.size, 0);
          setTooBig(big ? t("sources.upload.too_big", { name: big.name }) : total > MAX_REQUEST_BYTES ? t("sources.upload.too_much") : null);
        }}
      />
      <Button type="submit" disabled={pending || !!tooBig}>{pending ? t("sources.upload.reading") : t("sources.upload.submit")}</Button>
      <span className="sas-hint">{t("sources.upload.kept")}</span>
    </form>
  );
}

/** Write a note: a title and the text. Also used to edit a note on its page. */
export function NoteForm({ slug, note }: { slug: string; note?: { id: string; title: string; body: string } }) {
  const [state, action, pending] = useActionState(note ? updateNoteAction : addNoteAction, idle);
  const p = note ? "src-note-e" : "src-note";
  return (
    <form action={action} className="sas-stack-4" aria-labelledby={`${p}-h`}>
      <input type="hidden" name="slug" value={slug} />
      {note ? <input type="hidden" name="sourceId" value={note.id} /> : null}
      <h2 id={`${p}-h`} className="sas-heading">{note ? t("sources.note.edit_title") : t("sources.note.title")}</h2>
      {note ? <span className="sas-small">{t("sources.note.edit_hint")}</span> : null}
      <FormError state={state} id={`${p}-err`} />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-title`}>{t("sources.note.name")}</label>
        <input className="sas-input" id={`${p}-title`} name="title" required maxLength={200} defaultValue={note?.title} dir="auto" />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-body`}>{t("sources.note.body")}</label>
        <textarea className="sas-textarea" id={`${p}-body`} name="body" rows={note ? 12 : 5} required maxLength={20000} defaultValue={note?.body} dir="auto" />
      </div>
      <div><Button type="submit" variant={note ? "primary" : "secondary"} disabled={pending}>{note ? t("sources.note.save") : t("sources.note.submit")}</Button></div>
    </form>
  );
}

/** Add a call transcript (pasted or a file), with the use confirmation. Audio comes later. */
export function CallForm({ slug, accept }: { slug: string; accept: string }) {
  const [state, action, pending] = useActionState(addCallAction, idle);
  return (
    <form action={action} className="sas-stack-4" aria-labelledby="src-call-h">
      <input type="hidden" name="slug" value={slug} />
      <div className="sas-stack-2" style={{ gap: 2 }}>
        <h2 id="src-call-h" className="sas-heading">{t("sources.call.title")}</h2>
        <span className="sas-small">{t("sources.call.hint")}</span>
      </div>
      <FormError state={state} id="src-call-err" />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-call-name">{t("sources.call.name")}</label>
        <input className="sas-input" id="src-call-name" name="title" maxLength={200} placeholder={t("sources.call.name_placeholder")} dir="auto" />
      </div>
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="src-call-rep">{t("sources.call.rep")}</label>
          <input className="sas-input" id="src-call-rep" name="rep" maxLength={100} dir="auto" />
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor="src-call-date">{t("sources.call.date")}</label>
          <DateField id="src-call-date" name="callDate" />
        </div>
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-call-text">{t("sources.call.paste")}</label>
        <textarea className="sas-textarea" id="src-call-text" name="text" rows={5} maxLength={400000} placeholder={t("sources.call.paste_placeholder")} dir="auto" aria-describedby="src-call-text-hint" />
        <span className="sas-hint" id="src-call-text-hint">{t("sources.call.paste_hint")}</span>
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-call-file">{t("sources.call.file")}</label>
        <input className="sas-input" id="src-call-file" name="file" type="file" accept={accept} style={{ height: "auto", padding: 6 }} />
      </div>
      <label className="sas-check">
        <input type="checkbox" name="consent" required />
        <span>{t("sources.call.consent")}</span>
      </label>
      <span className="sas-hint">{t("sources.call.masked")}</span>
      <div className="sas-alert sas-alert--warning" aria-disabled="true">
        <Icon name="clock" /><span>{t("sources.call.audio_soon")}</span>
      </div>
      <div><Button type="submit" disabled={pending}>{t("sources.call.submit")}</Button></div>
    </form>
  );
}

/** While a source is being read, refresh the page every few seconds. */
export function RefreshWhileProcessing({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}
