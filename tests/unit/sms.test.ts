import { describe, expect, it } from "vitest";
import { TwilioRestTransport, type SendRequest, type SendResult, type TwilioTransport } from "@/lib/channels/twilio";
import {
  DEFAULT_SMS_DAILY_CAP, SMS_EVENTS, SMS_KINDS, SMS_PER_LEAD_DAILY, smsConfig, smsMode, smsRefusal, smsRoute, smsSegments, smsStoppedOf,
  type SmsFacts,
} from "@/lib/sms/rules";
import { smsText } from "@/lib/sms/texts";
import { leadIdFromStopToken, stopPath, stopTokenFor } from "@/lib/sms/token";
import { TwilioSmsTransport } from "@/lib/sms/transport";
import { chatTokenFor, linkIdFromChatToken } from "@/lib/simulator/token";
import { demoPhone, DEMO_SOURCE_REF_PREFIX } from "@/lib/demo/phones";

const MG = `MG${"a".repeat(32)}`;
const ALL_DAY = Array.from({ length: 7 }, () => ({ on: true, from: "00:00", to: "23:59" }));
const NEVER = Array.from({ length: 7 }, () => ({ on: false, from: "08:00", to: "09:00" }));
const NOW = new Date("2026-11-20T12:00:00Z");

const facts = (over: Partial<SmsFacts> = {}, lead: Partial<SmsFacts["lead"]> = {}): SmsFacts => ({
  lead: { isTest: false, status: "new", phone: "+972501234567", sourceRef: null, buyerRef: null, ...lead },
  stopped: false, hasConsent: true, kind: "follow_up", contactHours: ALL_DAY, timezone: "Asia/Jerusalem", recent: [], now: NOW,
  ...over,
});
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

describe("SMS mode and settings", () => {
  it("defaults to mock and reads test and live", () => {
    expect(smsMode({})).toBe("mock");
    expect(smsMode({ SMS_MODE: "" })).toBe("mock");
    expect(smsMode({ SMS_MODE: "nonsense" })).toBe("mock");
    expect(smsMode({ SMS_MODE: " TEST " })).toBe("test");
    expect(smsMode({ SMS_MODE: "live" })).toBe("live");
  });

  it("is always mock on Preview, whatever SMS_MODE says", () => {
    expect(smsMode({ SMS_MODE: "live", VERCEL_ENV: "preview" })).toBe("mock");
    expect(smsMode({ SMS_MODE: "test", VERCEL_ENV: "preview" })).toBe("mock");
    expect(smsMode({ SMS_MODE: "live", VERCEL_ENV: "production" })).toBe("live");
  });

  it("parses the service SID, tester numbers and the daily cap", () => {
    const c = smsConfig({ SMS_MODE: "test", TWILIO_SMS_MESSAGING_SERVICE_SID: ` ${MG} `, SMS_TEST_NUMBERS: "+972501111111, +972502222222;bad,+972501111111", SMS_DAILY_CAP: "20" });
    expect(c).toEqual({ mode: "test", messagingServiceSid: MG, testNumbers: ["+972501111111", "+972502222222"], dailyCap: 20 });
    expect(smsConfig({ TWILIO_SMS_MESSAGING_SERVICE_SID: "PN123" }).messagingServiceSid).toBeNull();
    expect(smsConfig({}).dailyCap).toBe(DEFAULT_SMS_DAILY_CAP);
    expect(smsConfig({ SMS_DAILY_CAP: "-3" }).dailyCap).toBe(DEFAULT_SMS_DAILY_CAP);
    expect(smsConfig({ SMS_DAILY_CAP: "0" }).dailyCap).toBe(0);
  });

  it("routes by mode: mock never sends, test sends only to testers, live needs Twilio and the service", () => {
    const tester = "+972501111111";
    const cfg = (env: Record<string, string>) => smsConfig({ TWILIO_SMS_MESSAGING_SERVICE_SID: MG, SMS_TEST_NUMBERS: tester, ...env });
    expect(smsRoute(cfg({}), true, tester)).toEqual({ action: "mock", reason: "mock" });
    expect(smsRoute(cfg({ SMS_MODE: "test" }), true, tester)).toEqual({ action: "send" });
    expect(smsRoute(cfg({ SMS_MODE: "test" }), true, "+972509999999")).toEqual({ action: "mock", reason: "not_a_tester" });
    expect(smsRoute(cfg({ SMS_MODE: "test" }), false, tester)).toEqual({ action: "refuse", reason: "not_configured" });
    expect(smsRoute(smsConfig({ SMS_MODE: "live" }), true, tester)).toEqual({ action: "refuse", reason: "not_configured" });
    expect(smsRoute(cfg({ SMS_MODE: "live" }), true, "+972509999999")).toEqual({ action: "send" });
  });
});

