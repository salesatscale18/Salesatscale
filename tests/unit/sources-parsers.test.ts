import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileKind, FileRejected, parseCsvFile, parseDocx, parsePdf, parsePlainText, parseXlsxFile } from "@/lib/sources/files";
import { htmlToText } from "@/lib/sources/html";
import { maskPersonalData } from "@/lib/sources/mask";
import { capSections, guessLanguage, statusFor } from "@/lib/sources/text";
import { parseClock, parseTranscript } from "@/lib/sources/transcript";

const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/sources/${name}`));

describe("PDF", () => {
  it("one section per page; the empty page is reported as scanned", async () => {
    const r = await parsePdf(fixture("two-pages-one-empty.pdf"));
    expect(r.stats?.pages).toBe(2);
    expect(r.sections).toEqual([{ locator: "p.1", heading: null, text: "Polar sensors alert you within 2 minutes." }]);
    expect(r.problems).toEqual([{ where: "p.2", message: "Page 2 looks scanned, so we could not read it.", fix: "Upload a text version or type the key points." }]);
    expect(statusFor(r)).toBe("partly_failed");
  });

  it("a damaged PDF fails with a plain problem instead of throwing", async () => {
    const r = await parsePdf(new TextEncoder().encode("%PDF-1.4 nothing here"));
    expect(r.sections).toEqual([]);
    expect(r.problems[0].message).toMatch(/could not open this PDF/);
    expect(statusFor(r)).toBe("failed");
  });
});

describe("DOCX", () => {
  it("splits into sections by headings", async () => {
    const r = await parseDocx(fixture("guide.docx"));
    expect(r.sections.map((s) => [s.locator, s.heading])).toEqual([["Start", null], ["Installation", "Installation"], ["Warranty", "Warranty"]]);
    expect(r.sections[1].text).toBe("A technician installs each sensor in about 20 minutes.");
    expect(r.sections[2].text).toBe("Every sensor has a 2-year warranty.");
    expect(statusFor(r)).toBe("ready");
  });
});

describe("CSV and XLSX", () => {
  it("CSV rows become text with a needs-input problem to map columns", () => {
    const r = parseCsvFile(new TextDecoder().decode(fixture("prices.csv")), "prices.csv");
    expect(r.sections).toEqual([{ locator: "rows 2–3", heading: null, text: "Product | Unit | Price\nSensor SNS-200 | sensor | 390\nGateway, hub | site | 1200" }]);
    expect(r.needsInput).toBe(true);
    expect(r.problems).toEqual([expect.objectContaining({ where: "prices.csv", fix: "Map columns to import into the catalog" })]);
    expect(statusFor(r)).toBe("needs_input");
  });

  it("XLSX cells are read from shared strings, numbers and inline strings", async () => {
    const r = await parseXlsxFile(fixture("prices.xlsx"), "prices.xlsx");
    expect(r.sections[0].text).toBe("Product | Price\nSensor SNS-200 | 390\nGateway & hub |  | note");
    expect(statusFor(r)).toBe("needs_input");
  });
});

describe("plain text and markdown", () => {
  it("markdown splits at headings", () => {
    const r = parsePlainText("Intro line\n\n# Prices\nFrom 390 a sensor\n\n## Support\n24/7 phone", true);
    expect(r.sections.map((s) => s.locator)).toEqual(["Start", "Prices", "Support"]);
  });
});

describe("file checks", () => {
  it("refuses unknown types, empty files and fake PDFs", () => {
    expect(() => fileKind("x.exe", new Uint8Array([1]))).toThrow(FileRejected);
    expect(() => fileKind("x.pdf", new Uint8Array())).toThrow(/empty/);
    expect(() => fileKind("x.pdf", new TextEncoder().encode("hello"))).toThrow(/not a valid PDF/);
    expect(() => fileKind("x.txt", new Uint8Array(10 * 1024 * 1024 + 1))).toThrow(/10 MB/);
    expect(fileKind("Deck.PDF", fixture("two-pages-one-empty.pdf"))).toBe("pdf");
  });
});

describe("transcripts", () => {
  it("VTT: turns with mm:ss locators and speakers; same-speaker cues merged; personal data masked", () => {
    const r = parseTranscript(new TextDecoder().decode(fixture("call.vtt")));
    expect(r.sections.map((s) => [s.locator, s.heading])).toEqual([["05:31", "Rep"], ["05:38", "Buyer"], ["06:12", "Rep"]]);
    expect(r.sections[1].text).toBe("The shift manager writes it on a sheet twice a day. Call me on [phone] or [email].");
    expect(r.stats?.durationSec).toBe(372);
    expect(r.problems).toEqual([]);
  });

  it("SRT with comma milliseconds", () => {
    const r = parseTranscript("1\n00:00:05,000 --> 00:00:07,000\nRep: Hello\n\n2\n00:01:02,500 --> 00:01:04,000\nBuyer: Hi");
    expect(r.sections.map((s) => [s.locator, s.heading, s.text])).toEqual([["00:05", "Rep", "Hello"], ["01:02", "Buyer", "Hi"]]);
  });

  it("pasted text with labels and stamps; unlabelled lines continue the turn", () => {
    const r = parseTranscript("[05:31] Rep: How many sites?\nBuyer: Three.\nAll in Tel Aviv.\n07:11 Seller: For three sites I can waive the fee.");
    expect(r.sections.map((s) => [s.locator, s.heading, s.text])).toEqual([
      ["05:31", "Rep", "How many sites?"], ["#2", "Buyer", "Three. All in Tel Aviv."], ["07:11", "Rep", "For three sites I can waive the fee."],
    ]);
  });

  it("text with no labels or times is kept, with a problem", () => {
    const r = parseTranscript("We talked about sensors and prices.");
    expect(r.sections).toHaveLength(1);
    expect(r.problems[0].fix).toMatch(/Rep: or Buyer:/);
  });

  it("parses clock values", () => {
    expect(parseClock("06:12")).toBe(372);
    expect(parseClock("1:02:05")).toBe(3725);
    expect(parseClock("00:05:31.250")).toBe(331);
    expect(parseClock("6:75")).toBeNull();
  });
});

describe("masking", () => {
  it("masks emails, phone numbers and card-like numbers", () => {
    expect(maskPersonalData("Write to dana.levi+x@cafe.co.il please")).toBe("Write to [email] please");
    expect(maskPersonalData("Call 054-123-4567 or +972 54 123 4567 or (03) 555-1234")).toBe("Call [phone] or [phone] or [phone]");
    expect(maskPersonalData("Card 4580 1234 5678 9012 exp 12/27")).toBe("Card [card number] exp 12/27");
    expect(maskPersonalData("Card 4580-1234-5678-9012.")).toBe("Card [card number].");
  });

  it("keeps times, prices, dates and short numbers", () => {
    const s = "At 06:12 he said ₪8,000 on 14.11.2026, 3 sites, 2026-11-14, SNS-200, 12 sensors";
    expect(maskPersonalData(s)).toBe(s);
  });
});

describe("HTML to text", () => {
  it("drops nav, footer, scripts and styles; keeps headings and paragraphs; finds links", () => {
    const html = `<html lang="en"><head><title>Polar &amp; Co</title><style>p{color:red}</style></head><body>
      <nav><a href="/a">Menu</a></nav><h1>Fridge sensors</h1><script>alert(1)</script>
      <p>Alerts in <b>2 minutes</b>.</p><a href="/faq">FAQ</a><footer>© 2026 Polar</footer></body></html>`;
    const p = htmlToText(html);
    expect(p.title).toBe("Polar & Co");
    expect(p.lang).toBe("en");
    expect(p.text).toBe("Fridge sensors\nAlerts in 2 minutes.\nFAQ");
    expect(p.links).toEqual(["/a", "/faq"]);
  });
});

describe("size cap and language", () => {
  it("cuts at the cap and records where", () => {
    const { sections, problem } = capSections([{ locator: "p.1", heading: null, text: "a".repeat(60) }, { locator: "p.2", heading: null, text: "b".repeat(60) }], 100);
    expect(sections.map((s) => s.text.length)).toEqual([60, 40]);
    expect(problem?.where).toBe("p.2");
    expect(capSections([{ locator: "p.1", heading: null, text: "abc" }], 100).problem).toBeNull();
  });

  it("guesses English, Hebrew or both", () => {
    expect(guessLanguage("Sensors that alert you within two minutes")).toBe("en");
    expect(guessLanguage("חיישנים שמתריעים תוך שתי דקות בכל המקררים")).toBe("he");
    expect(guessLanguage("Sensors that alert you חיישנים שמתריעים תוך שתי דקות")).toBe("en,he");
    expect(guessLanguage("12 34")).toBeNull();
  });
});
