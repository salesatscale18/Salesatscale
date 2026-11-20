import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appDb } from "@/lib/auth/account";
import { dir, translator } from "@/lib/i18n";
import { brandVars } from "@/lib/simulator/rules";
import { stopPageInfo } from "@/lib/sms/service";
import { stopSmsAction } from "./actions";
import "../../[token]/chat.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Text messages", robots: { index: false, follow: false } };

/**
 * "Stop text messages" (board ReachSms, stop page and done): reached from the
 * link at the top of the chat, or its menu. Public and login-free (proxy.ts
 * treats /chat/(.*) as public); the signed stop token is the credential. GET
 * only shows the question; the POST action records the stop, so link previews
 * never trigger it. It stops SMS only: the chat stays open, and the buyer can
 * turn SMS back on from the chat menu. A wrong or forged token is a 404.
 */
export default async function SmsStopPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await stopPageInfo(appDb, token);
  if (!info) notFound();
  const tr = translator(info.lang);
  const d = dir(info.lang);
  const initials = info.seller.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="c-root" lang={info.lang} dir="ltr" style={brandVars(info.brandColor)}>
      <main className="c-frame c-stop" dir={d}>
        <div className="c-head">
          <span className="c-avatar" aria-hidden="true">{initials}</span>
          <div className="c-head__text"><span className="c-head__name"><bdi>{info.seller}</bdi></span></div>
        </div>
        {info.stopped ? (
          <section className="c-stop__body c-stop__body--done" role="status" data-sms-stop-done="">
            <span className="c-stop__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m5.6 5.6 12.8 12.8" /></svg>
            </span>
            <h1 className="c-stop__title">{tr("buyer.sms_stop.done_title")}</h1>
            <p className="c-stop__text">{tr("buyer.sms_stop.done", { seller: info.seller })}</p>
            <p className="c-stop__hint">{tr("buyer.sms_stop.done_hint")}</p>
            {info.chatPath ? <a className="c-stop__link" href={info.chatPath}>{tr("buyer.sms_stop.open_chat")}</a> : null}
          </section>
        ) : (
          <form action={stopSmsAction} className="c-stop__body" data-sms-stop-ask="">
            <h1 className="c-stop__title">{tr("buyer.sms_stop.title", { seller: info.seller })}</h1>
            <p className="c-stop__text">{tr("buyer.sms_stop.body", { seller: info.seller })}</p>
            <input type="hidden" name="token" value={token} />
            <button type="submit" className="c-stop__btn">{tr("buyer.sms_stop.button")}</button>
            {info.chatPath ? <a className="c-stop__link" href={info.chatPath}>{tr("buyer.sms_stop.keep")}</a> : null}
          </form>
        )}
      </main>
    </div>
  );
}
