# CLAUDE.md — working rules for this repo

Stack: Next.js 16 (App Router, `proxy.ts` instead of `middleware.ts`), TypeScript,
Clerk (`@clerk/nextjs` v7 / Core 3 — use `<Show when="signed-in">`, not `SignedIn`),
Drizzle ORM + `@neondatabase/serverless` (neon-http), deployed on Vercel.

## Database
- Every table/column change goes through `db/schema.ts` → `npm run db:generate` →
  commit the generated files in `drizzle/`. Never hand-write or edit migration SQL
  unless a generated migration genuinely needs a fix, and never edit files of a
  migration that was already applied.
- Never run manual SQL (DDL or data fixes) against the database. No `drizzle-kit push`.
- Migrations run automatically only on production builds (`scripts/migrate.ts`
  checks `VERCEL_ENV === "production"`). Do not remove that guard: Preview shares
  the production database until a separate Neon branch is set up for Preview.

## Auth & authorization
- Authorization checks always happen on the server (server components, server
  actions, route handlers). Hiding UI on the client is never a security control.
- `proxy.ts` only enforces "signed in". Role checks happen in the page/action itself.
- Protected pages call `ensureUser()` (`lib/ensure-user.ts`) and use its returned
  DB row for role checks.
- `/sadmin` stays super-admin only: `proxy.ts` protects it, and every page under
  it must check `role === "super_admin"` server-side and call `notFound()` otherwise.
  Super admins come only from the `SUPER_ADMIN_EMAILS` env var.

## AI spend (Anthropic API key) — user rule, 2026-11-16
- Anything in development or testing that spends money on the Anthropic API
  needs the user's explicit approval **before** it runs. That includes: chatting
  with the agent in the test lab (by hand or via Playwright, in any environment),
  `npm run test:sim` with `E2E_AGENT=1`, sending WhatsApp messages the agent will
  answer, and any script or one-off call that uses `ANTHROPIC_API_KEY`.
- Ask the user directly (not in the team channel): what will run, why, roughly
  how many model calls, and the estimated cost. An approval covers that request
  only; it does not carry over to later runs or to other sessions.
- Budget: development spend stays within the budget the user sets. Current budget
  (user, 2026-11-16): **$5 per month**, to learn the real rates; the user will raise it
  later. Each paid run still needs the user's approval with an estimate first. Going over the
  budget needs the user's explicit approval. Report the estimated spend of
  approved runs in your `[PUSHED]` / `[DONE]` post.
- Default to the free path: tests use the scripted model (`ScriptedLlm`). Never
  add a test, CI step or script that calls the real API by default.
- This rule covers development and testing. Real seller traffic in production
  is governed by the account's spend cap; ask the user before changing that.

## Workflow (current stage: direct pushes to `main`, no PRs)
- At this stage we push directly to `main`; do not open PRs. Do the work on a
  local branch or commits, then rebase onto the latest `origin/main` and push to `main`.
- Before every push to `main`, run the checks and push only if all pass:
  `npm run lint`, `npm test` and `npm run build`.
- Never force-push `main`. If the push is rejected because someone pushed
  first: `git fetch origin && git rebase origin/main`, rerun the checks, push again.
- Schema changes: commit the generated migration files in `drizzle/` in the same
  push as the `db/schema.ts` change (never a schema change without its migration).
- Never commit secrets (`.env*` files, keys, tokens, connection strings); check
  `git diff --cached` before committing. Keep `.env.example` updated when adding env vars.
- Pushing to `main` deploys to production and runs migrations, so announce every
  push in the team channel (see below).

## Team coordination (parallel sessions)
- Several sessions work in parallel. The shared channel is GitHub issue #2
  (https://github.com/salesatscale18/Salesatscale/issues/2); the protocol is
  `docs/TEAM.md`. Read both at the start of every session.
- Post `[START]` / `[CLAIM]` / `[QUEUE]` / `[PUSHED]` / `[BLOCKED]` / `[INFO]` /
  `[DONE]` comments there. Re-read the channel's latest comments right before
  `[QUEUE]`: another session may have just pushed or claimed something.
- Claim shared areas before editing them; only one migration (`db/schema.ts` +
  `drizzle/`) may be in flight at a time.
- Pushes to `main` go one at a time through the release queue in the channel:
  post `[QUEUE]`, push when the Lead gives the go (or immediately if the queue is
  empty and no migration is in flight), then post `[PUSHED] <commit sha>`.
