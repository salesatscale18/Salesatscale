/**
 * Which market a lead belongs to (mvp-plan 3.13). Pure; unit-tested.
 *
 * Priority:
 *   1. the intake key the lead came with,
 *   2. the form's country field,
 *   3. the LONGEST matching phone prefix ("+1416" beats "+1"),
 *   4. otherwise the home market.
 * Ties within one step go to the home market, then to the oldest market.
 * Paused and setting-up markets still match: the market decides the lead's
 * language, hours and prices whether or not the agent may contact it yet.
 */
export type MatchableMarket = {
  id: string;
  isHome: boolean;
  phonePrefixes: string[];
  formCountryValues: string[];
  intakeKeyIds: string[];
  createdAt?: Date;
};

export type MatchInput = { phone?: string | null; formCountry?: string | null; intakeKeyId?: string | null };
export type MatchReason = "intake_key" | "form_country" | "phone_prefix" | "home";
export type MatchResult<M> = { market: M | null; reason: MatchReason };

/** "+44 20 5550-0142" → "+442055500142"; "0044…" → "+44…". Empty when there are no digits. */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function ordered<M extends MatchableMarket>(markets: M[]): M[] {
  return [...markets].sort(
    (a, b) =>
      Number(b.isHome) - Number(a.isHome) ||
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

export function matchMarket<M extends MatchableMarket>(markets: M[], input: MatchInput): MatchResult<M> {
  const list = ordered(markets);
  const home = list.find((m) => m.isHome) ?? null;

  if (input.intakeKeyId) {
    const byKey = list.find((m) => m.intakeKeyIds.includes(input.intakeKeyId!));
    if (byKey) return { market: byKey, reason: "intake_key" };
  }

  const country = input.formCountry ? norm(input.formCountry) : "";
  if (country) {
    const byCountry = list.find((m) => m.formCountryValues.some((v) => norm(v) === country));
    if (byCountry) return { market: byCountry, reason: "form_country" };
  }

  const phone = input.phone ? normalizePhone(input.phone) : "";
  // Only international numbers can match a prefix; a local number has no country code.
  if (phone.startsWith("+")) {
    let best: { market: M; length: number } | null = null;
    for (const m of list) {
      for (const p of m.phonePrefixes) {
        const prefix = normalizePhone(p);
        if (prefix.length > 1 && prefix.startsWith("+") && phone.startsWith(prefix) && (!best || prefix.length > best.length)) {
          best = { market: m, length: prefix.length };
        }
      }
    }
    if (best) return { market: best.market, reason: "phone_prefix" };
  }

  return { market: home, reason: "home" };
}
