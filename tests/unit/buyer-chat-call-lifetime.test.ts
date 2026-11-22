/**
 * The buyer chat page keeps a voice call alive while the thread refreshes (22 Nov 2026: two live calls ended
 * with the browser's close 1001 after 39 and 45 s). The call's client lives in a ref of the chat component, made
 * once and disposed only when the component unmounts; nothing on the page reloads, navigates or refreshes the
 * route by itself (the thread's poll only sets state), and links that leave the page open in a new tab.
 * Static checks of the page's source (no DOM in this test runner).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
const files = ["app/chat/[token]/chat-client.tsx", "app/chat/[token]/voice.tsx", "app/chat/[token]/reach.tsx", "app/chat/[token]/page.tsx"];

describe("the buyer chat page never reloads or remounts a call by itself", () => {
  it("no route refresh, reload or navigation from code", () => {
    for (const f of files) {
      const src = read(f);
      expect(src, f).not.toMatch(/router\.(refresh|push|replace)\(|location\.(reload|assign|replace)\(|location\.href\s*=/);
      expect(src, f).not.toMatch(/useRouter\(/);
    }
  });

  it("the call's client is made once (a ref) and disposed only on unmount", () => {
    const src = read("app/chat/[token]/chat-client.tsx");
    expect(src).toContain('if (voice && !clientRef.current && typeof window !== "undefined") clientRef.current = new VoiceClient();');
    expect(src.match(/\.dispose\(\)/g)).toHaveLength(1);
    expect(src).toContain("useEffect(() => () => clientRef.current?.dispose(), []);");
  });

  it("links in the chat open in a new tab (the call's page stays)", () => {
    const src = read("app/chat/[token]/chat-client.tsx");
    for (const m of src.matchAll(/<a [^>]*href=\{p(?:\.url)?\}[^>]*>/g)) expect(m[0]).toContain('target="_blank"');
  });
});
