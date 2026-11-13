/**
 * Go-live checklist (Setup › Go live, canvas: GoLive; implementation plan P8.7).
 *
 * `goLiveChecks` is pure: the loader gathers real data, the page and the
 * go-live action both call the same function, so the server decides.
 */
import { and, count, eq } from "drizzle-orm";
import type { Db } from "@/db/types";
import { conversations, knowledgeFacts, sellerAccounts, type RolloutMode, type SellerAccount } from "@/db/schema";
import { publishedCatalog } from "@/lib/catalog/service";
import { liveVersion } from "@/lib/agent/service";
import { currentLegal, getOrderFormSettings } from "@/lib/orders/settings";
import { writeAudit, type Actor } from "./audit";

export type GoLiveInput = {
  company: { legalName: string | null; companyId: string | null; supportContact: string | null };
  catalog: { version: number; activeItems: number } | null;
  liveAgentVersion: number | null;
  approvedFacts: number;
  /** Selling languages of the account. */
  languages: string[];
  /** Languages that have at least one active legal section. */
  legalLanguages: string[];
  payments: { card: boolean; bankTransfer: boolean; bankDetails: string | null };
  testConversations: number;
};

export type GoLiveCheckId = "company" | "catalog" | "agent" | "knowledge" | "legal" | "payments" | "test_lab" | "whatsapp";

export type GoLiveCheck = {
  id: GoLiveCheckId;
  /** "later" = arrives with a later phase; shown neutral and never blocks. */
  state: "pass" | "fail" | "later";
  blocking: boolean;
  /** Setup page that fixes it, relative to /app/<slug>. */
  fixPath: string | null;
  /** Facts for the detail line. */
  data: Record<string, string | number>;
};

export type GoLiveResult = { checks: GoLiveCheck[]; passed: number; total: number; ready: boolean };

const blank = (s: string | null | undefined) => !s || !s.trim();

export function goLiveChecks(input: GoLiveInput): GoLiveResult {
  const missingCompany = [
    blank(input.company.legalName) ? "legal name" : null,
    blank(input.company.companyId) ? "company ID" : null,
    blank(input.company.supportContact) ? "support contact" : null,
  ].filter((x): x is string => x !== null);
  const missingLegal = input.languages.filter((l) => !input.legalLanguages.includes(l));
  const p = input.payments;
  const bankUsable = p.bankTransfer && !blank(p.bankDetails);
  const check = (id: GoLiveCheckId, ok: boolean, fixPath: string, data: Record<string, string | number> = {}): GoLiveCheck => ({
    id, state: ok ? "pass" : "fail", blocking: true, fixPath, data,
  });

  const checks: GoLiveCheck[] = [
    check("company", missingCompany.length === 0, "/setup/company", { missing: missingCompany.join(", ") }),
    check("catalog", !!input.catalog && input.catalog.activeItems > 0, "/setup/catalog", { version: input.catalog?.version ?? 0, products: input.catalog?.activeItems ?? 0 }),
    check("agent", input.liveAgentVersion !== null, "/setup/playbook", { version: input.liveAgentVersion ?? 0 }),
    check("knowledge", input.approvedFacts > 0, "/setup/knowledge", { count: input.approvedFacts }),
    check("legal", input.languages.length > 0 && missingLegal.length === 0, "/setup/order-form", { missing: missingLegal.map((l) => l.toUpperCase()).join(", ") }),
    check("payments", p.card || bankUsable, "/setup/order-form", {
      methods: [p.card ? "card" : null, bankUsable ? "bank" : null].filter(Boolean).join("+"),
      bankWithoutDetails: p.bankTransfer && !bankUsable ? 1 : 0,
    }),
    check("test_lab", input.testConversations > 0, "/setup/test-lab", { count: input.testConversations }),
    { id: "whatsapp", state: "later", blocking: false, fixPath: null, data: {} },
  ];
  const blocking = checks.filter((c) => c.blocking);
  const passed = blocking.filter((c) => c.state === "pass").length;
  return { checks, passed, total: blocking.length, ready: passed === blocking.length };
}

/** Gathers the checklist input from real data for one account. */
export async function loadGoLiveInput(db: Db, account: SellerAccount): Promise<GoLiveInput> {
  const [catalog, live, [{ facts }], legal, settings, [{ tests }]] = await Promise.all([
    publishedCatalog(db, account.id),
    liveVersion(db, account.id),
    db.select({ facts: count() }).from(knowledgeFacts).where(and(eq(knowledgeFacts.accountId, account.id), eq(knowledgeFacts.status, "approved"))),
    currentLegal(db, account.id),
    getOrderFormSettings(db, account.id),
    db.select({ tests: count() }).from(conversations).where(and(eq(conversations.accountId, account.id), eq(conversations.isTest, true))),
  ]);
  return {
    company: { legalName: account.legalName, companyId: account.companyId, supportContact: account.supportContact },
    catalog: catalog ? { version: catalog.version.version, activeItems: catalog.items.filter((i) => i.active).length } : null,
    liveAgentVersion: live?.version ?? null,
    approvedFacts: Number(facts),
    languages: account.languages,
    legalLanguages: [...new Set(legal.map((s) => s.language))],
    payments: { card: settings.card, bankTransfer: settings.bankTransfer, bankDetails: settings.bankDetails },
    testConversations: Number(tests),
  };
}

export async function loadGoLive(db: Db, account: SellerAccount) {
  return goLiveChecks(await loadGoLiveInput(db, account));
}

export type GoLiveOutcome =
  | { ok: true; account: SellerAccount }
  | { ok: false; reason: "not_found" | "not_setting_up" | "not_ready"; failing?: GoLiveCheckId[] };

/** Setting up → Live. Re-checks every blocking item on the server; audited. */
export async function goLive(db: Db, actor: Actor, accountId: string, now = new Date()): Promise<GoLiveOutcome> {
  const [account] = await db.select().from(sellerAccounts).where(eq(sellerAccounts.id, accountId));
  if (!account) return { ok: false, reason: "not_found" };
  if (account.status !== "setting_up") return { ok: false, reason: "not_setting_up" };
  const result = await loadGoLive(db, account);
  if (!result.ready) {
    return { ok: false, reason: "not_ready", failing: result.checks.filter((c) => c.blocking && c.state !== "pass").map((c) => c.id) };
  }
  const [row] = await db
    .update(sellerAccounts)
    .set({ status: "live", wentLiveAt: now })
    .where(and(eq(sellerAccounts.id, accountId), eq(sellerAccounts.status, "setting_up")))
    .returning();
  if (!row) return { ok: false, reason: "not_setting_up" };
  await writeAudit(db, actor, { accountId, action: "account.went_live", targetType: "account", targetId: accountId, details: { rollout: row.rollout } });
  return { ok: true, account: row };
}

export const ROLLOUT_MODES: readonly RolloutMode[] = ["test_only", "half", "all"];

export async function saveRollout(db: Db, actor: Actor, accountId: string, mode: string) {
  if (!(ROLLOUT_MODES as readonly string[]).includes(mode)) return false;
  const [row] = await db.update(sellerAccounts).set({ rollout: mode as RolloutMode }).where(eq(sellerAccounts.id, accountId)).returning({ id: sellerAccounts.id });
  if (!row) return false;
  await writeAudit(db, actor, { accountId, action: "account.rollout_saved", targetType: "account", targetId: accountId, details: { rollout: mode } });
  return true;
}
