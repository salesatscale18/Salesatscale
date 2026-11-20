"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BuyerChat, BuyerMessage, LinkPreview } from "@/lib/simulator/service";
import { boldSegments } from "@/lib/agent/app-message";
import { QuoteCard } from "@/components/sas/quote-card";
import { replyButtonsAfter } from "@/lib/agent/quote-replies";
import { translator, type Locale } from "@/lib/i18n";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { CALL_PHASES, callLength } from "@/lib/voice/client/buyer-ui";
import { callClock } from "@/lib/voice/lab";
import { useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import { BuyerCallBar, VoiceSheet } from "./voice";

export type ChatStrings = {
  bannerLead: string; banner: string; automated: string; typing: string; typingLabel: string; placeholder: string; send: string; ended: string; expired: string;
  closedBy: string; today: string; yesterday: string; openForm: string; formLabel: string; todayWord: string; perMonth: string;
  empty: string; notSent: string; messages: string; sent: string; delivered: string; read: string;
  /** Reply buttons after the close ("Sounds good" / "Change something"). */
  replyYes: string; replyChange: string; replies: string;
  refused: Record<string, string>;
};


/** A message on the page: from the server, or the buyer's own still on its way (pending). */
type Shown = BuyerMessage & { pending?: "sending" | "confirmed" | "failed" };

const POLL_MS = 2000;
const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

/** One inline double-check (single when only sent): grey, or the brand colour once read. */
function Tick({ state, label }: { state: "sent" | "delivered" | "read"; label: string }) {
  return (
    <svg className={`c-tick${state === "read" ? " c-tick--read" : ""}`} viewBox="0 0 20 12" role="img" aria-label={label}>
      <path d={state === "sent" ? "M4 6l3.5 3.5L14 3" : "M1 6l3.5 3.5L11 3M8 9.5L9 10.5 17 2.5"} />
    </svg>
  );
}

function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return <>{parts.map((p, i) => (i % 2 === 1 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : <Fragment key={i}>{p}</Fragment>))}</>;
}

