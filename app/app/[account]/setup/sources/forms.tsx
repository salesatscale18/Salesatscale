"use client";

import { useFormStatus } from "react-dom";

/**
 * The Sources forms. Each one sits in a side panel (SidePanel) whose pinned
 * footer holds the submit button: PanelSubmit submits the form by id
 * (form="…") and follows its pending state, which the form reports with a
 * "sas:state" event (pending, or blocked by a file that is too big).
 */
import { DateField } from "@/components/sas/date-field";
import { DropFileInput } from "@/components/sas/list-kit-client";
import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import {
  addCallAction, addNoteAction, addWebsiteAction, updateCallAction, updateFileAction, updateNoteAction, updateWebsiteAction, uploadFilesAction, type FormState,
} from "./actions";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Vercel refuses a request body over 4.5 MB before it reaches the app, so check the total here. */
const MAX_REQUEST_BYTES = 4.4 * 1024 * 1024;
const idle: FormState = { error: null };

type StateDetail = { pending: boolean; blocked: boolean };

/** Tells the panel's submit button whether the form is pending or blocked. */
function useReportState(ref: React.RefObject<HTMLFormElement | null>, pending: boolean, blocked = false) {
  useEffect(() => {
    ref.current?.dispatchEvent(new CustomEvent<StateDetail>("sas:state", { detail: { pending, blocked } }));
  }, [ref, pending, blocked]);
}

/**
 * The primary button in a panel footer: submits the form with id `form` and
 * is disabled while it is pending or blocked (labels: `label`, `pendingLabel`).
 */
export function PanelSubmit({ form, label, pendingLabel }: { form: string; label: string; pendingLabel?: string }) {
  const [state, setState] = useState<StateDetail>({ pending: false, blocked: false });
  useEffect(() => {
    const el = document.getElementById(form);
    if (!el) return;
    const onState = (e: Event) => setState((e as CustomEvent<StateDetail>).detail);
    el.addEventListener("sas:state", onState);
    return () => el.removeEventListener("sas:state", onState);
  }, [form]);
  return (
    <button type="submit" form={form} className={buttonClass("primary")} disabled={state.pending || state.blocked} aria-busy={state.pending || undefined}>
      {state.pending && pendingLabel ? pendingLabel : label}
    </button>
  );
}

function FormError({ state, id }: { state: FormState; id: string }) {
  if (!state.error) return null;
  return (
    <div className="sas-alert sas-alert--danger" role="alert" id={id}>
      <Icon name="alert-triangle" /><span style={{ overflowWrap: "anywhere" }}>{state.error}</span>
    </div>
  );
}

/** A grey info note inside a panel ("We read up to 30 pages…"). */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <div className="sas-small" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "10px 12px", borderRadius: "var(--radius-md)", background: "var(--surface-sunken)" }}>
      <span style={{ flex: "none", display: "inline-flex", marginBlockStart: 2 }}><Icon name="info" /></span>
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  );
}

const hiddenSlug = (slug: string, sourceId?: string) => (
  <>
    <input type="hidden" name="slug" value={slug} />
    {sourceId ? <input type="hidden" name="sourceId" value={sourceId} /> : null}
  </>
);

/* ------------------------------------------------------------------------- */
/* Website                                                                   */
/* ------------------------------------------------------------------------- */

function WebsiteFields({ p, url, paths }: { p: string; url?: string; paths?: string[] }) {
  return (
    <>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-url`}>{t("sources.web.url")}</label>
        <input className="sas-input sas-num" id={`${p}-url`} name="url" type="url" required maxLength={500} placeholder="https://example.com" inputMode="url" defaultValue={url} dir="ltr" data-autofocus="" />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-paths`}>{t("sources.web.paths")}</label>
        <span className="sas-hint" style={{ marginBlockStart: -4 }}>{t("sources.optional")}</span>
        <input className="sas-input sas-num" id={`${p}-paths`} name="paths" maxLength={1000} placeholder="/products /faq" aria-describedby={`${p}-paths-hint`} defaultValue={paths?.join(" ")} dir="ltr" />
        <span className="sas-hint" id={`${p}-paths-hint`}>{t("sources.web.paths_hint")}</span>
      </div>
      <InfoNote>{t("sources.web.limits")}</InfoNote>
    </>
  );
}

