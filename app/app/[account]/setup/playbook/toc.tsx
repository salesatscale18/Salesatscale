import { t, type MessageKey } from "@/lib/i18n";

const SECTIONS: { id: string; label: MessageKey; isNew?: boolean }[] = [
  { id: "pb-agent-h-s", label: "playbook.agent" },
  { id: "pb-goal-h-s", label: "playbook.goal" },
  { id: "pb-opener-h-s", label: "playbook.opener", isNew: true },
  { id: "pb-fields-h-s", label: "playbook.fields" },
  { id: "plays", label: "playbook.plays", isNew: true },
  { id: "pb-obj-h-s", label: "playbook.toc.objections" },
  { id: "pb-lim-h-s", label: "playbook.limits" },
  { id: "pb-never-h-s", label: "playbook.never" },
];

/** "New" tag on sections added in P11. */
export function NewTag() {
  return (
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--primary)", border: "1px solid var(--primary)", borderRadius: 4, padding: "0 4px", lineHeight: "16px" }}>
      {t("playbook.new")}
    </span>
  );
}

/** The playbook's section list (canvas: PlaybookOpening, PlaybookPlays). Sales plays is its own page. */
export function PlaybookToc({ playbookHref, playsHref, current }: { playbookHref: string; playsHref: string; current?: "plays" }) {
  return (
    <nav aria-label={t("playbook.toc")} className="sas-subnav">
      {SECTIONS.map((s) => (
        <a
          key={s.id} className="sas-subnav__item" style={{ justifyContent: "space-between", gap: 8 }}
          href={s.id === "plays" ? playsHref : `${current ? playbookHref : ""}#${s.id}`}
          aria-current={s.id === "plays" && current === "plays" ? "page" : undefined}
        >
          {t(s.label)}{s.isNew ? <NewTag /> : null}
        </a>
      ))}
    </nav>
  );
}
