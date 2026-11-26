import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { Icon } from "@/components/sas/icon";
import { requireAccount } from "@/lib/auth/account";
import { agentNameRows } from "@/lib/agent/core/names";
import { isPlaybookPart } from "@/lib/agent/playbook-parts";
import { HANDOFF_NOTICE_COOKIE, showHandoffNotice } from "@/lib/agent/handoff-notice";
import { unpaidRemindersOf } from "@/lib/orders/unpaid-reminders";
import { voiceLabAccess, voiceSettingsSummary } from "@/lib/voice/lab";
import { resolveVoiceSettings, versionModelId } from "@/lib/voice/settings";
import { t } from "@/lib/i18n";
import { loadPlaybook } from "../data";
import { PartShell } from "../shell";
import { AgentRows, CloseRows, LimitsRows, NeverRows } from "../part-rows";
import { AfterPart, AsksPart, ObjectionsPart, OpeningPart } from "../part-editors";

/** The notice cookie, or nothing outside a request (render tests). */
async function noticeCookie(): Promise<string | undefined> {
  try { return (await cookies()).get(HANDOFF_NOTICE_COOKIE)?.value; } catch { return undefined; }
}

/**
 * Setup · Playbook › one part (boards PlaybookAgent, PlaybookClose,
 * PlaybookLimits, PlaybookNever, …). Agent, How a deal closes, Limits and
 * Never do are read first, one row edited at a time; Opening, What it asks,
 * Objections and After the order keep their editors. Always the draft.
 * Sales plays keep their own pages (plays/).
 */
export default async function PlaybookPartPage({ params, searchParams }: { params: Promise<{ account: string; part: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, part } = await params;
  const sp = await searchParams;
  if (!isPlaybookPart(part) || part === "plays") notFound();
  const access = await requireAccount(slug);
  const { account, user } = access;
  const data = await loadPlaybook(access);
  const p = data.draft.playbook;
  const edit = typeof sp.edit === "string" ? sp.edit : null;
  const base = { slug: account.slug, hrefs: data.hrefs, edit };
  const saved = sp.saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("playbook.saved")}</span></div> : null;

  let body;
  switch (part) {
    case "agent": {
      const rows = agentNameRows(p, data.nameLanguages);
      const asWritten = rows.filter((r) => r.tag === "as_written" && !r.own).map((r) => r.label);
      const model = versionModelId(data.draft.voiceSettings);
      const voice = voiceLabAccess(user) === "ok"
        ? { line: voiceSettingsSummary(resolveVoiceSettings(data.draft.voiceSettings, model), model), href: `${data.lab}?mode=voice&panel=voice` }
        : null;
      body = (
        <AgentRows
          {...base} p={p} voice={voice}
          names={{ rows, source: p.agentName, notice: asWritten.length ? t("names.as_written_notice", { languages: asWritten.join(", ") }) : null, marketsHref: `${data.base}/markets` }}
        />
      );
      break;
    }
    case "close":
      body = <CloseRows {...base} p={p} />;
      break;
    case "limits": {
      // O1: unknown questions no longer hand off; tell sellers whose hand-off rule still says so, until they dismiss it.
      const handOffNotice = showHandoffNotice(p.handOffWhen, await noticeCookie(), user.id) ? { playHref: `${data.hrefs.plays}/no_answer` } : null;
      body = <LimitsRows {...base} p={p} handOffNotice={handOffNotice} />;
      break;
    }
    case "never":
      body = <NeverRows {...base} p={p} />;
      break;
    case "opening":
      body = <OpeningPart {...base} p={p} company={account.tradeName} companyLocal={account.tradeNameLocal} key={JSON.stringify(p.opener ?? null)} />;
      break;
    case "asks":
      body = <AsksPart {...base} p={p} orderFormHref={`${data.base}/setup/order-form`} key={JSON.stringify([p.fields, p.questionBudget ?? null])} />;
      break;
    case "objections":
      body = <ObjectionsPart {...base} p={p} key={JSON.stringify([p.objections, p.objectionAttempts ?? null])} />;
      break;
    case "after":
      body = <AfterPart {...base} p={p} liveUnpaid={unpaidRemindersOf(data.live?.playbook ?? null)} key={JSON.stringify(unpaidRemindersOf(p))} />;
      break;
  }
  return <PartShell data={data} part={part} notice={saved}>{body}</PartShell>;
}
