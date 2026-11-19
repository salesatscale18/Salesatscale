import type { ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { ProvenanceTag } from "@/components/sas/primitives";
import { t } from "@/lib/i18n";
import type { DealPane, PaneField } from "@/lib/leads/deal-pane";

/**
 * The green circle-check after a verified value (W3): on the value's line, with
 * the source and date as tooltip and accessible label.
 */
function VerifiedMark({ title }: { title: string }) {
  return (
    <span className="sas-verified" role="img" aria-label={title} title={title} data-verified="">
      <Icon name="check-circle" />
    </span>
  );
}

/** A last word longer than this keeps only its last TAIL_CHARS characters with the check, so a long email can still wrap. */
const TAIL_WORD_MAX = 12;
const TAIL_CHARS = 6;

/**
 * Splits a value so its end can stay on one line with the check (W6): the
 * last word, or for a long last word only its short end (".example" of
 * "ronit@bakery-demo.example", else its last few characters). The head keeps
 * wrapping as before.
 */
export function verifiedTail(value: string): { head: string; tail: string } {
  const m = /^([\s\S]*\s)?(\S+)$/.exec(value);
  if (!m) return { head: value, tail: "" };
  const before = m[1] ?? "";
  const word = m[2];
  if (word.length <= TAIL_WORD_MAX) return { head: before, tail: word };
  // A long word: from its last ".", "@", "-", "_" or "/" when that end is short (".example"), else its last few characters.
  const cut = Math.max(...[".", "@", "-", "_", "/"].map((c) => word.lastIndexOf(c)));
  if (cut > 0 && word.length - cut <= TAIL_WORD_MAX) return { head: before + word.slice(0, cut), tail: word.slice(cut) };
  const chars = Array.from(word);
  return { head: before + chars.slice(0, -TAIL_CHARS).join(""), tail: chars.slice(-TAIL_CHARS).join("") };
}

/** A verified value with the check inline after its last word, never alone on a line or at the row's far edge (W6). */
function VerifiedValue({ value, title }: { value: unknown; title: string }) {
  const { head, tail } = verifiedTail(String(value).trimEnd());
  return (
    <span className="sas-verified-value">
      {head}
      <span className="sas-verified-tail">{tail}<VerifiedMark title={title} /></span>
    </span>
  );
}

/**
 * Deal fields, as DealStateFields shows them, except a verified value carries
 * the circle-check right after it instead of the "Verified" pill, so values
 * stop wrapping. "Agent inferred" and "Buyer said" keep their tags.
 */
function PaneFields({ fields }: { fields: PaneField[] }) {
  return (
    <dl className="sas-fields">
      {fields.map((f) => {
        const missing = f.value === undefined || f.value === null || f.value === "";
        return (
          <div key={f.key} className={missing ? "sas-field sas-field--missing" : "sas-field"}>
            <dt className="sas-field__label">{f.label}</dt>
            <dd className="sas-field__value">
              {missing ? t("deal_state.missing") : f.verified ? <VerifiedValue value={f.value} title={f.verified.title} /> : f.value}
              {!missing && f.provenance && !f.verified ? <ProvenanceTag kind={f.provenance} /> : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The deal state as the lead page and Conversations show it (one component,
 * data from lib/leads/deal-pane.ts): known fields, the order-form details not
 * known yet in one line that opens, objections, the next step, then whatever
 * the page adds right under it (`afterNextStep`: the consent line on the lead page).
 */
export function DealStatePane({ pane, afterNextStep }: { pane: DealPane; afterNextStep?: ReactNode }) {
  if (pane.state !== "fields") {
    return (
      <>
        <p className="sas-small" style={{ margin: 0 }}>{t(pane.state === "none" ? "lead.card.learn_none" : "lead.card.learn_pending")}</p>
        {afterNextStep}
      </>
    );
  }
  return (
    <div className="sas-stack-4" data-testid="deal-pane">
      <div>
        <PaneFields fields={pane.shown} />
        {pane.formVerified ? (
          <p className="sas-small sas-verified-note" data-testid="verified-note">
            <span className="sas-verified" aria-hidden="true"><Icon name="check-circle" /></span>
            {t("lead.card.verified_note")}
          </p>
        ) : null}
      </div>
      {pane.laterUnknown.length ? (
        <details className="sas-lead__unknown" data-testid="unknown-group">
          <summary>{t("lead.card.unknown_group", { count: pane.laterUnknown.length })}</summary>
          <PaneFields fields={pane.laterUnknown} />
        </details>
      ) : null}
      {pane.objections.length ? (
        <div className="sas-stack-2">
          <span className="sas-group-label">{t("lead.card.objections")}</span>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>{pane.objections.map((o, i) => <li key={i}>{o.text}{o.handled ? " ✓" : ""}</li>)}</ul>
        </div>
      ) : null}
      {pane.nextStep ? <div className="sas-stack-2" data-testid="next-step"><span className="sas-group-label">{t("lead.card.next_step")}</span><span>{pane.nextStep}</span></div> : null}
      {afterNextStep}
    </div>
  );
}
