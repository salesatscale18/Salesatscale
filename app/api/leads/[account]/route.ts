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
import { bearerKey, parseLead } from "@/lib/leads/rules";
import { resolveIntakeKey, upsertLead } from "@/lib/leads/service";
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

  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const consent = (body.consent && typeof body.consent === "object" ? body.consent : {}) as Record<string, unknown>;
  const forwardedFor = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const lead = parseLead(
    {
      fullName: body.name ?? body.full_name,
      company: body.company,
      phone: body.phone,
      language: body.language,
      sourceLabel: body.source ?? "Website form",
      sourceRef: body.source_id,
      consent: consent.given,
      consentSource: consent.source,
      consentWording: consent.wording,
      consentCapturedAt: consent.captured_at,
      consentIp: consent.ip ?? forwardedFor,
      consentPageUrl: consent.page_url,
    },
    account.market,
    { language: (account.languages[0] ?? "en") as Locale, now: new Date() },
  );
  if (!lead.ok) return NextResponse.json({ error: "invalid_lead", fields: lead.errors }, { status: 422 });

  const result = await upsertLead(appDb, account.id, { userId: null, actingAs: false }, lead.value, "webhook");
  if (!result.ok) {
    return result.reason === "consent_required"
      ? NextResponse.json({ error: "consent_required", message: "A new lead needs consent.given = true and consent.source." }, { status: 422 })
      : NextResponse.json({ error: "phone_conflict" }, { status: 409 });
  }
  return NextResponse.json(
    { id: result.lead.id, created: result.created, status: result.lead.status },
    { status: result.created ? 201 : 200 },
  );
}
