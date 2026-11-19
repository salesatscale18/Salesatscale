import type { translator } from "@/lib/i18n";
import { CopyValue } from "./copy-value";

type Translator = ReturnType<typeof translator>;

export type BankPart = { kind: "text"; text: string } | { kind: "branch" | "account"; value: string };

const LABELED = /^(branch|account(?:\s+(?:no\.?|number))?)\s*[:#]?\s*(.+)$/i;

/**
 * The seller's bank details split into parts (one per line or " · " part).
 * A part that starts with "branch" or "account" is a labelled value, so the
 * label can be shown in the buyer's language; everything else (the bank's
 * name) stays exactly as the seller wrote it. Pure. R5-4.
 */
export function bankParts(details: string): BankPart[] {
  return details.split(/\n| · /).map((p) => p.trim()).filter(Boolean).map((p): BankPart => {
    const m = p.match(LABELED);
    if (!m) return { kind: "text", text: p };
    return { kind: m[1].toLowerCase().startsWith("branch") ? "branch" : "account", value: m[2].trim() };
  });
}

/** The bank transfer details: the reference and the account with Copy buttons, labels translated. */
export function BankDetails({ details, reference, tr }: { details: string | null; reference: string; tr: Translator }) {
  const copy = { label: tr("buyer.copy"), copied: tr("buyer.copied") };
  const parts = details ? bankParts(details) : [];
  return (
    <dl className="b-bank" data-bank-details="">
      <div><dt>{tr("buyer.bank_reference")}</dt><dd><bdi className="b-num">{reference}</bdi><CopyValue value={reference} name={tr("buyer.bank_reference")} {...copy} /></dd></div>
      {parts.map((p, i) => p.kind === "text" ? (
        // The first unlabelled part is the bank's name, as the seller wrote it ("Bank" / "בנק"); any other stays unlabelled.
        <div key={i} data-bank-text="">{i === parts.findIndex((q) => q.kind === "text") ? <dt>{tr("buyer.bank_name")}</dt> : null}<dd><bdi>{p.text}</bdi></dd></div>
      ) : (
        <div key={i} data-bank-part={p.kind}>
          <dt>{tr(p.kind === "branch" ? "buyer.bank_branch" : "buyer.bank_account")}</dt>
          <dd><bdi className="b-num">{p.value}</bdi>{p.kind === "account" ? <CopyValue value={p.value} name={tr("buyer.bank_account")} {...copy} /> : null}</dd>
        </div>
      ))}
    </dl>
  );
}