/** Add a website (canvas: SourcesAdd › Website): address and the sections to read. */
export function WebsiteForm({ slug, id }: { slug: string; id: string }) {
  const [state, action, pending] = useActionState(addWebsiteAction, idle);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending);
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug)}
      <FormError state={state} id={`${id}-err`} />
      <WebsiteFields p="src-web" />
    </form>
  );
}

/** Edit a website: address and sections; saving reads it again. */
export function WebsiteEditForm({ slug, id, source }: { slug: string; id: string; source: { id: string; url: string; paths: string[] } }) {
  const [state, action, pending] = useActionState(updateWebsiteAction, idle);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending);
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug, source.id)}
      <FormError state={state} id={`${id}-err`} />
      <WebsiteFields p="src-web-e" url={source.url} paths={source.paths} />
    </form>
  );
}

/* ------------------------------------------------------------------------- */
/* Files                                                                     */
/* ------------------------------------------------------------------------- */

const sizeText = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A drop zone with a "Browse files" button over a real file input, and the
 * chosen files listed under it with a remove button each. Files dropped on
 * the Files tile arrive through DropFileInput (dropKey "files").
 */
function FileDrop({ id, name, accept, multiple, required, onFiles, label }: {
  id: string; name: string; accept: string; multiple?: boolean; required?: boolean; onFiles: (files: File[]) => void; label: string;
}) {
  const wrap = useRef<HTMLLabelElement>(null);
  const input = () => wrap.current?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const update = () => {
    const list = [...(input()?.files ?? [])];
    setFiles(list);
    onFiles(list);
  };
  const setInputFiles = (list: File[]) => {
    const el = input();
    if (!el) return;
    const dt = new DataTransfer();
    for (const f of list) dt.items.add(f);
    el.files = dt.files;
    update();
  };
  return (
    <div className="sas-stack-4">
      <div
        data-dropzone=""
        onDragOver={(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setOver(false);
          setInputFiles(multiple ? [...files, ...e.dataTransfer.files] : [e.dataTransfer.files[0]]);
        }}
        style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "24px 16px", textAlign: "center",
          border: `1px dashed ${over ? "var(--primary)" : "var(--line-strong)"}`, borderRadius: "var(--radius-lg)", background: over ? "var(--primary-soft)" : "transparent",
        }}
      >
        <span aria-hidden="true" style={{ display: "inline-grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-md)", background: "var(--primary-soft)", color: "var(--primary)" }}><Icon name="upload" /></span>
        <strong>{t("sources.upload.drop")}</strong>
        <span className="sas-small">{t("sources.upload.or")}</span>
        <label ref={wrap} className={buttonClass("secondary", "sm")} style={{ position: "relative", cursor: "pointer" }}>
          {t("sources.upload.browse")}
          <span className="sas-sr">{label}</span>
          <DropFileInput dropKey="files" id={id} name={name} multiple={multiple} required={required} accept={accept} className="sas-sr" onChange={update} />
        </label>
      </div>
      {files.length ? (
        <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label={t("sources.upload.chosen")} data-chosen-files="">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", border: "1px solid var(--line)", borderRadius: "var(--radius-md)" }}>
              <Icon name="file-text" />
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                <span style={{ overflowWrap: "anywhere" }} dir="auto">{f.name}</span>
                <span className="sas-small sas-num">{sizeText(f.size)}</span>
              </span>
              <button type="button" className={buttonClass("ghost", "sm")} aria-label={t("sources.upload.remove", { name: f.name })} onClick={() => setInputFiles(files.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Upload files: PDF, DOCX, TXT, MD, CSV, XLSX. Sizes are checked here first and again on the server. */
export function UploadForm({ slug, accept, id }: { slug: string; accept: string; id: string }) {
  const [state, action, pending] = useActionState(uploadFilesAction, idle);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending, !!tooBig);
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug)}
      <FormError state={tooBig ? { error: tooBig } : state} id={`${id}-err`} />
      <FileDrop
        id="src-files" name="files" accept={accept} multiple required label={t("sources.upload.choose")}
        onFiles={(files) => {
          const big = files.find((f) => f.size > MAX_FILE_BYTES);
          const total = files.reduce((n, f) => n + f.size, 0);
          setTooBig(big ? t("sources.upload.too_big", { name: big.name }) : total > MAX_REQUEST_BYTES ? t("sources.upload.too_much") : null);
        }}
      />
      <span className="sas-small">{t("sources.upload.types")}</span>
      <InfoNote>{t("sources.upload.kept")}</InfoNote>
    </form>
  );
}

