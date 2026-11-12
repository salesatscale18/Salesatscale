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

## Workflow
- Work on a branch and open a PR to `main`; never push to `main` directly.
- `npm run build` must pass before opening a PR.
- Never commit secrets; keep `.env.example` updated when adding env vars.

## Team coordination (parallel sessions)
- Several sessions work in parallel. The shared channel is GitHub issue #2
  (https://github.com/salesatscale18/Salesatscale/issues/2); the protocol is
  `docs/TEAM.md`. Read both at the start of every session.
- Post `[START]` / `[CLAIM]` / `[QUEUE]` / `[BLOCKED]` / `[DONE]` comments there.
- Claim shared areas before editing them; only one migration (`db/schema.ts` +
  `drizzle/`) may be in flight at a time.
- Only the Lead session merges to `main`, one PR at a time, via the release
  queue in the channel.
