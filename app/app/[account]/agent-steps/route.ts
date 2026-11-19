import { NextResponse, type NextRequest } from "next/server";
import { requireAccount } from "@/lib/auth/account";
import { STEPS_COOKIE, STEPS_COOKIE_MAX_AGE, parseScope, safeBack, stepsCookieValue } from "@/lib/conversations/agent-steps";

/**
 * "Show agent steps" switch (GET, works without JS): stores this person's
 * choice for the workspace or the test lab in a cookie and returns to the
 * thread. Only a display preference; the account access check still runs so
 * the cookie carries a real user id.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ account: string }> }) {
  const { account: slug } = await params;
  const access = await requireAccount(slug);
  const url = req.nextUrl;
  const scope = parseScope(url.searchParams.get("scope"));
  const show = url.searchParams.get("show");
  const back = safeBack(access.account.slug, url.searchParams.get("back"));
  const res = NextResponse.redirect(new URL(back, url.origin), 303);
  if (scope && (show === "1" || show === "0")) {
    res.cookies.set(STEPS_COOKIE[scope], stepsCookieValue(access.user.id, show === "1"), {
      path: "/app", maxAge: STEPS_COOKIE_MAX_AGE, sameSite: "lax", httpOnly: true, secure: url.protocol === "https:",
    });
  }
  return res;
}