/** Edit a file: its name, and "Replace file" (the new file's text replaces the old). */
export function FileEditForm({ slug, id, accept, source }: { slug: string; id: string; accept: string; source: { id: string; title: string; fileName?: string } }) {
  const [state, action, pending] = useActionState(updateFileAction, idle);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending, !!tooBig);
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug, source.id)}
      <FormError state={tooBig ? { error: tooBig } : state} id={`${id}-err`} />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-file-e-title">{t("sources.file.name")}</label>
        <input className="sas-input" id="src-file-e-title" name="title" required maxLength={200} defaultValue={source.title} dir="auto" data-autofocus="" />
      </div>
      <div className="sas-input-group">
        <span className="sas-input-label">{t("sources.replace_file")}</span>
        <span className="sas-hint">{t("sources.file.replace_hint")}</span>
        <FileDrop
          id="src-file-e-file" name="file" accept={accept} label={t("sources.replace_file")}
          onFiles={(files) => setTooBig(files[0] && files[0].size > MAX_FILE_BYTES ? t("sources.upload.too_big", { name: files[0].name }) : null)}
        />
      </div>
      <span className="sas-small">{t("sources.upload.types")}</span>
      <InfoNote>{t("sources.upload.kept")}</InfoNote>
    </form>
  );
}

/* ------------------------------------------------------------------------- */
/* Note                                                                      */
/* ------------------------------------------------------------------------- */

/** Write a note: a title and the text. With `note`, edits that note. */
export function NoteForm({ slug, id, note }: { slug: string; id: string; note?: { id: string; title: string; body: string } }) {
  const [state, action, pending] = useActionState(note ? updateNoteAction : addNoteAction, idle);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending);
  const p = note ? "src-note-e" : "src-note";
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4" style={{ flex: 1 }}>
      {hiddenSlug(slug, note?.id)}
      <FormError state={state} id={`${p}-err`} />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-title`}>{t("sources.note.name")}</label>
        <input className="sas-input" id={`${p}-title`} name="title" required maxLength={200} defaultValue={note?.title} placeholder={t("sources.note.name_placeholder")} dir="auto" data-autofocus="" />
      </div>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-body`}>{t("sources.note.body")}</label>
        <textarea className="sas-textarea" id={`${p}-body`} name="body" rows={14} required maxLength={20000} defaultValue={note?.body} placeholder={t("sources.note.body_placeholder")} dir="auto" />
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------------- */
/* Call transcript                                                           */
/* ------------------------------------------------------------------------- */

function CallMeta({ p, title, rep, callDate }: { p: string; title?: string; rep?: string; callDate?: string }) {
  return (
    <>
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor={`${p}-name`}>{t("sources.call.name")}</label>
        <input className="sas-input" id={`${p}-name`} name="title" maxLength={200} placeholder={t("sources.call.name_placeholder")} defaultValue={title} dir="auto" data-autofocus="" />
      </div>
      <div className="sas-grid-2" style={{ gap: 12 }}>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor={`${p}-rep`}>{t("sources.call.rep")}</label>
          <input className="sas-input" id={`${p}-rep`} name="rep" maxLength={100} defaultValue={rep} dir="auto" />
        </div>
        <div className="sas-input-group">
          <label className="sas-input-label" htmlFor={`${p}-date`}>{t("sources.call.date")}</label>
          <DateField id={`${p}-date`} name="callDate" defaultValue={callDate} />
        </div>
      </div>
    </>
  );
}

