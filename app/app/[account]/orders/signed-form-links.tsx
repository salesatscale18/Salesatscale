import { buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { CopyButton } from "@/components/sas/copy-button";
import { t } from "@/lib/i18n";

/**
 * A signed form's links for the seller: the signed document, and while the
 * order waits for payment the buyer's pay page (/f/<token>: a signed form's
 * link opens at the payment step) with Copy link. The link of a signed form
 * has no expiry, so none is shown. R5 item 8.
 *
 * `payVariant`: the look of "Open pay page" and "Copy link". The Orders panel
 * keeps "secondary"; the lead page's Orders card passes "ghost" so all three
 * match "Signed form" (W5).
 */
export function SignedFormLinks({ url, pay, payVariant = "secondary" }: { url: string; pay: boolean; payVariant?: "secondary" | "ghost" }) {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} data-signed-form-links="">
      <a className={buttonClass("ghost", "sm")} href={`${path}/document`} target="_blank" rel="noreferrer"><Icon name="file-text" />{t("orders.detail.signed_doc")}</a>
      {pay ? (
        <>
          <a className={buttonClass(payVariant, "sm")} href={url} target="_blank" rel="noreferrer" data-pay-link=""><Icon name="credit-card" />{t("orders.detail.open_pay_page")}</a>
          <CopyButton value={url} label={t("orders.detail.copy_link")} variant={payVariant} />
        </>
      ) : null}
    </div>
  );
}
