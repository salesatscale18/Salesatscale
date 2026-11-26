/**
 * A browser harness for the (i) button (tests/e2e/info-tip.spec.ts): the real InfoTip in rows shaped
 * like the Playbook's (label with its (i), value, Change on the right), one near the bottom of the
 * screen, inside a panel that hides its overflow. Served by tests/e2e/helpers/harness.ts.
 */
import type { CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { InfoTip } from "@/components/sas/info-tip";

// A phone lays the page out at its own width (the harness page has no viewport tag).
const meta = document.createElement("meta");
meta.name = "viewport";
meta.content = "width=device-width,initial-scale=1";
document.head.appendChild(meta);

const row = (label: string, text: string, value: string, extra?: { style?: CSSProperties }) => (
  <div data-info-scope="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 180px) minmax(0, 1fr) auto", gap: 16, padding: "14px 20px", borderTop: "1px solid var(--line)", ...extra?.style }} data-row={label}>
    <span>{label}<InfoTip label={label}>{text}</InfoTip></span>
    <span>{value}</span>
    <span data-info-avoid=""><button type="button" data-change={label}>Change</button></span>
  </div>
);

createRoot(document.getElementById("root")!).render(
  <div style={{ padding: 16 }}>
    <button type="button" data-before="">Before</button>
    <section className="sas-panel" style={{ overflow: "hidden", marginTop: 16 }}>
      {row("Speaks as", "Grammar only, for languages like Hebrew.", "Female")}
      {row("Discount without approval", "Above this, the quote waits for your approval.", "5% maximum")}
      {row("Approved exceptions", "Special terms you approved. A quote that uses one waits for your approval.", "None yet", { style: { marginTop: "calc(100vh - 260px)" } })}
    </section>
    <p data-outside="" style={{ padding: 40 }}>Outside</p>
  </div>,
);
