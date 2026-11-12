import type { ReactNode } from "react";
import { t } from "@/lib/i18n";
import { Icon, type IconName } from "./icon";
import { ProvenanceTag, type Actor, type Provenance } from "./primitives";

export type TimelineItem = {
  id: string;
  actor: Actor;
  icon: IconName;
  title: ReactNode;
  detail?: ReactNode;
  time: string;
};

/** A lead's unified timeline (messages, quotes, forms, payments, meetings). */
export function Timeline({ items, label }: { items: TimelineItem[]; label: string }) {
  return (
    <ol className="sas-tl" aria-label={label}>
      {items.map((it) => (
        <li key={it.id} className="sas-tl__item">
          <span className={it.actor === "agent" || it.actor === "human" ? `sas-av sas-av--${it.actor}` : "sas-av"} aria-hidden="true">
            <Icon name={it.icon} />
          </span>
          <div className="sas-tl__body">
            <span className="sas-tl__title">{it.title}</span>
            {it.detail ? <span className="sas-tl__detail">{it.detail}</span> : null}
          </div>
          <span className="sas-tl__time">{it.time}</span>
        </li>
      ))}
    </ol>
  );
}

export type DealField = { key: string; label: string; value?: ReactNode; provenance?: Provenance };

/** Deal-state fields: value plus provenance, or "Not known yet" when missing. */
export function DealStateFields({ fields, groupLabel }: { fields: DealField[]; groupLabel?: string }) {
  return (
    <div>
      {groupLabel ? <div className="sas-group-label">{groupLabel}</div> : null}
      <dl className="sas-fields">
        {fields.map((f) => {
          const missing = f.value === undefined || f.value === null || f.value === "";
          return (
            <div key={f.key} className={missing ? "sas-field sas-field--missing" : "sas-field"}>
              <dt className="sas-field__label">{f.label}</dt>
              <dd className="sas-field__value">
                {missing ? t("deal_state.missing") : f.value}
                {!missing && f.provenance ? <ProvenanceTag kind={f.provenance} /> : null}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

export type WindowState = "open" | "closing" | "closed";

/** The WhatsApp 24-hour service window. `remaining` is preformatted, e.g. "18h 20m". */
export function WindowTimer({ state, remaining }: { state: WindowState; remaining?: string }) {
  const text =
    state === "closed"
      ? t("window.closed")
      : t(state === "open" ? "window.open" : "window.closing", { time: remaining ?? "" });
  return (
    <span className={`sas-window sas-window--${state}`} role="status">
      <Icon name={state === "closed" ? "pause" : "clock"} />
      {text}
    </span>
  );
}

export function MetricTile({
  label,
  value,
  delta,
  trend,
}: {
  label: string;
  value: ReactNode;
  delta?: string;
  trend?: "up" | "down";
}) {
  return (
    <div className="sas-metric">
      <span className="sas-metric__label">{label}</span>
      <span className="sas-metric__value">{value}</span>
      {delta ? <span className={trend ? `sas-metric__delta sas-metric__delta--${trend}` : "sas-metric__delta"}>{delta}</span> : null}
    </div>
  );
}

const BANNER_ICON = { acting: "building", takeover: "user", test: "flask-conical", paused: "pause" } as const satisfies Record<string, IconName>;

/** Full-width banner: acting as (platform admin inside an account), takeover, test mode, account paused. */
export function Banner({
  kind,
  children,
  action,
}: {
  kind: keyof typeof BANNER_ICON;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`sas-banner sas-banner--${kind}`} role="status">
      <Icon name={BANNER_ICON[kind]} />
      <span className="sas-banner__text">{children}</span>
      {action}
    </div>
  );
}
