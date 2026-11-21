import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/lib/i18n/messages/en.json";
import { t, type MessageKey } from "@/lib/i18n";
import { HIDDEN_LEAD_EVENTS, LEAD_EVENT_ICON, isTimelineEvent, leadEventIcon, leadEventKey, leadEventTitle } from "@/lib/leads/event-icons";
import { SMS_EVENTS, SMS_KINDS } from "@/lib/sms/rules";
import { CALLBACK_EVENTS } from "@/lib/callbacks/rules";
import { TEAM_QUESTION_EVENTS } from "@/lib/team-questions/rules";
import { CHAT_OPENED_EVENT, SPEND_CAP_HANDOFF_EVENT } from "@/lib/agent/thread-markers";
import { SIMULATOR_CHANNEL, WEB_CHAT_CHANNEL } from "@/lib/simulator/rules";

const ROOT = process.cwd();

function sources(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
    const rel = path.join(dir, d.name);
    if (d.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(d.name) ? [rel] : [];
  });
}

/**
 * Every lead event type the code writes: literal `type: "x.y"` values and
 * `addEvent(..., "x.y", ...)` in files that write lead_events, plus the shared
 * constant sets the writers use.
 */
function writtenTypes(): Set<string> {
  const out = new Set<string>([
    ...Object.values(SMS_EVENTS), ...Object.values(CALLBACK_EVENTS), ...Object.values(TEAM_QUESTION_EVENTS),
    CHAT_OPENED_EVENT, SPEND_CAP_HANDOFF_EVENT,
  ]);
  for (const file of [...sources("lib"), ...sources("app")]) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (!src.includes("leadEvents")) continue;
    // Provider webhook types (payment.succeeded) are not lead events.
    if (file.endsWith(path.join("payments", "events.ts"))) {
      for (const m of src.matchAll(/insert\(leadEvents\)[\s\S]{0,400}?type: "([a-z_]+\.[a-z_]+)"/g)) out.add(m[1]);
      continue;
    }
    for (const m of src.matchAll(/\btype: "([a-z_]+\.[a-z_]+)"/g)) out.add(m[1]);
    for (const m of src.matchAll(/addEvent\([^)]*?"([a-z_]+\.[a-z_]+)"/g)) out.add(m[1]);
  }
  return out;
}

const keys = en as Record<string, string>;

describe("lead event titles", () => {
  const types = writtenTypes();

  it("finds the Reach event types among the written ones", () => {
    for (const x of ["chat.opened", "sms.sent", "sms.mocked", "sms.stopped", "lead.created", "order.paid"]) expect(types).toContain(x);
    expect(types).not.toContain("payment.succeeded");
  });

  it("every event type the code writes has a timeline title and icon, or is in the hidden list", () => {
    const missing: string[] = [];
    for (const type of types) {
      if (HIDDEN_LEAD_EVENTS.includes(type)) continue;
      const variants = type === "conversation.started"
        ? [undefined, { channel: SIMULATOR_CHANNEL }, { channel: WEB_CHAT_CHANNEL }]
        : [undefined];
      for (const data of variants) {
        const key = `lead.event.${leadEventKey(type, data)}`;
        if (!keys[key]) missing.push(`${key} (title)`);
        if (!LEAD_EVENT_ICON[leadEventKey(type, data)]) missing.push(`${type} (icon)`);
        if (leadEventIcon(type, { data }) === "cog") missing.push(`${type} (gear)`);
        if (!leadEventTitle(type, data, t).trim()) missing.push(`${type} (empty title)`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("hidden events are internal only and stay out of the timeline", () => {
    expect([...HIDDEN_LEAD_EVENTS]).toEqual([SMS_EVENTS.status]);
    expect(isTimelineEvent(SMS_EVENTS.status)).toBe(false);
    expect(isTimelineEvent(SMS_EVENTS.sent)).toBe(true);
  });

  it("an SMS names what it was about; stops and chat opens have plain titles", () => {
    expect(leadEventTitle("sms.sent", { kind: "order_form" }, t)).toBe("SMS sent: order form ready");
    expect(leadEventTitle("sms.mocked", { kind: "chat_link" }, t)).toBe("SMS not sent (test mode): chat link");
    expect(leadEventTitle("sms.refused", { kind: "quote_ready" }, t)).toBe("SMS not sent: quote ready");
    expect(leadEventTitle("sms.failed", { kind: "nope" }, t)).toBe("SMS failed: text message");
    expect(leadEventTitle("sms.sent", null, t)).toBe("SMS sent: text message");
    expect(leadEventTitle("sms.stopped", { via: "stop_link" }, t)).toBe("Text messages stopped");
    expect(leadEventTitle("sms.resumed", null, t)).toBe("Text messages turned back on");
    expect(leadEventTitle("chat.opened", { via: "sms" }, t)).toBe("Opened the chat");
    expect(leadEventTitle("quote.created", null, t)).toBe("Quote created");
    for (const kind of SMS_KINDS) expect(keys[`lead.event.sms_kind.${kind}` as MessageKey], kind).toBeTruthy();
  });
});
