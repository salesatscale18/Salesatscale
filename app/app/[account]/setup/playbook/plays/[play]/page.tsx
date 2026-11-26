import { notFound } from "next/navigation";
import { Icon } from "@/components/sas/icon";
import { appDb, requireAccount } from "@/lib/auth/account";
import { loadPlaybook } from "../../data";
import { DraftBar } from "../../draft-bar";
import { DEFAULT_PLAYS, defaultPlayFor, playFacts } from "@/lib/agent/core/plays";
import { questionBudgetOf } from "@/lib/agent/core/stage";
import { isPlayKey } from "@/lib/agent/playbook";
import { playSuggestions } from "@/lib/pipeline/service";
import { t } from "@/lib/i18n";
import { SuggestedTag } from "../parts";
import { PlayForm, type ElsewhereFact } from "./play-form";

/** Setup · Playbook › Sales plays › one play (canvas: PlayCard). Edits the draft version. */
export default async function PlayPage({ params, searchParams }: { params: Promise<{ account: string; play: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug, play } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account } = access;
  if (!isPlayKey(play)) notFound();
  const [data, suggestions] = await Promise.all([loadPlaybook(access), playSuggestions(appDb, account.id, play)]);
  const draft = data.draft;
  const base = `/app/${account.slug}`;
  const playbookHref = `${base}/setup/playbook`;
  const playsHref = `${playbookHref}/plays`;
  const draftHref = `${playbookHref}/draft#sg-play`;
  const d = defaultPlayFor(play, questionBudgetOf(draft.playbook));
  const stored = draft.playbook.plays?.[play];
  const pb = draft.playbook;

  // Facts that live in another setting are shown here read-only, with a link there.
  const elsewhere: ElsewhereFact[] = [];
  if (play === "too_expensive") {
    elsewhere.push({ label: t("playbook.play.discount_limit"), text: t("playbook.play.discount_limit_text", { pct: pb.maxDiscountBp / 100 }), href: data.hrefs.limits, linkLabel: t("playbook.play.edit_in_limits") });
  }
  if (play === "handoff" && pb.handOffWhen.trim()) {
    elsewhere.push({ label: t("playbook.handoff_when"), text: pb.handOffWhen, href: data.hrefs.limits, linkLabel: t("playbook.play.edit_in_limits") });
  }

  const card = suggestions.find((s) => s.payload.kind === "play_card");
  // "Edit first" (playbook draft): the suggested card opens as the seller's own card, to edit and save.
  const fromId = typeof sp.from === "string" ? sp.from : "";
  const from = card && card.id === fromId && card.status === "suggested" && card.payload.kind === "play_card" ? card.payload : null;
  const initialOwn = from ? { when: from.when, do: from.do, example: from.example, notThis: from.notThis } : stored?.own ?? null;
  const openFacts = suggestions.filter((s) => s.payload.kind === "play_content" && s.status === "suggested").length;
  const suggestionNote = card ? (
    <span className="sas-small">
      {card.status === "suggested" ? <><SuggestedTag />{" "}</> : null}
      {t("playbook.play.from_suggestion", { calls: card.evidence.length })} <a href={draftHref}>{t("playbook.play.see_suggestion")}</a>
    </span>
  ) : null;

  return (
    <>
    <main className="sas-shell__content">
      <DraftBar bar={data.bar} />
      <nav aria-label={t("playbook.play.breadcrumb")} className="sas-small pb-crumbs">
        <a href={playbookHref}>{t("playbook.title")}</a>
        <span aria-hidden="true">›</span>
        <a href={playsHref}>{t("playbook.plays")}</a>
        <span aria-hidden="true">›</span>
        <span aria-current="page">{d.title}</span>
      </nav>
      {sp.saved ? (
        <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t(sp.saved === "restored" ? "playbook.play.restored" : "playbook.play.saved")}</span></div>
      ) : null}
      {openFacts || (card && card.status === "suggested" && !stored?.own) ? (
        <div className="sas-alert" role="status" style={{ background: "var(--agent-soft)" }}>
          <Icon name="sparkles" />
          <span>
            {openFacts ? t(openFacts === 1 ? "playbook.plays.suggested_fact" : "playbook.plays.suggested_facts", { n: openFacts }) : t("playbook.plays.suggested_card")}.{" "}
            <a href={draftHref}>{t("playbook.play.review_in_draft")}</a>
          </span>
        </div>
      ) : null}
      <div style={{ maxWidth: 760 }}>
        <PlayForm
          key={JSON.stringify([stored ?? null, from ? fromId : null])}
          slug={account.slug} playKey={play} title={d.title} defaultCard={d} fromSuggestion={from ? fromId : null}
          initialFacts={playFacts(stored)} initialOwn={initialOwn} elsewhere={elsewhere}
          labHref={`${base}/setup/test-lab`} suggestionNote={suggestionNote} hint={d.sellerContentHint}
        />
      </div>
    </main>
    </>
  );
}
