/**
 * Lead pages › Add a page fixes (owner test, 25 Nov):
 * - the page address rule per connection: required for "Our form on your page",
 *   optional but recommended for "Your own form", optional for "Button or link";
 * - the banner file checked in the browser before it is sent (type and size);
 * - the banner field's markup: Replace and Remove on edit, the note where
 *   banners cannot be stored. (Choosing a file, the messages and the file kept
 *   through a failed save run in a real browser: tests/e2e/lead-page-banner.spec.ts.)
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BannerField, type BannerFieldText } from "@/app/app/[account]/lead-pages/banner-field";
import { BANNER_MAX_BYTES as SERVER_MAX, checkBanner, addressRequired, parseLeadPageInput, formFieldsOf, LEAD_PAGE_CONNECTIONS } from "@/lib/lead-pages/rules";
import { BANNER_ACCEPT, BANNER_MAX_BYTES, bannerFileProblem, fileSizeText } from "@/lib/lead-pages/banner-file";

const parse = (connection: string, address?: string) => parseLeadPageInput({ name: "Offer", connection, language: "en", address }, { languages: ["en"] });

describe("the page address per connection", () => {
  it("is required only for Our form on your page", () => {
    expect(LEAD_PAGE_CONNECTIONS.filter(addressRequired)).toEqual(["snippet"]);
    expect(parse("snippet")).toEqual({ ok: false, errors: { address: "Enter the address of the page the form is on." } });
    expect(parse("snippet", "  ")).toMatchObject({ ok: false, errors: { address: expect.any(String) } });
    expect(parse("snippet", "example.com/offer")).toMatchObject({ ok: true, value: { address: "https://example.com/offer" } });
  });

  it("is optional for Your own form and for Button or link: no error when empty", () => {
    for (const c of ["own_form", "link"]) {
      expect(parse(c)).toMatchObject({ ok: true, value: { connection: c, address: null } });
      expect(parse(c, "")).toMatchObject({ ok: true, value: { address: null } });
      expect(parse(c, "https://example.com/offer/")).toMatchObject({ ok: true, value: { address: "https://example.com/offer" } });
    }
  });

  it("a typed address must still be a web address, for every connection", () => {
    for (const c of ["snippet", "own_form", "link"]) {
      expect(parse(c, "not an address")).toEqual({ ok: false, errors: { address: "Enter the page address, like https://example.com/offer." } });
    }
  });
});

describe("optional buyer fields", () => {
  it("are Company and Email only; a stored sites flag is ignored", () => {
    expect(formFieldsOf({ fields: { company: true, email: true, sites: true } })).toEqual({ company: true, email: true });
    expect(formFieldsOf(null)).toEqual({ company: false, email: false });
    const r = parseLeadPageInput({ name: "x", connection: "link", language: "en", fields: { company: "on", sites: "on" } as never }, { languages: ["en"] });
    expect(r.ok && r.value.form.fields).toEqual({ company: true, email: false });
  });
});

describe("the banner file in the browser", () => {
  it("takes JPG, PNG or WebP up to 2 MB (the same limit as the server)", () => {
    expect(BANNER_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(SERVER_MAX).toBe(BANNER_MAX_BYTES);
    expect(BANNER_ACCEPT).toBe("image/jpeg,image/png,image/webp");
    for (const type of ["image/jpeg", "image/png", "image/webp"]) expect(bannerFileProblem({ name: "b", type, size: 1000 })).toBeNull();
    expect(bannerFileProblem({ name: "b.png", type: "image/png", size: BANNER_MAX_BYTES })).toBeNull();
    expect(bannerFileProblem({ name: "b.png", type: "image/png", size: BANNER_MAX_BYTES + 1 })).toBe("too_big");
  });

  it("refuses SVG, GIF and other files; with no declared type the extension decides", () => {
    expect(bannerFileProblem({ name: "logo.svg", type: "image/svg+xml", size: 100 })).toBe("wrong_type");
    expect(bannerFileProblem({ name: "a.gif", type: "image/gif", size: 100 })).toBe("wrong_type");
    expect(bannerFileProblem({ name: "notes.pdf", type: "application/pdf", size: 100 })).toBe("wrong_type");
    expect(bannerFileProblem({ name: "photo.JPEG", type: "", size: 100 })).toBeNull();
    expect(bannerFileProblem({ name: "photo.svg", type: "", size: 100 })).toBe("wrong_type");
    // A wrong type is reported first, even when it is also too big.
    expect(bannerFileProblem({ name: "big.svg", type: "image/svg+xml", size: BANNER_MAX_BYTES * 2 })).toBe("wrong_type");
  });

  it("the server still checks the bytes: a renamed SVG is not an image", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(checkBanner(svg)).toEqual({ ok: false, reason: "not_an_image" });
    expect(checkBanner(new Uint8Array(BANNER_MAX_BYTES + 1))).toEqual({ ok: false, reason: "too_large" });
  });

  it("sizes read as KB or MB", () => {
    expect(fileSizeText(300)).toBe("1 KB");
    expect(fileSizeText(820 * 1024)).toBe("820 KB");
    expect(fileSizeText(1.44 * 1024 * 1024)).toBe("1.4 MB");
    expect(fileSizeText(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("the banner field markup", () => {
  const text: BannerFieldText = {
    title: "Banner", hint: "hint", none: "Without a banner", choose: "Choose image", replace: "Replace", remove: "Remove", off: "Banners can't be added here.",
    selected: "Chosen: {name}, {size}.", wrongType: "Wrong type", tooBig: "This image is {size}.", again: "Choose it again.", clear: "Don't use it",
  };
  const icons = { placeholder: <i data-icon="placeholder" />, upload: <i data-icon="upload" /> };
  const remove = <button type="submit" name="intent" value="remove_banner">Remove</button>;

  it("add: Choose image, the empty thumbnail and the initials line", () => {
    const html = renderToStaticMarkup(<BannerField saved={null} uploads removeButton={null} icons={icons} text={text} />);
    expect(html).toContain('data-banner="none"');
    expect(html).toContain(">Choose image<input type=\"file\"");
    expect(html).toContain("Without a banner");
    expect(html).not.toContain("<img");
  });

  it("edit with a saved banner: shown whole, Replace and Remove", () => {
    const html = renderToStaticMarkup(<BannerField saved={{ src: "/api/lp/k/banner/abc", width: 1200, height: 400 }} uploads removeButton={remove} icons={icons} text={text} />);
    expect(html).toContain('data-banner="image"');
    expect(html).toContain('<img src="/api/lp/k/banner/abc" alt="" width="1200" height="400"/>');
    expect(html).toContain(">Replace<input type=\"file\"");
    expect(html).toContain('value="remove_banner"');
    expect(html).not.toContain("Without a banner");
  });

  it("where banners cannot be stored (Preview): the note, no file input", () => {
    const html = renderToStaticMarkup(<BannerField saved={null} uploads={false} removeButton={null} icons={icons} text={text} />);
    expect(html).toContain('data-banner-off=""');
    expect(html).not.toContain('type="file"');
  });
});
