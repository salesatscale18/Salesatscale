"use client";

import { useEffect } from "react";

type ChatBox = { scrollTop: number; scrollHeight: number; clientHeight: number; lastElementChild: { scrollIntoView(o?: ScrollIntoViewOptions): void } | null };

/**
 * Show the latest message of a thread. On a wide screen the chat pane is its
 * own scroll area (sas.css): it starts at the bottom. On a phone the page
 * scrolls, not the pane (and the `#thread` link put the page at the oldest
 * message): the latest message is scrolled into view instead. Pure enough to
 * unit-test with a fake element.
 */
export function scrollThreadToEnd(chat: ChatBox | null): "pane" | "page" | null {
  if (!chat) return null;
  if (chat.scrollHeight > chat.clientHeight + 1) {
    chat.scrollTop = chat.scrollHeight;
    return "pane";
  }
  chat.lastElementChild?.scrollIntoView({ block: "end" });
  return "page";
}

/**
 * The inbox thread opens at the latest message. Runs once per opened thread,
 * so a background refresh never moves the seller away from what they are reading.
 */
export function ScrollThreadToEnd() {
  useEffect(() => {
    scrollThreadToEnd(document.querySelector<HTMLElement>(".sas-inbox__chat .sas-chat"));
  }, []);
  return null;
}
