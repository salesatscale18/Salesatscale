import type { ButtonHTMLAttributes, ReactNode } from "react";
import { statusDef, type StatusObject, type StatusState } from "@/lib/domain/status";
import { t, type Locale, type MessageKey } from "@/lib/i18n";
import { Icon, type IconName } from "./icon";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "takeover" | "danger";

/** Class names for a button; use on <a> or Next <Link> when the action navigates. */
export function buttonClass(variant: ButtonVariant = "secondary", size: "md" | "sm" = "md"): string {
  return `sas-btn sas-btn--${variant}${size === "sm" ? " sas-btn--sm" : ""}`;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: "md" | "sm"; icon?: IconName }) {
  return (
    <button type={type} className={buttonClass(variant, size)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

/** A status pill: always an icon plus the exact word from the design system. */
export function StatusPill<O extends StatusObject>({ object, state }: { object: O; state: StatusState<O> }) {
  const def = statusDef(object, state);
  const tone = def.tone === "neutral" ? "" : ` sas-pill--${def.tone}`;
  return (
    <span className={`sas-pill${tone}`} data-status={`${object}.${state}`}>
      <Icon name={def.icon} />
      {t(`status.${object}.${state}` as MessageKey)}
    </span>
  );
}

export type Provenance = "buyer" | "inferred" | "verified";
const PROVENANCE_ICON: Record<Provenance, IconName> = {
  buyer: "message-square",
  inferred: "sparkles",
  verified: "shield-check",
};

/** Who a fact came from: Buyer said, Agent inferred or Verified. */
export function ProvenanceTag({ kind }: { kind: Provenance }) {
  return (
    <span className={`sas-prov sas-prov--${kind}`}>
      <Icon name={PROVENANCE_ICON[kind]} />
      {t(`provenance.${kind}`)}
    </span>
  );
}

export type Actor = "buyer" | "agent" | "human" | "system";

export function Avatar({ actor, initials, label }: { actor: Actor; initials?: string; label?: string }) {
  const cls = actor === "agent" || actor === "human" ? `sas-av sas-av--${actor}` : "sas-av";
  const content =
    actor === "agent" ? <Icon name="sparkles" /> : initials ? initials : <Icon name={actor === "system" ? "cog" : "user"} />;
  return (
    <span className={cls} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {content}
    </span>
  );
}

/** Small mono chip, used for agent trace items (tools and knowledge used). */
export function Chip({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <span className="sas-chip">
      {icon ? <Icon name={icon} /> : null}
      {children}
    </span>
  );
}

/** Wraps other-direction text with its own dir and lang (design system › RTL). */
export function LocalizedText({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <span lang={locale} dir={locale === "he" ? "rtl" : "ltr"}>
      {children}
    </span>
  );
}
