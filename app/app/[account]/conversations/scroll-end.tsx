"use client";

import { useEffect } from "react";

/**
 * The inbox thread opens at the latest message: its scroll area (the chat
 * pane, sas.css) starts at the bottom. Runs once per opened thread, so a
 * background refresh never moves the seller away from what they are reading.
 */
export function ScrollThreadToEnd() {
  useEffect(() => {
    const chat = document.querySelector<HTMLElement>(".sas-inbox__chat .sas-chat");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }, []);
  return null;
}
