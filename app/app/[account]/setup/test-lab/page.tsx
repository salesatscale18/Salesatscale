import { isUuid } from "@/lib/security/ids";
import { Fragment } from "react";
import { Button, StatusPill, buttonClass } from "@/components/sas/primitives";
import { Icon } from "@/components/sas/icon";
import { AgentStepsSwitch, ChatMessage, ChatThread, type TraceItem } from "@/components/sas/chat";
import type { ThreadMarker } from "@/lib/agent/thread-markers";
import { agentStepsFor } from "@/lib/conversations/agent-steps-server";
import { MessageBody } from "@/components/sas/message-body";
import { messageTextDir } from "@/lib/conversations/text-dir";
import { QuoteCardMessage } from "../../leads/[leadId]/quote-card-message";
import { APP_MESSAGE_CALL, appMessageKinds, isAppText, isTeamText } from "@/lib/agent/app-message";
import { DealStateFields } from "@/components/sas/record";
import { appDb, requireAccount } from "@/lib/auth/account";
import { mayDeleteRecordings } from "@/lib/voice/recording-playback";
import { seesPlatformDetails } from "@/lib/auth/display";
import { llmConfigured } from "@/lib/agent/llm";
import { getConversation, getDealState, listTestConversations, listVersions } from "@/lib/agent/service";
import { conversationView } from "@/lib/agent/conversation";
import { nextBuyerText, SCENARIOS, scenarioById } from "@/lib/agent/scenarios";
import { conversationScenarioCheck } from "@/lib/agent/scenario-results";
import { getLead } from "@/lib/leads/service";
import { formatDayMonthIn, formatLocalDateTime, timeAgo, zoneTitle } from "@/lib/format";
import { readViewerZone } from "@/lib/viewer-zone-server";
import { dir, isLocale, t, type MessageKey } from "@/lib/i18n";
import { describeCall } from "@/lib/agent/trace";
import { toolLabel } from "../../leads/[leadId]/conversation";
import { publishAction, rollbackAction, startChatAction } from "./actions";
import { Composer } from "./composer";
import { ConversationControls, MarkerEntry, deliveryLabel, splitMarkers, windowTimerProps } from "../../leads/[leadId]/conversation";
import { CallBlockEntry, isCallBlock } from "../../leads/[leadId]/call-block-entry";
import { ObjectionList } from "../../leads/[leadId]/deal-pane";
import { leadScheduledNextStep, paneObjections } from "@/lib/leads/deal-pane";
import { WindowTimer } from "@/components/sas/record";
import { conversationWindow } from "@/lib/channels/whatsapp";
import { listConnections } from "@/lib/channels/connections";
import { twilioConfig } from "@/lib/channels/twilio";
import { SidePanel } from "@/components/sas/list-kit";
import { VoiceCallBar } from "@/components/sas/voice/voice-call-bar";
import { VoiceCallStats } from "@/components/sas/voice/voice-call-stats";
import { VoiceSettingsForm } from "@/components/sas/voice/voice-settings-form";
import { ELEVEN_FOR_BUYER_CALLS } from "@/lib/voice-rt-eleven/rule";
import { usdRate } from "@/lib/ai/models";
import { INITIAL_SNAPSHOT } from "@/lib/voice/client/state";
import { barView, endDetailText } from "@/lib/voice/client/view";
import { callClock, callLimitShort, voiceLabAccess, voiceSettingsSummary } from "@/lib/voice/lab";
import { conversationVoiceModes, voiceSessionSummaries } from "@/lib/voice/service";
import { maxCallSeconds, resolveVoiceSettings, versionModelId, voiceModelId, voiceModelLabel } from "@/lib/voice/settings";
import { voiceModelChoices } from "@/lib/voice/model-choices";
import { ResultChip } from "./result-chip";
import { countChanges } from "@/lib/agent/version-compare";
import { statusDef } from "@/lib/domain/status";
import { classicModelId } from "@/lib/voice-classic/settings";
import { engineLabelKey, engineLabelVars, isPipelineEngine, sessionEngine } from "@/lib/voice-classic/engine-choice";
import { deploymentCallLimitSec } from "@/lib/voice/socket-limits";
import { saveVoiceSettingsAction } from "./voice-actions";
import { minorPerUsd } from "./voice-server";
import { CallArt, ChatArt, HistoryArt } from "./art";
import { VoiceCallAgainBar, VoiceLabBackGuard, VoiceLabChoices, VoiceLabKeeper, VoiceLabLive, VoiceLabStats } from "./voice-lab";

// A turn can take several model rounds.
export const maxDuration = 300;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const LANG_NAME: Record<string, string> = { en: "English", he: "Hebrew" };
const json = (v: unknown) => JSON.stringify(v, null, 2);

/**
 * Setup · Versions and test lab (P4.4; board: TestLabNew). Two modes, as tabs:
 * Chat (a test chat: scenario, language, version, Start; the open chat with
 * its tool trace) and Voice call (platform admins while voice is on: the same
 * choices with Start call; the open call). Each mode lists its own recent
 * chats or calls on the side, with Versions. The lab has its own bright test
 * palette (sas.css, `.lab-page`), apart from the workspace's colours.
 * Scenario results per version are on Compare versions.
 */
