/**
 * The stored playbook keys one row change of the Playbook (savePlaybookChange)
 * may write. Written out here from the editor's rows, not from the code under
 * test, so the tests check the save against an independent list.
 */
import type { PlaybookChange } from "@/lib/agent/playbook-save";

const SCALAR_TO_KEY: Record<string, string> = {
  agentName: "agentName", agentGender: "agentGender", tone: "tone", goal: "goal", maxDiscount: "maxDiscountBp",
  offerMeetingWhen: "offerMeetingWhen", handOffWhen: "handOffWhen", callRole: "callRole", questionBudget: "questionBudget", objectionAttempts: "objectionAttempts",
};

export function changedKeys(change: PlaybookChange): string[] {
  switch (change.kind) {
    case "set":
      // S2: the first question (Opening) is a `set` of the opener's question.
      return [...Object.keys(change.values).map((k) => SCALAR_TO_KEY[k]), ...(change.outcomes ? ["outcomes"] : []), ...(change.openerQuestion ? ["opener"] : [])];
    case "add": case "edit": case "delete": case "move":
      return [change.list === "openerTopics" ? "opener" : change.list];
    case "setDefault":
      return ["opener"];
    case "removeException":
      return ["exceptions"];
    case "part":
      return {
        name: ["agentName", "agentNameLocal"], opening: ["opener"], asks: ["fields", "questionBudget"],
        objections: ["objections", "objectionAttempts"], after: ["unpaidReminders"],
      }[change.part];
  }
}
