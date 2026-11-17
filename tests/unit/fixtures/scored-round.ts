/** Fixture transcripts for the scored-round checklist (tests/e2e/demo/score.ts). */
import type { Transcript, TranscriptMessage } from "../../e2e/demo/score";

const buyer = (text: string): TranscriptMessage => ({ actor: "buyer", kind: "text", text });
const agent = (text: string): TranscriptMessage => ({ actor: "agent", kind: "text", text });
const quote = (text: string): TranscriptMessage => ({ actor: "app", kind: "quote", text });
const form = (text: string): TranscriptMessage => ({ actor: "agent", kind: "order_form", text, card: "Order form · Q-1001 v1 ₪2,466.20 today + ₪106.20/month" });

export const QUOTE_EN = [
  "Quote Q-1001",
  "2 × wireless fridge sensor (SNS-200): ₪1,180",
  "1 × kitchen hub (GW-10): ₪660, plus ₪90 a month",
  "Installation: ₪250",
  "VAT 18%: ₪376.20",
  "Today: ₪2,466.20 including VAT",
  "Then: ₪106.20 a month including VAT",
  "Valid until 24 Nov",
].join("\n");

/** The target conversation of the P11 spec, word for word (buyer 2). */
export const TARGET: Transcript = [
  agent("Hi Rina, this is Maya, the automated assistant of Polar Demo. You asked about monitoring your fridge temperatures. How do you check them today?"),
  buyer("i use temp devices connected to my local station"),
  agent("That covers you while someone is near the station. What we add is an alert to your phone the moment a fridge goes out of range, also at night and on weekends. How many fridges and freezers do you want covered, and is it one kitchen?"),
  buyer("2, one kitchen"),
  agent("Got it, one kitchen with 2 fridges. The best fit is a wireless sensor in each fridge and one small hub for the kitchen, installed for you in about an hour. From then on you get a WhatsApp alert whenever a temperature drifts, so you can save the stock before it spoils. Does that sound like what you need?"),
  buyer("yes"),
  agent("Great, here is your quote."),
  quote(QUOTE_EN),
  agent("If this looks right, I'll send the order form now and the set can be in your kitchen by about 1 Dec. Sounds good?"),
  buyer("yes"),
  form("Here it is. Fill in your company details, sign and pay; it takes about 2 minutes."),
];

/** The real chat that started P11 (shortened): checklist, early SKUs and prices, permission, plain-text quote twice, company questions, system talk, two introductions. */
export const PROBLEM: Transcript = [
  agent("Hi Rina, this is Maya, the automated assistant of Polar Demo. You asked to hear from us. How can I help?"),
  buyer("i use temp devices connected to my local station"),
  agent("Thanks. How many fridges do you have?"),
  buyer("2"),
  agent("Hi again, I'm Maya, the automated assistant. For 2 fridges you need 2 × SNS-200 at ₪590 each and a GW-10 hub at ₪660. Would you like me to prepare the quote?"),
  buyer("ok"),
  agent("Quote: 2 × SNS-200 ₪1,180, GW-10 ₪660, installation ₪250. VAT 18% ₪376.20. Total ₪2,466.20."),
  agent("The tool's totals appear to include tax. Total ₪2,466.20 including VAT ₪376.20, plus ₪90 a month."),
  buyer("ok"),
  agent("What is your company name?"),
  buyer("Rina's Kitchen"),
  agent("Got it, thanks. What is your company ID?"),
];
