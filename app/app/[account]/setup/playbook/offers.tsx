"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon, type IconName } from "@/components/sas/icon";
import { buttonClass } from "@/components/sas/primitives";
import { t, type MessageKey } from "@/lib/i18n";
import { isOfferType, offerRowsOf, offersOf, type OfferRowInput, type OfferType } from "@/lib/agent/offer-settings";

/** One row in the editor: the switch and the numbers as typed. */
export type OfferRow = { type: OfferType; on: boolean; pct: string; units: string };

const ICON: Record<OfferType, IconName> = {
  smaller_start: "layers", more_units: "package", decide_now: "hourglass", general: "tags", pay_yearly: "calendar",
};
const name = (type: OfferType) => t(`playbook.offers.type.${type}` as MessageKey);

/** Active rows first (their order is the offer order), then the rows that are off. */
export function activeFirst(rows: readonly OfferRow[]): OfferRow[] {
  return [...rows.filter((r) => r.on), ...rows.filter((r) => !r.on)];
}

/**
 * The editor's starting rows: what was sent after a refused save (unknown or
 * repeated types dropped, missing ones taken from the stored list), else the
 * playbook's list (stored, or derived from its discount limit).
 */
export function offerRowsFor(p: { maxDiscountBp: number; offers?: unknown }, sent?: OfferRowInput[]): OfferRow[] {
  const stored: OfferRow[] = offerRowsOf(offersOf(p)).map((r) => ({ type: r.type as OfferType, on: r.on === "1", pct: r.pct, units: r.units }));
  if (!sent) return stored;
  const out: OfferRow[] = [];
  for (const r of sent) {
    if (!isOfferType(r.type) || out.some((x) => x.type === r.type)) continue;
    const s = stored.find((x) => x.type === r.type)!;
    out.push({ type: r.type, on: r.type === "smaller_start" || r.on === "1", pct: r.pct ?? s.pct, units: r.units ?? s.units });
  }
  for (const s of stored) if (!out.some((x) => x.type === s.type)) out.push({ ...s, on: s.type === "smaller_start" });
  return activeFirst(out);
}

/** The General discount as the old single limit read it (the never-do "Covered by Limits" check): its percent when on. */
export function generalLimit(rows: readonly OfferRow[]): string {
  const g = rows.find((r) => r.type === "general");
  return g?.on ? g.pct : "";
}

/** Moves the active row `type` by one place (rows that are off never move). */
export function moveActive(rows: readonly OfferRow[], type: OfferType, by: -1 | 1): OfferRow[] {
  const active = rows.filter((r) => r.on);
  const i = active.findIndex((r) => r.type === type);
  const j = i + by;
  if (i < 0 || j < 0 || j >= active.length) return [...rows];
  const next = [...active];
  [next[i], next[j]] = [next[j], next[i]];
  return [...next, ...rows.filter((r) => !r.on)];
}

/** Moves the active row `type` to place `to` (0-based among the active rows). */
function moveTo(rows: readonly OfferRow[], type: OfferType, to: number): OfferRow[] {
  const active = rows.filter((r) => r.on);
  const i = active.findIndex((r) => r.type === type);
  if (i < 0 || i === to) return [...rows];
  const next = active.filter((r) => r.type !== type);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, active[i]);
  return [...next, ...rows.filter((r) => !r.on)];
}

/** Switching a row on puts it last among the active ones; switching it off puts it first among the rows that are off. */
export function switchRow(rows: readonly OfferRow[], type: OfferType, on: boolean): OfferRow[] {
  const row = rows.find((r) => r.type === type);
  if (!row || row.type === "smaller_start") return [...rows];
  const rest = rows.filter((r) => r.type !== type);
  const active = rest.filter((r) => r.on);
  const off = rest.filter((r) => !r.on);
  return on ? [...active, { ...row, on: true }, ...off] : [...active, { ...row, on: false }, ...off];
}

/**
 * "Offers the agent may make" (Playbook › Limits; board OfferTool). The rows'
 * order is the offer order: drag the handle (mouse or touch), use the arrow
 * keys on the focused handle, or the ⋯ menu's Move up / Move down. The form
 * sends `offerOrder` and `offer.<type>.on|pct|units`; the server checks them
 * again (parseOfferRows).
 */