describe("SMS refusals", () => {
  it("passes a real lead with consent", () => {
    expect(smsRefusal(facts())).toBeNull();
  });

  it("refuses test leads, simulated buyers and fictional demo numbers", () => {
    expect(smsRefusal(facts({}, { isTest: true }))).toBe("test_lead");
    expect(smsRefusal(facts({}, { buyerRef: "SIM-0001", phone: "sim:SIM-0001" }))).toBe("simulated_lead");
    expect(smsRefusal(facts({}, { phone: "sim:SIM-0002" }))).toBe("simulated_lead");
    expect(smsRefusal(facts({}, { phone: demoPhone(1), sourceRef: `${DEMO_SOURCE_REF_PREFIX}rotem` }))).toBe("demo_number");
    // The same number in a real account (no demo source ID) is a real buyer.
    expect(smsRefusal(facts({}, { phone: demoPhone(1), sourceRef: "crm-1" }))).toBeNull();
  });

  it("refuses opted-out leads, stopped SMS, bad phones and missing consent", () => {
    expect(smsRefusal(facts({}, { status: "opted_out" }))).toBe("opted_out");
    expect(smsRefusal(facts({ stopped: true }))).toBe("sms_stopped");
    expect(smsRefusal(facts({}, { phone: "0501234567" }))).toBe("invalid_phone");
    expect(smsRefusal(facts({ hasConsent: false }))).toBe("no_consent");
  });

  it("holds automatic nudges outside contact hours, never the buyer's time or a person's action", () => {
    expect(smsRefusal(facts({ contactHours: NEVER, kind: "follow_up" }))).toBe("outside_contact_hours");
    expect(smsRefusal(facts({ contactHours: NEVER, kind: "opener" }))).toBe("outside_contact_hours");
    expect(smsRefusal(facts({ contactHours: NEVER, kind: "named_time" }))).toBeNull();
    expect(smsRefusal(facts({ contactHours: NEVER, kind: "chat_link" }))).toBeNull();
    expect(smsRefusal(facts({ contactHours: NEVER, kind: "hand_back" }))).toBeNull();
  });

  it("caps SMS per lead per day and spaces them, except the buyer's time and Send chat link", () => {
    const three = [minutesAgo(600), minutesAgo(300), minutesAgo(120)];
    expect(three).toHaveLength(SMS_PER_LEAD_DAILY);
    expect(smsRefusal(facts({ recent: three }))).toBe("lead_daily_cap");
    expect(smsRefusal(facts({ recent: three, kind: "chat_link" }))).toBe("lead_daily_cap");
    // Older than a day: no longer counted.
    expect(smsRefusal(facts({ recent: [minutesAgo(25 * 60), minutesAgo(26 * 60), minutesAgo(27 * 60)] }))).toBeNull();
    expect(smsRefusal(facts({ recent: [minutesAgo(10)] }))).toBe("too_soon");
    expect(smsRefusal(facts({ recent: [minutesAgo(31)] }))).toBeNull();
    expect(smsRefusal(facts({ recent: [minutesAgo(10)], kind: "named_time" }))).toBeNull();
    expect(smsRefusal(facts({ recent: [minutesAgo(10)], kind: "chat_link" }))).toBeNull();
  });

  it("folds stop and resume events: the latest wins", () => {
    const at = (m: number) => minutesAgo(m);
    expect(smsStoppedOf([])).toEqual({ stopped: false, at: null });
    expect(smsStoppedOf([{ type: SMS_EVENTS.stopped, createdAt: at(5) }])).toEqual({ stopped: true, at: at(5) });
    expect(smsStoppedOf([{ type: SMS_EVENTS.resumed, createdAt: at(1) }, { type: SMS_EVENTS.stopped, createdAt: at(5) }]).stopped).toBe(false);
    expect(smsStoppedOf([{ type: SMS_EVENTS.resumed, createdAt: at(9) }, { type: SMS_EVENTS.stopped, createdAt: at(5) }, { type: SMS_EVENTS.sent, createdAt: at(1) }]).stopped).toBe(true);
  });
});

