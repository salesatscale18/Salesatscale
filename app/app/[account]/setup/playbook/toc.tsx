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

/** The scroll-spy's switch line: px from the top of the viewport, just under the sticky offset. */
export const SPY_LINE = 160;

/**
 * The section in view: the last one whose heading (its top) has passed the switch
 * line (the first one before any has). Pure, for the scroll-spy and its test.
 */
export function sectionInView(tops: { id: string; top: number }[], line: number = SPY_LINE): string | null {
  if (!tops.length) return null;
  let current = tops[0].id;
  for (const s of tops) if (s.top <= line) current = s.id;
  return current;
}

/**
 * The blank space the sections column needs after its content, so the last section
 * can scroll up to its scroll margin (by a TOC click) and no further. Pure: `lastTop`
 * is the last section's top in page coordinates, `pageHeight` the page's height
 * without this space.
 */
export function tailSpace({ lastTop, scrollMargin, viewport, pageHeight }: { lastTop: number; scrollMargin: number; viewport: number; pageHeight: number }): number {
  return Math.max(0, Math.ceil(lastTop - scrollMargin + viewport - pageHeight));
}

/**
 * The playbook's section list (canvas: PlaybookOpening, PlaybookPlays). Sales
 * plays is its own page. Server-rendered links work without JS; on the
 * Playbook page a scroll-spy marks the section in view and sizes the space after the last section.
 * Sticky beside the sections; below 1100px a sticky chip strip that scrolls
 * sideways, keeping the current item in view (playbook.css).
 */
export function PlaybookToc({ playbookHref, playsHref, current }: { playbookHref: string; playsHref: string; current?: "plays" }) {
  const [active, setActive] = useState<string | null>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    if (current) return;
    const els = TOC_SECTIONS.map((s) => document.getElementById(spyId(s.id))).filter((x): x is HTMLElement => !!x);
    if (!els.length) return;
    const main = nav.current?.parentElement?.querySelector<HTMLElement>(".pb-main--spy") ?? null;
    let frame = 0;
    const update = () => {
      frame = 0;
      const id = sectionInView(els.map((el) => ({ id: el.id, top: el.getBoundingClientRect().top })));
      setActive(TOC_SECTIONS.find((s) => spyId(s.id) === id)?.id ?? null);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    // Size the blank space after the form to what the last section needs to reach the top.
    const size = () => {
      if (!main) return;
      const last = els[els.length - 1];
      const own = parseFloat(getComputedStyle(main).paddingBlockEnd) || 0;
      const space = tailSpace({
        lastTop: last.getBoundingClientRect().top + window.scrollY,
        scrollMargin: parseFloat(getComputedStyle(last).scrollMarginTop) || 0,
        viewport: window.innerHeight,
        pageHeight: document.documentElement.scrollHeight - own,
      });
      main.style.paddingBlockEnd = `${space}px`;
      onScroll();
    };
    size();
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", size);
    const ro = typeof ResizeObserver === "undefined" || !main ? null : new ResizeObserver(size);
    if (main) ro?.observe(main.firstElementChild ?? main);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", size);
      ro?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
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
