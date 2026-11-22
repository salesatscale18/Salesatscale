"use client";

/**
 * The buyer chat's reach cards (board ReachChat, owner-approved 21 Nov):
 * - TalkNowCard: opened from the "It's the time you asked for" SMS within 2
 *   hours of that time: Talk now (voice mode), Write instead, Pick another time.
 * - NewTimeCard: from the second SMS, or "Pick another time": In 1 hour,
 *   Tonight 21:00, Tomorrow 09:00, Other time…; "Message me {choice}" moves the
 *   buyer-named follow-up; "Talk now instead".
 * - BookingCard: the agent's "a person" step: call length, the number we call
 *   (masked, Change inline), day chips for the next 7 days, slots in the
 *   buyer's time (taken ones dashed and disabled), one Book button; then
 *   "Call booked" with Add to calendar (.ics), Change time and Cancel (confirm).
 * - SmsChip: "SMS sent · Sat 21:00" for the SMS that led the buyer here.
 * Every time is in the buyer's own zone: the browser's, else the market's
 * (spec 8). The server re-checks every action (reach-actions.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/sas/icon";
import { translator, type Locale } from "@/lib/i18n";
import { safeTimezone, zonePlainName } from "@/lib/format";
import type { ChatReach, ChatSmsChip } from "@/lib/chat/reach";
import type { BookingView } from "@/lib/team-calls/service";
import type { TalkNow } from "@/lib/follow-ups/named-time";
import { bookCallAction, cancelCallAction, rescheduleAction } from "./reach-actions";

const MINUTE = 60_000;

/** The buyer's own time zone: the browser's once the page runs, the market's before (server render). */
export function useBuyerZone(fallback: string): string {
  const [tz, setTz] = useState(fallback);
  useEffect(() => {
    try {
      const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (z) setTz(z);
    } catch {
      // Keep the market's zone.
    }
  }, []);
  return tz;
}

