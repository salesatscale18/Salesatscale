"use client";

import { useActionState } from "react";
import { StatusPill, buttonClass } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import { checkSampleAction, type SampleState } from "./actions";

/** "Check a sample" (UX decision): validates a JSON body like a real delivery, saves nothing. */
export function SampleCheck({ slug, example }: { slug: string; example: string }) {
  const [state, action, pending] = useActionState<SampleState, FormData>(checkSampleAction, { status: "idle" });
  return (
    <form action={action} className="sas-stack-2">
      <input type="hidden" name="slug" value={slug} />
      <strong>{t("settings.sample.title")}</strong>
      <span className="sas-small">{t("settings.sample.body")}</span>
      <label className="sas-sr" htmlFor="sample">{t("settings.sample.label")}</label>
      <textarea id="sample" name="sample" className="sas-textarea sas-num" rows={8} defaultValue={example} spellCheck={false} dir="ltr" />
      <div><button type="submit" className={buttonClass("secondary", "sm")} disabled={pending}>{t("settings.sample.check")}</button></div>
      {state.status === "checked" ? (
        <div className="sas-stack-2" role="status" aria-live="polite">
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <StatusPill object="intake_result" state={state.result} />
            <span>{state.text}</span>
          </span>
          <span className="sas-hint">{t("settings.sample.nothing_saved")}</span>
        </div>
      ) : null}
    </form>
  );
}
