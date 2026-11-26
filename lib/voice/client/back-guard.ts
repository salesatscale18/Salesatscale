/**
 * The Back guard (board VoiceBubbleBack): on the buyer chat, the browser's Back first asks ("End the call?" during
 * a call, "Leave the chat?" otherwise); in the test lab it asks only during a test call, also for a link that
 * leaves the test lab. During a live call, closing or reloading the tab gets the browser's own leave prompt.
 *
 * How (constraints from the brief, each covered by tests/unit/back-guard.test.ts):
 * - One guard entry: a pushState on the SAME URL (query string kept: ?via=sms, ?sms=on), marked in history.state
 *   next to Next's own fields (__NA, tree), so Next neither reloads nor renders on the server for it (the chat page
 *   records "opened the chat" on every server render). Arming checks the mark first: a remount on the guard entry
 *   (a server action that redirects to the same URL replaces it) pushes nothing, so each mount adds at most one.
 * - A server action whose redirect changes the URL (?sms=on) pushes a new entry above the guard: Back from there
 *   lands on the guard and asks; Leave skips every entry of this page.
 * - Back lands on the entry under the guard (popstate): the sheet opens. The safe choice pushes the guard again.
 *   Leave goes back past every entry of this page (the guard, a redirect's entry): never a reload, never a
 *   navigation to /c/<code> (that redirect left no entry of its own).
 * - Links clicked on purpose leave without a sheet (pushState adds no step to a normal link); during a live call they
 *   also skip the browser's leave prompt.
 * - Restored from the back-forward cache (pageshow persisted): the guard is armed again; no unload handler (it
 *   would keep the page out of that cache), and the beforeunload handler is attached only during a live call.
 *
 * The class is plain (a window-like object is passed in), so it runs against a fake history in tests.
 */
import { useEffect, useRef, useState } from "react";

/** The key our mark has in history.state (next to Next's __NA and tree). */
export const GUARD_KEY = "__sasBackGuard";

/** What the sheet asks. */
export type GuardAsk = "end_call" | "leave_chat";
/** The answer: the safe choice (Keep talking, Stay in the chat), stop the call (End call), or Leave. */
export type GuardChoice = "stay" | "end_call" | "leave";

type Listener = (e: { state?: unknown; persisted?: boolean } & Partial<Event>) => void;

/** The part of `window` the guard uses. */
export interface GuardWindow {
  history: { readonly state: unknown; readonly length: number; pushState(data: unknown, unused: string, url?: string | null): void; replaceState(data: unknown, unused: string, url?: string | null): void; back(): void };
  location: { readonly href: string; readonly pathname: string; readonly origin: string };
  addEventListener(type: string, fn: Listener, opts?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, fn: Listener, opts?: boolean | EventListenerOptions): void;
  document?: { addEventListener(type: string, fn: (e: MouseEvent) => void, capture?: boolean): void; removeEventListener(type: string, fn: (e: MouseEvent) => void, capture?: boolean): void };
}

export type BackGuardOptions = {
  /** What Back asks now; null: Back goes back as usual (the test lab with no call). */
  ask: () => GuardAsk | null;
  /** Opens the sheet. */
  onAsk: (ask: GuardAsk) => void;
  /** Closes the sheet when the guard settles it itself (Forward while it is open, a restore from the cache). */
  onSettled?: () => void;
  /** During a live call: closing or reloading the tab gets the browser's own leave prompt. */
  liveCall: () => boolean;
  /** The test lab: a link that leaves this page during a call asks first ("End the call?"). */
  guardLinks?: boolean;
  /** Clock for the "clicked on purpose" window (tests). */
  now?: () => number;
};

const marked = (state: unknown): boolean => !!state && typeof state === "object" && (state as Record<string, unknown>)[GUARD_KEY] === true;
const withMark = (state: unknown) => ({ ...(state && typeof state === "object" ? (state as Record<string, unknown>) : {}), [GUARD_KEY]: true });

export class BackGuard {
  private readonly path: string;
  private leaving = false;
  private open = false;
  /** Until when an unload counts as a link clicked on purpose (no leave prompt). */
  private intentionalUntil = 0;
  private unloadOn = false;
  private started = false;
  /** The entry we are on: marked (the guard) or not, and its URL (to skip a guard nobody needs any more). */
  private at: { marked: boolean; href: string; stateful: boolean };
  private readonly now: () => number;

  constructor(private readonly win: GuardWindow, private readonly o: BackGuardOptions) {
    this.path = win.location.pathname;
    this.at = { marked: marked(win.history.state), href: win.location.href, stateful: win.history.state != null };
    this.now = o.now ?? (() => Date.now());
  }

  /** Mounts: arms the guard (once per entry) and listens. */
  start() {
    if (this.started) return;
    this.started = true;
    this.win.addEventListener("popstate", this.onPop);
    this.win.addEventListener("pageshow", this.onShow);
    this.win.document?.addEventListener("click", this.onClick, true);
    this.sync();
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.win.removeEventListener("popstate", this.onPop);
    this.win.removeEventListener("pageshow", this.onShow);
    this.win.document?.removeEventListener("click", this.onClick, true);
    this.setUnload(false);
  }

