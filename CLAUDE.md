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

## Workflow (current stage: direct pushes to `main`, no PRs)
- At this stage we push directly to `main`; do not open PRs. Do the work on a
  local branch or commits, then rebase onto the latest `origin/main` and push to `main`.
- Before every push to `main`, run the checks and push only if both pass:
  `npm run lint` and `npm run build`.
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
- Post `[START]` / `[CLAIM]` / `[QUEUE]` / `[BLOCKED]` / `[DONE]` comments there.
- Claim shared areas before editing them; only one migration (`db/schema.ts` +
  `drizzle/`) may be in flight at a time.
- Pushes to `main` go one at a time through the release queue in the channel:
  post `[QUEUE]`, push when the Lead gives the go (or immediately if the queue is
  empty and no migration is in flight), then post `[PUSHED] <commit sha>`.
