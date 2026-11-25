"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { Icon } from "./icon";

type Status = { running: boolean; last: { id: string; status: string; error: string | null } | null };

/**
 * On-screen notice for the source analysis, on every page of the account:
 * "Analyzing your sources…" while a run goes (the page can be used meanwhile),
 * then "Analysis finished" (or stopped) with a link. Polls the account's
 * /analysis-status every 5 s only while a run goes; nothing shows otherwise.
 */
export function AnalysisNotice({ base, running: initial }: { base: string; running: boolean }) {
  const [running, setRunning] = useState(initial);
  const [ended, setEnded] = useState<Status["last"]>(null);
  const was = useRef(initial);
  useEffect(() => setRunning(initial), [initial]);
  useEffect(() => {
    if (!running) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/analysis-status`, { cache: "no-store" });
        if (!res.ok) return;
        const s = (await res.json()) as Status;
        if (stop) return;
        if (!s.running) {
          setRunning(false);
          if (was.current) setEnded(s.last);
        }
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    };
    const id = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [running, base]);
  useEffect(() => { if (running) was.current = true; }, [running]);

  if (running) {
    return (
      <div className="sas-toast" role="status" aria-live="polite" data-analysis-notice="running">
        <span className="sas-toast__spin" aria-hidden="true" />
        <span className="sas-toast__text"><strong>{t("pipeline.notice.running")}</strong><span>{t("pipeline.notice.running_sub")}</span></span>
        <a className="sas-toast__link" href={`${base}/setup/sources`}>{t("pipeline.notice.view")}</a>
      </div>
    );
  }
  if (!ended) return null;
  const ok = ended.status === "done";
  return (
    <div className={ok ? "sas-toast sas-toast--done" : "sas-toast sas-toast--failed"} role="status" aria-live="polite" data-analysis-notice={ok ? "done" : "failed"}>
      <Icon name={ok ? "check-circle" : "alert-triangle"} />
      <span className="sas-toast__text"><strong>{t(ok ? "pipeline.notice.done" : "pipeline.notice.failed")}</strong>{!ok && ended.error ? <span>{ended.error}</span> : null}</span>
      <a className="sas-toast__link" href={ok ? `${base}/setup/knowledge` : `${base}/setup/sources`}>{t(ok ? "pipeline.notice.review" : "pipeline.notice.view")}</a>
      <button type="button" className="sas-toast__close" onClick={() => setEnded(null)} aria-label={t("pipeline.notice.close")}><Icon name="x" /></button>
    </div>
  );
}
