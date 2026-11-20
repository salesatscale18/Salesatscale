"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BuyerChat, BuyerMessage, LinkPreview } from "@/lib/simulator/service";
import { boldSegments } from "@/lib/agent/app-message";
import { QuoteCard } from "@/components/sas/quote-card";
import { replyButtonsAfter } from "@/lib/agent/quote-replies";
import { translator, type Locale, type MessageKey } from "@/lib/i18n";
import { VoiceClient } from "@/lib/voice/client/voice-client";
import { CALL_PHASES, callLength, flushQueued, routeBuyerText } from "@/lib/voice/client/buyer-ui";
import { callClock } from "@/lib/voice/lab";
import { useVoiceSnapshot } from "@/components/sas/voice/voice-call";
import { BuyerCallBar, ChatVoiceBubble } from "./voice";
import { Icon } from "@/components/sas/icon";
import type { BuyerVoiceState } from "@/lib/voice/buyer";
import { resumeSmsAction } from "./actions";

export type ChatStrings = {
  bannerLead: string; banner: string; automated: string; typing: string; typingLabel: string; placeholder: string; send: string; ended: string; expired: string;
  closedBy: string; today: string; yesterday: string; openForm: string; formLabel: string; todayWord: string; perMonth: string;
  empty: string; notSent: string; messages: string; sent: string; delivered: string; read: string;
  /** Reply buttons after the close ("Sounds good" / "Change something"). */
  replyYes: string; replyChange: string; replies: string;
  refused: Record<string, string>;
  /** Text messages (board ReachChat): the stop link at the top, and the chat menu. */
  smsStop: string; menu: string; smsOn: string; smsOnDone: string;
};

/** The buyer's text messages on a real lead's chat: the stop page, whether they are stopped, and whether this visit came from an SMS. */
export type ChatSms = { stopUrl: string; stopped: boolean; fromSms: boolean; resumed?: boolean };


/** A message on the page: from the server, or the buyer's own still on its way (pending). */
type Shown = BuyerMessage & { pending?: "sending" | "confirmed" | "failed" };

