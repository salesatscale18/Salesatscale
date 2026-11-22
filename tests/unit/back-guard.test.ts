/**
 * The Back guard (lib/voice/client/back-guard.ts) against a fake browser history: one guard entry on the same URL
 * (query string kept), marked next to Next's state; never a reload or a server navigation; re-armed once per entry
 * after a remount; Leave goes back past this page's entries; links clicked on purpose leave without a sheet or a
 * leave prompt; the leave prompt only during a live call; the test lab asks only during its call; the cache restore.
 */
import { describe, expect, it } from "vitest";
import { BackGuard, GUARD_KEY, type GuardAsk, type GuardWindow } from "@/lib/voice/client/back-guard";

type Entry = { url: string; state: unknown };
type Fn = (e: Record<string, unknown>) => void;

/** A tab's session history: entries, an index, popstate on back(), pages before ours (another site). */
class FakeTab implements GuardWindow {
  entries: Entry[];
  i: number;
  listeners = new Map<string, Set<Fn>>();
  docListeners = new Set<(e: MouseEvent) => void>();
  /** What the page did: pushes, replaces, reloads, server navigations (none of the last two must happen). */
  log: string[] = [];
  left = false;
  constructor(before: string[], url: string, state: unknown = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "t" } }) {
    this.entries = [...before.map((u) => ({ url: u, state: null })), { url, state }];
    this.i = this.entries.length - 1;
  }
  get history() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const tab = this;
    return {
      get state() { return tab.entries[tab.i].state; },
      get length() { return tab.entries.length; },
      pushState(data: unknown, _u: string, url?: string | null) {
        tab.entries = tab.entries.slice(0, tab.i + 1);
        tab.entries.push({ url: url ?? tab.entries[tab.i].url, state: structuredClone(data) });
        tab.i++;
        tab.log.push(`push ${url}`);
      },
      replaceState(data: unknown, _u: string, url?: string | null) {
        tab.entries[tab.i] = { url: url ?? tab.entries[tab.i].url, state: structuredClone(data) };
        tab.log.push(`replace ${url}`);
      },
      back() { tab.go(-1); },
    };
  }
  get location() {
    const u = new URL(this.entries[this.i].url);
    return { href: u.href, pathname: u.pathname, origin: u.origin };
  }
  /** The browser's Back and Forward buttons (and history.back()): popstate within our page, gone past it. */
  go(d: -1 | 1) {
    const j = this.i + d;
    if (j < 0 || j >= this.entries.length) return;
    this.i = j;
    if (!this.entries[j].url.startsWith("https://app.example.com/chat/") && !this.entries[j].url.startsWith("https://app.example.com/app/")) {
      this.left = true;
      return;
    }
    for (const fn of this.listeners.get("popstate") ?? []) fn({ state: this.entries[j].state });
  }
  addEventListener(type: string, fn: Fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Fn) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
    return e;
  }
  document = {
    addEventListener: (_t: string, fn: (e: MouseEvent) => void) => this.docListeners.add(fn),
    removeEventListener: (_t: string, fn: (e: MouseEvent) => void) => this.docListeners.delete(fn),
  };
  /** A click on a link (href, target): what the page's capture listener sees. */
  click(href: string, o: { target?: string } = {}) {
    const a = { href: new URL(href, this.location.href).href, target: o.target ?? "", hasAttribute: () => false };
    const e = { target: { closest: () => a }, button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of this.docListeners) fn(e as unknown as MouseEvent);
    return e;
  }
  urls() { return this.entries.map((x) => x.url.replace("https://app.example.com", "")); }
}

const CHAT = "https://app.example.com/chat/tok123?via=sms";

function chatGuard(tab: FakeTab, o: { call?: () => boolean; asks?: GuardAsk[]; now?: () => number } = {}) {
  const asks = o.asks ?? [];
  const call = o.call ?? (() => false);
  const g = new BackGuard(tab, { ask: () => (call() ? "end_call" : "leave_chat"), liveCall: call, onAsk: (a) => asks.push(a), now: o.now });
  g.start();
  return { g, asks };
}