const parts = (at: Date, tz: string, locale: string, o: Intl.DateTimeFormatOptions) => {
  const p = new Intl.DateTimeFormat(locale, { timeZone: tz, hourCycle: "h23", ...o }).formatToParts(at);
  return (type: string) => p.find((x) => x.type === type)?.value ?? "";
};
/** "Sat 21:00" */
export const dayTime = (at: Date, tz: string, locale: string) => {
  const g = parts(at, tz, locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return `${g("weekday")} ${g("hour")}:${g("minute")}`;
};
/** "Mon 23 Nov, 15:30" */
export const longWhen = (at: Date, tz: string, locale: string) => {
  const g = parts(at, tz, locale, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${g("weekday")} ${g("day")} ${g("month")}, ${g("hour")}:${g("minute")}`;
};
const hhmm = (at: Date, tz: string) => {
  const g = parts(at, tz, "en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${g("hour")}:${g("minute")}`;
};
const dateKey = (at: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
/**
 * The buyer's zone in plain words (RB3), for "Times are Israel time.": the zone's plain name ("Israel time",
 * Hebrew "שעון ישראל"), "UTC" for UTC, else the city of the IANA id ("Lisbon time").
 */
export function zoneName(tz: string, lang: string, at = new Date()): string {
  const zone = safeTimezone(tz);
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/.test(zone)) return "UTC";
  const city = zone.split("/").pop()?.replace(/_/g, " ") ?? zone;
  if (lang === "he") {
    try {
      const v = new Intl.DateTimeFormat("he-IL", { timeZone: zone, timeZoneName: "longGeneric" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
      if (v && !/GMT|UTC/.test(v)) return v.replace(/[\u200e\u200f]/g, "").trim();
    } catch {
      // fall through
    }
    return `שעון ${city}`;
  }
  return zonePlainName(zone, at) ?? `${city} time`;
}

/** The instant of a wall-clock time ("2026-11-22", "09:00") in `tz`. */
function zonedInstant(tz: string, date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  const offset = (at: number) => {
    const g = parts(new Date(at), tz, "en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return (Date.UTC(Number(g("year")), Number(g("month")) - 1, Number(g("day")), Number(g("hour")), Number(g("minute")), Number(g("second"))) - Math.floor(at / 1000) * 1000);
  };
  let at = wall - offset(wall);
  at = wall - offset(at);
  return new Date(at);
}

const tr = (lang: string) => translator((lang === "he" ? "he" : "en") as Locale);
const localeOf = (lang: string) => (lang === "he" ? "he-IL" : "en-GB");

/** "SMS sent · Sat 21:00": a small centred chip in the chat. */
export function SmsChip({ at, tz, lang }: { at: string; tz: string; lang: string }) {
  return (
    <div className="rb-chip" dir={lang === "he" ? "rtl" : "ltr"} data-sms-chip="" suppressHydrationWarning>
      <Icon name="message-square" />
      <span suppressHydrationWarning>{tr(lang)("buyer.reach.sms_sent", { when: dayTime(new Date(at), tz, localeOf(lang)) })}</span>
    </div>
  );
}

/**
 * The SMS chips placed in the chat: each one right before the message it points to,
 * one with no message by time. Returns the chips due before `messageId`/`at`, removing them from `left`.
 */
export function chipsBefore(left: ChatSmsChip[], messageId: string, at: string): ChatSmsChip[] {
  // A later SMS about the same message (the second named-time SMS) goes by its own time.
  const near = (c: ChatSmsChip) => Date.parse(c.at) - Date.parse(at) < 2 * MINUTE;
  const due = left.filter((c) => (c.messageId === messageId && near(c)) || c.at <= at);
  for (const c of due) left.splice(left.indexOf(c), 1);
  return due;
}

// ---------------------------------------------------------------------------
// Talk now / new time
// ---------------------------------------------------------------------------

export function TalkNowCard({ talk, tz, lang, canTalk, onTalk, onWrite, onPickAnother }: {
  talk: TalkNow; tz: string; lang: string; canTalk: boolean; onTalk: () => void; onWrite: () => void; onPickAnother: () => void;
}) {
  const t = tr(lang);
  return (
    <section className="rb-card rb-card--accent" dir={lang === "he" ? "rtl" : "ltr"} aria-labelledby="rb-talk-h" data-talk-now="">
      <h2 id="rb-talk-h" className="rb-card__title rb-card__title--icon" suppressHydrationWarning>
        <Icon name="clock" />{t("buyer.reach.talk_title", { when: dayTime(new Date(talk.at), tz, localeOf(lang)) })}
      </h2>
      {/* Talk now starts voice mode (the chat's own switch); without voice the card offers writing. */}
      {canTalk ? <button type="button" className="rb-btn rb-btn--primary" onClick={onTalk} data-talk-now-start=""><Icon name="audio-lines" />{t("buyer.reach.talk_now")}</button> : null}
      <button type="button" className={`rb-btn ${canTalk ? "" : "rb-btn--primary"}`} onClick={onWrite} data-talk-write=""><Icon name="keyboard" />{t("buyer.reach.write_instead")}</button>
      <button type="button" className="rb-link" onClick={onPickAnother} data-talk-pick="">{t("buyer.reach.pick_another")}</button>
    </section>
  );
}

type Choice = { key: "in_hour" | "tonight" | "tomorrow" | "other"; at: Date | null };

export function NewTimeCard({ token, tz, lang, canTalk, onTalk, now: nowProp }: {
  token: string; tz: string; lang: string; canTalk: boolean; onTalk: () => void; now?: Date;
}) {
  const t = tr(lang);
  const locale = localeOf(lang);
  const [now] = useState(() => nowProp ?? new Date());
  const [pick, setPick] = useState<Choice["key"] | null>(null);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = dateKey(now, tz);
  const tomorrow = dateKey(new Date(now.getTime() + 24 * 60 * MINUTE), tz);
  const choices: Record<Choice["key"], Date | null> = useMemo(() => {
    const tonight = zonedInstant(tz, today, "21:00");
    return {
      in_hour: new Date(Math.ceil((now.getTime() + 60 * MINUTE) / MINUTE) * MINUTE),
      // Tonight only while it is still at least 15 minutes ahead.
      tonight: tonight.getTime() - now.getTime() >= 15 * MINUTE ? tonight : null,
      tomorrow: zonedInstant(tz, tomorrow, "09:00"),
      other: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(other) ? zonedInstant(tz, other.slice(0, 10), other.slice(11, 16)) : null,
    };
  }, [now, tz, today, tomorrow, other]);
  const chosen = pick ? choices[pick] : null;
  const label = pick === "other" && chosen ? longWhen(chosen, tz, locale) : pick && pick !== "other" ? t(`buyer.reach.${pick}_lc`) : null;
  const save = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const r = await rescheduleAction(token, chosen.toISOString());
      if (r.ok) setSaved(longWhen(new Date(r.at), tz, locale));
      else setError(r.reason === "too_soon" || r.reason === "too_far" ? t("buyer.reach.new_error_window") : t("buyer.reach.new_error"));
    } catch {
      setError(t("buyer.reach.new_error"));
    } finally {
      setBusy(false);
    }
  };
  const opt = (key: Choice["key"], text: string) => (
    <button
      key={key} type="button" className={`rb-opt${pick === key ? " rb-opt--on" : ""}`} aria-pressed={pick === key} disabled={key !== "other" && !choices[key]}
      onClick={() => setPick(key)} data-new-time={key}
    >{text}</button>
  );
  return (
    <section className="rb-card" dir={lang === "he" ? "rtl" : "ltr"} aria-labelledby="rb-new-h" data-new-time-card="">
      <h2 id="rb-new-h" className="rb-card__title">{t("buyer.reach.new_title")}</h2>
      {saved ? (
        <p className="rb-card__text rb-card__text--ok" role="status" data-new-time-saved=""><Icon name="check-circle" />{t("buyer.reach.new_saved", { when: saved })}</p>
      ) : (
        <>
          <p className="rb-card__text">{t("buyer.reach.new_body")}</p>
          <div className="rb-grid" role="group" aria-label={t("buyer.reach.new_title")}>
            {opt("in_hour", t("buyer.reach.in_hour"))}
            {opt("tonight", t("buyer.reach.tonight"))}
            {opt("tomorrow", t("buyer.reach.tomorrow"))}
            {opt("other", t("buyer.reach.other"))}
          </div>
          {pick === "other" ? (
            <label className="rb-field">
              <span>{t("buyer.reach.other_label")}</span>
              <input type="datetime-local" className="rb-input" value={other} onChange={(e) => setOther(e.target.value)} min={`${today}T00:00`} data-new-time-other="" />
            </label>
          ) : null}
          {error ? <p className="rb-card__error" role="alert">{error}</p> : null}
          <button type="button" className="rb-btn rb-btn--primary" disabled={!chosen || busy} onClick={() => void save()} data-new-time-save="" suppressHydrationWarning>
            {label ? t("buyer.reach.message_me", { choice: label }) : t("buyer.reach.choose")}
          </button>
        </>
      )}
      {canTalk ? <button type="button" className="rb-btn" onClick={onTalk} data-new-time-talk=""><Icon name="audio-lines" />{t("buyer.reach.talk_instead")}</button> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

/** The .ics file for Add to calendar (a data: link, so it works without a script). */
export function icsHref(at: Date, minutes: number, title: string): string {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sales at Scale//Team call//EN", "BEGIN:VEVENT",
    `UID:${f(at)}-team-call@salesatscale`, `DTSTAMP:${f(new Date())}`, `DTSTART:${f(at)}`, `DTEND:${f(new Date(at.getTime() + minutes * MINUTE))}`,
    `SUMMARY:${esc(title)}`, "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;
}

export function BookingCard({ token, booking, tz, lang, seller, onReach }: {
  token: string; booking: BookingView; tz: string; lang: string; seller: string; onReach: (r: ChatReach) => void;
}) {
  const t = tr(lang);
  const locale = localeOf(lang);
  const dir = lang === "he" ? "rtl" : "ltr";
  const [reopen, setReopen] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editPhone, setEditPhone] = useState(false);
  const [phone, setPhone] = useState("");
  const [usePhone, setUsePhone] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Slots grouped by the buyer's own day; the next 7 days that have any.
  const days = useMemo(() => {
    const m = new Map<string, { key: string; first: Date; slots: BookingView["slots"] }>();
    for (const s of booking.slots) {
      const at = new Date(s.at);
      const key = dateKey(at, tz);
      const d = m.get(key) ?? { key, first: at, slots: [] };
      d.slots.push(s);
      m.set(key, d);
    }
    return [...m.values()].slice(0, 7);
  }, [booking.slots, tz]);
  const shownDay = days.find((d) => d.key === day) ?? days.find((d) => d.slots.some((s) => !s.taken)) ?? days[0];
  const dayRow = useRef<HTMLDivElement>(null);
  // The day row shows only while the card offers slots (not on "Call booked" until Change time).
  const rowShown = days.length > 0 && !(booking.booked && !reopen);
  const moreEnd = useMoreAtEnd(dayRow, rowShown ? days.length : 0);
  // RB3: the selected day in view, on load and on select (the row only: the chat log does not move).
  useEffect(() => {
    const row = dayRow.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (row && chip) scrollChipIntoView(row, chip);
  }, [shownDay?.key, rowShown]);

  const book = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    try {
      const r = await bookCallAction(token, { at: slot, ...(usePhone ? { phone: usePhone } : {}), timezone: tz });
      if (r.result.ok) {
        setReopen(false);
        setSlot(null);
        onReach(r.reach);
      } else {
        setError(t(r.result.reason === "slot_taken" ? "buyer.book.error.slot_taken" : r.result.reason === "invalid_phone" ? "buyer.book.error.invalid_phone" : "buyer.book.error.other"));
        if (r.result.reason === "slot_taken") { setSlot(null); onReach(r.reach); }
      }
    } catch {
      setError(t("buyer.book.error.other"));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      const r = await cancelCallAction(token);
      setConfirmCancel(false);
      if (r.ok) setNotice(t("buyer.book.cancelled"));
      onReach(r.reach);
    } finally {
      setBusy(false);
    }
  };

  if (booking.booked && !reopen) {
    const at = new Date(booking.booked.at);
    return (
      <section className="rb-card rb-card--accent" dir={dir} aria-labelledby="rb-booked-h" data-booking-card="booked">
        <h2 id="rb-booked-h" className="rb-card__title rb-card__title--icon"><Icon name="check-circle" />{t("buyer.book.booked_title")}</h2>
        <p className="rb-card__when" suppressHydrationWarning><b>{longWhen(at, tz, locale)}</b> {t("buyer.book.booked_when", { when: "", minutes: booking.lengthMin }).trim()}</p>
        <p className="rb-card__text">
          {booking.booked.phone ? withPhone(t("buyer.book.booked_body_phone", { phone: PHONE }), booking.booked.phone) : t("buyer.book.booked_body")}
        </p>
        {confirmCancel ? (
          <div className="rb-row" role="group" aria-label={t("buyer.book.cancel_confirm")} data-booking-cancel-confirm="">
            <span className="rb-card__text">{t("buyer.book.cancel_confirm")}</span>
            <button type="button" className="rb-btn rb-btn--danger rb-btn--sm" disabled={busy} onClick={() => void cancel()} data-booking-cancel-yes="">{t("buyer.book.cancel_yes")}</button>
            <button type="button" className="rb-btn rb-btn--sm" onClick={() => setConfirmCancel(false)}>{t("buyer.book.cancel_no")}</button>
          </div>
        ) : (
          <div className="rb-row">
            <a className="rb-btn rb-btn--sm" href={icsHref(at, booking.lengthMin, t("buyer.book.ics_title", { seller }))} download="call.ics" data-booking-ics=""><Icon name="calendar" />{t("buyer.book.add_calendar")}</a>
            <button type="button" className="rb-link" onClick={() => { setReopen(true); setSlot(null); }} data-booking-change="">{t("buyer.book.change_time")}</button>
            <button type="button" className="rb-link rb-link--muted" onClick={() => setConfirmCancel(true)} data-booking-cancel="">{t("buyer.book.cancel")}</button>
          </div>
        )}
      </section>
    );
  }

  const shownPhone = usePhone ?? booking.phone;
  const picked = slot ? new Date(slot) : null;
  return (
    <section className="rb-card" dir={dir} aria-labelledby="rb-book-h" data-booking-card="slots">
      <h2 id="rb-book-h" className="rb-card__title">{t("buyer.book.title", { minutes: booking.lengthMin })}</h2>
      {notice ? <p className="rb-card__text" role="status">{notice}</p> : null}
      <p className="rb-card__text">
        {shownPhone ? withPhone(t("buyer.book.pick_phone", { phone: PHONE }), shownPhone) : t("buyer.book.pick")}{" "}
        {!editPhone ? <button type="button" className="rb-link" onClick={() => setEditPhone(true)} data-booking-phone-change="">{t("buyer.book.change")}</button> : null}
      </p>
      {editPhone ? (
        <div className="rb-row rb-row--field">
          <label className="rb-field">
            <span>{t("buyer.book.phone_label")}</span>
            <input type="tel" className="rb-input" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={40} data-booking-phone="" />
          </label>
          <button type="button" className="rb-btn rb-btn--sm" disabled={!phone.trim()} onClick={() => { setUsePhone(phone.trim()); setEditPhone(false); }}>{t("buyer.book.phone_save")}</button>
        </div>
      ) : null}
      {days.length === 0 ? <p className="rb-card__text">{t("buyer.book.none")}</p> : (
        <>
          <div className="rb-days" role="group" aria-label={t("buyer.book.days")} ref={dayRow} data-more-end={moreEnd ? "" : undefined}>
            {days.map((d) => {
              const g = parts(d.first, tz, locale, { weekday: "short", day: "numeric" });
              const on = d.key === shownDay?.key;
              return (
                <button key={d.key} type="button" className={`rb-day${on ? " rb-day--on" : ""}`} aria-pressed={on} onClick={() => { setDay(d.key); setSlot(null); }} data-booking-day={d.key} suppressHydrationWarning>
                  <span>{g("weekday")}</span><b className="c-num">{g("day")}</b>
                </button>
              );
            })}
          </div>
          <div className="rb-slots" role="group" aria-label={t("buyer.book.slots")}>
            {shownDay?.slots.map((s) => {
              const time = hhmm(new Date(s.at), tz);
              return s.taken ? (
                <span key={s.at} className="rb-slot rb-slot--taken" aria-disabled="true" aria-label={t("buyer.book.taken", { time })} data-booking-slot="taken" suppressHydrationWarning>{time}</span>
              ) : (
                <button key={s.at} type="button" className={`rb-slot${slot === s.at ? " rb-slot--on" : ""}`} aria-pressed={slot === s.at} onClick={() => setSlot(s.at)} data-booking-slot="free" suppressHydrationWarning>{time}</button>
              );
            })}
          </div>
          <p className="rb-card__hint" suppressHydrationWarning>{t("buyer.book.zone", { zone: zoneName(tz, lang) })}</p>
        </>
      )}
      {error ? <p className="rb-card__error" role="alert">{error}</p> : null}
      <button type="button" className="rb-btn rb-btn--primary" disabled={!picked || busy} onClick={() => void book()} data-booking-book="" suppressHydrationWarning>
        {picked ? t("buyer.book.book", { when: longWhen(picked, tz, locale) }) : t("buyer.book.pick_slot")}
      </button>
    </section>
  );
}

/** Scrolls a day chip into its row's view (sideways only), with a little room; physical sides, so LTR and RTL alike. */
function scrollChipIntoView(row: HTMLElement, chip: HTMLElement) {
  const r = row.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  const room = 16;
  if (c.left < r.left + room) row.scrollLeft += c.left - r.left - room;
  else if (c.right > r.right - room) row.scrollLeft += c.right - r.right + room;
}

/** Whether a sideways row has more to scroll on its end side (right in LTR, left in RTL): the fade shows then. */
function useMoreAtEnd(ref: React.RefObject<HTMLElement | null>, count: number): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(Math.ceil(Math.abs(el.scrollLeft) + el.clientWidth) < el.scrollWidth - 1);
    check();
    el.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => { el.removeEventListener("scroll", check); window.removeEventListener("resize", check); };
  }, [ref, count]);
  return more;
}

const PHONE = "\u0000";
/** A sentence with the phone number in it, the number kept left to right inside Hebrew text. */
const withPhone = (text: string, phone: string) => text.split(PHONE).map((part, i) => (i === 0 ? part : <span key={i}><span className="c-num" dir="ltr">{phone}</span>{part}</span>));

/** Wraps a card as a row of the chat log. */
export const CardRow = ({ children }: { children: ReactNode }) => <div className="c-msg c-msg--in c-msg--card rb-row-card">{children}</div>;
