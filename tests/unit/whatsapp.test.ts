import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  contentBody, mapApprovalStatus, parseFormBody, TwilioRestTransport, twilioConfig, twilioSignature, validTwilioSignature, whatsappAddressToE164,
} from "@/lib/channels/twilio";
import { firstNameOf, nextDeliveryStatus, openerRefusal, renderTemplate, templateVariables, windowState, WINDOW_MS, type OpenerFacts } from "@/lib/channels/rules";
import { inboundText, publicBaseUrl, statusCallbackUrl } from "@/lib/channels/whatsapp";
import { deliveryLabel, remainingText, windowTimerProps } from "@/app/app/[account]/leads/[leadId]/conversation";

describe("Twilio webhook signatures", () => {
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

  it("signs the URL plus the params sorted by name, HMAC-SHA1, base64", () => {
    const data = `${url}CallSidCA1234567890ABCDECaller+12349013030Digits1234From+12349013030To+18005551212`;
    expect(twilioSignature(token, url, params)).toBe(createHmac("sha1", token).update(data).digest("base64"));
  });

  it("accepts a match on any candidate URL and rejects tampering", () => {
    const sig = twilioSignature(token, url, params);
    expect(validTwilioSignature(token, sig, ["https://internal/x", url], params)).toBe(true);
    expect(validTwilioSignature(token, sig, [url], { ...params, Digits: "9999" })).toBe(false);
    expect(validTwilioSignature("other", sig, [url], params)).toBe(false);
    expect(validTwilioSignature(token, null, [url], params)).toBe(false);
    expect(validTwilioSignature(token, "short", [url], params)).toBe(false);
  });

  it("parses form bodies and WhatsApp addresses", () => {
    expect(parseFormBody("Body=Hi+there%21&From=whatsapp%3A%2B972501234567")).toEqual({ Body: "Hi there!", From: "whatsapp:+972501234567" });
    expect(whatsappAddressToE164("whatsapp:+972501234567")).toBe("+972501234567");
    expect(whatsappAddressToE164("+972501234567")).toBeNull();
    expect(whatsappAddressToE164("whatsapp:972501234567")).toBeNull();
    expect(whatsappAddressToE164(undefined)).toBeNull();
  });

  it("reads credentials only when both are set", () => {
    expect(twilioConfig({})).toBeNull();
    expect(twilioConfig({ TWILIO_ACCOUNT_SID: "AC1" })).toBeNull();
    expect(twilioConfig({ TWILIO_ACCOUNT_SID: " AC1 ", TWILIO_AUTH_TOKEN: "t" })).toEqual({ accountSid: "AC1", authToken: "t" });
  });
});

describe("the 24-hour window", () => {
  const at = new Date("2026-11-16T10:00:00Z");
  it("is closed with no buyer message, open for 24 hours after one, closed after", () => {
    expect(windowState(null, at)).toEqual({ open: false, closesAt: null });
    expect(windowState(at, new Date(at.getTime() + WINDOW_MS - 1)).open).toBe(true);
    expect(windowState(at, new Date(at.getTime() + WINDOW_MS)).open).toBe(false);
  });
  it("shows closing in the last two hours", () => {
    const w = windowState(at, at);
    expect(windowTimerProps(w, new Date(at.getTime() + 60_000))).toEqual({ state: "open", remaining: "23h 59m" });
    expect(windowTimerProps(w, new Date(at.getTime() + 23 * 3600_000))).toEqual({ state: "closing", remaining: "1h 0m" });
    expect(windowTimerProps({ open: false, closesAt: null }, at)).toEqual({ state: "closed" });
    expect(remainingText(at, new Date(at.getTime() + 1000))).toBe("0h 0m");
  });
});

describe("opener gates", () => {
  const base: OpenerFacts = {
    twilioConfigured: true,
    lead: { isTest: false, status: "new" },
    hasConsent: true,
    account: { status: "live", contactHours: null, timezone: "Asia/Jerusalem" },
    hasConnection: true, hasApprovedOpener: true, hasLiveAgent: true, hasActiveWhatsappConversation: false,
    now: new Date("2026-11-16T10:00:00Z"), // Monday 12:00 in Jerusalem, inside default hours
  };
  it("passes when everything is in place", () => expect(openerRefusal(base)).toBeNull());
  it.each<[Partial<OpenerFacts>, string]>([
    [{ lead: { isTest: true, status: "new" } }, "test_lead"],
    [{ lead: { isTest: false, status: "opted_out" } }, "opted_out"],
    [{ hasConsent: false }, "no_consent"],
    [{ hasActiveWhatsappConversation: true }, "already_started"],
    [{ account: { ...base.account, status: "paused" } }, "account_paused"],
    [{ account: { ...base.account, status: "setting_up" } }, "account_not_live"],
    [{ twilioConfigured: false }, "not_configured"],
    [{ hasConnection: false }, "no_connection"],
    [{ hasApprovedOpener: false }, "no_template"],
    [{ hasLiveAgent: false }, "no_agent"],
    [{ now: new Date("2026-11-14T10:00:00Z") }, "outside_contact_hours"], // Saturday
  ])("refuses %o with %s", (patch, reason) => expect(openerRefusal({ ...base, ...patch })).toBe(reason));
});