const POLL_MS = 2000;
/** The ended call bar hides after this long (paused while hovered or focused). */
const BAR_HIDE_MS = 8000;
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
export function ChatClient({ token, lang, seller, initials, strings, initial, timeZone = "UTC", voice = null, simulated = true, sms = null }: {
  token: string; lang: string; seller: string; initials: string; strings: ChatStrings; initial: BuyerChat;
  /** A simulated buyer's chat: the "Simulated chat" banner shows (never on a real buyer's chat). */
  simulated?: boolean;
  /** A real lead's text messages: the stop link (opened from an SMS) and the chat menu. Null: no SMS on this chat. */
  sms?: ChatSms | null;
  /** The lead's market time zone: times and dates read as on the pay page and the seller's thread (R5-3). */
  timeZone?: string;
  /** Buyer calls (live voice): null while voice calls are off for the platform (nothing changes on the page). */
  voice?: { agentName: string; gender: string; /** The voice bubble's tab link to this conversation's order form tabs (lib/voice/tab-key.ts). */ tabKey?: string | null } | null;
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
  // "Switch to voice" (live voice): the server's gates, refreshed on every poll (with the reason on a simulated chat or for the seller's signed-in staff).
  const [voiceState, setVoiceState] = useState<BuyerVoiceState>(initial.voice ?? { available: false });
  // The buyer's first switch in this conversation: the bar says what they say appears as text.
  const [firstNote, setFirstNote] = useState(false);
  const [barHidden, setBarHidden] = useState(false);
  const clientRef = useRef<VoiceClient | null>(null);
  if (voice && !clientRef.current && typeof window !== "undefined") clientRef.current = new VoiceClient();
  const callSnap = useVoiceSnapshot(clientRef.current);
  const inCall = CALL_PHASES.has(callSnap.phase);
  // The call's phase as of now (quick-reply handlers may be older than the last render).
  const phaseRef = useRef(callSnap.phase);
  phaseRef.current = callSnap.phase;
  /** Text sent while a call was starting: waits for it (see send). */
  const queued = useRef<{ id: string; text: string }[]>([]);
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
    // The bubble's room at the bottom appears with the call: keep the last message in view.
  }, [items.length, typing, calls.length, inCall]);

  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  /** A normal chat message (the agent answers in the chat). */
  const chatSend = async (text: string) => {
    const clientId = crypto.randomUUID();
    setNotice(null);
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

  /**
   * Sends the draft, or a reply button's text: every send on the page goes
   * through here. During a call it goes into the call as a typed buyer turn
   * (the agent answers by voice; the call stores it once); while the call is
   * still starting it waits and goes into the call once live, or into the chat
   * if the call never starts (routeBuyerText).
   */
  const send = async (quick?: string) => {
    const text = (quick ?? draft).trim();
    if (!text || ended) return;
    if (quick === undefined) setDraft("");
    requestAnimationFrame(grow);
    const c = clientRef.current;
    const route = c ? routeBuyerText(phaseRef.current) : "chat";
    if (route === "call" && c?.sendText(text)) return;
    if (route === "queue" || (route === "call" && c)) {
      // Shown as on its way until the call stores it (the poll brings it back once).
      const id = `queued-${crypto.randomUUID()}`;
      queued.current.push({ id, text });
      setItems((cur) => [...cur, { id, from: "buyer", body: text, at: new Date().toISOString(), status: null, name: null, previews: [], pending: "sending" }]);
      return;
    }
    await chatSend(text);
  };

  // Queued text: into the call once it is live, or into the chat if the call never got there.
  useEffect(() => {
    const action = flushQueued(callSnap.phase);
    if (action === "wait" || !queued.current.length) return;
    const list = queued.current;
    queued.current = [];
    const ids = new Set(list.map((q) => q.id));
    setItems((cur) => cur.filter((m) => !ids.has(m.id)));
    for (const q of list) {
      if (action === "call" && clientRef.current?.sendText(q.text)) continue;
      void chatSend(q.text);
    }
  }, [callSnap.phase]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  /**
   * Switches the chat to voice: audio unlocked in this tap, the microphone (the browser's own prompt), then the
   * server checks the gates and gives the ticket. No notice in between: it is the same conversation by voice.
   */
  const startCall = () => {
    const c = clientRef.current;
    // A second tap before the page re-rendered (a double tap) must not restart the call being set up.
    if (!c || CALL_PHASES.has(c.getSnapshot().phase)) return;
    setBarHidden(false);
    c.begin();
    void (async () => {
      if (!(await c.prepare())) return;
      try {
        const res = await fetch(`/chat/${token}/voice`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        const r = (await res.json().catch(() => ({}))) as {
          ok?: boolean; reason?: string; gate?: BuyerVoiceState["reason"];
          sessionId?: string; ticket?: string; wsUrl?: string; maxSec?: number; mode?: "scripted" | "live"; firstInConversation?: boolean;
        };
        if (r.ok && r.sessionId && r.ticket && r.wsUrl) {
          setFirstNote(!!r.firstInConversation);
          c.start({ wsUrl: r.wsUrl, sessionId: r.sessionId, ticket: r.ticket, maxSec: r.maxSec ?? null, mode: r.mode ?? null });
          return;
        }
        if (r.gate) {
          // A simulated chat or the seller's staff: the button turns disabled with the reason (the server said why).
          c.cancel();
          setVoiceState({ available: false, reason: r.gate });
          return;
        }
      } catch {
        // Shown as not available below.
      }
      c.unavailable("error");
    })();
  };
  // When a call ends: fetch its stored lines and the call row now, then let the bar go after a moment.
  useEffect(() => {
    if (callSnap.phase === "ended") void poll();
  }, [callSnap.phase, poll]);
  // The ended bar goes after 8 s, but never while the pointer is over it or focus is in it (the timer starts again after).
  const [barHold, setBarHold] = useState(false);
  useEffect(() => {
    if (callSnap.phase !== "ended" || barHold) return;
    const id = window.setTimeout(() => setBarHidden(true), BAR_HIDE_MS);
    return () => window.clearTimeout(id);
  }, [callSnap.phase, barHold]);
  useEffect(() => () => clientRef.current?.dispose(), []);
  const showBar = !!voice && !!clientRef.current && callSnap.phase !== "idle" && !barHidden;
  const showTalk = !!voice && voiceState.available && !inCall && !ended;
  // A gate off, and the server said why (a simulated chat, or the seller's signed-in staff): the button stays, disabled, with the reason under the composer.
  const whyOff = !!voice && !voiceState.available && !!voiceState.reason && !inCall && !ended
    ? tr(`buyer.voice.why.${voiceState.reason}` as MessageKey) : null;

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
  // Each finished call is framed by two rows between the messages: where it started (connected) and where it ended;
  // a short call with nothing from the buyer is one row only (its summary).
  const callRows = [...calls.flatMap((c) => [...(c.empty ? [] : [{ c, at: c.startedAt, start: true }]), { c, at: c.at, start: false }])].sort((a, b) => a.at.localeCompare(b.at) || Number(b.start) - Number(a.start));
  const pushCall = ({ c, start }: (typeof callRows)[number]) => {
    const at = new Date(start ? c.startedAt : c.at);
    separator(at, `d-${c.id}-${start ? "s" : "e"}`);
    rows.push(
      <div key={`call-${c.id}-${start ? "start" : "end"}`} className="c-call" dir={dir} data-call-row={start ? "start" : "end"}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /></svg>
        <span>{start ? tr("buyer.voice.call_started", { time: timeOf(at) }) : tr("buyer.voice.call_row", { length: callLength(c.durationSec, tr), time: timeOf(at) })}</span>
      </div>,
    );
  };
  items.forEach((m, i) => {
    const d = new Date(m.at);
    // A call's start row goes before its first line (spoken lines are stored after the call connected).
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
      {simulated ? <div className="c-banner" role="note" dir={dir}><b>{strings.bannerLead}</b> <span>{strings.banner}</span></div> : null}
      <header className="c-head" dir={dir}>
        <span className="c-avatar" aria-hidden="true">{initials}</span>
        <span className="c-head__text">
          <span className="c-head__name">{seller}</span>
          <span className={`c-head__sub${showTyping ? " c-head__sub--typing" : ""}`}>{showTyping ? strings.typing : strings.automated}</span>
        </span>
        {sms ? (
          // The chat menu (a native disclosure: works without JS): stop text messages, or turn them back on.
          <details className="c-menu" data-chat-menu="">
            <summary className="c-menu__btn" aria-label={strings.menu} title={strings.menu}><Icon name="ellipsis" /></summary>
            <div className="c-menu__list" role="menu">
              {sms.stopped ? (
                <form action={resumeSmsAction}>
                  <input type="hidden" name="token" value={token} />
                  <button type="submit" role="menuitem" className="c-menu__item" data-sms-resume="">{strings.smsOn}</button>
                </form>
              ) : (
                <a role="menuitem" className="c-menu__item" href={sms.stopUrl} data-sms-stop-menu="">{strings.smsStop}</a>
              )}
            </div>
          </details>
        ) : null}
      </header>
      {sms && sms.fromSms && !sms.stopped ? (
        <div className="c-stopbar" dir={dir}><a href={sms.stopUrl} data-sms-stop="">{strings.smsStop}</a></div>
      ) : null}
      {sms?.resumed && !sms.stopped ? <div className="c-notice c-notice--ok" role="status" dir={dir}>{strings.smsOnDone}</div> : null}
      {showBar && clientRef.current ? (
        <BuyerCallBar
          client={clientRef.current} tr={tr} agentName={voice!.agentName} dir={dir}
          firstNote={firstNote} onStartAgain={startCall} onClose={() => { clientRef.current?.cancel(); setBarHidden(true); setBarHold(false); }} onHoldChange={setBarHold}
        />
      ) : null}
      <div className="c-log" ref={logRef} role="log" aria-label={strings.messages} dir={dir}>
        {items.length === 0 && !closedAt ? <p className="c-empty" dir={dir}>{strings.empty}</p> : rows}
        {showTyping ? <div className="c-msg c-msg--in"><div className="c-bubble c-dots" role="status" aria-label={strings.typingLabel}><i /><i /><i /></div></div> : null}
      </div>
      <div className="c-sr" aria-live="polite">{announce}</div>
      {voice && clientRef.current ? (
        // The voice bubble, above the composer at the bottom-end; it also links an order form tab to this call.
        <ChatVoiceBubble client={clientRef.current} tabKey={voice.tabKey ?? null} tr={tr} agentName={voice.agentName} dir={dir} showBubble={showBar || inCall} />
      ) : null}
      {notice ? <div className="c-notice" role="status" dir={dir}>{notice}</div> : null}
      {ended ? (
        <div className="c-ended" role="status" aria-disabled="true" dir={dir}>{expired ? strings.expired : strings.ended}</div>
      ) : (
        <>
        <form className="c-bar" dir={dir} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="c-sr" htmlFor="c-input">{strings.placeholder}</label>
          <textarea
            id="c-input" ref={inputRef} className="c-input" rows={1} dir="auto" placeholder={strings.placeholder} value={draft} maxLength={4000}
            onChange={(e) => { setDraft(e.target.value); grow(); }} onKeyDown={onKey}
          />
          {/* The composer's edge, as in chat apps: Send while there is text; otherwise Switch to voice, or during a call Back to text. */}
          {!draft.trim() && inCall && voice ? (
            <button type="button" className="c-mode c-mode--back" aria-label={tr("buyer.voice.back")} title={tr("buyer.voice.back")} onClick={() => clientRef.current?.end()} data-voice-back="">
              <Icon name="keyboard" />
            </button>
          ) : !draft.trim() && (showTalk || whyOff) ? (
            <button
              type="button" className="c-mode" aria-label={tr("buyer.voice.switch")} title={whyOff ?? tr("buyer.voice.switch")}
              aria-disabled={whyOff ? true : undefined} aria-describedby={whyOff ? "c-voice-why" : undefined}
              onClick={() => { if (!whyOff) startCall(); }} data-voice-talk="" data-voice-disabled={whyOff ? "" : undefined}
            >
              <Icon name="audio-lines" />
            </button>
          ) : null}
          <button type="submit" className={`c-send${!draft.trim() && ((inCall && voice) || showTalk || whyOff) ? " c-send--hidden" : ""}`} aria-label={strings.send} disabled={!draft.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
          </button>
        </form>
        {whyOff ? <p className="c-voice-why" id="c-voice-why" dir={dir} data-voice-why={voiceState.reason}>{whyOff}</p> : null}
        </>
      )}
    </div>
  );
}
