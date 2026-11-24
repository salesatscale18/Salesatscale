import type { ThreadMarker } from "@/lib/agent/thread-markers";
import type { ReactNode } from "react";
import { CallBlock, type CallBlockCard, type CallBlockLine, type CallBlockStrings } from "@/components/sas/voice/call-block";
import { callLength } from "@/lib/voice/client/buyer-ui";
import { voiceModelLabel } from "@/lib/voice/settings";
import { formatClockIn, formatDayIn } from "@/lib/format";
import { t } from "@/lib/i18n";
import { deleteRecordingAction } from "../../calls/actions";

type CallMarker = Extract<ThreadMarker, { kind: "voice_ended" }> & { call: NonNullable<Extract<ThreadMarker, { kind: "voice_ended" }>["call"]> };

/** A call's line as the block shows it: the stored message (spoken or typed in the call). */
export type CallLineSource = { id: string; actor: string; body: string; spokenAtMs: number | null; typedInCall: boolean | null; steps?: ReactNode; seq?: number };
/** Something posted in the chat during the call (a card), rendered as the thread renders it, with its time. */
export type CallCardSource = { id: string; at: Date; node: ReactNode; seq?: number };

/** A voice_ended marker that is shown as a call block (calls since recordings exist). */
export const isCallBlock = (mk: ThreadMarker): mk is CallMarker => mk.kind === "voice_ended" && !!mk.call;

function strings(): CallBlockStrings {
  return {
    hideLines: t("conv.call.hide_lines"), showLines: t("conv.call.show_lines"), play: t("conv.call.play"), pause: t("conv.call.pause"),
    position: t("conv.call.position"), speed: t("conv.call.speed"), download: t("conv.call.download"), more: t("conv.call.more"),
    copyTranscript: t("conv.call.copy"), copied: t("conv.call.copied"), deleteRecording: t("conv.call.delete"),
    deleteConfirm: t("conv.call.delete_confirm"), deleteYes: t("conv.call.delete_yes"), cancel: t("conv.call.cancel"),
    playFrom: t("conv.call.play_from"), typed: t("conv.call.typed"), recorded: t("conv.call.recorded"),
    valueText: t("conv.call.value_text"), minute: t("conv.call.minute"), minutes: t("conv.call.minutes"), second: t("conv.call.second"), seconds: t("conv.call.seconds"),
  };
}

/**
 * The call block at a call's summary row (board RecThread), seller side only: the header, the player when the
 * audio is kept (the account-checked route under /app/<slug>/calls), and the call's lines with their times in
 * the call. `linesInBlock` false: the lines stay in the thread (the test lab, where each carries its steps).
 */
export function CallBlockEntry({ marker, lines, cards = [], slug, back, buyer, zone, linesInBlock = true, canDelete = false, pipeline = false }: {
  marker: CallMarker; lines: CallLineSource[]; cards?: CallCardSource[]; slug: string; back: string; buyer: string; zone: string | null; linesInBlock?: boolean;
  /** Account admins (lib/voice/recording-playback.ts mayDeleteRecordings): "Delete recording…" in the ⋯ menu. */
  canDelete?: boolean;
  /** A test-lab call on a pipeline engine (lib/voice-pipeline): never recorded by design, said so ("Not recorded (pipeline test)"). */
  pipeline?: boolean;
}) {
  const c = marker.call;
  const range = `${formatDayIn(c.connectedAt, zone)} ${formatClockIn(c.connectedAt, zone)}–${formatClockIn(marker.at, zone)}`;
  const meta = [range, c.model && c.model !== "scripted" ? voiceModelLabel(c.model) : null].filter(Boolean).join(" · ");
  const stateText = c.state === "saved" ? t("conv.call.recorded") : c.state === "deleted"
    ? (c.keepDays ? t("conv.call.deleted_kept", { days: c.keepDays }) : t("conv.call.deleted"))
    : pipeline ? t("conv.call.not_recorded_pipeline") : t("conv.call.not_recorded");
  const blockLines: CallBlockLine[] = lines
    .filter((l) => l.spokenAtMs !== null && (l.actor === "agent" || l.actor === "buyer"))
    .map((l) => ({ id: l.id, atMs: l.spokenAtMs ?? 0, actor: l.actor as "agent" | "buyer", who: l.actor === "agent" ? t("conv.who.agent") : buyer, text: l.body, typed: !!l.typedInCall, steps: l.steps, seq: l.seq }));
  const blockCards: CallBlockCard[] = cards.map((x) => ({ id: x.id, atMs: Math.max(0, x.at.getTime() - c.connectedAt.getTime()), node: x.node, seq: x.seq }));
  const base = `/app/${slug}/calls/${c.sessionId}/recording`;
  return (
    <CallBlock
      title={t("conv.call.title", { length: callLength(marker.durationSec, t) })}
      state={c.state} stateText={stateText} meta={meta}
      note={c.state === "deleted" ? t("conv.call.deleted_note") : c.state === "not_recorded" && !pipeline ? t("conv.call.not_recorded_note") : undefined}
      lines={blockLines} cards={blockCards} linesInBlock={linesInBlock} durationSec={c.recordingSec ?? c.durationSec}
      audioSrc={c.state === "saved" ? base : undefined} downloadHref={c.state === "saved" ? `${base}?download=1` : undefined}
      deleteForm={c.state === "saved" && canDelete ? { action: deleteRecordingAction, slug, sessionId: c.sessionId, back } : undefined}
      strings={strings()}
    />
  );
}
