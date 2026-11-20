import { buttonClass } from "@/components/sas/primitives";
import { Icon, type IconName } from "@/components/sas/icon";
import { t, type MessageKey } from "@/lib/i18n";
import type { SellerAccount } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { summarizeContactHours } from "@/lib/accounts/contact-hours";
import { whatsappEnabled } from "@/lib/channels/rules";
import { listMarkets } from "@/lib/markets/service";
import { marketContactSettings } from "@/lib/markets/settings";
import { agentSmsEnabled, SENDER_NAME_MAX, smsConfig, smsSender } from "@/lib/sms/rules";
import { accountSmsTestNumbers, MAX_SMS_TEST_NUMBERS } from "@/lib/sms/settings";
import { formatPhone } from "@/lib/leads/rules";
import { addSmsTestNumberAction, removeSmsTestNumberAction } from "./channels-actions";

const maybe = (key: string) => (t(key as MessageKey) as string | undefined) ?? null;

/** A pill: always an icon and a word. */
function Pill({ tone, icon, children }: { tone: "info" | "warning" | "neutral" | "success"; icon: IconName; children: string }) {
  return <span className={`sas-pill${tone === "neutral" ? "" : ` sas-pill--${tone}`}`}><Icon name={icon} />{children}</span>;
}

function Row({ icon, title, pill, children, side }: { icon: IconName; title: string; pill: React.ReactNode; children: React.ReactNode; side?: React.ReactNode }) {
  return (
    <div className="sas-channel-row">
      <span className="sas-channel-row__icon" aria-hidden="true"><Icon name={icon} /></span>
      <div className="sas-channel-row__main">
        <div className="sas-channel-row__title"><h3>{title}</h3>{pill}</div>
        {children}
      </div>
      {side ? <div className="sas-channel-row__side">{side}</div> : null}
    </div>
  );
}

/**
 * Settings › Channels (board ReachSettings): where buyers talk with the agent
 * and how they are reached. Web chat is always on; SMS shows its mode (Test
 * mode / Live), the registered sender and its registration state, and the
 * account's test numbers (add/remove, stored per account: lib/sms/settings);
 * WhatsApp is a read-only platform state (WHATSAPP_ENABLED; "Off" with no
 * switch while off); email as a fallback is planned ("Not yet"). Next to it, the read-only "Team calls · Fixed for now" card.
 * Going live with SMS waits for the approved sender (TWILIO_SMS_SENDER_STATUS)
 * and the platform's SMS_MODE=live.
 */