describe("templates", () => {
  it("fills {{1}} with the first name and {{2}} with the trade name, keeping unknown ones", () => {
    const vars = templateVariables({ fullName: "  Rina  Cohen " }, { tradeName: "Polar" });
    expect(vars).toEqual({ "1": "Rina", "2": "Polar" });
    expect(renderTemplate("Hi {{1}}, this is {{ 2 }} ({{3}})", vars)).toBe("Hi Rina, this is Polar ({{3}})");
    expect(firstNameOf("Madonna")).toBe("Madonna");
  });
  it("maps Twilio approval states and reads the template text", () => {
    expect(mapApprovalStatus("approved")).toBe("approved");
    expect(mapApprovalStatus("rejected")).toBe("rejected");
    expect(mapApprovalStatus("paused")).toBe("rejected");
    expect(mapApprovalStatus("received")).toBe("pending");
    expect(mapApprovalStatus(undefined)).toBe("pending");
    expect(contentBody({ "twilio/quick-reply": { body: "" }, "twilio/text": { body: "Hello {{1}}" } })).toBe("Hello {{1}}");
    expect(contentBody(undefined)).toBe("");
  });
});

describe("delivery statuses", () => {
  it("never moves backwards; failures win unless already read", () => {
    expect(nextDeliveryStatus(null, "queued")).toBe("queued");
    expect(nextDeliveryStatus("queued", "sent")).toBe("sent");
    expect(nextDeliveryStatus("delivered", "sent")).toBeNull();
    expect(nextDeliveryStatus("delivered", "read")).toBe("read");
    expect(nextDeliveryStatus("sent", "undelivered")).toBe("undelivered");
    expect(nextDeliveryStatus("read", "failed")).toBeNull();
    expect(nextDeliveryStatus("failed", "delivered")).toBeNull();
    expect(nextDeliveryStatus("sent", "something_new")).toBeNull();
  });
  it("labels not-sent messages with the reason", () => {
    expect(deliveryLabel({ deliveryStatus: null, deliveryError: null })).toBeNull();
    expect(deliveryLabel({ deliveryStatus: "delivered", deliveryError: null })).toBe("Delivered");
    expect(deliveryLabel({ deliveryStatus: "not_sent", deliveryError: "window_closed" })).toBe("Not sent: 24-hour window closed");
    expect(deliveryLabel({ deliveryStatus: "not_sent", deliveryError: "provider: 63016 x" })).toBe("Not sent: provider: 63016 x");
  });
});

describe("inbound text and callback URLs", () => {
  it("describes attachments the agent cannot see", () => {
    expect(inboundText({ Body: " hi " })).toBe("hi");
    expect(inboundText({ Body: "", NumMedia: "1", MediaContentType0: "image/jpeg" })).toBe("[The buyer sent an attachment (image/jpeg) that cannot be viewed here]");
    expect(inboundText({ Body: "see", NumMedia: "2" })).toContain("2 attachments");
    expect(inboundText({})).toBe("[empty message]");
  });
  it("uses APP_URL, else Vercel's production URL", () => {
    expect(publicBaseUrl({ APP_URL: "https://app.example.com/", VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe("https://app.example.com");
    expect(publicBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app" })).toBe("https://x.vercel.app");
    expect(publicBaseUrl({})).toBeNull();
    expect(statusCallbackUrl("https://a.b")).toBe("https://a.b/api/webhooks/whatsapp/status");
    expect(statusCallbackUrl(null)).toBeNull();
  });
});

describe("Twilio REST transport", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fake = (responses: Response[]): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responses.shift()!;
  }) as typeof fetch;

  it("sends free text from the number with basic auth and a status callback", async () => {
    calls.length = 0;
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "tok" }, fake([reply(201, { sid: "SM1", status: "queued" })]));
    expect(await tr.send({ to: "+972501234567", from: "+14155238886", body: "Hi", statusCallback: "https://a/cb" })).toEqual({ ok: true, sid: "SM1", status: "queued" });
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    const form = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(form)).toEqual({ To: "whatsapp:+972501234567", From: "whatsapp:+14155238886", Body: "Hi", StatusCallback: "https://a/cb" });
  });

  it("sends templates through a messaging service and maps errors", async () => {
    calls.length = 0;
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "tok" }, fake([reply(400, { code: 63016, message: "Outside window" })]));
    const r = await tr.send({ to: "+972501234567", from: "+1", messagingServiceSid: "MGx", contentSid: "HXabc", contentVariables: { "1": "Rina" } });
    expect(r).toEqual({ ok: false, code: "63016", message: "Outside window" });
    const form = Object.fromEntries(new URLSearchParams(String(calls[0].init.body)));
    expect(form).toEqual({ To: "whatsapp:+972501234567", MessagingServiceSid: "MGx", ContentSid: "HXabc", ContentVariables: "{\"1\":\"Rina\"}" });
  });

  it("reports network failures instead of throwing", async () => {
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "t" }, (async () => { throw new Error("boom"); }) as typeof fetch);
    expect(await tr.send({ to: "+1", from: "+2", body: "x" })).toEqual({ ok: false, code: "network", message: "boom" });
  });

  it("reads a Content template with its WhatsApp approval", async () => {
    const tr = new TwilioRestTransport({ accountSid: "AC1", authToken: "t" }, fake([
      reply(200, { sid: "HX1", friendly_name: "opener_he", language: "he", types: { "twilio/text": { body: "שלום {{1}}" } } }),
      reply(200, { whatsapp: { status: "approved", category: "MARKETING", rejection_reason: "" } }),
    ]));
    expect(await tr.fetchContent("HX1")).toEqual({
      sid: "HX1", name: "opener_he", language: "he", body: "שלום {{1}}", approval: { status: "approved", category: "MARKETING", rejectionReason: null },
    });
    const missing = new TwilioRestTransport({ accountSid: "AC1", authToken: "t" }, fake([reply(404, {}), reply(404, {})]));
    expect(await missing.fetchContent("HX2")).toBeNull();
  });
});