/** The app's quote message: WhatsApp-style `*bold*` lines (headline and totals) shown bold. */
function Bolded({ text }: { text: string }) {
  return <>{boldSegments(text).map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** Amounts and IDs stay left-to-right inside Hebrew text. */
const Num = ({ children }: { children: ReactNode }) => <span className="c-num">{children}</span>;

function Card({ p, s, initials, dir }: { p: LinkPreview; s: ChatStrings; initials: string; dir: "ltr" | "rtl" }) {
  return (
    <div className="c-card" dir={dir}>
      <div className="c-card__top">
        <span className="c-card__logo" aria-hidden="true">{initials}</span>
        <span className="c-card__text">
          <b className="c-card__seller">{p.seller}</b>
          {/* The buyer sees a version only from v2 on, as on the quote card and the form. */}
          <span className="c-card__title">{s.formLabel} · <Num>{p.ref.replace(/ v1$/, "")}</Num></span>
          {p.oneTime || p.recurring ? (
            <span className="c-card__sum">
              {p.oneTime ? <><Num>{p.oneTime}</Num> {s.todayWord}</> : null}
              {p.oneTime && p.recurring ? " + " : null}
              {p.recurring ? <><Num>{p.recurring}</Num>{s.perMonth}</> : null}
            </span>
          ) : null}
        </span>
      </div>
      <a className="c-card__btn" href={p.url} target="_blank" rel="noopener noreferrer">{s.openForm}</a>
    </div>
  );
}

/** The calendar day in the market's time zone (R5-3), so the date separators match the times. */
const dayKeyIn = (timeZone: string) => (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * The buyer's chat: polls `messages?after=<id>` every 2 s while the tab is
 * visible, sends with Enter (Shift+Enter for a new line), shows "typing…"
 * while an agent turn runs, and announces new replies to screen readers.
 * The layout never flips; banner, header, card, separators and bar take the
 * lead's direction and every bubble is dir="auto".
 */
export function ChatClient({ token, lang, seller, initials, strings, initial, timeZone = "UTC", voice = null }: {
  token: string; lang: string; seller: string; initials: string; strings: ChatStrings; initial: BuyerChat;
  /** The lead's market time zone: times and dates read as on the pay page and the seller's thread (R5-3). */
  timeZone?: string;
  /** Buyer calls (live voice): null while voice calls are off for the platform (nothing changes on the page). */
  voice?: { agentName: string; gender: string } | null;
}) {
  const [items, setItems] = useState<Shown[]>(initial.messages);
  const [cards, setCards] = useState(initial.cards ?? {});
  const [typing, setTyping] = useState(initial.typing);
  const [ended, setEnded] = useState(initial.ended);
  // The link went idle for 14 days while the page was open: the server answers 410.
  const [expired, setExpired] = useState(false);
  const [closedAt, setClosedAt] = useState(initial.closedAt);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [calls, setCalls] = useState(initial.calls ?? []);
  // "Talk to us" (live voice): the server's gates, refreshed on every poll.
  const [voiceState, setVoiceState] = useState(initial.voice ?? { available: false, consented: false });
  const [sheet, setSheet] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const clientRef = useRef<VoiceClient | null>(null);
  if (voice && !clientRef.current && typeof window !== "undefined") clientRef.current = new VoiceClient();
  const callSnap = useVoiceSnapshot(clientRef.current);
  const inCall = CALL_PHASES.has(callSnap.phase);
  const tr = translator((lang === "he" ? "he" : "en") as Locale);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastId = useRef<string | null>(initial.messages.at(-1)?.id ?? null);
  const busy = useRef(false);
  const base = `/chat/${token}/messages`;
  const locale = lang === "he" ? "he-IL" : "en-GB";
  const dir = lang === "he" ? "rtl" : "ltr";

  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch(`${base}${lastId.current ? `?after=${lastId.current}` : ""}`, { cache: "no-store" });
      if (res.status === 410) { setExpired(true); setEnded(true); return; }
      if (!res.ok) return;
      const data = (await res.json()) as BuyerChat;
      setTyping(data.typing);
      setEnded(data.ended);
      setClosedAt(data.closedAt);
      // Every card comes back on every poll: an approved, replaced or expired quote changes in place.
      setCards(data.cards ?? {});
      setCalls(data.calls ?? []);
      if (data.voice) setVoiceState(data.voice);
      // Messages confirmed by the server before this poll started are now in its answer.
      setItems((cur) => {
        const known = new Set(cur.map((m) => m.id));
        const fresh = data.messages.filter((m) => !known.has(m.id));
        if (fresh.length === 0) return cur;
        const kept = cur.filter((m) => m.pending !== "confirmed");
        return [...kept.filter((m) => !m.pending), ...fresh, ...kept.filter((m) => m.pending)];
      });
      const incoming = data.messages.filter((m) => m.from !== "buyer");
      if (incoming.length) setAnnounce(incoming.map((m) => `${m.name ?? seller}: ${m.body}`).join("\n"));
      if (data.messages.length) lastId.current = data.messages.at(-1)!.id;
    } catch {
      // Offline for a moment: the next poll catches up.
    } finally {
      busy.current = false;
    }
  }, [base, seller]);

  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void poll(); };
    const id = window.setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [poll]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, typing, calls.length]);

  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  /** Sends the draft, or a reply button's text (a normal buyer message: the agent answers as if it was typed). */
  const send = async (quick?: string) => {
    const text = (quick ?? draft).trim();
    if (!text || ended) return;
    // During a call, what the buyer types goes into the call (the agent answers by voice; stored once, by the call).
    if (inCall && clientRef.current) {
      if (callSnap.phase === "live" && clientRef.current.sendText(text)) {
        if (quick === undefined) setDraft("");
        requestAnimationFrame(grow);
      }
      return;
    }
    const clientId = crypto.randomUUID();
    if (quick === undefined) setDraft("");
    setNotice(null);
    requestAnimationFrame(grow);
    setItems((cur) => [...cur, { id: clientId, from: "buyer", body: text, at: new Date().toISOString(), status: null, name: null, previews: [], pending: "sending" }]);
    let reason: string | null = null;
    try {
      const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, clientId }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string };
      if (!res.ok || !data.ok) reason = data.reason ?? "error";
    } catch {
      reason = "error";
    }
    setItems((cur) => cur.map((m) => (m.id === clientId ? { ...m, pending: reason ? "failed" : "confirmed" } : m)));
    if (reason) {
      setNotice(strings.refused[reason] ?? strings.notSent);
      if (reason === "opted_out") setEnded(true);
      if (reason === "expired") { setExpired(true); setEnded(true); }
    } else {
      setTyping(true);
    }
    void poll();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  /** Starts a call: audio unlocked in this click, the microphone, then the server checks the gates and gives the ticket. */
  const startCall = (consent: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    setSheet(false);
    setBarHidden(false);
    c.begin();
    void (async () => {
      if (!(await c.prepare())) return;
      try {
        const res = await fetch(`/chat/${token}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent }) });
        const r = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; sessionId?: string; ticket?: string; wsUrl?: string; maxSec?: number; mode?: "scripted" | "live" };
        if (r.ok && r.sessionId && r.ticket && r.wsUrl) {
          if (consent) setVoiceState((v) => ({ ...v, consented: true }));
          c.start({ wsUrl: r.wsUrl, sessionId: r.sessionId, ticket: r.ticket, maxSec: r.maxSec ?? null, mode: r.mode ?? null });
          return;
        }
        if (r.reason === "consent_needed") {
          c.cancel();
          setSheet(true);
          return;
        }
      } catch {
        // Shown as not available below.
      }
      c.unavailable("error");
    })();
  };
  const onTalk = () => (voiceState.consented ? startCall(false) : setSheet(true));
  // When a call ends: fetch its stored lines and the call row now, then let the bar go after a moment.
  useEffect(() => {
    if (callSnap.phase !== "ended") return;
    void poll();
    const id = window.setTimeout(() => setBarHidden(true), 8000);
    return () => window.clearTimeout(id);
  }, [callSnap.phase, poll]);
  useEffect(() => () => clientRef.current?.dispose(), []);
  const showBar = !!voice && !!clientRef.current && callSnap.phase !== "idle" && !barHidden;
  const showTalk = !!voice && voiceState.available && !inCall && !ended;

  const dayKey = dayKeyIn(timeZone);
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const dateLabel = (d: Date) => dayKey(d) === dayKey(now) ? strings.today
    : dayKey(d) === dayKey(yesterday) ? strings.yesterday
    : new Intl.DateTimeFormat(locale, { timeZone, day: "numeric", month: locale.startsWith("he") ? "long" : "short", ...(dayKey(d).slice(0, 4) !== dayKey(now).slice(0, 4) ? { year: "numeric" } : {}) }).format(d);
  const timeOf = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

  const rows: ReactNode[] = [];
  let prevDay = "";
  const separator = (d: Date, key: string) => {
    if (dayKey(d) === prevDay) return;
    prevDay = dayKey(d);
    rows.push(<div key={key} className="c-date" role="separator" dir={dir} suppressHydrationWarning>{dateLabel(d)}</div>);
  };
  const repliesAfter = ended || typing ? null : replyButtonsAfter(items, cards);
  // Finished calls as rows between the messages, at the time each call ended.
  const callRows = [...calls].sort((a, b) => a.at.localeCompare(b.at));
  const pushCall = (c: (typeof calls)[number]) => {
    separator(new Date(c.at), `d-${c.id}`);
    rows.push(
      <div key={`call-${c.id}`} className="c-call" dir={dir} data-call-row="">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
        <span>{tr("buyer.voice.call_row", { length: callLength(c.durationSec, tr), time: timeOf(new Date(c.at)) })}</span>
      </div>,
    );
  };
  items.forEach((m, i) => {
    const d = new Date(m.at);
    while (callRows.length && callRows[0].at <= m.at) pushCall(callRows.shift()!);
    separator(d, `d-${m.id}`);
    const card = cards[m.id];
    if (card) {
      // The app's quote message shows as the designed card; the stored text stays the fallback (and what WhatsApp sends).
      rows.push(
        <div key={m.id} className="c-msg c-msg--in c-msg--card">
          <QuoteCard card={card} />
        </div>,
      );
      return;
    }
    const answered = items.slice(i + 1).some((n) => n.from !== "buyer" && !n.pending);
    const state = m.from !== "buyer" ? null : m.pending === "sending" || m.pending === "failed" ? "sent" : answered ? "read" : "delivered";
    const side = m.from === "buyer" ? "out" : "in";
    // A link with a card shows as the card (artboard SimDesktop), not as a raw URL; a message that is only the link is the card alone.
    const text = m.previews.reduce((b, p) => b.split(p.url).join(""), m.body).replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
    const onlyLink = m.previews.length > 0 && !text;
    rows.push(
      <div key={m.id} className={`c-msg c-msg--${side}${m.pending === "failed" ? " c-msg--failed" : ""}`}>
        {m.from === "human" && m.name ? <span className="c-who" dir="auto">{m.name}</span> : null}
        {onlyLink ? null : (
          <div className={`c-bubble${m.kind ? ` c-bubble--${m.kind}` : ""}`} dir="auto" data-kind={m.kind}>
            {m.kind === "quote" ? <Bolded text={m.body} /> : <Linked text={m.previews.length ? text : m.body} />}
            <span className="c-meta">
              {m.call ? (
                // Said (or typed) in a call: the time in the call, with a mark (board VoiceBuyer 3).
                <span className="c-spoken" title={tr(m.call.typed ? "buyer.voice.typed_at" : "buyer.voice.spoken_at", { time: callClock(m.call.atMs / 1000) })} data-spoken="">
                  <svg viewBox="0 0 24 24" role="img" aria-label={tr(m.call.typed ? "buyer.voice.typed_at" : "buyer.voice.spoken_at", { time: callClock(m.call.atMs / 1000) })}>
                    <path d={m.call.typed ? "M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" : "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3"} />
                  </svg>
                  {callClock(m.call.atMs / 1000)}
                </span>
              ) : <time dateTime={m.at} suppressHydrationWarning>{timeOf(d)}</time>}
              {m.pending === "failed" ? <span>· {strings.notSent}</span> : null}
              {state ? <Tick state={state} label={strings[state]} /> : null}
            </span>
          </div>
        )}
        {m.previews.map((p) => <Card key={p.url} p={p} s={strings} initials={initials} dir={dir} />)}
      </div>,
    );
    if (m.id === repliesAfter) {
      rows.push(
        <div key={`r-${m.id}`} className="c-replies" role="group" aria-label={strings.replies} data-reply-buttons="">
          <button type="button" className="c-reply" onClick={() => void send(strings.replyYes)}>{strings.replyYes}</button>
          <button type="button" className="c-reply" onClick={() => void send(strings.replyChange)}>{strings.replyChange}</button>
        </div>,
      );
    }
  });
  callRows.forEach(pushCall);
  if (closedAt) {
    separator(new Date(closedAt), "d-closed");
    rows.push(
      <div key="closed" className="c-sys" role="status" dir={dir}>
        {strings.closedBy.split("{seller}").map((part, i) => (i === 0 ? part : <Fragment key={i}><bdi>{seller}</bdi>{part}</Fragment>))}
        {" · "}<time className="c-num" dateTime={closedAt} suppressHydrationWarning>{timeOf(new Date(closedAt))}</time>
      </div>,
    );
  }
  const showTyping = typing && !ended;

  return (
    <div className="c-frame">
      <div className="c-banner" role="note" dir={dir}><b>{strings.bannerLead}</b> <span>{strings.banner}</span></div>
      <header className="c-head" dir={dir}>
        <span className="c-avatar" aria-hidden="true">{initials}</span>
        <span className="c-head__text">
          <span className="c-head__name">{seller}</span>
          <span className={`c-head__sub${showTyping ? " c-head__sub--typing" : ""}`}>{showTyping ? strings.typing : strings.automated}</span>
        </span>
      </header>
      {showBar && clientRef.current ? (
        <BuyerCallBar
          client={clientRef.current} tr={tr} agentName={voice!.agentName} dir={dir}
          onStartAgain={() => startCall(false)} onClose={() => { clientRef.current?.cancel(); setBarHidden(true); }}
        />
      ) : null}
      <div className="c-log" ref={logRef} role="log" aria-label={strings.messages} dir={dir}>
        {items.length === 0 && !closedAt ? <p className="c-empty" dir={dir}>{strings.empty}</p> : rows}
        {showTyping ? <div className="c-msg c-msg--in"><div className="c-bubble c-dots" role="status" aria-label={strings.typingLabel}><i /><i /><i /></div></div> : null}
      </div>
      <div className="c-sr" aria-live="polite">{announce}</div>
      {notice ? <div className="c-notice" role="status" dir={dir}>{notice}</div> : null}
      {ended ? (
        <div className="c-ended" role="status" aria-disabled="true" dir={dir}>{expired ? strings.expired : strings.ended}</div>
      ) : (
        <form className="c-bar" dir={dir} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="c-sr" htmlFor="c-input">{strings.placeholder}</label>
          <textarea
            id="c-input" ref={inputRef} className="c-input" rows={1} dir="auto" placeholder={strings.placeholder} value={draft} maxLength={4000}
            onChange={(e) => { setDraft(e.target.value); grow(); }} onKeyDown={onKey}
          />
          {showTalk ? (
            <button type="button" className="c-talk" aria-label={tr("buyer.voice.talk")} title={tr("buyer.voice.talk_hint")} onClick={onTalk} data-voice-talk="">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
            </button>
          ) : null}
          <button type="submit" className="c-send" aria-label={strings.send} disabled={!draft.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
          </button>
        </form>
      )}
      {sheet && voice ? (
        <VoiceSheet tr={tr} agentName={voice.agentName} seller={seller} gender={voice.gender} dir={dir} onStart={() => startCall(true)} onClose={() => setSheet(false)} />
      ) : null}
    </div>
  );
}