export function OffersPanel({ rows, onChange, errors, quoteValidDays }: {
  rows: OfferRow[];
  onChange: (rows: OfferRow[]) => void;
  errors: Record<string, string>;
  quoteValidDays: number;
}) {
  const [announce, setAnnounce] = useState("");
  const [menu, setMenu] = useState<OfferType | null>(null);
  const [dragging, setDragging] = useState<OfferType | null>(null);
  const items = useRef(new Map<OfferType, HTMLLIElement>());
  const handles = useRef(new Map<OfferType, HTMLButtonElement>());
  const active = rows.filter((r) => r.on);

  const said = (next: OfferRow[], type: OfferType) => {
    const act = next.filter((r) => r.on);
    const n = act.findIndex((r) => r.type === type) + 1;
    setAnnounce(t("playbook.offers.position", { name: name(type), n, of: act.length }));
  };
  const move = (type: OfferType, by: -1 | 1) => {
    const next = moveActive(rows, type, by);
    onChange(next);
    said(next, type);
  };

  // Close the ⋯ menu on Escape or a click elsewhere.
  useEffect(() => {
    if (!menu) return;
    const close = (ev: Event) => {
      if (ev instanceof globalThis.KeyboardEvent && ev.key !== "Escape") return;
      if (ev.type === "pointerdown" && (ev.target as Element | null)?.closest?.(`[data-offer-menu="${menu}"]`)) return;
      setMenu(null);
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", close); };
  }, [menu]);

  const onHandleKey = (ev: KeyboardEvent<HTMLButtonElement>, type: OfferType) => {
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      move(type, ev.key === "ArrowUp" ? -1 : 1);
    }
  };

  // Drag with pointer events (mouse, pen and touch): the row moves to where the pointer is among the active rows.
  const onDown = (ev: PointerEvent<HTMLButtonElement>, type: OfferType) => {
    if (ev.button !== 0) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    setDragging(type);
  };
  const onMove = (ev: PointerEvent<HTMLButtonElement>, type: OfferType) => {
    if (dragging !== type) return;
    const others = active.filter((r) => r.type !== type);
    let to = others.length;
    for (let k = 0; k < others.length; k++) {
      const box = items.current.get(others[k].type)?.getBoundingClientRect();
      if (box && ev.clientY < box.top + box.height / 2) { to = k; break; }
    }
    if (active.findIndex((r) => r.type === type) !== to) onChange(moveTo(rows, type, to));
  };
  const onUp = (ev: PointerEvent<HTMLButtonElement>, type: OfferType) => {
    if (dragging !== type) return;
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId);
    setDragging(null);
    said(rows, type);
  };

  const err = (key: string) => (errors[key] ? <span className="sas-error" id={`pb-${key}-error`}>{errors[key]}</span> : null);
  const invalid = (key: string) => (errors[key] ? { "aria-invalid": true as const, "aria-describedby": `pb-${key}-error` } : {});

  const numbers = (r: OfferRow) => {
    if (r.type === "smaller_start") return <span className="sas-small">{t("playbook.offers.no_discount")}</span>;
    const at = `offer.${r.type}`;
    return (
      <>
        <span className="pb-offer__num">
          <input
            className="sas-input sas-num" id={`pb-${at}.pct`} name={`${at}.pct`} inputMode="decimal" value={r.pct}
            aria-label={t("playbook.offers.pct_label", { name: name(r.type) })} {...invalid(`${at}.pct`)}
            onChange={(ev) => onChange(rows.map((x) => (x.type === r.type ? { ...x, pct: ev.target.value } : x)))}
          />
          <span aria-hidden="true">{t(r.type === "more_units" ? "playbook.offers.pct_unit_short" : "playbook.offers.pct_unit")}</span>
        </span>
        {r.type === "more_units" ? (
          <span className="pb-offer__num">
            <input
              className="sas-input sas-num" id={`pb-${at}.units`} name={`${at}.units`} inputMode="numeric" value={r.units}
              aria-label={t("playbook.offers.units_label", { name: name(r.type) })} {...invalid(`${at}.units`)}
              onChange={(ev) => onChange(rows.map((x) => (x.type === r.type ? { ...x, units: ev.target.value } : x)))}
            />
            <span aria-hidden="true">{t("playbook.offers.units_unit")}</span>
          </span>
        ) : null}
      </>
    );
  };

  return (
    <div className="sas-stack-2" data-testid="offers-panel">
      <div className="sas-stack-2" style={{ gap: 2 }}>
        <span className="sas-input-label" id="pb-offers-h">{t("playbook.offers.title")}</span>
        <span className="sas-hint">{t("playbook.offers.hint")}</span>
      </div>
      <input type="hidden" name="offerOrder" value={rows.map((r) => r.type).join(",")} />
      <ol className="pb-offers" aria-labelledby="pb-offers-h">
        {rows.map((r) => {
          const pos = r.on ? active.indexOf(r) : -1;
          const label = name(r.type);
          const at = `offer.${r.type}`;
          return (
            <li
              key={r.type} ref={(el) => { if (el) items.current.set(r.type, el); else items.current.delete(r.type); }}
              className={`pb-offer${r.on ? "" : " pb-offer--off"}${dragging === r.type ? " pb-offer--drag" : ""}`}
              data-offer={r.type} data-on={r.on ? "1" : "0"}
            >
              <span className="pb-offer__handle">
                {r.on ? (
                  <button
                    type="button" className="pb-offer__grip" ref={(el) => { if (el) handles.current.set(r.type, el); else handles.current.delete(r.type); }}
                    aria-label={t("playbook.offers.handle", { name: label })}
                    onKeyDown={(ev) => onHandleKey(ev, r.type)} onPointerDown={(ev) => onDown(ev, r.type)} onPointerMove={(ev) => onMove(ev, r.type)}
                    onPointerUp={(ev) => onUp(ev, r.type)} onPointerCancel={(ev) => onUp(ev, r.type)}
                  ><Icon name="grip" /></button>
                ) : null}
              </span>
              <span className={`pb-offer__place${r.on ? "" : " pb-offer__place--off"}`}>{r.on ? pos + 1 : <><span aria-hidden="true">–</span><span className="sas-sr">{t("playbook.offers.off")}</span></>}</span>
              <span className="pb-offer__main">
                <span className="pb-offer__icon" aria-hidden="true"><Icon name={ICON[r.type]} /></span>
                <span className="sas-stack-2" style={{ gap: 2, minWidth: 0 }}>
                  <strong>{label}</strong>
                  <span className="sas-small">
                    {t(`playbook.offers.about.${r.type}` as MessageKey, { days: quoteValidDays })}
                    {r.type === "pay_yearly" ? <> {t("playbook.offers.yearly_note")}</> : null}
                  </span>
                </span>
              </span>
              <span className="pb-offer__nums">{numbers(r)}</span>
              <span className="pb-offer__end">
                {r.type === "smaller_start" ? (
                  <span className="sas-small pb-offer__always">{t("playbook.offers.always_on")}</span>
                ) : (
                  <>
                    <input type="hidden" name={`${at}.on`} value={r.on ? "1" : "0"} />
                    <input
                      type="checkbox" role="switch" className="sas-switch" checked={r.on} aria-label={t("playbook.offers.switch", { name: label })}
                      onChange={(ev) => { const next = switchRow(rows, r.type, ev.target.checked); onChange(next); if (ev.target.checked) said(next, r.type); else setAnnounce(t("playbook.offers.off_label", { name: label })); }}
                    />
                  </>
                )}
                {r.on ? (
                  <span className="pb-offer__menu" data-offer-menu={r.type}>
                    <button
                      type="button" className={buttonClass("ghost", "sm")} aria-haspopup="menu" aria-expanded={menu === r.type}
                      aria-label={t("playbook.offers.menu", { name: label })} onClick={() => setMenu(menu === r.type ? null : r.type)}
                    ><Icon name="ellipsis" /></button>
                    {menu === r.type ? (
                      <span className="pb-offer__pop" role="menu" aria-label={t("playbook.offers.menu", { name: label })}>
                        <button type="button" role="menuitem" disabled={pos === 0} autoFocus={pos !== 0} onClick={() => { setMenu(null); move(r.type, -1); handles.current.get(r.type)?.focus(); }}>
                          <Icon name="arrow-up" />{t("playbook.offers.move_up")}
                        </button>
                        <button type="button" role="menuitem" disabled={pos === active.length - 1} autoFocus={pos === 0} onClick={() => { setMenu(null); move(r.type, 1); handles.current.get(r.type)?.focus(); }}>
                          <Icon name="arrow-down" />{t("playbook.offers.move_down")}
                        </button>
                      </span>
                    ) : null}
                  </span>
                ) : <span className="pb-offer__menu" aria-hidden="true" />}
              </span>
              {errors[`${at}.pct`] || errors[`${at}.units`] ? <span className="pb-offer__err">{err(`${at}.pct`)}{err(`${at}.units`)}</span> : null}
            </li>
          );
        })}
        <li className="pb-offer pb-offer--pinned" data-offer="above">
          <span className="pb-offer__handle pb-offer__lock" aria-hidden="true"><Icon name="lock" /></span>
          <span className="pb-offer__place pb-offer__place--off" aria-hidden="true" />
          <span className="pb-offer__main">
            <span className="pb-offer__icon pb-offer__icon--none" aria-hidden="true" />
            <span className="sas-stack-2" style={{ gap: 2, minWidth: 0 }}>
              <strong>{t("playbook.offers.above")}</strong>
              <span className="sas-small">{t("playbook.offers.above_hint")}</span>
            </span>
          </span>
          <span className="pb-offer__nums" />
          <span className="pb-offer__end"><span className="sas-small pb-offer__always">{t("playbook.offers.always_last")}</span></span>
        </li>
      </ol>
      <div id="pb-offers-live" className="sas-sr" aria-live="polite" role="status">{announce}</div>
      {err("offers")}
    </div>
  );
}
