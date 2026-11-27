/**
 * The buyer voice bar's one-time hint ("What you say appears as text in this chat.", owner 26 Nov 2026): shown once, on
 * the buyer's first voice call in this browser, for about HINT_SHOW_MS, then never again. Remembered in localStorage;
 * where storage is blocked or throws (private modes, blocked site data), once per page load instead.
 */

/** The localStorage key (its value: when it was shown, ISO). */
export const HINT_KEY = "sas.voice.firstHint";
/** How long the hint shows, then its fade (none with reduced motion). */
export const HINT_SHOW_MS = 4000;
export const HINT_FADE_MS = 400;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Shown in this page load already (the fallback without storage). */
let shownThisLoad = false;

/** Test seam: a new page load. */
export function resetHintForTests() {
  shownThisLoad = false;
}

/**
 * True when the hint should show now, and marks it shown: the first call in this browser (storage), or, without
 * working storage, the first in this page load. Any storage error falls back to the page load; never throws.
 */
export function claimFirstHint(store: () => Store | null | undefined = defaultStore): boolean {
  let s: Store | null | undefined = null;
  try {
    s = store();
  } catch {
    s = null;
  }
  if (s) {
    try {
      if (s.getItem(HINT_KEY) !== null) return false;
      s.setItem(HINT_KEY, new Date().toISOString());
      shownThisLoad = true;
      return true;
    } catch {
      // Storage there but not usable (quota, blocked): the page load decides.
    }
  }
  if (shownThisLoad) return false;
  shownThisLoad = true;
  return true;
}

/** Where the hint is: showing, fading out (opacity only), or gone (its row collapses: the bar is compact again). */
export type HintPhase = "on" | "fading" | "off";

/**
 * Runs the hint once: "on" now, "fading" after HINT_SHOW_MS (or at once when `dismiss` is called), "off" after the
 * fade; with reduced motion no fade ("off" straight away). Returns { dismiss, cancel }.
 */
export function runHint(o: { reduced: boolean; set: (p: HintPhase) => void; showMs?: number; fadeMs?: number }) {
  const showMs = o.showMs ?? HINT_SHOW_MS;
  const fadeMs = o.reduced ? 0 : o.fadeMs ?? HINT_FADE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phase: HintPhase = "on";
  const go = (p: HintPhase) => {
    phase = p;
    o.set(p);
  };
  const leave = () => {
    if (phase !== "on") return;
    clearTimeout(timer);
    if (fadeMs <= 0) {
      go("off");
      return;
    }
    go("fading");
    timer = setTimeout(() => go("off"), fadeMs);
  };
  go("on");
  timer = setTimeout(leave, showMs);
  return { dismiss: leave, cancel: () => clearTimeout(timer) };
}

function defaultStore(): Store | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
