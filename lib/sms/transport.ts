/**
 * SMS transports. Everything that sends an SMS goes through an `SmsTransport`,
 * so tests use `MockSmsTransport` (or a fake TwilioTransport) and never reach
 * the network. In SMS_MODE=mock the service calls no transport at all.
 */
import { randomBytes } from "node:crypto";
import { defaultTransport, type SendResult, type TwilioTransport } from "@/lib/channels/twilio";
import type { SmsConfig } from "./rules";

export type SmsSendRequest = {
  /** E.164, no "whatsapp:" prefix. */
  to: string;
  body: string;
  statusCallback?: string | null;
  validityPeriodSeconds?: number | null;
};

export interface SmsTransport {
  send(req: SmsSendRequest): Promise<SendResult>;
}

/** Records requests and answers with a made-up SID. Never sends anything (tests only). */
export class MockSmsTransport implements SmsTransport {
  sent: SmsSendRequest[] = [];
  fail: SendResult | null = null;
  async send(req: SmsSendRequest): Promise<SendResult> {
    this.sent.push(req);
    return this.fail ?? { ok: true, sid: `SM${randomBytes(16).toString("hex")}`, status: "queued" };
  }
}

/** SMS through Twilio's Messages API and the platform's SMS messaging service (registered alpha sender). */
export class TwilioSmsTransport implements SmsTransport {
  constructor(private readonly twilio: TwilioTransport, private readonly messagingServiceSid: string) {}

  send(req: SmsSendRequest): Promise<SendResult> {
    return this.twilio.send({
      channel: "sms",
      to: req.to,
      from: "",
      messagingServiceSid: this.messagingServiceSid,
      statusCallback: req.statusCallback ?? null,
      validityPeriodSeconds: req.validityPeriodSeconds ?? null,
      body: req.body,
    });
  }
}

/** The real SMS transport, or null when Twilio or the SMS messaging service is not configured. */
export function defaultSmsTransport(config: SmsConfig): SmsTransport | null {
  const twilio = defaultTransport();
  return twilio && config.messagingServiceSid ? new TwilioSmsTransport(twilio, config.messagingServiceSid) : null;
}
