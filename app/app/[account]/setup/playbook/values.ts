/** Starting values of the part editors: what was submitted after a refused save, else the stored playbook. Pure. */
import type { Playbook } from "@/db/schema";
import { readOpener } from "@/lib/agent/core/opener";
import { questionBudgetOf } from "@/lib/agent/core/stage";
import { objectionAttemptsOf } from "@/lib/agent/core/objections";
import type { PlaybookFormState } from "./actions";
import type { OpeningValues } from "./opening";

/** The scalar inputs' values: after a refused save, what was submitted, not the saved playbook. */
export function playbookFormValues(p: Playbook, state: PlaybookFormState) {
  const sent = state.status === "error" ? state.values : null;
  return {
    goal: sent?.goal ?? p.goal, agentName: sent?.agentName ?? p.agentName,
    /** The seller's own name versions as sent after a refused save (undefined: the stored ones). */
    agentNameLocal: sent ? sent.agentNameLocal : undefined,
    agentGender: sent?.agentGender ?? p.agentGender ?? "neutral",
    questionBudget: sent?.questionBudget !== undefined && Number.isInteger(Number(sent.questionBudget)) ? questionBudgetOf({ questionBudget: Number(sent.questionBudget) }) : questionBudgetOf(p),
    /** Attempts per objection (O1 part 3), within 1..3. */
    objectionAttempts: sent?.objectionAttempts !== undefined && Number.isInteger(Number(sent.objectionAttempts)) ? objectionAttemptsOf({ objectionAttempts: Number(sent.objectionAttempts) }) : objectionAttemptsOf(p),
    tone: sent?.tone ?? p.tone, outcomes: sent?.outcomes ?? p.outcomes,
    maxDiscount: sent?.maxDiscount ?? String(p.maxDiscountBp / 100), offerMeetingWhen: sent?.offerMeetingWhen ?? p.offerMeetingWhen, handOffWhen: sent?.handOffWhen ?? p.handOffWhen,
    /** Who takes calls (O6): as typed; empty shows the default as the placeholder. */
    callRole: sent?.callRole ?? p.callRole ?? "",
  };
}

/** The Opening part's starting values: what was submitted after a refused save, else the stored opener (either shape). */
export function openingValues(p: Playbook, state: PlaybookFormState): OpeningValues {
  const sent = state.status === "error" ? state.values.opener : undefined;
  if (sent) return { topics: sent.topics.map((x) => ({ en: x.en, he: x.he })), defaultTopic: Number(sent.defaultTopic) || 0, question: { ...sent.question } };
  const o = readOpener(p.opener);
  return {
    topics: o.topics.map((x) => ({ en: x.en, he: x.he ?? "" })),
    defaultTopic: o.defaultTopic,
    question: { en: o.question?.en ?? "", he: o.question?.he ?? "" },
  };
}