describe("the Back guard: one entry on the same URL", () => {
  it("pushes ONE guard on the same URL with the full query string, keeping Next's state (no reload, no server render)", () => {
    const tab = new FakeTab(["https://sms.example.org/inbox"], CHAT);
    chatGuard(tab);
    expect(tab.urls()).toEqual(["https://sms.example.org/inbox", "/chat/tok123?via=sms", "/chat/tok123?via=sms"]);
    expect(tab.entries[2].state).toMatchObject({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: "t" }, [GUARD_KEY]: true });
    expect(tab.log).toEqual(["push https://app.example.com/chat/tok123?via=sms"]);
    // ?sms=on keeps its query too.
    const t2 = new FakeTab([], "https://app.example.com/chat/tok123?sms=on");
    chatGuard(t2);
    expect(t2.urls()).toEqual(["/chat/tok123?sms=on", "/chat/tok123?sms=on"]);
  });

  it("a remount (or a second mount: React's dev double effect) on the guard entry pushes nothing: exactly one guard", () => {
    const tab = new FakeTab([], CHAT);
    const a = chatGuard(tab);
    a.g.stop();
    chatGuard(tab);
    chatGuard(tab);
    expect(tab.log).toHaveLength(1);
    expect(tab.entries).toHaveLength(2);
  });

  it("a server action's redirect to a new URL (?sms=on) above the guard: a remount arms once; Back asks; Leave skips all this page's entries", () => {
    const tab = new FakeTab(["https://sms.example.org/inbox"], CHAT);
    chatGuard(tab).g.stop();
    // Next pushes the redirect's entry (its own state, no mark) and the page mounts again there.
    tab.history.pushState({ __NA: true }, "", "https://app.example.com/chat/tok123?sms=on");
    const { g, asks } = chatGuard(tab);
    expect(tab.log.filter((l) => l.startsWith("push"))).toHaveLength(3); // guard, Next's redirect, one guard for this mount
    tab.go(-1);
    expect(asks).toEqual(["leave_chat"]);
    g.choose("leave");
    expect(tab.left).toBe(true);
    expect(tab.location.href).toBe("https://sms.example.org/inbox");
    expect(tab.log.join(" ")).not.toMatch(/\/c\/|reload/);
  });
});

describe("the Back guard: the sheets", () => {
  it("Back in the text chat: Leave the chat?; Stay re-arms one guard; Back asks again", () => {
    const tab = new FakeTab(["https://sms.example.org/inbox"], CHAT);
    const { g, asks } = chatGuard(tab);
    tab.go(-1);
    expect(asks).toEqual(["leave_chat"]);
    expect(g.isOpen).toBe(true);
    expect(tab.left).toBe(false);
    g.choose("stay");
    expect(tab.entries).toHaveLength(3);
    expect(tab.i).toBe(2);
    tab.go(-1);
    expect(asks).toEqual(["leave_chat", "leave_chat"]);
  });

  it("Leave really leaves: history.back() past the guard, to the page before (the /c/ redirect left no entry)", () => {
    const tab = new FakeTab(["https://sms.example.org/inbox"], CHAT);
    const { g } = chatGuard(tab);
    tab.go(-1);
    g.choose("leave");
    expect(tab.left).toBe(true);
    expect(tab.location.href).toBe("https://sms.example.org/inbox");
  });

  it("during a call: End the call?; End call ends it, stays in the chat and guards it for Leave the chat? from then on", () => {
    const tab = new FakeTab([], CHAT);
    let live = true;
    const { g, asks } = chatGuard(tab, { call: () => live });
    tab.go(-1);
    expect(asks).toEqual(["end_call"]);
    live = false; // the caller ended the call
    g.choose("end_call");
    expect(tab.i).toBe(1);
    expect(tab.history.state).toMatchObject({ [GUARD_KEY]: true });
    tab.go(-1);
    expect(asks).toEqual(["end_call", "leave_chat"]);
  });

  it("Forward onto the guard while the sheet is open settles it as the safe choice", () => {
    const tab = new FakeTab([], CHAT);
    const settled: string[] = [];
    const g = new BackGuard(tab, { ask: () => "leave_chat", liveCall: () => false, onAsk: () => {}, onSettled: () => settled.push("x") });
    g.start();
    tab.go(-1);
    tab.go(1);
    expect(settled).toEqual(["x"]);
    expect(g.isOpen).toBe(false);
  });

  it("a fragment link's step (no state) is not Back", () => {
    const tab = new FakeTab([], CHAT);
    const { asks } = chatGuard(tab);
    // A fragment navigation: a new entry with no state, and popstate (as browsers fire it).
    tab.history.pushState(null, "", `${CHAT}#x`);
    tab.fire("popstate", { state: null });
    tab.go(-1);
    tab.go(1);
    expect(asks).toEqual([]);
  });
});

