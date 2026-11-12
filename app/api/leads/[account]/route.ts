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
import { bearerKey, parseJsonObject, parseLead, rawFromIntakeBody } from "@/lib/leads/rules";
import { recordDelivery, refusalText, resolveIntakeKey, upsertLead } from "@/lib/leads/service";
import type { Locale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const MAX_BODY = 32 * 1024;
const unauthorized = () => NextResponse.json({ error: "unauthorized" }, { status: 401 });

export async function POST(req: Request, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const key = bearerKey(req.headers.get("authorization"), req.headers.get("x-api-key"));
  if (!key) return unauthorized();
  const keyRow = await resolveIntakeKey(appDb, key);
  if (!keyRow) return unauthorized();
  const [account] = await appDb.select().from(sellerAccounts).where(eq(sellerAccounts.slug, slug));
  if (!account || account.id !== keyRow.accountId) return unauthorized();

  const log = (result: "created" | "updated" | "rejected", reason: string | null, leadName: unknown, leadId?: string) =>
    recordDelivery(appDb, { accountId: account.id, keyId: keyRow.id, result, reason, leadId, leadName: typeof leadName === "string" ? leadName : null });

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
    requireConsentText: true,
  });
  if (!lead.ok) {
    await log("rejected", Object.values(lead.errors)[0] ?? "Invalid lead", name);
    return NextResponse.json({ error: "invalid_lead", fields: lead.errors }, { status: 422 });
  }

  const result = await upsertLead(appDb, account.id, { userId: null, actingAs: false }, lead.value, "webhook");
  if (!result.ok) {
    await log("rejected", refusalText(result).problem, name);
    if (result.reason === "consent_required") {
      return NextResponse.json({ error: "consent_required", message: "A new lead needs consent.source and consent.text." }, { status: 422 });
    }
    if (result.reason === "opted_out") return NextResponse.json({ error: "opted_out" }, { status: 409 });
    return NextResponse.json({ error: "phone_conflict" }, { status: 409 });
  }
  await log(result.created ? "created" : "updated", null, name, result.lead.id);
  return NextResponse.json(
    { id: result.lead.id, created: result.created, status: result.lead.status },
    { status: result.created ? 201 : 200 },
  );
}
