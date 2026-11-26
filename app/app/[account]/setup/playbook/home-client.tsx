"use client";

import { useEffect, useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { partForAnchor } from "@/lib/agent/playbook-parts";

/**
 * Old links to the one-page playbook (#pb-lim-h-s, #pb-opener-h, …) land on
 * the part that holds that section now. Runs once on home; no anchor, no move.
 */
export function AnchorRedirect({ home }: { home: string }) {
  useEffect(() => {
    const part = partForAnchor(window.location.hash);
    if (part) window.location.replace(`${home}/${part}`);
  }, [home]);
  return null;
}

/** "How it sounds": the first message from the draft, with an English / Hebrew switch when the account sells in both. */
export function HowItSounds({ texts }: { texts: Partial<Record<Locale, string>> }) {
  const langs = (["en", "he"] as const).filter((l) => texts[l]);
  const [lang, setLang] = useState<Locale>(langs[0] ?? "en");
  return (
    <div className="sas-stack-2" style={{ gap: 10 }}>
      <div className="pb-aside__head">
        <h2 className="sas-heading" id="pb-sounds-h">{t("playbook.sounds.title")}</h2>
        {langs.length > 1 ? (
          <span className="pb-seg" role="group" aria-label={t("playbook.opening.language")}>
            {langs.map((l) => (
              <button key={l} type="button" aria-pressed={l === lang} onClick={() => setLang(l)}>{t(l === "en" ? "playbook.opening.english" : "playbook.opening.hebrew")}</button>
            ))}
          </span>
        ) : null}
      </div>
      <p className="pb-bubble" lang={lang} dir={lang === "he" ? "rtl" : "ltr"} data-testid="how-it-sounds">{texts[lang]}</p>
      <span className="sas-small">{t("playbook.sounds.sub")}</span>
    </div>
  );
}
