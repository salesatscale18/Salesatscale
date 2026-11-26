"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Icon, type IconName } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import { moveOffer, switchOffer, type OfferChange, type OfferType, type StoredOffer } from "@/lib/agent/offer-settings";
import type { PlaybookPart } from "@/lib/agent/playbook-parts";
import { EditRow, OtherErrors, PartRows, useFocusTarget, useRowSave, useRows, type ErrorOf } from "./row";
import { SortHelp, useSortable } from "./sortable";
import { InfoTip } from "@/components/sas/info-tip";
import { LockTag } from "./parts";
import "./playbook.css";

/** `edit`: the row opened first (from `?edit=offer.<type>`). */
type Base = { slug: string; hrefs: Record<PlaybookPart, string>; edit?: string | null };

const ICON: Record<OfferType, IconName> = {
  smaller_start: "layers", more_units: "package", decide_now: "hourglass", general: "tags", pay_yearly: "calendar",
};
const name = (type: OfferType) => t(`playbook.offers.type.${type}` as MessageKey);
const val = (form: FormData, key: string) => String(form.get(key) ?? "");
const aria = (id: string, msg?: string) => ({ "aria-invalid": msg ? (true as const) : undefined, "aria-describedby": msg ? `${id}-error` : undefined });

/** An offer's numbers as read: "5% off at most", "5% off from 10 units", "No discount". */
export function offerNumbers(o: StoredOffer): string {
  if (o.type === "smaller_start") return t("playbook.offers.no_discount");
  const pct = (o.percentBp ?? 0) / 100;
  return o.type === "more_units" ? t("playbook.offers.read_units", { pct, units: o.minUnits ?? 0 }) : t("playbook.offers.read_pct", { pct });
}

/** An offer's numbers, changed in its row (the server checks them again: parseOfferRows). */
function NumbersEditor({ o, e }: { o: StoredOffer; e: ErrorOf }) {
  const at = `offer.${o.type}`;
  return (
    <span className="pb-offer__nums">
      <span className="pb-offer__num">
        <input
          className="sas-input sas-num" id={`pb-${at}.pct`} name="pct" inputMode="decimal" defaultValue={String((o.percentBp ?? 0) / 100)}
          aria-label={t("playbook.offers.pct_label", { name: name(o.type) })} {...aria(`pb-${at}.pct`, e(`${at}.pct`))}
        />
        <span aria-hidden="true">{t(o.type === "more_units" ? "playbook.offers.pct_unit_short" : "playbook.offers.pct_unit")}</span>
      </span>
      {o.type === "more_units" ? (
        <span className="pb-offer__num">
          <input
            className="sas-input sas-num" id={`pb-${at}.units`} name="units" inputMode="numeric" defaultValue={String(o.minUnits ?? "")}
            aria-label={t("playbook.offers.units_label", { name: name(o.type) })} {...aria(`pb-${at}.units`, e(`${at}.units`))}
          />
          <span aria-hidden="true">{t("playbook.offers.units_unit")}</span>
        </span>
      ) : null}
      {e(`${at}.pct`) ? <span className="sas-error" id={`pb-${at}.pct-error`}>{e(`${at}.pct`)}</span> : null}
      {e(`${at}.units`) ? <span className="sas-error" id={`pb-${at}.units-error`}>{e(`${at}.units`)}</span> : null}
    </span>
  );
}

/**
 * Offers (board PlaybookOffers; the list approved 23 Nov, board OfferTool):
 * the offers the agent may make after a price objection, one at a time, in
 * this order. Read first; each change saves ONE row (savePlaybookChange):
 * an offer's numbers (Change), its switch, or its place among the active
 * ones (drag the handle, ↑ / ↓ on the focused handle, or ⋯ Move up / Move
 * down). Rows that are off sit below without a number; "Anything above
 * these" (the seller's approval) is pinned last. `offers`: the stored list,
 * or the one derived from the discount limit (offersOf).
 */
export function OffersRows({ slug, hrefs, edit, offers, quoteValidDays }: Base & { offers: StoredOffer[]; quoteValidDays: number }) {
  return (
    <PartRows slug={slug} part="offers" hrefs={hrefs} edit={edit}>
      <OfferList offers={offers} quoteValidDays={quoteValidDays} />
      {/* The platform's own rules: the tag and an (i), as in Never do. */}
      <div className="pb-rows__note pb-fixed-line" data-platform-fixed="">
        <LockTag /><InfoTip label={t("playbook.fixed.tag")} wide><span data-offers-rules="">{t("playbook.offers.rules")}</span></InfoTip>
      </div>
    </PartRows>
  );
}