export async function ChannelsSection({ account, saved, error }: { account: SellerAccount; saved: string; error: string }) {
  const [own, marketList] = await Promise.all([accountSmsTestNumbers(appDb, account.id), listMarkets(appDb, account.id)]);
  const config = smsConfig(process.env, own);
  const sender = smsSender();
  const live = config.mode === "live";
  const waOn = whatsappEnabled();
  const hidden = <input type="hidden" name="slug" value={account.slug} />;
  const errorText = error ? maybe(`settings.channels.err.${error}`) ?? t("settings.channels.err.generic") : null;
  return (
    <div className="sas-channels">
      {saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{maybe(`settings.channels.saved.${saved}`) ?? t("settings.channels.saved.numbers")}</span></div> : null}
      {errorText ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{errorText}</span></div> : null}
      <div className="sas-channels__grid">
        <section className="sas-panel sas-channels__card" aria-labelledby="ch-h" data-channels-card="">
          <div className="sas-panel__body sas-stack-2" style={{ gap: 2 }}>
            <h2 id="ch-h" className="sas-heading">{t("settings.channels.title")}</h2>
            <span className="sas-small">{t("settings.channels.body")}</span>
          </div>

          <Row icon="message-circle" title={t("settings.channels.chat")} pill={<Pill tone="info" icon="check">{t("settings.channels.always_on")}</Pill>}>
            <p className="sas-small">{t("settings.channels.chat_body")}</p>
          </Row>

          <Row
            icon="message-square" title={t("settings.channels.sms")}
            pill={live ? <Pill tone="success" icon="check">{t("settings.channels.live")}</Pill> : <Pill tone="warning" icon="flask-conical">{t("settings.channels.test_mode")}</Pill>}
            side={live ? null : (
              <div className="sas-channel-golive">
                <button type="button" className={buttonClass("secondary", "sm")} disabled aria-describedby="sms-golive-reason" data-sms-go-live="">{t("settings.channels.go_live")}</button>
                <span className="sas-small" id="sms-golive-reason" data-sms-go-live-why="">{t("settings.channels.go_live_why")}</span>
              </div>
            )}
          >
            <p className="sas-small">{t("settings.channels.sms_body")}</p>
            <dl className="sas-channel-fields">
              <dt>{t("settings.channels.sender")}</dt>
              <dd data-sms-sender={sender.approved ? "approved" : "pending"}>
                {sender.name ? (
                  <>
                    <span className="sas-channel-sender">{sender.name}</span>
                    <span className="sas-small">
                      {t("settings.channels.sender_letters", { n: sender.name.length, max: SENDER_NAME_MAX })} · {t(sender.approved ? "settings.channels.sender_approved" : "settings.channels.sender_pending")}
                    </span>
                  </>
                ) : <span className="sas-small">{t("settings.channels.sender_none")}</span>}
              </dd>
              <dt id="sms-testers-h">{t("settings.channels.test_numbers")}</dt>
              <dd>
                <ul className="sas-channel-testers" aria-labelledby="sms-testers-h">
                  {config.testNumbers.map((n) => (
                    <li key={n} className="sas-channel-tester">
                      <span className="sas-num" title={n}>{formatPhone(n)}</span>
                      <form action={removeSmsTestNumberAction}>
                        {hidden}
                        <input type="hidden" name="number" value={n} />
                        <button type="submit" className="sas-channel-tester__x" aria-label={t("settings.channels.remove_number", { number: formatPhone(n) })} title={t("settings.channels.remove_number", { number: formatPhone(n) })}><Icon name="x" /></button>
                      </form>
                    </li>
                  ))}
                  {config.testNumbers.length < MAX_SMS_TEST_NUMBERS ? (
                    <li>
                      <details className="sas-channel-add">
                        <summary className={buttonClass("ghost", "sm")}><Icon name="plus" />{t("settings.channels.add")}</summary>
                        <form action={addSmsTestNumberAction} className="sas-channel-add__form">
                          {hidden}
                          <label className="sas-input-label" htmlFor="sms-add-number">{t("settings.channels.add_label")}</label>
                          <input id="sms-add-number" name="number" type="tel" className="sas-input" placeholder="+972501234567" required autoComplete="off" />
                          <button type="submit" className={buttonClass("primary", "sm")}>{t("settings.channels.add_button")}</button>
                        </form>
                      </details>
                    </li>
                  ) : null}
                </ul>
                {config.testNumbers.length === 0 ? <span className="sas-small">{t("settings.channels.no_test_numbers")}</span> : null}
              </dd>
            </dl>
            <div className="sas-channel-hint"><Icon name="info" /><span>{t(live ? "settings.channels.sms_live_hint" : "settings.channels.sms_hint")}</span></div>
            {agentSmsEnabled() ? null : <p className="sas-small">{t("settings.channels.followup_off")}</p>}
          </Row>

          <Row
            icon="phone-call" title={t("settings.channels.whatsapp")}
            pill={waOn ? <Pill tone="info" icon="check">{t("settings.channels.on")}</Pill> : <Pill tone="neutral" icon="pause">{t("settings.channels.off")}</Pill>}
          >
            {waOn
              ? <p className="sas-small">{t("settings.channels.whatsapp_body")} {t("settings.channels.whatsapp_platform")}</p>
              : <div className="sas-channel-hint" data-whatsapp-off=""><Icon name="info" /><span>{t("settings.channels.whatsapp_off_hint")}</span></div>}
          </Row>

          <Row
            icon="mail" title={t("settings.channels.email")}
            pill={<Pill tone="neutral" icon="clock">{t("settings.channels.not_yet")}</Pill>}
          >
            <div className="sas-channel-hint" data-email-planned=""><Icon name="info" /><span>{t("settings.channels.email_planned")}</span></div>
          </Row>
        </section>

        <section className="sas-panel sas-channels__card" aria-labelledby="tc-h" data-team-calls-card="">
          <div className="sas-panel__body sas-stack-4">
            <div className="sas-stack-2" style={{ gap: 2 }}>
              <div className="sas-channel-row__title"><h2 id="tc-h" className="sas-heading">{t("settings.team_calls.title")}</h2><Pill tone="neutral" icon="lock">{t("settings.team_calls.fixed")}</Pill></div>
              <span className="sas-small">{t("settings.team_calls.body")}</span>
            </div>
            <dl className="sas-channel-fields sas-channel-fields--wide">
              <dt>{t("settings.team_calls.times")}</dt>
              <dd>
                <span>{t("settings.team_calls.times_value")}</span>
                {marketList.map((m) => (
                  <span key={m.id} className="sas-small" data-market-hours="">{m.name}: {summarizeContactHours(marketContactSettings(account, m).contactHours)}</span>
                ))}
              </dd>
              <dt>{t("settings.team_calls.ahead")}</dt><dd>{t("settings.team_calls.ahead_value")}</dd>
              <dt>{t("settings.team_calls.length")}</dt><dd>{t("settings.team_calls.length_value")}</dd>
              <dt>{t("settings.team_calls.taken")}</dt><dd>{t("settings.team_calls.taken_value")}</dd>
            </dl>
            <div className="sas-channel-hint"><Icon name="info" /><span>{t("settings.team_calls.hint")} <a href={`/app/${account.slug}/settings?section=hours`}>{t("settings.team_calls.hours_link")}</a></span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