export default async function TestLabPage({ params, searchParams }: { params: Promise<{ account: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { account: slug } = await params;
  const sp = await searchParams;
  const access = await requireAccount(slug);
  const { account, user } = access;
  // Model and effort are platform details: sellers do not see them (live review 7.1.3).
  const showModel = seesPlatformDetails(access);
  // Records in the viewer's own zone (the sas_tz cookie), else the account's; the zone on hover (not "13:42 UTC").
  const viewerZone = await readViewerZone();
  const tz = viewerZone ?? account.timezone;
  const local = (at: Date) => formatLocalDateTime(at, tz);
  const isAdmin = user.role === "super_admin";
  const base = `/app/${account.slug}`;
  const lab = `${base}/setup/test-lab`;
  const [versions, chats, conv, waNumbers] = await Promise.all([
    listVersions(appDb, account.id),
    // History lists up to 100; the side list on Chat / Voice call shows the newest few.
    listTestConversations(appDb, account.id, one(sp.mode) === "history" ? 100 : 20),
    isUuid(one(sp.c)) ? getConversation(appDb, account.id, one(sp.c)) : Promise.resolve(null),
    listConnections(appDb, account.id),
  ]);
  const testerNumbers = waNumbers.filter((c) => c.status === "active" && c.testerNumbers.length > 0);
  const onWhatsapp = conv?.channel === "whatsapp";
  // Voice calls (release 1): platform admins only, and only while VOICE_REALTIME is not off. Checked here, on the server.
  const voice = voiceLabAccess(user) === "ok";
  const onVoice = conv?.channel === "voice";
  const [voiceSummaries, voiceModes] = await Promise.all([
    onVoice && conv ? voiceSessionSummaries(appDb, account.id, conv.id) : Promise.resolve([]),
    conversationVoiceModes(appDb, account.id, chats.filter((c) => c.channel === "voice").map((c) => c.id)),
  ]);
  const voiceSummary = voiceSummaries[0] ?? null;
  // Calls on a pipeline engine are never recorded (test only): their call block says so, not as a failure.
  const pipelineCalls = new Set(voiceSummaries.filter((v) => isPipelineEngine(v.engine)).map((v) => v.sessionId));
  const fx = { currency: account.currency, minorPerUsd: minorPerUsd(usdRate(account.currency)) };
  const usageHref = `${base}/settings`;
  const waWindow = onWhatsapp && conv && conv.status !== "closed" ? await conversationWindow(appDb, account.id, conv.id) : null;
  const draft = versions.find((v) => v.status === "draft");
  const scenario = conv?.isTest ? scenarioById(conv.scenario) : null;
  const scenarios = SCENARIOS.filter((s) => account.languages.includes(s.language));
  // Chat or Voice call (tabs): the URL's ?mode=, else the open conversation's channel. Voice only for whoever may call.
  const modeParam = one(sp.mode);
  const mode: "chat" | "voice" | "history" = modeParam === "history" && !conv ? "history"
    : voice && (modeParam === "voice" || (modeParam !== "chat" && onVoice)) ? "voice" : "chat";
  // The open conversation shows on its own tab (a seller without voice still sees a saved call).
  const showConv = mode !== "history" && (!voice || (mode === "voice") === onVoice);
  const [view, convLead, scenarioCheck, deal, scheduledStep] = await Promise.all([
    conv?.isTest ? conversationView(appDb, account.id, conv) : null,
    conv?.isTest ? getLead(appDb, account.id, conv.leadId) : null,
    conv?.isTest ? conversationScenarioCheck(appDb, account.id, conv) : null,
    conv ? getDealState(appDb, account.id, conv.leadId) : null,
    // A live call or follow-up: the next step from its stored instant in the viewer's zone (not the stored text's baked time).
    conv ? leadScheduledNextStep(appDb, account.id, conv.leadId, account.timezone, viewerZone) : null,
  ]);
  const nextStep = scheduledStep || deal?.nextStep;
  const thread = view?.thread ?? [];
  // "Show agent steps" (board ConvSteps): the step list before agent replies. On by default here, remembered apart from the workspace.
  const showSteps = await agentStepsFor("lab", user.id, sp.steps);
  // Recent: calls on the Voice call tab, chats (in the app or on WhatsApp) on the Chat tab; everything for whoever has no voice.
  const RECENT = 5;
  const recent = (voice ? chats.filter((c) => (c.channel === "voice") === (mode === "voice")) : chats).slice(0, RECENT);
  // History: every test chat and call, newest first; ?kind= narrows it to chats or calls.
  const kindParam = one(sp.kind);
  const kind: "all" | "chat" | "call" = kindParam === "chat" || kindParam === "call" ? kindParam : "all";
  const hasCalls = chats.some((c) => c.channel === "voice");
  const history = chats.filter((c) => kind === "all" || (kind === "call") === (c.channel === "voice"));
  const stepsBack = conv ? `${lab}?c=${conv.id}` : lab;
  // Hand-off, take-over and hand-back markers show either way.
  const { timed: timedMarkers, after: markersAfter } = splitMarkers(view?.markers);
  let pendingMarkers = timedMarkers;
  // A call since recordings exist: its block (header and player); its lines stay in the thread with their steps.
  const markerNode = (mk: ThreadMarker, key: string) => isCallBlock(mk)
    ? <CallBlockEntry key={key} marker={mk} lines={thread.filter(({ message: m }) => m.voiceSessionId === mk.call.sessionId).map(({ message: m }) => m)} slug={slug} back={conv ? `${lab}?c=${conv.id}` : lab} buyer={t("lab.who.buyer")} zone={viewerZone ?? tz} linesInBlock={false} canDelete={mayDeleteRecordings(access)} pipeline={pipelineCalls.has(mk.call.sessionId)} />
    : <MarkerEntry key={key} marker={mk} meId={user.id} time={local(mk.at)} timeTitle={zoneTitle(mk.at, tz)} viewerZone={viewerZone} />;
  // R5-14: the chat started with its first message (a seeded or imported chat can be older than its row).
  const chatStarted = conv ? new Date(Math.min(conv.createdAt.getTime(), ...thread.map((x) => x.message.createdAt.getTime()))) : new Date();
  // Messages the app wrote (the quote message) are known from the tool call that wrote them.
  const kinds = appMessageKinds(thread.flatMap((x) => x.calls));
  const notice = one(sp.notice) || undefined;
  const convVersion = conv ? versions.find((v) => v.id === conv.agentVersionId) : undefined;
  const error = one(sp.error);
  const locale = conv && isLocale(conv.language) ? conv.language : "en";
  const versionLabel = (v: (typeof versions)[number]) => `${t("lab.version", { version: v.version })} · ${t(`status.agent_version.${v.status}` as MessageKey)}`;
  // The language is named only when the title does not already say it ("Hebrew buyer", not "Hebrew buyer (Hebrew)").
  const scenarioLabel = (s: (typeof scenarios)[number]) => {
    const lang = LANG_NAME[s.language] ?? s.language;
    return s.language === "en" || s.title.toLowerCase().includes(lang.toLowerCase()) ? s.title : `${s.title} (${lang})`;
  };
  const now = new Date();
  // "Call the agent": the same pickers as a new test chat (a call starts in the chosen language), the Ready line per version.
  const callLimit = deploymentCallLimitSec();
  const liveVersion = versions.find((v) => v.status === "live");
  const callVersions = [
    ...(draft ? [] : [{ value: "", label: t("lab.new_draft"), settings: liveVersion?.voiceSettings ?? null, version: (versions[0]?.version ?? 0) + 1, status: "draft" as const }]),
    // "v2 · Draft · 23 Nov": the version's date (published, else last changed) from the row already loaded.
    ...versions.map((v) => ({ value: v.id, label: `${versionLabel(v)} · ${formatDayMonthIn(v.publishedAt ?? v.updatedAt ?? v.createdAt, tz)}`, settings: v.voiceSettings, version: v.version, status: v.status })),
  ];
  const callMax = Object.fromEntries(callVersions.map((v) => [v.value, maxCallSeconds({ settings: v.settings, deadlineSec: callLimit })]));
  // One source for the limit: the same maxCallSeconds the relay reports in `{t:'call', maxSec}` (lib/voice/socket.ts).
  const limitLines = Object.fromEntries(callVersions.map((v) => [v.value, t("voice.settings.limit_line", { limit: callLimitShort(callMax[v.value]) })]));
  // Classic (20 Nov) runs on Gemini only: the versions whose own model it would not use, with that model's label.
  // ElevenLabs ("Voice from") is not used there either (lib/voice-rt-eleven/rule.ts): the note says so.
  const classicModelNotes = Object.fromEntries(callVersions.flatMap((v) => {
    const id = versionModelId(v.settings);
    if (classicModelId(id) === id) return [];
    const eleven = resolveVoiceSettings(v.settings, id).speech === "elevenlabs";
    return [[v.value, eleven ? t("lab.voice.engine_gemini_note_eleven", { model: voiceModelLabel(id) }) : t("lab.voice.engine_gemini_note", { model: voiceModelLabel(id) })]];
  }));
  const engineText = (engine: string | null | undefined) => {
    const e = sessionEngine({ engine });
    return t(engineLabelKey(e), engineLabelVars(e));
  };
  const settingsVersion = draft ?? liveVersion;
  const settingsLine = settingsVersion ? t("voice.settings.summary", { summary: voiceSettingsSummary(resolveVoiceSettings(settingsVersion.voiceSettings, versionModelId(settingsVersion.voiceSettings)), versionModelId(settingsVersion.voiceSettings)) }) : null;
  const keep = conv ? `c=${conv.id}&` : "";
  const settingsHref = draft ? `${lab}?${keep}panel=voice` : null;
  const voicePanel = voice && draft && one(sp.panel) === "voice";
  // The saved call (a voice conversation opened later): its ended bar and "This call" card.
  const savedEnded = voiceSummary?.status === "ended" ? voiceSummary : null;
  const endedView = savedEnded ? barView({
    ...INITIAL_SNAPSHOT, phase: "ended", endReason: savedEnded.endReason, durationSec: savedEnded.durationSec ?? 0, costMicros: savedEnded.costMicros, mode: savedEnded.mode,
  }, now.getTime(), { savedNote: t("voice.ended.saved"), fx }) : null;
  // The open chat's Deal state (R4 D4): directly under the chat on a phone, in the side column on a wide screen.
  const dealCard = (at: "main" | "side") => (conv && convVersion ? (
            <section className={`sas-panel lab-deal lab-deal--${at}`} aria-labelledby={`lab-deal-h-${at}`} data-deal-card={at}>
              <div className="sas-panel__body sas-stack-4">
                <h2 id={`lab-deal-h-${at}`} className="sas-heading">{t("lab.deal_state")}</h2>
                <DealStateFields fields={convVersion.playbook.fields.map((f) => ({ key: f.key, label: f.label, value: deal?.fields[f.key]?.value, provenance: deal?.fields[f.key]?.provenance }))} />
                {deal?.objections.length ? (
                  <div className="sas-stack-2">
                    <span className="sas-group-label">{t("lead.card.objections")}</span>
                    <ObjectionList objections={paneObjections(deal.objections)} />
                  </div>
                ) : null}
                {nextStep ? <div className="sas-stack-2"><span className="sas-group-label">{t("lead.card.next_step")}</span><span>{nextStep}</span></div> : null}
              </div>
            </section>
  ) : null);

  const threadEl = conv && convVersion ? (
    <ChatThread label={t("lab.chat_with", { version: convVersion.version })}>
      {thread.length === 0 ? <p className="sas-small" style={{ margin: 0 }}>{t("lab.chat_empty")}</p> : null}
      {thread.map(({ message: m, calls: allCalls }) => {
        // The app's own messages (after a seller approval) are linked by an app_message row: not a tool call.
        const calls = allCalls.filter((c) => c.name !== APP_MESSAGE_CALL);
        // A message a team action sent (callback time, team answer, declined price) reads "Team" in the human colour (O7, UX).
        const actor = m.actor === "buyer" ? "buyer" : m.actor === "agent" ? (isTeamText(kinds.get(m.id)) ? "human" : "agent") : m.actor === "human" ? "human" : "system";
        const trace: TraceItem[] = [];
        const usage = m.usage as { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null;
        const before = pendingMarkers.filter((mk) => mk.at.getTime() <= m.createdAt.getTime());
        pendingMarkers = pendingMarkers.slice(before.length);
        return (
          <Fragment key={m.id}>
            {before.map((mk, i) => markerNode(mk, `mk-${m.id}-${i}`))}
            {calls.length && showSteps ? (
              <ol className="sas-stack-2" aria-label={t("lab.trace")} style={{ margin: 0, paddingInlineStart: 0, listStyle: "none", alignSelf: "flex-end", maxWidth: "78%", width: "100%" }}>
                {calls.map((c) => {
                  const d = describeCall(c.name, c.input, c.result, c.outcome);
                  return (
                    <li key={c.id} className="sas-stack-2" style={{ background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px" }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <strong className="sas-num sas-small" title={showModel ? d.label : undefined}>{c.sequence}. {toolLabel(c.name)}</strong>
                        {c.outcome === "refused" || c.outcome === "failed" ? <StatusPill object="tool_call" state={c.outcome} /> : null}
                      </div>
                      {d.sent ? <span className="sas-small">{t("lab.trace_sent")}: {d.sent}</span> : null}
                      {d.got ? <span className="sas-small">{t("lab.trace_got")}: {d.got}{d.missing.length ? ` — ${t("lab.trace_missing")}: ${d.missing.join(", ")}` : ""}</span> : null}
                      <details>
                        <summary className="sas-small">{t("lab.show_raw")}</summary>
                        <pre className="sas-code" dir="ltr">{json({ input: c.input, result: c.result })}</pre>
                      </details>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {view?.quoteCards[m.id] ? (
              <QuoteCardMessage card={view.quoteCards[m.id]} time={local(m.createdAt)} slug={null} approve={null} />
            ) : (
            <ChatMessage
              actor={actor} who={actor === "agent" && isAppText(kinds.get(m.id)) ? t("conv.qcard.sent_by_app") : t(`lab.who.${actor}` as MessageKey)}
              // Spoken and typed lines of a call show the time in the call only (the date is in the header); the full time on hover.
              time={m.voiceSessionId && m.spokenAtMs !== null ? undefined : (actor === "agent" || actor === "human") && deliveryLabel(m) ? `${local(m.createdAt)} · ${deliveryLabel(m)}` : local(m.createdAt)} timeTitle={zoneTitle(m.createdAt, tz)} locale={m.language && isLocale(m.language) ? m.language : "en"} trace={trace} textDir={messageTextDir(m, kinds.get(m.id))}
              spoken={m.voiceSessionId && m.spokenAtMs !== null ? {
                at: callClock(m.spokenAtMs / 1000), typed: m.typedInCall,
                label: t(m.typedInCall ? "voice.typed_at" : "voice.spoken_at", { time: callClock(m.spokenAtMs / 1000) }),
                title: `${t(m.typedInCall ? "voice.typed_at" : "voice.spoken_at", { time: callClock(m.spokenAtMs / 1000) })} · ${local(m.createdAt)}`,
              } : undefined}>
              {/* R5-2: each message finds its own direction (an English reply in a Hebrew chat reads left to right). */}
              <div dir={messageTextDir(m, kinds.get(m.id))} data-msg-dir="">
                <MessageBody body={m.body} kind={kinds.get(m.id)} />
              </div>
            </ChatMessage>
            )}
            {isAdmin && usage?.inputTokens !== undefined ? (
              <span className="sas-small sas-num" style={{ alignSelf: "flex-end" }}>{t("lab.tokens", { input: usage.inputTokens, output: usage.outputTokens ?? 0, cached: usage.cacheReadTokens ?? 0 })}</span>
            ) : null}
            {(markersAfter.get(m.id) ?? []).map((mk, i) => markerNode(mk, `mk-after-${m.id}-${i}`))}
          </Fragment>
        );
      })}
      {pendingMarkers.map((mk, i) => markerNode(mk, `mk-end-${i}`))}
      <span id="end" />
    </ChatThread>
  ) : null;
  // A saved call's ended bar; Call again only for whoever may call (the role is checked again in the action).
  const endedBar = endedView && conv ? (
    <div className="lab-vc-bar" data-voice-saved="">
      {voice ? (
        <VoiceCallAgainBar view={endedView} slug={account.slug} lab={lab} versionId={conv.agentVersionId} scenario={conv.scenario} usageHref={usageHref} engine={savedEnded?.engine ?? null} />
      ) : <VoiceCallBar view={{ ...endedView, action: null }} />}
    </div>
  ) : null;

  return (
    <main className="sas-shell__content lab-page" data-lab-mode={mode}>
      <header className="sas-page-head">
        <span className="lab-mark" aria-hidden="true"><Icon name="flask-conical" /></span>
        <h1 className="sas-title">{t("lab.title")}</h1>
        <span className="lab-badge"><Icon name="flask-conical" />{t("lab.badge")}</span>
        <div className="sas-page-head__actions">
          <a className={buttonClass("secondary")} href={`${base}/setup/playbook`}><Icon name="scroll-text" />{t("lab.edit_playbook")}</a>
          {draft ? (
            <form action={publishAction}><input type="hidden" name="slug" value={account.slug} /><Button type="submit" variant="primary">{t("lab.publish", { version: draft.version })}</Button></form>
          ) : null}
        </div>
      </header>
      <nav className="lab-modes" aria-label={t("lab.modes")}>
        <a className="lab-modes__tab" href={`${lab}?mode=chat`} aria-current={mode === "chat" ? "page" : undefined} data-lab-tab="chat"><Icon name="message-circle" />{t("lab.mode.chat")}</a>
        {voice ? <a className="lab-modes__tab" href={`${lab}?mode=voice`} aria-current={mode === "voice" ? "page" : undefined} data-lab-tab="voice"><Icon name="phone-call" />{t("lab.mode.voice")}</a> : null}
        <a className="lab-modes__tab" href={`${lab}?mode=history`} aria-current={mode === "history" ? "page" : undefined} data-lab-tab="history"><Icon name="history" />{t("lab.mode.history")}</a>
      </nav>

      {sp.published ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.published", { version: one(sp.published) })}</span></div> : null}
      {sp.rolledback ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("lab.rolled_back", { version: one(sp.rolledback) })}</span></div> : null}
      {voice && sp.voice_saved ? <div className="sas-alert sas-alert--success" role="status"><Icon name="check-circle" /><span>{t("voice.settings.saved", { version: one(sp.voice_saved) })}</span></div> : null}
      {!llmConfigured() || error === "no_key" ? <div className="sas-alert sas-alert--warning" role="alert"><Icon name="alert-triangle" /><span>{t("lab.no_key")}</span></div> : null}
      {error === "model" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.error")}</span></div> : null}
      {error === "spend_cap" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.spend_cap")}</span></div> : null}
      {error === "rate_limited" ? <div className="sas-alert sas-alert--danger" role="alert"><Icon name="alert-triangle" /><span>{t("lab.rate_limited")}</span></div> : null}
      {error === "in_call" ? <div className="sas-alert sas-alert--warning" role="alert"><Icon name="alert-triangle" /><span>{t("lab.in_call")}</span></div> : null}
      {account.status === "paused" || error === "paused" ? <div className="sas-alert sas-alert--warning" role="status"><Icon name="pause" /><span>{t("lab.paused")}</span></div> : null}

      {mode === "history" ? (
        <section className="sas-panel lab-history" aria-labelledby="lab-hist-h" data-lab-history="">
          <div className="sas-panel__head" style={{ flexWrap: "wrap" }}>
            <h2 id="lab-hist-h" className="sas-heading">{t("lab.history.title")}</h2>
            {voice || hasCalls ? (
              <nav className="lab-filter" aria-label={t("lab.history.filter")}>
                {(["all", "chat", "call"] as const).map((k) => (
                  <a key={k} className="lab-filter__chip" href={`${lab}?mode=history${k === "all" ? "" : `&kind=${k}`}`} aria-current={kind === k ? "true" : undefined} data-history-kind={k}>{t(`lab.history.kind.${k}`)}</a>
                ))}
              </nav>
            ) : null}
          </div>
          {history.length === 0 ? (
            <div className="lab-empty"><HistoryArt /><strong>{t("lab.history.empty")}</strong></div>
          ) : (
            <ul className="sas-list">
              {history.map((c) => {
                const v = versions.find((x) => x.id === c.agentVersionId);
                const k = c.channel === "voice" ? "call" : c.channel === "whatsapp" ? "whatsapp" : "chat";
                return (
                  <li key={c.id}>
                    <a className="sas-list__row lab-history__row" href={`${lab}?c=${c.id}`} data-history-row={k}>
                      <span className={`lab-kind lab-kind--${k}`}><Icon name={k === "call" ? "phone-call" : k === "whatsapp" ? "message-square" : "message-circle"} label={t(`lab.history.type.${k}`)} /></span>
                      <span className="sas-list__main">
                        <strong data-chat-name="">{scenarioById(c.scenario)?.title ?? t("lab.free_chat")}</strong>
                        <span className="sas-small">{t(`lab.history.type.${k}`)} · {t("lab.version", { version: v?.version ?? "?" })} · {LANG_NAME[c.language] ?? c.language}</span>
                      </span>
                      {voiceModes.get(c.id) === "scripted" ? <span className="sas-pill" data-scripted-pill=""><Icon name="flask-conical" />{t("voice.pill.scripted")}</span> : null}
                      <time className="sas-small lab-history__when" dateTime={c.updatedAt.toISOString()} title={`${local(c.updatedAt)} · ${zoneTitle(c.updatedAt, tz)}`}>{timeAgo(c.updatedAt, now, tz)}</time>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : (
      <div className="sas-split lab-split">
        <div className="sas-split__main">
          {voice ? (
            <>
              <VoiceLabKeeper />
              <VoiceLabBackGuard />
            </>
          ) : null}
          {mode === "voice" ? (
            <>
              <VoiceLabChoices callOnly
                slug={account.slug} lab={lab} usageHref={usageHref} settingsLine={settingsLine} settingsHref={settingsHref}
                scenarios={scenarios.map((x) => ({ value: x.id, label: scenarioLabel(x), language: x.language }))}
                languages={account.languages.map((l) => ({ value: l, label: LANG_NAME[l] ?? l }))} defaultLanguage={account.languages[0]}
                versions={callVersions.map((v) => ({ value: v.value, label: v.label }))} defaultVersionId={draft?.id ?? ""}
                callMax={callMax} limitLines={limitLines}
                // The engine select: platform admins only (this whole block is: voiceLabAccess above).
                engines={voice} classicModelNotes={classicModelNotes}
              />
            </>
          ) : (
            <section className="sas-panel" aria-labelledby="lab-new-h">
              <form action={startChatAction} className="sas-panel__body" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }} data-new-chat="">
                <h2 id="lab-new-h" className="sas-heading" style={{ flex: "0 0 auto", alignSelf: "center", marginInlineEnd: 4 }}>{t("lab.new_chat")}</h2>
                <input type="hidden" name="slug" value={account.slug} />
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="lab-scenario">{t("lab.scenario")}</label>
                  <select className="sas-select" id="lab-scenario" name="scenario" defaultValue="">
                    <option value="">{t("lab.scenario_none")}</option>
                    {scenarios.map((s) => <option key={s.id} value={s.id}>{scenarioLabel(s)}</option>)}
                  </select>
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="lab-lang">{t("lab.language")}</label>
                  <select className="sas-select" id="lab-lang" name="language" defaultValue={account.languages[0]}>
                    {account.languages.map((l) => <option key={l} value={l}>{LANG_NAME[l] ?? l}</option>)}
                  </select>
                </div>
                <div className="sas-input-group">
                  <label className="sas-input-label" htmlFor="lab-ver">{t("lab.version_label")}</label>
                  <select className="sas-select" id="lab-ver" name="versionId" defaultValue={draft?.id ?? ""}>
                    {draft ? null : <option value="">{t("lab.new_draft")}</option>}
                    {versions.map((v) => <option key={v.id} value={v.id}>{versionLabel(v)}</option>)}
                  </select>
                </div>
                <Button type="submit" variant="primary"><Icon name="plus" />{t("lab.start")}</Button>
              </form>
            </section>
          )}

          {conv && convVersion && showConv ? (
            <section className={onVoice ? "sas-panel lab-conv" : "sas-panel lab-conv lab-chat"} aria-labelledby="lab-chat-h" style={{ overflow: onVoice ? "clip" : "hidden" }}>
              <div className="sas-panel__body" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <h2 id="lab-chat-h" className="sas-heading">{t("lab.chat_with", { version: convVersion.version })}</h2>
                <StatusPill object="agent_version" state={convVersion.status} />
                {onVoice ? <span className="sas-pill" data-voice-pill=""><Icon name="phone-call" />{t("voice.pill.call")}</span> : null}
                {onVoice && voiceSummary?.mode === "scripted" ? <span className="sas-pill" data-scripted-pill=""><Icon name="flask-conical" />{t("voice.pill.scripted")}</span> : null}
                {/* The model this call ran on (its session row): calls on different models of one draft stay apart. */}
                {onVoice && voiceSummary && voiceModelLabel(voiceSummary.model) !== voiceSummary.model ? <span className="sas-pill" data-voice-model-pill="">{voiceModelLabel(voiceSummary.model)}</span> : null}
                {/* The voice engine of a Classic (20 Nov) or Classic + guards call: compared side by side with Current calls. */}
                {voice && onVoice && voiceSummary && voiceSummary.engine !== "current" ? <span className="sas-pill" data-voice-engine-pill="">{t("voice.pill.engine", { engine: engineText(voiceSummary.engine) })}</span> : null}
                {/* R5-14: when the chat started (its first message), not when the conversation row was made. */}
                <span className="sas-small">{LANG_NAME[conv.language] ?? conv.language} · <time dateTime={chatStarted.toISOString()} title={zoneTitle(chatStarted, tz)} data-chat-started="">{local(chatStarted)}</time></span>
                {onWhatsapp ? <span className="sas-chip"><Icon name="message-circle" />{t("lab.wa.chip", { phone: conv.channelAddress ?? "" })}</span> : null}
                {waWindow ? <WindowTimer {...windowTimerProps(waWindow, new Date())} /> : null}
                <span className="sas-steps-switch__slot"><AgentStepsSwitch slug={account.slug} scope="lab" show={showSteps} back={stepsBack} /></span>
              </div>
              {onVoice && voice ? (
                <VoiceLabLive conversationId={conv.id} slug={account.slug} lab={lab} usageHref={usageHref}>
                  {endedBar}
                  {threadEl}
                </VoiceLabLive>
              ) : (
                <>
                  {onVoice ? endedBar : null}
                  {threadEl}
                </>
              )}
              {scenario && scenarioCheck && !onVoice ? (
                <div className="sas-stack-2" role="status" aria-label={t("lab.scenario_check", { title: scenario.title })} style={{ padding: 16, borderBlockStart: "1px solid var(--line)" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong className="sas-small">{t("lab.scenario_check", { title: scenario.title })}</strong>
                    <ResultChip result={scenarioCheck.result} />
                  </div>
                  <span className="sas-small">{scenarioCheck.reason} {t("lab.scenario_expected", { text: scenario.expected })}</span>
                </div>
              ) : null}
              {conv.status === "closed" ? (
                <div className="sas-alert" role="status" style={{ margin: 16 }}><Icon name="pause" /><span>{t("lab.closed")}</span></div>
              ) : (
                <>
                  {onVoice ? null : onWhatsapp ? (
                    <p className="sas-small" role="status" style={{ margin: 0, padding: 16, borderBlockStart: "1px solid var(--line)", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      <Icon name="message-circle" />{t("lab.wa.reply_from_phone", { phone: conv.channelAddress ?? "" })}
                      <a href={`${lab}?c=${conv.id}#end`}>{t("lab.wa.refresh")}</a>
                    </p>
                  ) : (
                    <Composer
                      slug={account.slug} conversationId={conv.id} dir={dir(locale)}
                      // A multi-turn scenario fills in its next buyer message after each reply (remounted so the new text shows).
                      key={scenario ? `scn:${nextBuyerText(scenario, thread.map((x) => x.message)) ?? ""}` : "free"}
                      initialText={scenario ? nextBuyerText(scenario, thread.map((x) => x.message)) : undefined}
                    />
                  )}
                  {/* A finished call has Call again instead: no take-over footer. */}
                  {view && !(onVoice && savedEnded) ? (
                    <ConversationControls
                      slug={account.slug} from="lab" view={view} me={user} buyerName={t("lab.who.buyer")}
                      leadOptedOut={convLead?.lead.status === "opted_out"} notice={notice}
                    />
                  ) : null}
                </>
              )}
            </section>
          ) : null}
          {!(conv && convVersion && showConv) ? (
            <div className="lab-empty" data-lab-empty={mode}>
              {mode === "voice" ? <CallArt /> : <ChatArt />}
              <strong>{t(mode === "voice" ? "lab.empty.call" : "lab.empty.chat")}</strong>
            </div>
          ) : null}
          {showConv ? dealCard("main") : null}

        </div>

        <aside className="sas-split__side sas-stack-4">
          {onVoice && conv && showConv && scenario && scenarioCheck ? (
            <section className="sas-panel sas-panel__body sas-stack-2" aria-labelledby="lab-vsc-h" data-voice-scenario="">
              <h2 id="lab-vsc-h" className="sas-heading">{t("lab.scenario_check", { title: scenario.title })}</h2>
              {/* A scripted call is never a scenario result for the version: say so instead of a result. */}
              {voiceSummary?.mode === "scripted" ? (
                <>
                  <span><span className="sas-pill" data-scenario-result="scripted"><Icon name="flask-conical" />{t("voice.scenario.scripted")}</span></span>
                  <span className="sas-small">{t("lab.scenario_expected", { text: scenario.expected })}</span>
                </>
              ) : (
                <>
                  <span><ResultChip result={scenarioCheck.result} /></span>
                  <span className="sas-small">{scenarioCheck.reason} {t("lab.scenario_expected", { text: scenario.expected })}</span>
                </>
              )}
            </section>
          ) : null}
          {onVoice && conv && showConv ? (() => {
            const saved = savedEnded ? (
              <VoiceCallStats
                durationSec={savedEnded.durationSec ?? 0} maxSec={savedEnded.maxSec} costMicros={savedEnded.costMicros} scripted={savedEnded.mode === "scripted"} fx={fx}
                answerMsAvg={savedEnded.answerMsAvg} live={false} costEstimated={savedEnded.costEstimated} endReason={savedEnded.endReason} errorCode={savedEnded.errorCode}
                technical={isAdmin ? endDetailText(savedEnded.endDetail) : null} model={voiceModelLabel(savedEnded.model) || null} engine={voice ? engineText(savedEnded.engine) : null} voiceUsed={savedEnded.voiceUsed} toolsOff={savedEnded.toolsOff} pipeline={voice ? savedEnded.pipeline : null} rtEleven={voice ? savedEnded.rtEleven : null}
                standby={savedEnded.standbySec !== null && savedEnded.activeSec !== null ? { activeSec: savedEnded.activeSec, standbySec: savedEnded.standbySec } : null}
              />
            ) : null;
            return voice ? <VoiceLabStats conversationId={conv.id}>{saved}</VoiceLabStats> : saved;
          })() : null}
          {showConv ? dealCard("side") : null}

          <section className="sas-panel" aria-labelledby="lab-ver-h">
            <div className="sas-panel__body sas-stack-4">
              <h2 id="lab-ver-h" className="sas-heading">{t("lab.versions")}</h2>
              {versions.length === 0 ? <span className="sas-small">{t("lab.no_draft")}</span> : null}
              <ul className="sas-stack-4" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {versions.map((v) => {
                  // Compare (board VersionCompareEntry): the draft against live, an earlier version against live (older on the left).
                  const compareHref = liveVersion && v.id !== liveVersion.id
                    ? `${lab}/compare?${v.status === "draft" ? `a=${liveVersion.id}&b=${v.id}` : `a=${v.id}&b=${liveVersion.id}`}`
                    : null;
                  const changes = v.status === "draft" && liveVersion ? countChanges(liveVersion, v, showModel) : null;
                  return (
                  <li key={v.id} className="sas-stack-2" data-version-row={v.status}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <strong className="sas-id">{t("lab.version", { version: v.version })}</strong>
                      {/* The live version's pill is blue here (board VersionCompareEntry): the same word and icon, the info tone. */}
                      {v.status === "live" ? (
                        <span className="sas-pill sas-pill--info" data-status="agent_version.live"><Icon name={statusDef("agent_version", "live").icon} />{t("status.agent_version.live")}</span>
                      ) : <StatusPill object="agent_version" state={v.status} />}
                    </div>
                    <span className="sas-small">{showModel ? <span data-version-model="">{t("lab.version_model", { model: v.model, effort: v.effort })}</span> : null}{showModel && v.publishedAt ? " · " : null}{v.publishedAt ? <><time dateTime={v.publishedAt.toISOString()} title={zoneTitle(v.publishedAt, tz)}>{t("lab.published_at", { date: local(v.publishedAt) })}</time></> : null}{changes !== null ? <span data-changes-from-live="">{showModel || v.publishedAt ? " · " : null}{changes === 0 ? t("compare.same_as_live") : changes === 1 ? t("compare.changes_from_live_one") : t("compare.changes_from_live", { n: changes })}</span> : null}</span>
                    {compareHref || v.status === "retired" ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {compareHref ? (
                          <a className={buttonClass(v.status === "draft" ? "secondary" : "ghost", "sm")} href={compareHref} aria-label={t("compare.with_live_label", { version: v.version })} data-compare-with-live="">{t("compare.with_live")}</a>
                        ) : null}
                        {v.status === "retired" ? (
                          <form action={rollbackAction}>
                            <input type="hidden" name="slug" value={account.slug} />
                            <input type="hidden" name="versionId" value={v.id} />
                            <Button type="submit" variant="ghost" size="sm">{t("lab.rollback")}</Button>
                          </form>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            </div>
          </section>

          <section className="sas-panel" aria-labelledby="lab-chats-h">
            <div className="sas-panel__body sas-stack-2">
              <h2 id="lab-chats-h" className="sas-heading">{t(mode === "voice" ? "lab.calls" : "lab.chats")}</h2>
              {recent.length === 0 ? <span className="sas-small">{t(mode === "voice" ? "lab.calls_empty" : "lab.chats_empty")}</span> : null}
              <ul className="sas-stack-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {recent.map((c) => {
                  const v = versions.find((x) => x.id === c.agentVersionId);
                  return (
                    <li key={c.id}>
                      {c.channel === "voice" ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <a href={`${lab}?c=${c.id}`} aria-current={c.id === conv?.id ? "page" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: c.id === conv?.id ? 600 : undefined }} data-chat-name="">
                            <Icon name="phone-call" label={t("voice.pill.call")} />
                            {scenarioById(c.scenario)?.title ?? t("lab.free_chat")}
                          </a>
                          {voiceModes.get(c.id) === "scripted" ? <span className="sas-pill" data-scripted-pill=""><Icon name="flask-conical" />{t("voice.pill.scripted")}</span> : null}
                        </div>
                      ) : (
                        <a href={`${lab}?c=${c.id}`} aria-current={c.id === conv?.id ? "page" : undefined} style={{ display: "block", fontWeight: c.id === conv?.id ? 600 : undefined }} data-chat-name="">
                          {scenarioById(c.scenario)?.title ?? t("lab.free_chat")}
                        </a>
                      )}
                      <span className="sas-small" style={{ display: "block" }}>
                        {t("lab.version", { version: v?.version ?? "?" })} · {LANG_NAME[c.language] ?? c.language}{c.channel === "whatsapp" ? ` · ${t("conv.channel.whatsapp")}` : ""} ·{" "}
                        <time dateTime={c.updatedAt.toISOString()} title={`${local(c.updatedAt)} · ${zoneTitle(c.updatedAt, tz)}`}>{timeAgo(c.updatedAt, now, tz)}</time>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {chats.length > 0 ? <a className="lab-recent__all" href={`${lab}?mode=history${voice ? `&kind=${mode === "voice" ? "call" : "chat"}` : ""}`} data-lab-all-history="">{t("lab.history.all")}<Icon name="arrow-right" /></a> : null}
            </div>
          </section>
          {mode === "chat" ? (
          <details className="sas-panel lab-wa" data-lab-wa="">
            <summary className="sas-panel__body lab-wa__summary"><span id="lab-wa-h" className="sas-heading">{t("lab.wa.title")}</span></summary>
            <div className="sas-panel__body sas-stack-2" style={{ paddingBlockStart: 0 }}>
            {testerNumbers.length === 0 ? (
              <span className="sas-small">{t("lab.wa.none")} <a href={`${base}/settings?section=whatsapp`}>{t("lab.wa.setup")}</a></span>
            ) : (
              <>
                <span className="sas-small">{t(twilioConfig() ? "lab.wa.how" : "lab.wa.not_configured")}</span>
                <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                  {testerNumbers.map((c) => (
                    <li key={c.id} className="sas-small">
                      {t("lab.wa.pair", { testers: c.testerNumbers.join(", "), number: c.senderNumber })}
                    </li>
                  ))}
                </ul>
              </>
            )}
            </div>
          </details>
          ) : null}
        </aside>
      </div>
      )}
      {voicePanel && draft ? (
        <SidePanel
          id="lab-voice-settings" title={t("voice.settings.title")} meta={t("voice.settings.meta", { version: draft.version })}
          closeHref={conv ? `${lab}?c=${conv.id}` : lab}
        >
          <VoiceSettingsForm
            action={saveVoiceSettingsAction} slug={account.slug} models={voiceModelChoices()} platformModel={voiceModelId()} initial={resolveVoiceSettings(draft.voiceSettings, versionModelId(draft.voiceSettings))}
            elevenForBuyers={ELEVEN_FOR_BUYER_CALLS} languages={account.languages}
            version={draft.version} closeHref={conv ? `${lab}?c=${conv.id}` : lab} deploymentLimitSec={callLimit}
          />
        </SidePanel>
      ) : null}
    </main>
  );
}
