/**
 * Scored test rounds, free dry mode: a fake agent that answers the scripted
 * buyers with canned replies (FAKE_REPLIES below), so the buyer loop, the
 * scorer and the result files can be tested without the network or a model.
 *
 * The replies follow the target conversation of the P11 spec, so a dry round
 * is expected to pass every check: a failing check in dry mode is a bug in the
 * buyer scripts or the scorer, not in the agent.
 */
import type { ChatDriver } from "./round";
import type { Transcript, TranscriptMessage } from "./score";
import { COMPETITOR } from "./score";

type Lang = "en" | "he";

/** Canned replies (the fixture). `{n}` = number of fridges, `{name}` = buyer's first name. */
export const FAKE_REPLIES = {
  en: {
    opener: "Hi {name}, this is Maya, the automated assistant of Polar Demo. You asked about monitoring your fridge temperatures. How do you check them today?",
    reactStation: "That covers you while someone is near the station. What we add is an alert to your phone the moment a fridge goes out of range, also at night and on weekends. How many fridges and freezers do you want covered, and is it one kitchen?",
    reactManual: "A check by hand misses what happens at night and on weekends. With a sensor in each fridge you get an alert on your phone the moment it drifts. How many fridges and freezers do you want covered, and is it one kitchen?",
    reactCompetitor: "Good that you are comparing. With us you get a WhatsApp alert at any hour and installation in about an hour. How many fridges and freezers do you want covered, and is it one kitchen?",
    askCount: "Then let's size it for your kitchen. How many fridges and freezers do you want covered, and is it one kitchen?",
    price: "For {n} fridges it is ₪{oneTime} once plus ₪90 a month, before VAT, with installation. Is it all in one kitchen?",
    recommend: "Got it, one kitchen with {n} fridges. That means a wireless sensor in each fridge and one kitchen hub, installed for you in about an hour, so you hear about a warm fridge before the stock spoils. Does that sound like what you need?",
    preQuote: "Great, here is your quote.",
    requote: "No problem, here is the updated quote for {n} fridges.",
    close: "If this looks right, I'll send the order form now and the set can be in your kitchen by about 1 Dec. Sounds good?",
    form: "Here it is. Fill in your company details, sign and pay; it takes about 2 minutes. https://example.test/f/AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    objection: "I understand, it is a real cost for a small kitchen. One spoiled fridge of stock usually costs more than the whole set. Does that change how it looks for you?",
    doubt: "Fair question. The sensor reads the temperature every few minutes and the alert reaches your phone within a minute, day or night. Would a sample alert help you decide?",
    think: "Of course, it is a real decision. What is still open for you, so you can settle it with your partner?",
    later: "Sure, take your time. I'll be here when you have talked it over.",
    compare: `I can't speak for ${COMPETITOR}, I only know our own set. Ours alerts your phone the moment a fridge drifts, at any hour, and we install it for you. How many fridges and freezers do you want covered, and is it one kitchen?`,
    after: "Thanks. I'll confirm here as soon as the order goes through.",
    other: "Thanks for telling me. What else would you like to know?",
  },
  he: {
    opener: "היי {name}, כאן מאיה, העוזר/ת האוטומטי/ת של Polar Demo. ביקשת שניצור קשר. איך אפשר לעזור?",
    reactStation: "זה עובד כשמישהו ליד התחנה. אנחנו מוסיפים התראה לטלפון ברגע שמקרר יוצא מהטווח, גם בלילה ובסופ\"ש. כמה מקררים ומקפיאים תרצו לכסות, וזה מטבח אחד?",
    reactManual: "בדיקה ידנית מפספסת את מה שקורה בלילה ובסופ\"ש. עם חיישן בכל מקרר תקבלו התראה לטלפון ברגע שהטמפרטורה זזה. כמה מקררים ומקפיאים תרצו לכסות, וזה מטבח אחד?",
    reactCompetitor: "טוב שאתם משווים. אצלנו מקבלים התראה בווטסאפ בכל שעה והתקנה בתוך כשעה. כמה מקררים ומקפיאים תרצו לכסות, וזה מטבח אחד?",
    askCount: "אז בואו נתאים את זה למטבח שלכם. כמה מקררים ומקפיאים תרצו לכסות, וזה מטבח אחד?",
    price: "ל-{n} מקררים זה ₪{oneTime} חד-פעמי ועוד ₪90 לחודש, לפני מע\"מ, כולל התקנה. זה הכל במטבח אחד?",
    recommend: "הבנתי, מטבח אחד עם {n} מקררים. זה אומר חיישן אלחוטי בכל מקרר ורכזת אחת למטבח, מותקנים אצלכם בתוך כשעה, כך שתדעו על מקרר שמתחמם לפני שהסחורה מתקלקלת. זה נשמע כמו מה שאתם צריכים?",
    preQuote: "מצוין, הנה הצעת המחיר.",
    requote: "אין בעיה, הנה הצעת המחיר המעודכנת ל-{n} מקררים.",
    close: "אם זה נראה נכון, אשלח עכשיו את טופס ההזמנה והערכה יכולה להיות אצלכם עד בערך 1 בדצמ׳. מתאים?",
    form: "הנה הטופס. ממלאים פרטי חברה, חותמים ומשלמים; זה לוקח בערך 2 דקות. https://example.test/f/AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    objection: "מבין, זו הוצאה אמיתית למטבח קטן. מקרר אחד של סחורה מקולקלת עולה בדרך כלל יותר מכל הערכה. זה משנה את התמונה בשבילכם?",
    doubt: "שאלה הוגנת. החיישן מודד כל כמה דקות וההתראה מגיעה לטלפון תוך דקה, ביום ובלילה. דוגמה של התראה תעזור לכם להחליט?",
    think: "כמובן, זו החלטה אמיתית. מה עוד פתוח אצלכם, כדי שתוכלו לסגור את זה עם השותף?",
    later: "בטח, קחו את הזמן. אני כאן כשתדברו.",
    compare: `אני לא יכול להתייחס ל-${COMPETITOR}, אני מכיר רק את הערכה שלנו. אצלנו ההתראה מגיעה לטלפון ברגע שמקרר זז, בכל שעה, ואנחנו מתקינים בשבילכם. כמה מקררים ומקפיאים תרצו לכסות, וזה מטבח אחד?`,
    after: "תודה. אאשר כאן ברגע שההזמנה תעבור.",
    other: "תודה שסיפרת. מה עוד תרצו לדעת?",
  },
} satisfies Record<Lang, Record<string, string>>;

