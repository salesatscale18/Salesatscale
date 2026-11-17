"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { BuyerChat, BuyerMessage, LinkPreview } from "@/lib/simulator/service";

export type ChatStrings = {
  bannerLead: string; banner: string; automated: string; typing: string; typingLabel: string; placeholder: string; send: string; ended: string;
  closedBy: string; today: string; yesterday: string; openForm: string; formLabel: string; todayWord: string; perMonth: string;
  empty: string; notSent: string; messages: string; sent: string; delivered: string; read: string;
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

/** Amounts and IDs stay left-to-right inside Hebrew text. */
const Num = ({ children }: { children: ReactNode }) => <span className="c-num">{children}</span>;

function Card({ p, s, initials, dir }: { p: LinkPreview; s: ChatStrings; initials: string; dir: "ltr" | "rtl" }) {
  return (
    <div className="c-card" dir={dir}>
      <div className="c-card__top">
        <span className="c-card__logo" aria-hidden="true">{initials}</span>
        <span className="c-card__text">
          <b className="c-card__seller">{p.seller}</b>
          <span className="c-card__title">{s.formLabel} · <Num>{p.ref}</Num></span>
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

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/**
 * The buyer's chat: polls `messages?after=<id>` every 2 s while the tab is
 * visible, sends with Enter (Shift+Enter for a new line), shows "typing…"
 * while an agent turn runs, and announces new replies to screen readers.
 * The layout never flips; banner, header, card, separators and bar take the
 * lead's direction and every bubble is dir="auto".
 */
export function ChatClient({ token, lang, seller, initials, strings, initial }: {
  token: string; lang: string; seller: string; initials: string; strings: ChatStrings; initial: BuyerChat;
}) {
  const [items, setItems] = useState<Shown[]>(initial.messages);
  const [typing, setTyping] = useState(initial.typing);
  const [ended, setEnded] = useState(initial.ended);
  const [closedAt, setClosedAt] = useState(initial.closedAt);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
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
      if (!res.ok) return;
      const data = (await res.json()) as BuyerChat;
      setTyping(data.typing);
      setEnded(data.ended);
      setClosedAt(data.closedAt);
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
  }, [items.length, typing]);

  const grow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || ended) return;
    const clientId = crypto.randomUUID();
    setDraft("");
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

  const now = new Date();
  const yesterday = new Date(now.getTime() - 86_400_000);
  const dateLabel = (d: Date) => dayKey(d) === dayKey(now) ? strings.today
    : dayKey(d) === dayKey(yesterday) ? strings.yesterday
    : new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(d);
  const timeOf = (d: Date) => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

  const rows: ReactNode[] = [];
  let prevDay = "";
  const separator = (d: Date, key: string) => {
    if (dayKey(d) === prevDay) return;
    prevDay = dayKey(d);
    rows.push(<div key={key} className="c-date" role="separator" dir={dir} suppressHydrationWarning>{dateLabel(d)}</div>);
  };
  items.forEach((m, i) => {
    const d = new Date(m.at);
    separator(d, `d-${m.id}`);
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
          <div className="c-bubble" dir="auto">
            <Linked text={m.previews.length ? text : m.body} />
            <span className="c-meta">
              <time dateTime={m.at} suppressHydrationWarning>{timeOf(d)}</time>
              {m.pending === "failed" ? <span>· {strings.notSent}</span> : null}
              {state ? <Tick state={state} label={strings[state]} /> : null}
            </span>
          </div>
        )}
        {m.previews.map((p) => <Card key={p.url} p={p} s={strings} initials={initials} dir={dir} />)}
      </div>,
    );
  });
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
      <div className="c-log" ref={logRef} role="log" aria-label={strings.messages}>
        {items.length === 0 && !closedAt ? <p className="c-empty" dir={dir}>{strings.empty}</p> : rows}
        {showTyping ? <div className="c-msg c-msg--in"><div className="c-bubble c-dots" role="status" aria-label={strings.typingLabel}><i /><i /><i /></div></div> : null}
      </div>
      <div className="c-sr" aria-live="polite">{announce}</div>
      {notice ? <div className="c-notice" role="status" dir={dir}>{notice}</div> : null}
      {ended ? (
        <div className="c-ended" role="status" aria-disabled="true" dir={dir}>{strings.ended}</div>
      ) : (
        <form className="c-bar" dir={dir} onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label className="c-sr" htmlFor="c-input">{strings.placeholder}</label>
          <textarea
            id="c-input" ref={inputRef} className="c-input" rows={1} dir="auto" placeholder={strings.placeholder} value={draft} maxLength={4000}
            onChange={(e) => { setDraft(e.target.value); grow(); }} onKeyDown={onKey}
          />
          <button type="submit" className="c-send" aria-label={strings.send} disabled={!draft.trim()}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></svg>
          </button>
        </form>
      )}
    </div>
  );
}
