/**
 * A browser harness for the add/edit form's banner field (tests/e2e/lead-page-banner.spec.ts):
 * the real form shell (useActionState, as on the page) and the real BannerField, with a
 * stand-in for the server action that refuses an empty name the way the real one does (the form
 * itself refuses it first, before sending) and a name only the server refuses ("Server says no"), and
 * records what it received (window.__sent). Bundled with esbuild by the spec.
 */
import { createRoot } from "react-dom/client";
import { BannerField } from "@/app/app/[account]/lead-pages/banner-field";
import { FieldError, LeadPageFormShell } from "@/app/app/[account]/lead-pages/form-shell";
import type { LeadPageFormState } from "@/app/app/[account]/lead-pages/actions";

type Sent = { name: string; connection: string; banner: { name: string; size: number } | null };
const w = window as unknown as { __sent: Sent[] };
w.__sent = [];

async function action(_prev: LeadPageFormState, form: FormData): Promise<LeadPageFormState> {
  await new Promise((r) => setTimeout(r, 150));
  const file = form.get("banner");
  const banner = file && typeof file !== "string" && file.size > 0 ? { name: file.name, size: file.size } : null;
  const name = String(form.get("name") ?? "").trim();
  w.__sent.push({ name, connection: String(form.get("connection") ?? ""), banner });
  // An empty name is refused in the browser before sending (form-shell.tsx); "Server says no" stands for a refusal only the server makes.
  if (!name || name === "Server says no") return { errors: { name: name ? "Use another name." : "Enter a name for the page." }, connection: String(form.get("connection") ?? ""), bannerSent: !!banner };
  document.body.setAttribute("data-saved", banner ? `banner:${banner.name}` : "no-banner");
  return null;
}

createRoot(document.getElementById("root")!).render(
  <LeadPageFormShell action={action} errorTitle="Check the fields marked below." className="lpg-form">
    <label><input type="radio" name="connection" value="snippet" defaultChecked />Our form on your page</label>
    <label><input type="radio" name="connection" value="link" />Button or link</label>
    <label>Name <input name="name" /></label>
    <FieldError name="name" />
    <BannerField
      saved={null} uploads removeButton={null}
      icons={{ placeholder: <span>▭</span>, upload: <span>↑</span> }}
      text={{
        title: "Banner", hint: "JPG, PNG or WebP, up to 2 MB.", none: "Without a banner the screen shows your company's initials, large.",
        choose: "Choose image", replace: "Replace", remove: "Remove", off: "Banners can't be added here.",
        selected: "Chosen: {name}, {size}. It is saved when you save the page.", wrongType: "This file is not a JPG, PNG or WebP image. Choose another one.",
        tooBig: "This image is {size}. Choose one up to 2 MB.", again: "The image was not kept. Choose it again.", clear: "Don't use it",
      }}
    />
    <button type="submit" name="intent" value="draft">Save draft</button>
  </LeadPageFormShell>,
);
