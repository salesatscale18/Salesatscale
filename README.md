# Sales at Scale

Next.js (App Router) + TypeScript, Clerk auth, Drizzle ORM on Neon Postgres. Deployed on Vercel.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, Clerk keys, SUPER_ADMIN_EMAILS
npm run db:migrate           # apply migrations to the database in .env.local
npm run dev                  # http://localhost:3000
```

Tip: with the Vercel CLI linked to the project, `vercel env pull .env.local` fetches the values.

> Preview and Production currently share one database. Point `.env.local` at a
> separate Neon branch for local work so `db:migrate` doesn't touch production.

## Project layout

| Path | What |
| --- | --- |
| `app/page.tsx` | Landing page (+ auth bar) |
| `app/sadmin/` | Super-admin area (signed-in + `super_admin` role only) |
| `proxy.ts` | Clerk middleware (Next 16 calls it "proxy"); requires sign-in for `/sadmin` |
| `lib/ensure-user.ts` | Syncs the Clerk user into `users`; sets `super_admin` from `SUPER_ADMIN_EMAILS` |
| `db/schema.ts` | Drizzle schema — the source of truth for tables |
| `drizzle/` | Generated SQL migrations (committed) |
| `scripts/migrate.ts` | Runs migrations during the Vercel build, **production only** |

## Adding a table (or changing one)

1. Edit `db/schema.ts`.
2. Run `npm run db:generate` — creates a new SQL file in `drizzle/`.
3. Review the SQL and commit it together with the schema change.
4. Merge to `main`: the production build runs `scripts/migrate.ts`, which applies it.
   Preview builds skip migrations on purpose.

## Scripts

- `npm run dev` / `npm start`
- `npm run build` — `scripts/migrate.ts` (production only) then `next build`
- `npm run db:generate` — generate SQL migrations from the schema
- `npm run db:migrate` — apply migrations to `DATABASE_URL` manually
- `npm run lint` — type-check
