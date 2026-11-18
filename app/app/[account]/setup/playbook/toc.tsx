"use client";

import { useEffect, useRef, useState } from "react";
import { t, type MessageKey } from "@/lib/i18n";
import "./playbook.css";

/** The playbook's sections; `spy` is the section on the Playbook page that marks the item as current. */
export const TOC_SECTIONS: { id: string; label: MessageKey; isNew?: boolean }[] = [
  { id: "pb-agent-h-s", label: "playbook.agent" },
  { id: "pb-goal-h-s", label: "playbook.goal" },
  { id: "pb-opener-h-s", label: "playbook.opener", isNew: true },
  { id: "pb-fields-h-s", label: "playbook.fields" },
  { id: "plays", label: "playbook.plays", isNew: true },
  { id: "pb-obj-h-s", label: "playbook.toc.objections" },
  { id: "pb-lim-h-s", label: "playbook.limits" },
  { id: "pb-never-h-s", label: "playbook.never" },
];
/** On the Playbook page, the Sales plays item follows the plays summary panel. */
const spyId = (id: string) => (id === "plays" ? "pb-plays-h-s" : id);

/** "New" tag on sections added in P11. */
export function NewTag() {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 4, padding: "0 4px", lineHeight: "16px" }}>
      {t("playbook.new")}
    </span>
  );
}

/**
 * The section in view: the last one whose top has passed 30% of the viewport
 * (the first one before any has). Pure, for the scroll-spy and its test.
 */
export function sectionInView(tops: { id: string; top: number }[], viewport: number): string | null {
  if (!tops.length) return null;
  const line = viewport * 0.3;
  let current = tops[0].id;
  for (const s of tops) if (s.top <= line) current = s.id;
  return current;
}

/**
 * The playbook's section list (canvas: PlaybookOpening, PlaybookPlays). Sales
 * plays is its own page. Server-rendered links work without JS; on the
 * Playbook page a scroll-spy (IntersectionObserver) marks the section in view.
 * Sticky beside the sections; below 1100px a sticky chip strip that scrolls
 * sideways, keeping the current item in view (playbook.css).
 */
export function PlaybookToc({ playbookHref, playsHref, current }: { playbookHref: string; playsHref: string; current?: "plays" }) {
  const [active, setActive] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    if (current || typeof IntersectionObserver === "undefined") return;
    const els = TOC_SECTIONS.map((s) => document.getElementById(spyId(s.id))).filter((x): x is HTMLElement => !!x);
    if (!els.length) return;
    const update = () => {
      const id = sectionInView(els.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top })), window.innerHeight);
      setActive(TOC_SECTIONS.find((s) => spyId(s.id) === id)?.id ?? null);
    };
    // Fires when a section's top or bottom crosses the 30% line.
    const io = new IntersectionObserver(update, { rootMargin: "0px 0px -70% 0px", threshold: [0, 1] });
    els.forEach((el) => io.observe(el));
    update();
    return () => io.disconnect();
  }, [current]);

  const shown = current === "plays" ? "plays" : active;
  useEffect(() => {
    // Chip strip (horizontal): scroll the current item into the middle, without moving the page.
    const n = nav.current;
    const item = n?.querySelector<HTMLElement>("[aria-current]");
    if (!n || !item || n.scrollWidth <= n.clientWidth) return;
    n.scrollTo({ left: item.offsetLeft - (n.clientWidth - item.offsetWidth) / 2, behavior: "smooth" });
  }, [shown]);

  return (
    <nav ref={nav} aria-label={t("playbook.toc")} className="sas-subnav pb-toc" data-testid="playbook-toc">
      {TOC_SECTIONS.map((s) => (
        <a
          key={s.id} className="sas-subnav__item"
          href={s.id === "plays" ? playsHref : `${current ? playbookHref : ""}#${s.id}`}
          aria-current={s.id === shown ? (current ? "page" : "location") : undefined}
        >
          {t(s.label)}{s.isNew ? <NewTag /> : null}
        </a>
      ))}
    </nav>
  );
}
