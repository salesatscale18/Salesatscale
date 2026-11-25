import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { translator, type Locale } from "@/lib/i18n";
import { chatNames } from "@/lib/simulator/service";
import { brandVars } from "@/lib/simulator/rules";
import { leadPageConsentParts } from "@/lib/leads/consent-line";
import { handoverReceivedLine } from "@/lib/lead-pages/handover-text";
import { publicUrl } from "@/lib/orders/token";
import { originOf } from "@/lib/lead-pages/origin";
import { bannerUrlPath, CLICK_ID_KEYS, consentTickedOf, formFieldsOf, initialsOf, trackingOf, UTM_KEYS } from "@/lib/lead-pages/rules";
import { pageByKey, pageCountries, privacyNotice } from "@/lib/lead-pages/service";
import { formTimingToken, previewTokenValid } from "@/lib/lead-pages/tokens";
import { aboutLine, leadFormText } from "@/lib/lead-pages/form-text";
import { LeadForm } from "./lead-form";
import { HostedFormFrame, LeadFormHead } from "./lead-form-view";
import { LeadPageHeader } from "./header";
import "./lead-page.css";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ key: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params;
  const found = await pageByKey(appDb, key);
  const lang = found?.page.language === "he" ? "he" : "en";
  const seller = found ? (await chatNames(appDb, found.account, lang)).seller : "";
  return { title: seller || "Form", robots: { index: false, follow: false } };
}

/**
 * The hosted lead form (/p/<key>, "Button or link"; also every page type's
 * preview). Public and login-free. A draft is a 404 unless the seller's
 * preview token is in the link; a paused page says it is closed. The form
 * posts to /api/lp/<key>/submit; without JavaScript it still works.
 * Query parameters: ?e=<name|phone|generic|busy> (an error after a no-JS post,
 * never a personal detail), ?sent=1 (the plain "Thanks" page), utm_* and ad
 * click IDs (kept on the submission when the page carries ad details).
 */
export default async function LeadFormPage({ params, searchParams }: Props) {
  const { key } = await params;
  const sp = (await searchParams) ?? {};
  const found = await pageByKey(appDb, key);
  if (!found) notFound();
  const { page, account, brandColor } = found;
  const now = new Date();
  const previewToken = one(sp.preview);
  const preview = previewTokenValid(previewToken, page.id, now);
  if (page.status === "draft" && !preview) notFound();
  const lang: Locale = page.language === "he" ? "he" : "en";
  const tr = translator(lang);
  const dir = lang === "he" ? "rtl" : "ltr";
  const names = await chatNames(appDb, account, lang);
  const banner = page.banner ? { src: bannerUrlPath(page.publicKey, page.banner), width: page.banner.width, height: page.banner.height } : null;
  const shell = (body: React.ReactNode) => (
    <HostedFormFrame lang={lang} dir={dir} style={brandVars(brandColor)} header={<LeadPageHeader banner={banner} seller={names.seller} initials={initialsOf(names.seller)} />}>
      {body}
    </HostedFormFrame>
  );
  if (one(sp.sent) === "1") {
    return shell(<p className="lp-hand__sub" role="status" data-lp-thanks="">{handoverReceivedLine(names, null, lang)}</p>);
  }
  if (page.status === "paused" && !preview) return shell(<p className="lp-hand__sub" role="status" data-lp-closed="">{tr("buyer.lp.form.closed")}</p>);

  const hidden: Record<string, string> = { ft: formTimingToken(page.id, now.getTime()) };
  if (preview) hidden.preview = previewToken;
  const ad: Record<string, string> = {};
  if (trackingOf(page.tracking).carryAdDetails) {
    for (const k of UTM_KEYS) { const v = one(sp[`utm_${k}`]).slice(0, 200); if (v) ad[`utm_${k}`] = v; }
    for (const k of CLICK_ID_KEYS) { const v = one(sp[k]).slice(0, 200); if (v) ad[k] = v; }
    // Where the visit came from (the ad or the seller's page): its host only, never our own.
    const ref = originOf((await headers()).get("referer"));
    if (ref && ref !== originOf(publicUrl("/"))) ad.referrer = new URL(ref).host;
    Object.assign(hidden, ad);
  }
  const notice = await privacyNotice(appDb, page);
  const privacyHref = notice ? `/p/${page.publicKey}/privacy${preview ? `?preview=${encodeURIComponent(previewToken)}` : ""}` : null;
  const e = one(sp.e);
  const initialError = e === "name" || e === "phone" || e === "generic" || e === "busy" ? e : null;
  const text = leadFormText(tr);
  const about = aboutLine(tr, page.openingTopic, lang);
  return shell(
    <>
      <LeadFormHead about={about} title={text.title} />
      <LeadForm
        action={`/api/lp/${page.publicKey}/submit`}
        // A preview visit sends its token: it ticks "The form opened from the link" and is never counted.
        beacon={{ url: `/api/lp/${page.publicKey}/e`, body: JSON.stringify({ t: "view", ...ad, ...(preview ? { preview: previewToken } : {}) }) }}
        strings={text}
        fields={formFieldsOf(page.form)}
        consentTicked={consentTickedOf(page.form, await pageCountries(appDb, page, account))}
        consentLine={leadPageConsentParts(lang, names.seller, names.agent)}
        privacyHref={privacyHref}
        hidden={hidden}
        initialError={initialError}
        dir={dir}
      />
    </>,
  );
}