describe("SMS texts and segments", () => {
  const vars = { seller: "Polar", chat: "https://app.test/chat/abc", stop: "https://app.test/chat/stop/xyz" };

  it("every kind in every language has the chat link and ends with the stop link", () => {
    for (const lang of ["en", "he"]) {
      for (const kind of SMS_KINDS) {
        const text = smsText(kind, lang, vars);
        expect(text).toContain("Polar");
        expect(text).toContain(vars.chat);
        expect(text.endsWith(vars.stop)).toBe(true);
      }
    }
    expect(smsText("chat_link", "en", vars)).toContain("Stop messages: https://app.test/chat/stop/xyz");
    expect(smsText("chat_link", "fr", vars)).toBe(smsText("chat_link", "en", vars));
    expect(smsText("named_time", "en", vars)).toContain("it's the time you asked for");
  });

  it("never re-expands placeholders inside the values", () => {
    expect(smsText("chat_link", "en", { ...vars, seller: "{chat}" })).toMatch(/^\{chat\}: /);
  });

  it("counts GSM-7 and UCS-2 segments", () => {
    expect(smsSegments("")).toBe(0);
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("€".repeat(80))).toBe(1);
    expect(smsSegments("€".repeat(81))).toBe(2);
    expect(smsSegments("ש".repeat(70))).toBe(1);
    expect(smsSegments("ש".repeat(71))).toBe(2);
    expect(smsSegments(`${"a".repeat(100)}ש`)).toBe(2);
  });
});

describe("SMS stop token", () => {
  const leadId = "0f8b4a52-3c1d-4e5f-9a6b-7c8d9e0f1a2b";

  it("round-trips the lead id and rejects forged or altered tokens", () => {
    const token = stopTokenFor(leadId);
    expect(leadIdFromStopToken(token)).toBe(leadId);
    expect(stopPath(token)).toBe(`/chat/stop/${token}`);
    const [id, mac] = token.split(".");
    const flipped = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
    expect(leadIdFromStopToken(`${id}.${flipped}`)).toBeNull();
    expect(leadIdFromStopToken("nope")).toBeNull();
    expect(leadIdFromStopToken(`${token}x`)).toBeNull();
  });

  it("is not a chat token, and a chat token is not a stop token (own HMAC domain)", () => {
    const stop = stopTokenFor(leadId);
    const chat = chatTokenFor(leadId);
    expect(stop).not.toBe(chat);
    expect(linkIdFromChatToken(stop)).toBeNull();
    expect(leadIdFromStopToken(chat)).toBeNull();
  });

  it("refuses an id that is not a UUID", () => {
    expect(() => stopTokenFor("abc")).toThrow();
  });
});

describe("Twilio transport for SMS", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake = (): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ sid: "SM1", status: "accepted" }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  it("sends plain E.164 through the messaging service, with a status callback and validity period", async () => {
    calls.length = 0;
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "tok" }, fake());
    const r = await tr.send({ channel: "sms", to: "+972501234567", from: "", messagingServiceSid: MG, body: "Hi", statusCallback: "https://a/cb", validityPeriodSeconds: 900 });
    expect(r).toEqual({ ok: true, sid: "SM1", status: "accepted" });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({
      To: "+972501234567", MessagingServiceSid: MG, Body: "Hi", StatusCallback: "https://a/cb", ValidityPeriod: "900",
    });
  });

  it("keeps the whatsapp: prefix when no channel is given", async () => {
    calls.length = 0;
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "tok" }, fake());
    await tr.send({ to: "+972501234567", from: "+14155238886", body: "Hi" });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ To: "whatsapp:+972501234567", From: "whatsapp:+14155238886", Body: "Hi" });
  });

  it("TwilioSmsTransport always sends as SMS through the configured service", async () => {
    const seen: SendRequest[] = [];
    const twilio: TwilioTransport = {
      async send(req): Promise<SendResult> { seen.push(req); return { ok: true, sid: "SM2", status: "queued" }; },
      async fetchContent() { return null; },
    };
    const sms = new TwilioSmsTransport(twilio, MG);
    expect(await sms.send({ to: "+972501234567", body: "Hi", statusCallback: null })).toEqual({ ok: true, sid: "SM2", status: "queued" });
    expect(seen[0]).toMatchObject({ channel: "sms", to: "+972501234567", messagingServiceSid: MG, body: "Hi", validityPeriodSeconds: null });
  });
});