function CallFooterNotes() {
  return <InfoNote>{t("sources.call.masked")} {t("sources.call.audio_later")}</InfoNote>;
}

/** Add a call transcript, pasted or as a file (Paste text / Upload file), with the use confirmation. Audio comes later. */
export function CallForm({ slug, accept, id }: { slug: string; accept: string; id: string }) {
  const [state, action, pending] = useActionState(addCallAction, idle);
  const [mode, setMode] = useState<"paste" | "file">("paste");
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending);
  const tab = (m: "paste" | "file", label: string) => (
    <button
      type="button" aria-pressed={mode === m} onClick={() => setMode(m)} data-call-mode={m}
      className={buttonClass(mode === m ? "secondary" : "ghost", "sm")}
      style={mode === m ? { background: "var(--primary-soft)", borderColor: "var(--primary)", color: "var(--primary)" } : undefined}
    >
      {label}
    </button>
  );
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug)}
      <span className="sas-small">{t("sources.call.hint")}</span>
      <FormError state={state} id="src-call-err" />
      <CallMeta p="src-call" />
      <div role="group" aria-label={t("sources.call.how")} style={{ display: "inline-flex", gap: 4, alignSelf: "flex-start" }}>
        {tab("paste", t("sources.call.mode_paste"))}
        {tab("file", t("sources.call.mode_file"))}
      </div>
      <div className="sas-input-group" hidden={mode !== "paste"} style={mode !== "paste" ? { display: "none" } : undefined}>
        <label className="sas-input-label" htmlFor="src-call-text">{t("sources.call.transcript")}</label>
        <textarea
          className="sas-textarea" id="src-call-text" name="text" rows={8} maxLength={400000} placeholder={t("sources.call.paste_placeholder")} dir="auto"
          aria-describedby="src-call-text-hint" disabled={mode !== "paste"}
        />
        <span className="sas-hint" id="src-call-text-hint">{t("sources.call.paste_hint")} {t("sources.call.file_types")}</span>
      </div>
      <div className="sas-input-group" hidden={mode !== "file"} style={mode !== "file" ? { display: "none" } : undefined}>
        <label className="sas-input-label" htmlFor="src-call-file">{t("sources.call.file")}</label>
        <input className="sas-input" id="src-call-file" name="file" type="file" accept={accept} style={{ height: "auto", padding: 6 }} disabled={mode !== "file"} />
      </div>
      <label className="sas-check">
        <input type="checkbox" name="consent" required />
        <span>{t("sources.call.consent")}</span>
      </label>
      <CallFooterNotes />
    </form>
  );
}

/** Edit a call: name, rep, date and the transcript (masked again on save). */
export function CallEditForm({ slug, id, source }: { slug: string; id: string; source: { id: string; title: string; rep?: string; callDate?: string; text: string } }) {
  const [state, action, pending] = useActionState(updateCallAction, idle);
  const ref = useRef<HTMLFormElement>(null);
  useReportState(ref, pending);
  return (
    <form ref={ref} id={id} action={action} className="sas-stack-4">
      {hiddenSlug(slug, source.id)}
      <FormError state={state} id={`${id}-err`} />
      <CallMeta p="src-call-e" title={source.title} rep={source.rep} callDate={source.callDate} />
      <div className="sas-input-group">
        <label className="sas-input-label" htmlFor="src-call-e-text">{t("sources.call.transcript")}</label>
        <textarea className="sas-textarea" id="src-call-e-text" name="text" rows={14} required maxLength={400000} defaultValue={source.text} dir="auto" aria-describedby="src-call-e-hint" />
        <span className="sas-hint" id="src-call-e-hint">{t("sources.call.paste_hint")}</span>
      </div>
      <InfoNote>{t("sources.call.masked")}</InfoNote>
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

/**
 * The analysis Start button: one click only. While the request is on its way it is
 * disabled and says "Starting…", so a second click cannot start the run again.
 */
export function StartAnalysisButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="sas-btn sas-btn--primary sas-btn--sm" disabled={pending} aria-disabled={pending} data-analyze-start="">
      {pending ? t("pipeline.confirm.starting") : label}
    </button>
  );
}
