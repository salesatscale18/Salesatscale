import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { translator, type Locale } from "@/lib/i18n";
import { chatNames } from "@/lib/simulator/service";
import { brandVars } from "@/lib/simulator/rules";
import { pageByKey, privacyNotice } from "@/lib/lead-pages/service";
import { previewTokenValid } from "@/lib/lead-pages/tokens";
import "../lead-page.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy notice", robots: { index: false, follow: false } };

type Props = { params: Promise<{ key: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> };

/**
 * The privacy notice behind a lead form's consent line: the market's
 * `privacy_notice` legal section in the form's language (lib/markets/legal.ts
 * marketLegal). A draft page's notice needs the preview token, like the form.
 */
export default async function LeadPagePrivacy({ params, searchParams }: Props) {
  const { key } = await params;
  const sp = (await searchParams) ?? {};
  const found = await pageByKey(appDb, key);
  if (!found) notFound();
  const { page, account, brandColor } = found;
  const previewToken = typeof sp.preview === "string" ? sp.preview : "";
  if (page.status === "draft" && !previewTokenValid(previewToken, page.id, new Date())) notFound();
  const notice = await privacyNotice(appDb, page);
  if (!notice) notFound();
  const lang: Locale = page.language === "he" ? "he" : "en";
  const tr = translator(lang);
  const seller = (await chatNames(appDb, account, lang)).seller;
  return (
    <div className="lp-root lp-root--form" lang={lang} dir={lang === "he" ? "rtl" : "ltr"} style={brandVars(brandColor)}>
      <main className="lp-page">
        <div className="lp-body">
          <p className="lp-note" style={{ textAlign: "start" }}><bdi>{seller}</bdi></p>
          <h1 className="lp-title">{notice.title}</h1>
          <p className="lp-legal" dir="auto">{notice.body}</p>
          <a className="lp-link" href={`/p/${page.publicKey}${previewToken ? `?preview=${encodeURIComponent(previewToken)}` : ""}`}>{tr("buyer.lp.privacy.back")}</a>
        </div>
      </main>
    </div>
  );
}