type ReplyKey = keyof (typeof FAKE_REPLIES)["en"];

const shekel = (minor: number) => {
  const s = (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `₪${s.replace(/\.00$/, "")}`;
};

/** The app's quote message for n sensors + hub + installation (same layout as lib/agent/quote-message.ts). */
export function fakeQuote(n: number, lang: Lang, number = 1001): string {
  const sensors = 59_000 * n;
  const oneTime = sensors + 66_000 + 25_000;
  const vat = Math.round(oneTime * 0.18);
  const monthly = 9_000;
  const mVat = Math.round(monthly * 1.18);
  return lang === "he"
    ? [`הצעת מחיר Q-${number}`, `${n} × wireless fridge sensor (SNS-200): ${shekel(sensors)}`, `1 × kitchen hub (GW-10): ${shekel(66_000)}, ועוד ${shekel(monthly)} לחודש`,
      `installation: ${shekel(25_000)}`, `מע"מ 18%: ${shekel(vat)}`, `היום: ${shekel(oneTime + vat)} כולל מע"מ`, `לאחר מכן: ${shekel(mVat)} לחודש כולל מע"מ`, "בתוקף עד 24 בנוב׳"].join("\n")
    : [`Quote Q-${number}`, `${n} × wireless fridge sensor (SNS-200): ${shekel(sensors)}`, `1 × kitchen hub (GW-10): ${shekel(66_000)}, plus ${shekel(monthly)} a month`,
      `installation: ${shekel(25_000)}`, `VAT 18%: ${shekel(vat)}`, `Today: ${shekel(oneTime + vat)} including VAT`, `Then: ${shekel(mVat)} a month including VAT`, "Valid until 24 Nov"].join("\n");
}

const YES = /\b(?:yes|ok|okay|go ahead|let'?s|sure|send)\b|כן|שלח|מתאים|בסדר/i;
const PRICE = /how much|cost|price|כמה עולה|מחיר/i;

/**
 * A fake chat: the buyer's messages get canned replies from a small state
 * machine (understand → recommend → quote + close → order form). Free.
 */
export class FakeAgentDriver implements ChatDriver {
  private t: Transcript = [];
  private qty: number | null = null;
  private recommended = false;
  private quotes = 0;
  private formSent = false;
  /** Every buyer message the fake agent got (the dry-mode count of "paid" turns). */
  readonly received: string[] = [];

  constructor(private readonly lang: Lang, private readonly firstName: string) {
    this.agent("opener");
  }

  private say(key: ReplyKey) {
    const n = String(this.qty ?? 2);
    const oneTime = shekel((59_000 * (this.qty ?? 2) + 91_000)).slice(1);
    return FAKE_REPLIES[this.lang][key].replaceAll("{n}", n).replaceAll("{name}", this.firstName).replaceAll("{oneTime}", oneTime);
  }

  private agent(key: ReplyKey) {
    const text = this.say(key);
    const m: TranscriptMessage = key === "form"
      ? { actor: "agent", kind: "order_form", text: text.replace(/\s*https?:\/\/\S+/, ""), card: `Order form · Q-${1000 + this.quotes} v1` }
      : { actor: "agent", kind: "text", text };
    this.t.push(m);
  }

  private quoteTurn(first: boolean) {
    this.quotes++;
    this.agent(first ? "preQuote" : "requote");
    this.t.push({ actor: "app", kind: "quote", text: fakeQuote(this.qty ?? 2, this.lang, 1000 + this.quotes) });
    this.agent("close");
  }

  async read(): Promise<Transcript> {
    return this.t.map((m) => ({ ...m }));
  }

  async send(text: string): Promise<string | null> {
    this.received.push(text);
    const firstAnswer = !this.t.some((m) => m.actor === "buyer");
    this.t.push({ actor: "buyer", kind: "text", text });
    const digits = text.match(/\b(\d+)\b/);
    if (this.formSent) this.agent("after");
    else if (/expensive|יקר/i.test(text)) this.agent("objection");
    else if (/think|partner|לחשוב|שותף/i.test(text)) this.agent("think");
    else if (/get back|talk to him/i.test(text)) this.agent("later");
    else if (/really work|באמת עובד/i.test(text)) this.agent("doubt");
    else if (text.includes(COMPETITOR) && /different|שונה/i.test(text)) this.agent("compare");
    else if (PRICE.test(text) && this.quotes === 0) {
      if (digits) this.qty = Number(digits[1]);
      this.agent("price");
    } else if (this.quotes > 0 && digits && Number(digits[1]) !== this.qty) {
      this.qty = Number(digits[1]);
      this.quoteTurn(false);
    } else if (this.quotes > 0 && YES.test(text)) {
      this.formSent = true;
      this.agent("form");
    } else if (this.recommended && YES.test(text)) this.quoteTurn(true);
    else if (!this.recommended && digits) {
      this.qty = Number(digits[1]);
      this.recommended = true;
      this.agent("recommend");
    } else if (!this.recommended && this.qty !== null && /kitchen|מטבח/i.test(text)) {
      this.recommended = true;
      this.agent("recommend");
    } else if (firstAnswer) this.agent(/station/i.test(text) ? "reactStation" : text.includes(COMPETITOR) ? "reactCompetitor" : "reactManual");
    else if (this.qty === null) this.agent("askCount");
    else this.agent("other");
    return null;
  }
}