describe("the Back guard: links and the leave prompt", () => {
  it("links clicked on purpose leave without a sheet, and skip the leave prompt during a call", () => {
    const tab = new FakeTab([], CHAT);
    let t = 1000;
    const { asks } = chatGuard(tab, { call: () => true, now: () => t });
    const click = tab.click("https://app.example.com/sms/stop/abc");
    expect(click.defaultPrevented).toBe(false);
    expect(asks).toEqual([]);
    const e = tab.fire("beforeunload", { preventDefault() { (this as Record<string, unknown>).prevented = true; } });
    expect(e.prevented).toBeUndefined();
    // Later, closing the tab during the call: the browser's prompt.
    t += 5000;
    const e2 = tab.fire("beforeunload", { preventDefault() { (this as Record<string, unknown>).prevented = true; } });
    expect(e2.prevented).toBe(true);
    expect(e2.returnValue).toBe("");
  });

  it("the leave prompt only during a live call", () => {
    const tab = new FakeTab([], CHAT);
    let live = false;
    const { g } = chatGuard(tab, { call: () => live });
    expect(tab.listeners.get("beforeunload")?.size ?? 0).toBe(0);
    live = true;
    g.sync();
    expect(tab.listeners.get("beforeunload")?.size).toBe(1);
    live = false;
    g.sync();
    expect(tab.listeners.get("beforeunload")?.size).toBe(0);
  });

  it("restored from the back-forward cache: guarded again, no sheet left open", () => {
    const tab = new FakeTab(["https://sms.example.org/inbox"], CHAT);
    const { g } = chatGuard(tab);
    tab.go(-1);
    g.choose("leave");
    // Forward from the SMS app's page: the chat comes back from the cache, on its first entry.
    tab.i = 1;
    tab.left = false;
    tab.fire("pageshow", { persisted: true });
    expect(tab.i).toBe(2);
    expect(tab.history.state).toMatchObject({ [GUARD_KEY]: true });
    expect(tab.entries).toHaveLength(3);
  });
});

describe("the Back guard in the test lab", () => {
  const LAB = "https://app.example.com/app/acme/setup/test-lab?c=conv1";
  function labGuard(tab: FakeTab, onCall: () => boolean) {
    const asks: GuardAsk[] = [];
    const g = new BackGuard(tab, { ask: () => (onCall() ? "end_call" : null), liveCall: onCall, guardLinks: true, onAsk: (a) => asks.push(a) });
    g.start();
    return { g, asks };
  }

  it("no call: no guard, Back and links as usual", () => {
    const tab = new FakeTab(["https://app.example.com/app/acme/leads"], LAB);
    const { asks } = labGuard(tab, () => false);
    expect(tab.entries).toHaveLength(2);
    expect(tab.click("/app/acme/leads").defaultPrevented).toBe(false);
    expect(asks).toEqual([]);
  });

  it("during a call: Back and a link off the test lab ask End the call?; a link within the test lab does not", () => {
    const tab = new FakeTab(["https://app.example.com/app/acme/leads"], LAB);
    let on = false;
    const { g, asks } = labGuard(tab, () => on);
    on = true;
    g.sync();
    expect(tab.entries).toHaveLength(3);
    expect(tab.click("/app/acme/setup/test-lab?c=conv2").defaultPrevented).toBe(false);
    expect(tab.click("/app/acme/leads").defaultPrevented).toBe(true);
    expect(asks).toEqual(["end_call"]);
    g.choose("stay");
    expect(tab.entries).toHaveLength(3);
    tab.go(-1);
    expect(asks).toEqual(["end_call", "end_call"]);
    g.choose("end_call");
    on = false;
    g.sync();
    // The call is over: Back from the leftover guard entry goes on, past it, to where it meant to go.
    tab.go(-1);
    expect(tab.location.pathname).toBe("/app/acme/leads");
  });
});
