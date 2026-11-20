import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { dir, translator } from "@/lib/i18n";
import { stopPageInfo } from "@/lib/sms/service";
import { stopSmsAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Text messages", robots: { index: false, follow: false } };

/**
 * PLACEHOLDER for the UX board (reach plan L2: the stop page). Plain text only.
 *
 * The opt-out link in every SMS (lib/sms/texts.ts). Public and login-free
 * (proxy.ts already treats /chat/(.*) as public). GET only shows a confirm
 * button; the POST action records the stop, so link previews never trigger it.
 * A wrong or forged token is a 404.
 */
export default async function SmsStopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await stopPageInfo(appDb, token);
  if (!info) notFound();
  const tr = translator(info.lang);
  return (
    <main lang={info.lang} dir={dir(info.lang)} style={{ maxWidth: 480, margin: "0 auto", padding: "48px 16px", fontFamily: "Inter, system-ui, sans-serif" }}>
      {info.stopped ? (
        <p role="status">{tr("buyer.sms_stop.done", { seller: info.seller })}</p>
      ) : (
        <form action={stopSmsAction}>
          <h1 style={{ fontSize: 20 }}>{tr("buyer.sms_stop.title", { seller: info.seller })}</h1>
          <p>{tr("buyer.sms_stop.body", { seller: info.seller })}</p>
          <input type="hidden" name="token" value={token} />
          <button type="submit">{tr("buyer.sms_stop.button")}</button>
        </form>
      )}
    </main>
  );
}