/**
 * The switch and the drag handle take focus back after their save (the shared
 * rule, focus.ts via useFocusTarget): a switched row moves between the active
 * and the off rows, and a moved row is re-rendered, so focus would fall to the page.
 */
function FocusSwitch({ focusId, ...props }: { focusId: string } & InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  useFocusTarget(focusId, ref);
  return <input ref={ref} type="checkbox" role="switch" className="sas-switch" {...props} />;
}

function FocusHandle({ focusId, props }: { focusId: string; props: ReturnType<ReturnType<typeof useSortable>["handleProps"]> }) {
  const ref = useRef<HTMLButtonElement>(null);
  useFocusTarget(focusId, ref);
  return <button ref={ref} {...props}><span className="pb-handle__dots" aria-hidden="true" /></button>;
}

function OfferList({ offers, quoteValidDays }: { offers: StoredOffer[]; quoteValidDays: number }) {
  const rowsCtx = useRows();
  const sig = JSON.stringify(offers);
  // While a switch or a move saves, the rows show in their new order; a refusal puts them back.
  const [optimistic, setOptimistic] = useState<{ sig: string; list: StoredOffer[] } | null>(null);
  const [touched, setTouched] = useState<OfferType | null>(null);
  const [menu, setMenu] = useState<OfferType | null>(null);
  const [announce, setAnnounce] = useState("");
  // Where focus goes once a switch or a move is saved (its switch, or its handle).
  const focusNext = useRef<string | null>(null);
  const save = useRowSave(() => { if (focusNext.current) rowsCtx.focusTo(focusNext.current); }, () => setOptimistic(null));
  const shown = optimistic && optimistic.sig === sig ? optimistic.list : offers;
  const active = shown.filter((o) => o.on);
  const off = shown.filter((o) => !o.on);
  const busy = save.pending || rowsCtx.open !== null;

  const run = (type: OfferType, list: StoredOffer[], change: OfferChange) => {
    setTouched(type);
    focusNext.current = `offer.${type}.${change.kind === "offerSwitch" ? "switch" : "handle"}`;
    setOptimistic({ sig, list });
    save.run(change);
  };
  const moveTo = (type: OfferType, to: number) => {
    if (busy) return;
    run(type, moveOffer(shown, type, to), { kind: "offerMove", type, to });
  };
  const sort = useSortable({
    count: active.length, busy, helpId: "pb-sort-help-offers",
    what: (i) => name(active[i].type),
    onMove: (from, to) => moveTo(active[from].type, to),
  });

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

  const status = (type: OfferType): ReactNode => {
    if (type !== touched) return null;
    if (save.pending) return <span className="sas-small pb-pending" role="status">{t("playbook.saving")}</span>;
    return save.errors ? <OtherErrors errors={save.errors} own={[]} /> : null;
  };

  const row = (o: StoredOffer, place: number | null, lead: ReactNode) => {
    const label = name(o.type);
    const at = `offer.${o.type}`;
    return (
      <EditRow
        id={at} label={label} item={{ what: label }} own={[at]} lead={lead} keepRead
        rowAttrs={{ "data-offer": o.type, "data-on": o.on ? "1" : "0" }}
        read={(
          <span className="pb-offer-read">
            <span className={`pb-offer__place${place === null ? " pb-offer__place--off" : ""}`}>
              {place !== null ? place : <><span aria-hidden="true">–</span><span className="sas-sr">{t("playbook.offers.off")}</span></>}
            </span>
            <span className="pb-offer__icon" aria-hidden="true"><Icon name={ICON[o.type]} /></span>
            <span className="pb-offer__title">
              <strong className="pb-offer__name">{label}</strong>
              <InfoTip label={label}>
                <span data-offer-about={o.type}>{t(`playbook.offers.about.${o.type}` as MessageKey, { days: quoteValidDays })}</span>
                {o.type === "pay_yearly" ? <span data-offer-yearly-note="">{t("playbook.offers.yearly_note")}</span> : null}
                {o.type === "smaller_start" ? <span data-offer-locked-why="">{t("playbook.offers.locked_why")}</span> : null}
              </InfoTip>
            </span>
          </span>
        )}
        aside={<span className="pb-offer__read-nums sas-small" data-offer-numbers="">{o.on || o.type === "smaller_start" ? offerNumbers(o) : t("playbook.offers.off")}</span>}
        editable={o.type !== "smaller_start"}
        editor={o.type === "smaller_start" ? undefined : (e) => <NumbersEditor o={o} e={e} />}
        hint={t(`playbook.offers.about.${o.type}` as MessageKey, { days: quoteValidDays })}
        toChange={(form) => ({ kind: "offer", type: o.type, pct: val(form, "pct"), ...(o.type === "more_units" ? { units: val(form, "units") } : {}) })}
        extra={(
          <span className="pb-offer__end">
            {o.type === "smaller_start" ? (
              /* It cannot be switched off (offer-settings: always on, a switch is refused): a lock in the switch's place. */
              <span className="pb-offer__lock" role="img" aria-label={t("playbook.offers.locked", { name: label })} title={t("playbook.offers.always_on")} data-offer-lock="">
                <Icon name="lock" />
              </span>
            ) : (
              <FocusSwitch
                focusId={`${at}.switch`} checked={o.on} disabled={busy} aria-label={t("playbook.offers.switch", { name: label })}
                onChange={(ev) => {
                  const on = ev.target.checked;
                  const next = switchOffer(shown, o.type, on);
                  setAnnounce(on ? t("playbook.offers.position", { name: label, n: next.filter((x) => x.on).findIndex((x) => x.type === o.type) + 1, of: next.filter((x) => x.on).length }) : t("playbook.offers.off_label", { name: label }));
                  run(o.type, next, { kind: "offerSwitch", type: o.type, on });
                }}
              />
            )}
            {place !== null ? (
              <span className="pb-offer__menu" data-offer-menu={o.type}>
                <button
                  type="button" className="pb-icon-btn" aria-haspopup="menu" aria-expanded={menu === o.type} disabled={busy}
                  aria-label={t("playbook.offers.menu", { name: label })} onClick={() => setMenu(menu === o.type ? null : o.type)}
                ><Icon name="ellipsis" /></button>
                {menu === o.type ? (
                  <span className="pb-offer__pop" role="menu" aria-label={t("playbook.offers.menu", { name: label })}>
                    <button type="button" role="menuitem" disabled={place === 1} autoFocus={place !== 1} onClick={() => { setMenu(null); setAnnounce(t("playbook.offers.position", { name: label, n: place - 1, of: active.length })); moveTo(o.type, place - 2); }}>
                      <Icon name="arrow-up" />{t("playbook.offers.move_up")}
                    </button>
                    <button type="button" role="menuitem" disabled={place === active.length} autoFocus={place === 1} onClick={() => { setMenu(null); setAnnounce(t("playbook.offers.position", { name: label, n: place + 1, of: active.length })); moveTo(o.type, place); }}>
                      <Icon name="arrow-down" />{t("playbook.offers.move_down")}
                    </button>
                  </span>
                ) : null}
              </span>
            ) : <span className="pb-offer__menu" aria-hidden="true" />}
          </span>
        )}
        after={status(o.type)}
      />
    );
  };

  return (
    <div data-testid="offers-panel" className="pb-offers">
      <div className="pb-list-head" data-offers-head="">
        <span id="pb-offers-h">{t("playbook.offers.title")}</span>
        <InfoTip label={t("playbook.offers.title")} wide><span data-offers-hint="">{t("playbook.offers.hint")}</span></InfoTip>
      </div>
      <SortHelp id="pb-sort-help-offers" announce={sort.announce} />
      <div className="pb-sortable" ref={sort.listRef} role="list" aria-labelledby="pb-offers-h" data-dragging={sort.dragging !== null ? "" : undefined}>
        {active.map((o, pos) => (
          <div key={o.type} role="listitem" data-sort-row="" className="pb-sortable__item">
            {row(o, pos + 1, <FocusHandle focusId={`offer.${o.type}.handle`} props={sort.handleProps(pos)} />)}
          </div>
        ))}
      </div>
      {off.length ? (
        <div role="list" aria-label={t("playbook.offers.off_head")} className="pb-offers__off">
          {off.map((o) => <div key={o.type} role="listitem">{row(o, null, <span aria-hidden="true" />)}</div>)}
        </div>
      ) : null}
      <div className="pb-row pb-row--item pb-offer--pinned" data-offer="above" data-info-scope="">
        <span className="pb-row__lead"><Icon name="lock" /></span>
        <div className="pb-row__value">
          <span className="pb-offer-read">
            <span className="pb-offer__place pb-offer__place--off" aria-hidden="true" />
            <span className="pb-offer__icon pb-offer__icon--none" aria-hidden="true" />
            <span className="pb-offer__title">
              <strong className="pb-offer__name">{t("playbook.offers.above")}</strong>
              <InfoTip label={t("playbook.offers.above")}><span data-offer-above-hint="">{t("playbook.offers.above_hint")}</span></InfoTip>
            </span>
          </span>
        </div>
        <span className="pb-row__actions" data-info-avoid=""><span className="sas-small pb-offer__always">{t("playbook.offers.always_last")}</span></span>
      </div>
      <div id="pb-offers-live" className="sas-sr" aria-live="polite" role="status">{announce}</div>
    </div>
  );
}
