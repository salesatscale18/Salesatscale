/**
 * Lead intake webhook (implementation plan P2.5).
 *
 * POST /api/leads/<account-slug> with `Authorization: Bearer <intake key>`.
 * Not behind Clerk: the per-account key is the authentication. A key only
 * works for its own account; anything else gets the same 401.
 * Field reference: docs/lead-intake.md.
 */
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { sellerAccounts } from "@/db/schema";
import { appDb } from "@/lib/auth/account";
import { bearerKey, consentSourceIntake, parseJsonObject, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";
import { recordDelivery, refusalText, resolveIntakeKey, upsertLead } from "@/lib/leads/service";
import type { Locale } from "@/lib/i18n";
import { clientIp, declaredTooLarge, rateLimit } from "@/lib/security/rate-limit";

export const dynamic = "force-dynamic";

const MAX_BODY = 32 * 1024;
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });
const tooMany = (retryAfterSeconds: number) =>
  NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } });

export async function POST(req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  // Checked before the key, so guessing keys is throttled too.
  const ip = clientIp(req.headers);
  const perIp = await rateLimit(appDb, `intake:ip:${ip}`, { limit: 120, windowSeconds: 60 });
  if (!perIp.ok) return tooMany(perIp.retryAfterSeconds);
  const perAccount = await rateLimit(appDb, `intake:acct:${slug.slice(0, 100)}:${ip}`, { limit: 60, windowSeconds: 60 });
  if (!perAccount.ok) return tooMany(perAccount.retryAfterSeconds);

  const key = bearerKey(req.headers.get("authorization"), req.headers.get("x-api-key"));
  if (!key) return unauthorized();
  const keyRow = await resolveIntakeKey(appDb, key);
  if (!keyRow) return unauthorized();
  const [account] = await appDb.select().from(sellerAccounts).where(eq(sellerAccounts.slug, slug));
  if (!account || account.id !== keyRow.accountId) return unauthorized();

  const log = (result: "created" | "updated" | "rejected", reason: string | null, leadName: unknown, leadId?: string) =>
    recordDelivery(appDb, { accountId: account.id, keyId: keyRow.id, result, reason, leadId, leadName: typeof leadName === "string" ? leadName : null });

  if (declaredTooLarge(req.headers, MAX_BODY)) {
    await log("rejected", "Body over 32 KB", null);
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) {
    await log("rejected", "Body over 32 KB", null);
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const body = parseJsonObject(text);
  if (!body) {
    await log("rejected", "Body is not a JSON object", null);
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = body.full_name ?? body.name;
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const lead = parseLead(rawFromIntakeBody(body, forwardedFor), account.market, {
    language: (account.languages[0] ?? "en") as Locale,
    now: new Date(),
    // Leads from the form asked to be called back: consent unless consent.given is false. A consent
    // note (consent.source, consent.text) is kept when sent, never required; else the key names the source.
    consentByDefault: true,
    consentSource: consentSourceIntake(keyRow.name),
  });
  if (!lead.ok) {
    await log("rejected", Object.values(lead.errors)[0] ?? "Invalid lead", name);
    return NextResponse.json({ error: "invalid_lead", fields: lead.errors }, { status: 422 });
  }
  // A delivery here is the buyer sending the seller's form themselves: their own request to be
  // contacted, so it counts as an explicit yes, also for a lead saved earlier without consent
  // (UX, 22 Nov). CSV re-imports and a seller's re-add never add consent to such a lead.
  if (lead.value.consent) lead.value.consentDefaulted = false;

  // The lead's market: the key's market first, then the optional "country" field, then the phone prefix.
  const result = await upsertLead(appDb, account.id, { userId: null, actingAs: false }, lead.value, "webhook", {
    intakeKeyId: keyRow.id,
    keyMarketId: keyRow.marketId,
  });
  if (!result.ok) {
    await log("rejected", refusalText(result).problem, name);
    if (result.reason === "opted_out") return NextResponse.json({ error: "opted_out" }, { status: 409 });
    if (result.reason === "account_paused") return NextResponse.json({ error: "account_paused" }, { status: 403 });
    return NextResponse.json({ error: "phone_conflict" }, { status: 409 });
  }
  await log(result.created ? "created" : "updated", null, name, result.lead.id);
  return NextResponse.json(
    { id: result.lead.id, created: result.created, status: result.lead.status },
    { status: result.created ? 201 : 200 },
  );
}
