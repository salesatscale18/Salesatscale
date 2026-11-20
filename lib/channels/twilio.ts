/**
 * Twilio WhatsApp provider (decision D2: Twilio as the BSP), also used for
 * SMS (lib/sms: `channel: "sms"`).
 *
 * Plain REST over fetch, no SDK. Everything that talks to Twilio goes through
 * a `TwilioTransport`, so tests use a fake and never reach the network.
 * Credentials come from env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) and are
 * never stored in the database.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type TwilioConfig = { accountSid: string; authToken: string };

/** The platform's Twilio credentials, or null when WhatsApp is not configured. */
export function twilioConfig(env: Record<string, string | undefined> = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  return accountSid && authToken ? { accountSid, authToken } : null;
}

// ---------------------------------------------------------------------------
// Webhook signatures (https://www.twilio.com/docs/usage/security)
// ---------------------------------------------------------------------------

/** base64(HMAC-SHA1(authToken, url + each POST param name and value, sorted by name)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/**
 * True when `signature` matches any of the candidate URLs. Twilio signs the
 * exact URL configured on its side; behind a proxy that can differ from the
 * request URL, so the caller passes both the APP_URL form and the request URL.
 */
export function validTwilioSignature(authToken: string, signature: string | null, urls: string[], params: Record<string, string>): boolean {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return [...new Set(urls)].some((url) => {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** Form-encoded webhook body → flat params (last value wins, as Twilio never repeats keys). */
export function parseFormBody(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body));
}

/** "whatsapp:+972501234567" → "+972501234567"; anything else → null. */
export function whatsappAddressToE164(address: string | undefined | null): string | null {
  const m = /^whatsapp:(\+[1-9]\d{6,14})$/.exec((address ?? "").trim());
  return m ? m[1] : null;
}

export const toWhatsappAddress = (e164: string) => `whatsapp:${e164}`;

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

export type SendRequest = {
  to: string;
  from: string;
  messagingServiceSid?: string | null;
  statusCallback?: string | null;
  /**
   * "whatsapp" (default): `To`/`From` get the "whatsapp:" prefix. "sms": plain
   * E.164 `To`, sent through the messaging service (lib/sms), which holds the
   * registered alphanumeric sender.
   */
  channel?: "whatsapp" | "sms";
  /** Seconds Twilio may queue the message before dropping it (ValidityPeriod; needs a messaging service). */
  validityPeriodSeconds?: number | null;
} & ({ body: string } | { contentSid: string; contentVariables: Record<string, string> });

export type SendResult =
  | { ok: true; sid: string; status: string }
  | { ok: false; code: string; message: string };

export type ContentInfo = {
  sid: string;
  name: string;
  language: string;
  body: string;
  approval: { status: "approved" | "pending" | "rejected"; category: string | null; rejectionReason: string | null };
};

export interface TwilioTransport {
  send(req: SendRequest): Promise<SendResult>;
  /** A Content template with its WhatsApp approval status, or null when Twilio does not know it. */
  fetchContent(contentSid: string): Promise<ContentInfo | null>;
}

const API = "https://api.twilio.com/2010-04-01";
const CONTENT_API = "https://content.twilio.com/v1";
const TIMEOUT_MS = 10_000;

/** Twilio's approval states mapped to ours: anything not decided yet counts as pending. */
export function mapApprovalStatus(status: string | undefined | null): "approved" | "pending" | "rejected" {
  const s = (status ?? "").toLowerCase();
  if (s === "approved") return "approved";
  if (s === "rejected" || s === "paused" || s === "disabled") return "rejected";
  return "pending";
}

/** The text of a Content template: the first type that has a body. */
export function contentBody(types: Record<string, { body?: unknown }> | undefined): string {
  for (const v of Object.values(types ?? {})) if (typeof v?.body === "string" && v.body.trim()) return v.body;
  return "";
}

export class TwilioRestTransport implements TwilioTransport {
  constructor(private readonly config: TwilioConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private auth() {
    return `Basic ${Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString("base64")}`;
  }

  private async call(url: string, init: RequestInit = {}) {
    return this.fetchImpl(url, { ...init, headers: { Authorization: this.auth(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  async send(req: SendRequest): Promise<SendResult> {
    const form = new URLSearchParams();
    const address = req.channel === "sms" ? (n: string) => n : toWhatsappAddress;
    form.set("To", address(req.to));
    if (req.messagingServiceSid) form.set("MessagingServiceSid", req.messagingServiceSid);
    else form.set("From", address(req.from));
    if ("body" in req) form.set("Body", req.body);
    else {
      form.set("ContentSid", req.contentSid);
      form.set("ContentVariables", JSON.stringify(req.contentVariables));
    }
    if (req.statusCallback) form.set("StatusCallback", req.statusCallback);
    if (req.validityPeriodSeconds) form.set("ValidityPeriod", String(Math.round(req.validityPeriodSeconds)));
    try {
      const res = await this.call(`${API}/Accounts/${encodeURIComponent(this.config.accountSid)}/Messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; code?: number; message?: string };
      if (!res.ok || !json.sid) return { ok: false, code: String(json.code ?? res.status), message: (json.message ?? `HTTP ${res.status}`).slice(0, 300) };
      return { ok: true, sid: json.sid, status: json.status ?? "queued" };
    } catch (e) {
      return { ok: false, code: "network", message: e instanceof Error ? e.message.slice(0, 300) : "network error" };
    }
  }

  async fetchContent(contentSid: string): Promise<ContentInfo | null> {
    const sid = encodeURIComponent(contentSid);
    const [content, approval] = await Promise.all([this.call(`${CONTENT_API}/Content/${sid}`), this.call(`${CONTENT_API}/Content/${sid}/ApprovalRequests`)]);
    if (!content.ok) return null;
    const c = (await content.json()) as { sid: string; friendly_name?: string; language?: string; types?: Record<string, { body?: unknown }> };
    const a = approval.ok
      ? ((await approval.json()) as { whatsapp?: { status?: string; category?: string; rejection_reason?: string } }).whatsapp
      : undefined;
    return {
      sid: c.sid,
      name: c.friendly_name ?? c.sid,
      language: (c.language ?? "en").toLowerCase().split(/[-_]/)[0],
      body: contentBody(c.types),
      approval: { status: mapApprovalStatus(a?.status), category: a?.category ?? null, rejectionReason: a?.rejection_reason || null },
    };
  }
}

/** The real transport, or null when Twilio is not configured. */
export function defaultTransport(): TwilioTransport | null {
  const config = twilioConfig();
  return config ? new TwilioRestTransport(config) : null;
}