  /** Arms the guard when Back should ask: one pushState on the same URL, never on an entry that is already the guard. */
  arm() {
    if (!this.o.ask()) return;
    const h = this.win.history;
    if (marked(h.state)) return;
    h.pushState(withMark(h.state), "", this.win.location.href);
    this.at = { marked: true, href: this.win.location.href, stateful: true };
  }

  /** The call or what Back asks changed: the leave prompt follows the live call; a test call that starts arms the guard. */
  sync() {
    this.setUnload(this.o.liveCall());
    if (!this.open && !this.leaving) this.arm();
  }

  /** The sheet's answer. End call: the caller ends the call; the guard stays for the chat (Leave the chat? from then on). */
  choose(choice: GuardChoice) {
    this.open = false;
    if (choice === "leave") {
      this.leaving = true;
      this.setUnload(false);
      this.win.history.back();
      return;
    }
    this.arm();
  }

  get isOpen() {
    return this.open;
  }

  private onPop: Listener = (e) => {
    const state = e.state === undefined ? this.win.history.state : e.state;
    const prev = this.at;
    this.at = { marked: marked(state), href: this.win.location.href, stateful: state != null };
    if (this.leaving) {
      // Leave: past every entry of this page (the guard, a redirect's entry) to the page before it.
      if (this.win.location.pathname === this.path) this.win.history.back();
      else this.leaving = false;
      return;
    }
    // Not ours: a fragment link (no state), or another page of the app.
    if (state === null || state === undefined || this.win.location.pathname !== this.path) return;
    if (marked(state)) {
      // Forward onto the guard while the sheet is open: as the safe choice.
      if (this.open) {
        this.open = false;
        this.o.onSettled?.();
        return;
      }
      // Back from a fragment link's step onto the guard: not a step off the page.
      if (!prev.stateful) return;
      // Back from a redirect's entry onto the guard: this step asks too.
    }
    const ask = this.o.ask();
    if (!ask) {
      // The test lab after its call: Back stepped off a guard nobody needs any more; it goes on to where it meant to.
      if (prev.marked && !marked(state) && prev.href === this.win.location.href) this.win.history.back();
      return;
    }
    this.open = true;
    this.o.onAsk(ask);
  };

  private onShow: Listener = (e) => {
    if (!e.persisted) return;
    // Back from the next page, restored from the cache: the page was left on purpose; guard it again.
    this.leaving = false;
    if (this.open) {
      this.open = false;
      this.o.onSettled?.();
    }
    this.arm();
    this.sync();
  };

  private onBeforeUnload: Listener = (e) => {
    if (this.leaving || this.now() < this.intentionalUntil) return;
    e.preventDefault?.();
    // Older browsers show the prompt only with a returnValue.
    (e as { returnValue?: unknown }).returnValue = "";
  };

  private setUnload(on: boolean) {
    if (on === this.unloadOn) return;
    this.unloadOn = on;
    if (on) this.win.addEventListener("beforeunload", this.onBeforeUnload);
    else this.win.removeEventListener("beforeunload", this.onBeforeUnload);
  }

  /** A link clicked on purpose: no leave prompt for it; in the test lab during a call, a link off the page asks first. */
  private onClick = (e: MouseEvent) => {
    const a = (e.target as { closest?: (s: string) => Element | null } | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((a.target && a.target !== "_self") || a.hasAttribute("download")) return;
    let url: URL;
    try {
      url = new URL(a.href, this.win.location.href);
    } catch {
      return;
    }
    if (this.o.guardLinks && url.origin === this.win.location.origin && url.pathname !== this.path) {
      const ask = this.o.ask();
      if (ask) {
        e.preventDefault();
        e.stopPropagation();
        this.open = true;
        this.o.onAsk(ask);
        return;
      }
    }
    this.intentionalUntil = this.now() + 1500;
  };
}

/**
 * The guard on a page: `ask` says what Back asks now (null: nothing), `liveCall` whether a call is live.
 * Returns the open sheet (or null) and `choose` for its answer; End call is the caller's to run (`onEndCall`).
 */
export function useBackGuard(o: { ask: GuardAsk | null; liveCall: boolean; guardLinks?: boolean; onEndCall: () => void; enabled?: boolean }) {
  const [sheet, setSheet] = useState<GuardAsk | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const guard = useRef<BackGuard | null>(null);
  const enabled = o.enabled !== false;
  useEffect(() => {
    if (!enabled) return;
    const g = new BackGuard(window as unknown as GuardWindow, {
      ask: () => latest.current.ask,
      liveCall: () => latest.current.liveCall,
      guardLinks: latest.current.guardLinks,
      onAsk: (a) => setSheet(a),
      onSettled: () => setSheet(null),
    });
    guard.current = g;
    g.start();
    return () => {
      g.stop();
      guard.current = null;
    };
  }, [enabled]);
  useEffect(() => {
    guard.current?.sync();
  }, [o.ask, o.liveCall]);
  const choose = (c: GuardChoice) => {
    setSheet(null);
    if (c === "end_call") latest.current.onEndCall();
    guard.current?.choose(c);
  };
  // The call ended while "End the call?" was open: the sheet asks what Back asks now (or closes, nothing to ask).
  const shown = sheet && o.ask ? (sheet === "end_call" ? o.ask : sheet) : null;
  useEffect(() => {
    if (sheet && !o.ask) {
      setSheet(null);
      guard.current?.choose("stay");
    }
  }, [sheet, o.ask]);
  return { sheet: shown, choose };
}
