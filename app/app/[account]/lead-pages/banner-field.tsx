"use client";

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { BANNER_ACCEPT, bannerFileProblem, fileSizeText } from "@/lib/lead-pages/banner-file";
import { useLeadPageFormState } from "./form-shell";

export type BannerFieldText = {
  title: string; hint: string; none: string; choose: string; replace: string; remove: string; off: string;
  /** "{name}" and "{size}" are filled in. */
  selected: string; wrongType: string;
  /** "{size}" is filled in. */
  tooBig: string; again: string; clear: string;
};

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k: string) => v[k] ?? m);

/**
 * The hand-over banner in the add/edit form. The chosen image shows at once in
 * the thumbnail (whole, the same contain rule as the saved one), with its name
 * and size. A file that is not JPG, PNG or WebP, or is over 2 MB, is refused here
 * with a message and never sent. The file input stays mounted while the other
 * fields come back with errors, so the chosen file is still there for the next
 * save. Nothing is uploaded until the rest of the page is valid (the action
 * saves the settings first). Server-side checks stay (magic bytes, 2 MB, no SVG).
 */
export function BannerField({ saved, uploads, removeButton, icons, text }: {
  /** The saved banner (edit), or null. */
  saved: { src: string; width: number; height: number } | null;
  /** False on Preview (no blob writes) or with no store: the note instead of the input. */
  uploads: boolean;
  /** The "Remove" submit button (edit with a saved banner). */
  removeButton: ReactNode;
  icons: { placeholder: ReactNode; upload: ReactNode };
  text: BannerFieldText;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<{ name: string; size: number; url: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const state = useLeadPageFormState();

  useEffect(() => () => { if (chosen) URL.revokeObjectURL(chosen.url); }, [chosen]);
  // A refused save that came with a file, but the input has none now: the errors came back with
  // a fresh page (the post went before the script ran), so the file is gone. Ask for it again.
  useEffect(() => {
    setLost(!!state?.bannerSent && !input.current?.files?.length);
  }, [state]);

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0] ?? null;
    setLost(false);
    if (!file) { setChosen(null); setProblem(null); return; }
    const p = bannerFileProblem(file);
    if (p) {
      // Never sent: the input is emptied and the reason shown.
      e.currentTarget.value = "";
      setChosen(null);
      setProblem(p === "wrong_type" ? text.wrongType : fill(text.tooBig, { size: fileSizeText(file.size) }));
      return;
    }
    setProblem(null);
    setChosen({ name: file.name, size: file.size, url: URL.createObjectURL(file) });
  };
  const clear = () => {
    if (input.current) input.current.value = "";
    setChosen(null);
    setProblem(null);
    setLost(false);
  };

  const shown = chosen ? { src: chosen.url, width: undefined, height: undefined } : saved;
  return (
    <div className="lpg-banner" data-banner-field="">
      <div className="lpg-banner__thumb" data-banner={chosen ? "chosen" : saved ? "image" : "none"}>
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shown.src} alt="" width={shown.width} height={shown.height} data-banner-preview={chosen ? "" : undefined} />
        ) : <span className="lpg-banner__initials" aria-hidden="true">{icons.placeholder}</span>}
      </div>
      <div className="lpg-banner__text">
        <strong>{text.title}</strong>
        <span className="sas-small">{text.hint}</span>
        {uploads ? (
          <span className="lpg-banner__actions">
            <label className="sas-btn sas-btn--secondary sas-btn--sm lpg-file">
              {icons.upload}
              {saved || chosen ? text.replace : text.choose}
              <input ref={input} type="file" name="banner" accept={BANNER_ACCEPT} onChange={onChange} />
            </label>
            {chosen ? <button type="button" className="sas-btn sas-btn--ghost sas-btn--sm" onClick={clear} data-banner-clear="">{text.clear}</button> : null}
            {saved && !chosen ? removeButton : null}
          </span>
        ) : <span className="sas-small" data-banner-off="">{text.off}</span>}
        {chosen ? (
          <span className="sas-small lpg-banner__chosen" role="status" data-banner-chosen="">
            {fill(text.selected, { name: chosen.name, size: fileSizeText(chosen.size) })}
          </span>
        ) : null}
        {problem ? <span className="lpg-field__err" role="alert" data-banner-problem="">{problem}</span> : null}
        {lost && !problem ? <span className="lpg-field__err" role="alert" data-banner-again="">{text.again}</span> : null}
        {!saved && !chosen ? <span className="sas-small">{text.none}</span> : null}
      </div>
    </div>
  );
}
