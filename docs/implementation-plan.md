# Sales at Scale — MVP Implementation Plan

Status: draft v1, 2026-11-12. Owner: implementation-plan session (`claude/determined-hopper-8rjy8a`).

This plan turns the product plan into build phases. It does not repeat product decisions; it points to them.

| Source | Where | What it fixes |
|---|---|---|
| Product plan | [`docs/mvp-plan.md`](mvp-plan.md) | Scope, decisions 3.1–3.12, screens, go-live checklist, open decisions |
| Design system (Trust Blue) | https://claude.ai/artifact/JqDhGuh7uQXqV1er6vwQgu | Tokens, type, status words, icons, RTL rules, `sas-` components |
| Screen designs + notes | https://claude.ai/artifact/Q4qUgGrnwScxyysAd1iHdM | 25 screens: seller workspace (8), setup (8 + test lab), buyer (5), admin (3), side nav and setup steps; "States and gaps" page in progress (see below) |
| Repo rules | `CLAUDE.md`, `docs/TEAM.md`, channel issue #2 | Stack, migrations, auth, release queue |

When this plan and the product plan disagree, the product plan wins. Fix this file.

Ownership: the UX/product session owns `docs/mvp-plan.md`, the screens and the design system; this plan, the phases, tests and code are owned by the implementation session. Screen or product questions go to the UX session or the channel.

States being designed by the UX session (canvas page "States and gaps"), needed by the steps in brackets:

1. Signed in with no account, account picker, invite acceptance (P0.5, P1.4)
2. Admin "create account" form with required fields (P1.3)
3. Lead card empty state; test-lab trace row for a tool refusal (P2.6, P4.6)
4. Buyer "price changed" and "payment failed" pages (P5.4, P5.5)
5. Empty, error and loading states for Leads, Orders and Inbox (P2.3, P3.5, P6.6)

---

## 1. How to read and update this plan

- Work is split into **phases** (P0–P10). Each phase has **steps** with IDs (`P3.2`), and each step lists what it builds, its migration (if any) and its tests.
- A phase is done when its **exit criteria** pass: the listed tests are green in CI and the demo works.
- **Progress lives in section 9** (the tracker). Whoever finishes a step updates its row in the same push: status, commit SHA, date. The channel post for that push names the step IDs: `[PUSHED] abc1234 — P3.1, P3.2`.
- Status words: `todo`, `in progress`, `blocked`, `done`. A blocked row says what it waits for.
- One session owns a step at a time. Claim it in the channel: `[CLAIM] P3.2 quote engine`.

## 2. Build order in one picture

```
P0 Foundations ─► P1 Tenancy & admin ─► P2 Leads & consent ─┐
                                   └──► P3 Catalog & quotes ─┼─► P4 Agent core + test lab ─► P5 Order form & payment ─► MILESTONE A
                                                             │                                                          (first full deal, test lab)
                                                             └──────────────────────────────────────────────────────────► P6 WhatsApp channel ─► MILESTONE B
                                                                                                                         P7 Meetings, follow-ups, notifications
                                                                                                                         P8 Setup wizard & knowledge
                                                                                                                         P9 Overview, reports, admin ops
                                                                                                                         P10 Pilot hardening ─► PILOT
```

- **Milestone A — first full deal in the test lab.** A tester chats with the agent in the written test lab, the agent qualifies, creates a server-priced quote, sends the order form link, the tester signs and pays with the test provider, and the order shows as Paid. No WhatsApp yet. This is the "one end-to-end path with a small catalog and test payments" from the product plan (section 8, step 6).
- **Milestone B — the same deal on WhatsApp** with a test number, plus takeover and opt-out.
- **Pilot** — the go-live checklist passes for the pilot seller, and real leads are contacted.

The test lab is the agent's first channel on purpose: it is the cheapest one to build and test, and it exercises the same agent, tools and deal state that WhatsApp will use (decision 3.3).

## 3. Architecture baseline

These choices apply to every phase. Items marked **(decide)** are in section 8.

### 3.1 Code layout

```
app/
  (marketing)/ …               landing page, /terms (existing)
  sadmin/ …                    platform admin (existing, super_admin only)
  app/[account]/ …             seller workspace, one URL segment per seller account (slug)
  f/[token]/ …                 buyer order form + payment (public, token-gated)
  m/[token]/ …                 buyer meeting booking (public, token-gated)
  api/webhooks/whatsapp        channel webhook
  api/webhooks/payments/[p]    payment provider webhooks
  api/leads/[account]          lead intake webhook (per-account key)
  api/cron/…                   scheduled job runners
db/schema/…                    Drizzle schema, split per domain, re-exported from db/schema.ts
lib/auth/                      ensureUser (existing), requireAccount(), audit()
lib/domain/…                   pure business logic (quote engine, deal state, consent, follow-up rules)
lib/agent/                     agent runtime, tools, prompt assembly, LLM provider interface
lib/channels/                  channel adapter interface + whatsapp + testlab adapters
lib/payments/                  payment provider interface + fake provider (+ real one later)
lib/jobs/                      job table runner (send, follow-up, ingest, retries)
lib/i18n/                      translation keys, en.json, he.json, dir() helper
components/sas/                React versions of the design-system components
tests/                         unit, integration (db), e2e, agent scenarios
```

`lib/domain` holds no I/O, so it is unit-tested without a database. Server actions and route handlers stay thin: check auth, call domain logic, write through repositories.

### 3.2 Tenancy and authorization (decisions 3.8, CLAUDE.md)

- Every seller-side table has `account_id uuid not null` with an index. There are no exceptions; global tables are only `users`, `seller_accounts` and provider/job tables that still carry `account_id` where they belong to one.
- `requireAccount(slug)` in `lib/auth/` is the only way a seller page or action gets an account: it calls `ensureUser()`, loads the account, and allows access if the user is a member (`account_members`) or a `super_admin`. A super admin who is not a member is "acting as": the shell shows the acting Banner and every write is audited with `acting_as = true`. Not allowed → `notFound()`.
- All seller-side queries go through repository functions that take the `AccountContext` returned by `requireAccount` and add `where account_id = ctx.accountId`. No raw `db.select()` on tenant tables in pages.
- Public buyer pages never use an account from the URL; they resolve everything from a random token (stored hashed) and only show that one quote/meeting.
- `proxy.ts` gains `/app(.*)` as a signed-in route (shared area: claim it). Role checks stay in pages and actions.
- `audit_log` from P1: who, account, acting_as, action, target, before/after summary, time. Written for publish, export, delete, financial actions, role changes, takeover, pause.

### 3.3 Agent runtime (decisions 3.1, 3.10)

- One turn = load the conversation's **agent version** (playbook, knowledge snapshot, tools, model settings) + **deal state** + **rolling summary** + recent messages → call the LLM with tool definitions → run tool calls on the server → store the reply, tool calls, knowledge used and deal-state changes with provenance.
- Each tool is a server function with a typed input schema, **preconditions** and an idempotency key. When a precondition fails it returns a structured refusal (`{ ok: false, missing: ["site_count"] }`) that the agent sees, never an exception to the buyer.
- Tools for the MVP: `search_catalog`, `check_fit`, `lookup_knowledge`, `update_deal_state`, `create_quote`, `send_order_form`, `offer_meeting_slots`, `book_meeting`, `hand_off_to_human`, `check_payment_status`.
- Platform safety rules (consent, opt-out, no card data in chat, approved knowledge only, channel policy) are enforced in code before and after the LLM call, not only in the prompt.
- The LLM sits behind `lib/agent/llm.ts` (provider interface). Tests use a scripted fake LLM so agent behavior tests are deterministic.

### 3.4 Channels (decision 3.3)

`ChannelAdapter`: `send(message)`, `sendTemplate(template, vars)`, `parseInbound(request)`, `deliveryStatus(event)`, `windowState(conversation)`. Implementations: `testlab` (P4), `whatsapp` (P6). The agent never imports a channel.

### 3.5 Payments (decision 3.6)

`PaymentProvider`: `createCheckout(order)`, `verifyEvent(request)`, `refund(payment)`, `issueInvoice(order)`, `createRecurring(order)`. P5 ships a `fake` provider with a hosted-looking test checkout page and signed webhooks, so the full flow works before the real provider is chosen. Bank transfer is a provider-independent path.

### 3.6 Background work

Follow-ups, outgoing sends, retries, source ingestion and payment re-checks run from a `jobs` table (type, account, payload, run_at, attempts, status, last_error, idempotency key) processed by a cron route **(decide: runner)**. Jobs are idempotent; a failed job after N retries shows in Admin › Operations.

### 3.7 UI

- Design tokens from `tokens.json` become CSS variables in a workspace stylesheet (light + dark), and the `sas-` classes from the canvas's `bundle.css` are ported as is. React wrappers in `components/sas/`: Button, StatusPill, ProvenanceTag, ChatMessage, TimelineEvent, DealStateField, WindowTimer, MetricTile, Banner, SideNav, SetupSteps.
- Status words come from one map (`lib/domain/status.ts`) that matches the design system's status table exactly; pills never take free text.
- Every UI string uses a translation key from P0 (`en.json`; `he.json` for buyer pages and agent-facing templates). Layout uses logical properties only. `dir`/`lang` set on the smallest element holding other-direction text.
- Money is integer minor units + currency in the database, formatted on display (`₪4,860.00`, `₪180.00/month`).

### 3.8 Files

Uploaded sources, logos and signed order-form PDFs go to object storage **(decide: Vercel Blob)**, keyed by account, never public-listable. Signed snapshots are write-once.

## 4. Testing strategy

| Layer | Tool | What it covers | Runs |
|---|---|---|---|
| Typecheck | `tsc` (`npm run lint`) | Whole repo | every push (existing rule) |
| Unit | Vitest | `lib/domain/*`: quote math, discounts, approval rules, deal-state stage derivation, consent checks, follow-up scheduling and cancellation, window state, status map, i18n key coverage | every push |
| Integration (DB) | Vitest + PGlite (Postgres in process) with the real migrations from `drizzle/` | Repositories, tenant isolation, tool preconditions, webhook handlers, idempotency, audit writes | every push |
| Agent scenarios | Vitest + scripted fake LLM; optional live-LLM run | Tool-call sequences and refusals for the test-lab scenario suite (ready buyer, discount push, partner approval, asks for a person, off-topic, Hebrew) | fake: every push; live: before publishing an agent change |
| End to end | Playwright (preinstalled Chromium) against `next dev` with Clerk test mode | Sign-in, account entry, add lead, test-lab deal to paid, buyer form EN + HE (RTL), takeover | per phase exit and before each `main` push that touches the flow |
| Accessibility | `@axe-core/playwright` on key screens | Contrast, labels, focus (the design system sets 4.5:1) | with E2E |

Rules:

- **Tests never touch the production database.** Integration tests run on PGlite with the committed migrations, so they also prove every migration applies cleanly from zero. (Preview shares the production database until D9 is done before the pilot.)
- Every tenant-scoped repository gets an isolation test: account B's user cannot read or write account A's rows, by ID guessing included.
- Every tool gets a precondition test (refused with the right `missing` list) and an idempotency test (same key twice → one effect).
- Every webhook gets: bad signature rejected, duplicate event processed once, out-of-order event handled.
- Money tests use exact integer assertions, never floats.
- Bugs get a failing test first.

Proposed check before every push to `main` (needs a `[RULE]` from the Lead with the user's OK): `npm run lint && npm test && npm run build`. CI runs the same on every push to any branch.

## 5. Phases

Each step: **what** · **migration** · **tests**. "UI" names the canvas artboard it implements.

### P0 — Foundations (no product features)

Goal: every later phase can write tests, use the design system and run CI.

| Step | What | Migration | Tests |
|---|---|---|---|
| P0.1 | Test harness: Vitest config, PGlite helper that applies `drizzle/` migrations, `npm test`, `npm run test:e2e` (Playwright). Claim `package.json`. | no | A smoke test per layer |
| P0.2 | CI: GitHub Actions running lint, unit + integration tests and build on every push | no | CI green on `main` |
| P0.3 | Design system in code: tokens → CSS variables (light/dark), `sas-` component styles, `components/sas/*` React wrappers, status-word map, Inter + Noto Sans Hebrew + JetBrains Mono | no | Unit: status map covers the design system's status table; Playwright screenshot of a components page |
| P0.4 | i18n: `t()` with `en.json`/`he.json`, `dir()` helper, typed keys | no | Unit: every key in `en` exists in `he` for buyer namespaces |
| P0.5 | Workspace shell components: SideNav (seller and admin modes), SetupSteps, shell layout, acting/test/takeover banners, shown on `/sadmin/design`. The `app/app/[account]/layout.tsx` route with placeholder pages ships in P1.2, once `requireAccount()` exists. UI: SideNav, SetupSteps | no | Unit: nav links and active item; E2E: shell renders, nav links work (P1.2) |
| P0.6 | Environments: confirm the Vercel project link (open item in the channel), set up a separate Neon branch for Preview, document env vars in `.env.example` | no | Preview deploy uses its own DB |

Exit: CI green; components page matches the canvas; a signed-in user sees the shell.

### P1 — Tenancy, accounts, audit, platform admin

Goal: seller accounts exist, a seller admin can sign in to their account only, and a platform admin can enter any account with the acting banner.

| Step | What | Migration | Tests |
|---|---|---|---|
| P1.1 | Schema: `seller_accounts` (name, slug, status Setting up/Live/Paused, market, languages, currency, timezone, spend cap), `account_members` (account, user, role enum `seller_admin`), `audit_log` | **M1** | Migration applies from zero |
| P1.2 | `requireAccount()`, `AccountContext`, tenant repository pattern, `audit()`; `proxy.ts` protects `/app(.*)` (claim) | no | Integration: member ok, non-member `notFound`, super_admin → acting; isolation test template |
| P1.3 | Admin › Accounts: list, create, pause/resume (pause stops all outgoing work for the account), account detail, audit log view. UI: AdminAccounts | no | Integration: only super_admin; pause writes audit; E2E create account |
| P1.4 | Invite seller admin: our own invite link (hashed token, 7-day expiry); accepting needs a verified email that matches and links the user as `seller_admin`. Sending the link by email waits for D8 | no | Integration: invite → membership; mismatch, expired, reused refused |
| P1.5 | Enter account (acting as): banner on every seller screen, writes audited with `acting_as` | no | E2E: super admin enters, banner visible, audit row written |

Exit: two test accounts; each seller admin sees only their own; admin can enter both.

### P2 — Leads and consent

Goal: leads come in with a consent record, and the lead list and lead card exist (timeline without chat yet).

| Step | What | Migration | Tests |
|---|---|---|---|
| P2.1 | Schema: `leads` (name, company, phone E.164, language, source, source_id, owner, status), `consent_records` (source, exact wording, time, channel, ip/url), `lead_events` (unified timeline: type, actor, payload) | **M2** | Isolation tests |
| P2.2 | Domain: phone normalization, dedupe (same phone or same source ID → update), consent required, opt-out flag | no | Unit: dedupe, invalid phone, missing consent rejected |
| P2.3 | Leads list: saved views with counts, search, filters, Add lead side panel with consent. UI: Leads | no | E2E: add lead; cannot save without consent |
| P2.4 | CSV import with per-row errors ("row 14: no consent") | no | Integration: mixed file → right inserts/updates/rejections |
| P2.5 | Intake webhook `/api/leads/[account]` with per-account secret (hashed), consent required in payload | no | Integration: bad key 401, duplicate updates, missing consent 422 |
| P2.6 | Lead card shell: header, timeline tab, deal-state panel placeholder, consent record. UI: Main (Lead card) | no | E2E: open lead from list |

Exit: leads from all three intake paths appear with consent; no path creates a lead without consent.

### P3 — Catalog and quote engine

Goal: the only source of prices, and quotes priced only on the server.

| Step | What | Migration | Tests |
|---|---|---|---|
| P3.1 | Schema: `catalogs` (versioned draft/published), `products`, `variants` (SKU, unit), `price_lines` (one-time / recurring with period, minor units, currency), `fit_rules`, custom-pricing threshold; `quotes`, `quote_versions`, `quote_lines` (with catalog version and price source), discount and approval fields | **M3** | Isolation; published catalog is read-only |
| P3.2 | Quote engine (`lib/domain/quote.ts`): lines × quantities per site, one-time and monthly totals, discounts within cap, tax, approval needed when over cap or custom-pricing product, validity date, idempotency | no | Unit: exhaustive table tests on totals, rounding, cap, threshold, recurring |
| P3.3 | Fit check (`lib/domain/fit.ts`) from fit rules (e.g. one gateway per site, max sensors per gateway) | no | Unit: pilot-style rules, but rules are data, nothing category-specific in code |
| P3.4 | Catalog screen: products, variants, prices, fit rules, custom-pricing flag, draft → publish new version. UI: Catalog | no | E2E: edit draft, publish v2; quotes keep v1 |
| P3.5 | Quotes and orders list + detail (quote side): versions, line price source, Awaiting approval → Approve and send, Cancel. UI: Orders | no | Integration: approval flow, new version invalidates old |

Exit: a quote created through the domain API matches hand-calculated totals for the pilot catalog; no price comes from anywhere but the published catalog.

### P4 — Agent core and test lab

Goal: the agent converses in the written test lab, fills the deal state and uses tools under server checks.

| Step | What | Migration | Tests |
|---|---|---|---|
| P4.1 | Schema: `conversations` (lead, channel, status, agent_version, paused/takeover), `messages` (direction, actor, body, lang, channel ids, delivery status), `tool_calls`, `deal_states` (fields with value + provenance Buyer said / Agent inferred / Verified, summary), `agent_versions` (draft/testing/live/retired, playbook snapshot, knowledge snapshot ref, model settings), `playbooks`, `knowledge_facts` (minimal: manual, approved) | **M4** | Isolation; one live version per account |
| P4.2 | LLM provider interface + first provider **(decide)** + scripted fake LLM | no | Unit: fake LLM drives tool loops |
| P4.3 | Tool layer with preconditions and refusals: `search_catalog`, `check_fit`, `lookup_knowledge`, `update_deal_state`, `create_quote`, `hand_off_to_human` | no | Integration: one precondition + idempotency test per tool |
| P4.4 | Agent turn loop: prompt assembly from playbook + deal state + summary, language follows buyer, safety rules in code, rolling summary, cost recorded per turn | no | Scenario tests with fake LLM; unit: summary trimming |
| P4.5 | Deal state → derived stages (new, qualified, quoted, agreed, paid, meeting booked) for reporting | no | Unit: derivation table |
| P4.6 | Test lab: written chat with the draft version, scenario + language picker, trace panel (tools, results, knowledge, deal-state diff), test conversations flagged and excluded from reports. UI: TestLab | no | E2E: chat in test lab, trace shows tool calls |
| P4.7 | Playbook editor (minimal): goal, deal-state fields with "before quote" / "before order form", objections, limits. Edits go to the draft version. UI: Playbook | no | Integration: `create_quote` blocked until before-quote fields known |
| P4.8 | Lead card: chat column with agent trace chips, deal-state panel with provenance, person edit → Verified + audit. UI: Main | no | E2E: edit field → Verified tag |

Exit: in the test lab, the scripted "ready buyer" scenario reaches a valid quote and the "discount push" scenario is refused above the cap.

### P5 — Order form, signature and payment (test mode) → Milestone A

| Step | What | Migration | Tests |
|---|---|---|---|
| P5.1 | Schema: `order_form_templates` (versions, per language: legal sections, buyer fields, payment methods, link validity), `order_forms` (quote version, token hash, state Sent/Opened/Signed/Link expired, snapshot), `signatures` (typed name, checkbox, time, IP, user agent, form version), `orders`, `payment_attempts`, `provider_events` (raw, verified, dedupe key) | **M5** | Isolation; snapshot immutable |
| P5.2 | Order form template setup with live mobile preview, EN + HE. UI: OrderFormSetup | no | E2E: preview switches to RTL |
| P5.3 | `send_order_form` tool: preconditions (before-order-form fields, quote valid, not awaiting approval), personal link, material change → new quote version + old link dead | no | Integration: old token shows "Offer updated" |
| P5.4 | Buyer pages `/f/[token]`: review, editable allowed fields, sign, states (expired, price changed, pending, paid), seller branding, "Secured by Sales at Scale", EN/HE switch. UI: BuyerOrder, BuyerExpired | no | E2E mobile viewport EN + HE; a11y check |
| P5.5 | Payment provider interface + fake provider (test checkout + signed webhook); re-check price/availability/validity before payment; recurring consent. UI: BuyerPay, BuyerPaid | no | Integration: bad signature, wrong amount/currency/account → not paid; duplicate event once |
| P5.6 | Bank transfer path: order "Bank transfer expected", seller marks received (audited) | no | Integration: only bank-transfer orders can be marked by hand |
| P5.7 | Signed snapshot PDF + data stored write-once; downloadable by buyer and seller | no | Integration: snapshot hash stable |
| P5.8 | Confirmations: buyer and seller notified (test lab message + email stub) | no | — |

**Milestone A exit:** Playwright E2E — test lab chat → quote → order form link → sign (EN and HE) → fake payment → order Paid on the lead card and in Quotes and orders. Runs in CI.

### P6 — WhatsApp channel → Milestone B

| Step | What | Migration | Tests |
|---|---|---|---|
| P6.1 | Schema: `channel_connections` (per account: phone number id, display name, status; tokens in env/secret store, never in DB plaintext), `message_templates` (name, language, category, approval status, rejection reason), `jobs` | **M6** | — |
| P6.2 | WhatsApp adapter **(decide: Meta Cloud API or BSP)**: send, templates, inbound webhook with signature check, delivery statuses, media | no | Integration with recorded webhook fixtures |
| P6.3 | 24-hour window: state per conversation, WindowTimer, outside window → templates only (enforced in adapter, not only UI) | no | Unit: window math; integration: free text refused when closed |
| P6.4 | Opener: eligible lead (consent, contact hours, not opted out, account Live, launch option) → approved opening template | no | Integration: each gate blocks |
| P6.5 | Opt-out: "stop" and variants (EN/HE) honored at once, cancels jobs, marks lead Opted out | no | Unit + integration |
| P6.6 | Takeover and hand back; Conversations inbox with Needs you / Human handling / Agent handling, handoff brief, composer (free text in window, templates outside). UI: Inbox | no | E2E: take over pauses agent; hand back resumes with context |
| P6.7 | Job runner **(decide)** for sends, retries, delivery reconciliation | no | Integration: retry then fail → Operations |
| P6.8 | Settings › WhatsApp: connection, health, templates with status. UI: Settings | no | — |

**Milestone B exit:** the Milestone A deal on a test WhatsApp number, plus takeover and opt-out, verified by hand with a recorded checklist.

### P7 — Meetings, follow-ups, notifications

| Step | What | Migration | Tests |
|---|---|---|---|
| P7.1 | Schema: `availability` (per rep weekly hours, length, buffer, horizon, blocked dates), `meetings` (lead, rep, time, status, outcome, token hash), `follow_up_policies` (per situation: delays, max count, template per language), `notifications` | **M7** | — |
| P7.2 | Slot engine (time zones, buffer, horizon, blocked dates) + `offer_meeting_slots` / `book_meeting` tools | no | Unit: slot table tests incl. DST |
| P7.3 | Meetings screen: upcoming with brief, needs an outcome, availability editor. Buyer `/m/[token]` page with colleague invite. ICS invite + WhatsApp confirmation. UI: Meetings, BuyerMeeting | no | E2E booking; no double-booking under concurrency |
| P7.4 | Follow-up scheduler: create jobs per policy; cancel on reply, sign, pay, opt-out, takeover; contact hours. UI: FollowUps | no | Unit: every cancel trigger |
| P7.5 | Notifications to the seller admin (email **(decide)** / WhatsApp) for handoff, approval, meeting, failed payment; Settings › Notifications, contact hours | no | Integration: one per event, deduped |

### P8 — Setup wizard, knowledge and agent versions

| Step | What | Migration | Tests |
|---|---|---|---|
| P8.1 | Schema: `sources` (type website/pdf/docx/csv/xlsx, language, status, errors, blob key), `knowledge_facts` extended (topic, status Suggested/Approved/Rejected, source location), `contradictions`, `gap_questions`, `company_profiles` | **M8** | — |
| P8.2 | Company setup (identity, logo, brand color, languages, agent name and disclosure). UI: Company | no | — |
| P8.3 | Source ingestion jobs: website (allowed paths), PDF/DOCX text extraction, CSV/Excel → catalog mapping; precise partial-failure messages. UI: Sources | no | Integration with fixture files |
| P8.4 | Fact extraction (LLM) → Suggested facts with source links; contradiction detection; gap questions. UI: Knowledge | no | Fixture-based tests with fake LLM |
| P8.5 | Setup steps bar across setup screens; playbook full editor with wizard suggestions. UI: SetupSteps, Playbook | no | — |
| P8.6 | Agent versions: publish = frozen package (playbook, knowledge snapshot, tools, model, scenario results); rollback in one action; publish blocked until critical scenarios pass | no | Integration: conversation keeps its version; rollback audited |
| P8.7 | Go-live checklist gate + launch options (test leads only / share / all new). UI: GoLive | no | Integration: opener refuses while any item fails |

### P9 — Overview, reports, platform operations

| Step | What | Migration | Tests |
|---|---|---|---|
| P9.1 | Schema: `usage_events` (WhatsApp, LLM tokens, payment fees per account/lead/turn), report indexes if needed | **M9** | — |
| P9.2 | Seller Overview: headline numbers, funnel (furthest step), Needs you queue, latest outcomes, top objections, health, Pause agent. UI: Overview | no | Integration: funnel counts on seeded data; test conversations excluded |
| P9.3 | Reports: outcomes by week, conversion by agent version, loss reasons, cost per lead / paid order, CSV export. UI: Reports | no | Integration: CSV matches on-screen numbers |
| P9.4 | Admin › Activity (totals, alerts, accounts table) and Admin › Operations (provider status, failed jobs with retry/dismiss, usage and cost per account, CSV). UI: AdminActivity, AdminOps | no | Integration: super_admin only |
| P9.5 | Spend cap enforcement: near-cap alert, at-cap pause of new conversations | no | Unit + integration |

### P10 — Pilot hardening and launch

| Step | What |
|---|---|
| P10.1 | Security review (`/security-review`): tenant isolation sweep, webhook auth, token entropy, rate limits on public routes, no secrets/PII in logs |
| P10.2 | Real payment provider adapter **(decide)** behind the same interface; switch pilot to live mode after a real low-value transaction |
| P10.3 | Retention jobs per the decided periods; data export and delete for an account |
| P10.4 | Hebrew review of buyer pages, templates and approved translations by a native speaker |
| P10.5 | Pilot seller onboarding through the wizard; go-live checklist passes; launch with "only test leads", then a share |
| P10.6 | Monitoring: runtime error alerts, failed-job alerts, daily pilot report in the channel |

## 6. Migrations sequence

Only one migration in flight at a time (`docs/TEAM.md`). Each is generated from `db/schema.ts` with `npm run db:generate`, committed with the schema change, and pushed alone; the next schema change waits until that production deploy succeeds.

| # | Phase | Tables |
|---|---|---|
| M1 | P1 | seller_accounts, account_members, audit_log |
| M2 | P2 | leads, consent_records, lead_events |
| M3 | P3 | catalogs, products, variants, price_lines, fit_rules, quotes, quote_versions, quote_lines |
| M4 | P4 | conversations, messages, tool_calls, deal_states, agent_versions, playbooks, knowledge_facts |
| M5 | P5 | order_form_templates, order_forms, signatures, orders, payment_attempts, provider_events |
| M6 | P6 | channel_connections, message_templates, jobs |
| M7 | P7 | availability, meetings, follow_up_policies, notifications |
| M8 | P8 | sources, contradictions, gap_questions, company_profiles, knowledge_facts changes |
| M9 | P9 | usage_events |

Additive changes inside a phase are fine as extra migrations, still one at a time. Never edit an applied migration.

## 7. Parallel work (lanes)

Phases are sequential where data depends on data; inside and across phases these lanes can run in parallel sessions, each claiming its steps:

| Lane | Can start after | Steps |
|---|---|---|
| Foundations | now | P0.1–P0.2 (tests, CI) |
| UI system | now | P0.3–P0.5 (tokens, components, shell) — no schema |
| Tenancy | P0.1 | P1 |
| Leads | M1 pushed | P2 |
| Commerce | M1 pushed | P3, then P5 |
| Agent | M3 pushed | P4 |
| Channel | M4 pushed | P6 |

Pure domain logic (`lib/domain/*` with unit tests) can be written ahead of its migration. Schema changes queue through the single migration claim.

## 8. Decisions needed

From `docs/mvp-plan.md` section 7, plus technical choices this plan needs. A recommendation is given where the choice is ours; the rest are the user's.

| # | Decision | Needed by | Recommendation / default |
|---|---|---|---|
| D1 | LLM provider and model for the agent | P4.2 | **Default applied:** Anthropic, `claude-opus-5-5` (override with `AGENT_MODEL`), effort medium, server-side refusal fallback on. Behind `LlmClient`; a scripted fake keeps tests deterministic. Needs `ANTHROPIC_API_KEY` in Vercel. |
| D2 | WhatsApp: Meta Cloud API or a BSP; coexistence for the pilot number | P6.2 | User decides; check coexistence early with the pilot seller. |
| D3 | Payment provider for the pilot | P10.2 (fake provider until then) | User decides after confirming where the pilot seller is registered. |
| D4 | E-signature level | P5.4 | Checkbox + typed name (as designed) unless the pilot seller requires a provider. |
| D5 | Retention periods | P10.3 | User decides. |
| D6 | Background job runner | P6.7 | DB `jobs` table + Vercel Cron every minute (needs a Vercel plan with per-minute cron); alternative: a managed queue. |
| D7 | File storage | P5.7 / P8.3 | Vercel Blob (private). |
| D8 | Email for notifications, confirmations and invite links | P1.4 / P5.8 / P7.5 | A transactional email API (e.g. Resend). |
| D9 | Preview database | Before the pilot seller's real data (P8/P10) | **Decided (user, 2026-11-12): deferred.** We push straight to live while there is no real data. Add a separate Neon branch for Preview before the first real seller data, so Preview builds of unfinished code can't touch it. |
| D10 | `npm test` added to the pre-push rule | P0.2 | **Approved by the user (2026-11-12).** CI runs it on every push; Lead to add it to `CLAUDE.md` with a `[RULE]` post. |
| D13 | Release cadence | Now | **Decided (user, 2026-11-12): fast-track.** Push to `main` as soon as lint + test + build pass; sessions verify deploys via the Vercel connector; the user runs UAT at milestones. |
| D11 | Workspace URL shape | P0.5 | `/app/[account-slug]/…` for sellers; platform admin stays under `/sadmin`. Done in P1. |
| D12 | Database transactions | Before P3 (quotes) | **Done (P3):** kept neon-http; multi-row writes go through `db/atomic.ts` (`db.batch()` = one transaction on Neon, `db.transaction()` on PGlite), with app-generated IDs. |

## 9. Progress tracker

Update the row in the same push that finishes the step.

| Step | Status | Owner | Commit | Date | Notes |
|---|---|---|---|---|---|
| Plan | done | determined-hopper | this push | 2026-11-12 | This document + `docs/mvp-plan.md` on `main` |
| P0.1 | done | determined-hopper | this push | 2026-11-12 | Vitest (unit + PGlite integration on `drizzle/` migrations), Playwright config + smoke spec. `npm test`, `npm run test:e2e` |
| P0.2 | done | determined-hopper | this push | 2026-11-12 | `.github/workflows/ci.yml`: lint, test, build on every push. E2E job runs only when `E2E_CLERK_*` secrets (Clerk dev instance) are set |
| P0.3 | done | determined-hopper | this push | 2026-11-12 | `components/sas/` (tokens light/dark, `sas-` styles, React components), `lib/domain/status.ts`, `lib/domain/money.ts`; preview at `/sadmin/design` |
| P0.4 | done | determined-hopper | this push | 2026-11-12 | `lib/i18n` with `en`/`he`; Hebrew strings need native review (P10.4) |
| P0.5 | done | determined-hopper | P1 push | 2026-11-12 | Components in P0; `/app/[account]` shell shipped with P1.2 |
| P0.6 | deferred | | | | Preview DB deferred to before the pilot (D9). Vercel project link still an open item for the Lead |
| P1.1 | done | determined-hopper | this push | 2026-11-12 | M1 `0001_tenancy`: `seller_accounts`, `account_members`, `account_invites`, `audit_log` |
| P1.2 | done | determined-hopper | this push | 2026-11-12 | `requireAccount()` / `resolveAccountAccess`, `Db` type (`db/types.ts`), `/app` entry + picker + no-account, `/app/[account]` shell with placeholders (completes P0.5); `proxy.ts` protects `/app`, `/invite` |
| P1.3 | done | determined-hopper | this push | 2026-11-12 | `/sadmin/accounts`: list, create (with owner invite), detail, pause/resume, audit log |
| P1.4 | in progress | determined-hopper | this push | 2026-11-12 | Invite links (hashed token, 7 days, verified-email match) and `/invite/[token]` done. Invite **email** waits for D8; the admin copies the link for now |
| P1.5 | done | determined-hopper | this push | 2026-11-12 | Enter account → acting banner, entry and writes audited with `acting_as` |
| P2.1 | done | determined-hopper | this push | 2026-11-12 | M2 `0002_leads`: `leads`, `consent_records`, `lead_events`, `lead_intake_keys` |
| P2.2 | done | determined-hopper | this push | 2026-11-12 | `lib/leads/rules.ts`: E.164 normalization by market, masking, one validator for all intake paths, consent required |
| P2.3 | done | determined-hopper | this push | 2026-11-12 | Leads list: views with counts, search, source/language/period filters, Add lead panel, first-use/filtered/error/loading states. "Needs you" view, progress and next-step columns wait for P4–P6 data |
| P2.4 | done | determined-hopper | this push | 2026-11-12 | CSV import with per-row results (2,000 rows, 1 MB) |
| P2.5 | done | determined-hopper | this push | 2026-11-12 | `POST /api/leads/[account]` with per-account hashed keys (Settings), `docs/lead-intake.md`. Rate limiting in P10.1 |
| P2.6 | done | determined-hopper | this push | 2026-11-12 | Lead card shell: header with masked phone, empty conversation, timeline, consent record, opt-out (audited) |
| P2.7 | done | determined-hopper | next push | 2026-11-12 | UX follow-up (canvas ImportCsv, LeadIntake): migration `0003_leads_intake` (lead email, key last-4, `lead_intake_deliveries`), opted-out people rejected on every intake path, whole-file consent, duplicate-in-file check, problem/fix per rejected row with download, template, Recent deliveries, Copy buttons. "Send a test lead" not built (it would create a real lead) |
| P3.1 | done | determined-hopper | P3 push | 2026-11-12 | Migration `0004_catalog_quotes` (plan's M3): versioned catalog (one draft + one published), items with tiers and custom-pricing quantity, fit rules as data, quotes / versions / lines, `seller_accounts.max_discount_bp`. `db/atomic.ts` for all-or-nothing writes (D12, no driver change) |
| P3.2 | done | determined-hopper | P3 push | 2026-11-12 | `lib/catalog/pricing.ts`: integer-only engine (tiers, discount cap, VAT incl./excl., approval reasons); quotes service with idempotency keys, numbering, versions, approval, cancel |
| P3.3 | done | determined-hopper | P3 push | 2026-11-12 | `lib/catalog/fit.ts`: requires (per site), max per, advice |
| P3.4 | done | determined-hopper | P3 push | 2026-11-12 | Catalog setup screen: products, item editor, fit rules, VAT, draft → publish / discard. Spreadsheet import comes with Sources (P8) |
| P3.5 | done | determined-hopper | P3 push | 2026-11-12 | Quotes and orders (quote side): tabs, approval with custom prices, versions, cancel; quote editor from the lead card with live server-side preview |
| P3.6 | done | determined-hopper | P3 UX push | 2026-11-12 | UX P3 decisions: statuses (quote Cancelled file-x, catalog Draft/Live, item Active neutral, Live = check-circle everywhere, info icon for advice); price-tier row editor with inline errors, enforced on save and publish; quote editor per canvas (items table, Add product, × N sites, amber discount, sticky preview, red fit checks with one-click fix, amber approval, grey advice, Fix N problems / Submit for approval / Create and approve, What changed required); lead card quotes show older versions under "Show v1". "Save as draft" waits for P5 (create vs send) |
| P4.1 | done | determined-hopper | P4 push | 2026-11-12 | Migration `0005_agent`: agent_versions (playbook jsonb snapshot, model, effort; one draft + one live), knowledge_facts, conversations, messages, tool_calls, deal_states; `leads.is_test` (test-lab leads hidden from lists and counts) |
| P4.2 | done | determined-hopper | P4 push | 2026-11-12 | `lib/agent/llm.ts`: `LlmClient`, Anthropic provider (D1 default), `ScriptedLlm` fake |
| P4.3 | done | determined-hopper | P4 push | 2026-11-12 | `lib/agent/tools.ts`: six strict tools; refusals carry a rule and what is missing; quotes idempotent per tool call; discount above the limit → Awaiting approval |
| P4.4 | done | determined-hopper | P4 push | 2026-11-12 | `lib/agent/turn.ts`: prompt from playbook + deal state, language from the conversation, safety in code (STOP / הסר opt-out, card numbers masked, refusal → hand-off), up to 8 tool rounds, usage per message. Rolling summary deferred: last 40 messages + deal state for now |
| P4.5 | done | determined-hopper | P4 push | 2026-11-12 | `derivedStage` (new / qualified / quoted); agreed, paid and meeting arrive with P5/P7 |
| P4.6 | done | determined-hopper | P4 push | 2026-11-12 | Versions and test lab: publish, one-step rollback, test chat by version and language, trace per reply (input, result, Refused/Failed, tokens), deal-state panel. Scenario picker deferred |
| P4.7 | done | determined-hopper | P4 push | 2026-11-12 | Playbook editor (draft) + minimal Knowledge (approved facts with source) |
| P4.8 | done | determined-hopper | P4 push | 2026-11-12 | Lead card deal state with provenance; "Set and verify" → Verified, audited, event on the timeline; agent never overwrites Verified. Chat column on real leads arrives with the channel (P6) |
| P5.1 | done | determined-hopper | P5 push | 2026-11-12 | Migration `0006_orders`: order_form_settings, legal_sections (write-once versions per language), order_forms (token hash, immutable snapshot, superseded link), signatures (write-once, SHA-256 document hash, IP, user agent, legal versions), orders, payment_attempts, provider_events (dedupe key) |
| P5.2 | done | determined-hopper | P5 push | 2026-11-12 | Setup 6 · Order form: legal sections per language with versions, sample text to start, buyer fields, payment methods, bank details, link validity, brand color, live EN/HE mobile preview |
| P5.3 | done | determined-hopper | P5 push | 2026-11-12 | `createOrderForm` + agent tool `send_order_form` (refuses before-order-form fields missing, awaiting approval, expired, unpriced, opted out, no legal text in the language); HMAC link tokens; new link or new quote version → old link shows "Offer updated" with the new one. Seller can send from Quotes and orders |
| P5.4 | done | determined-hopper | P5 push | 2026-11-12 | Buyer pages `/f/[token]`: review, business details, terms with versions, sign; Offer updated, Expired, Price changed (accept → new version and link), test-payment strip, EN/HE switch with RTL, seller branding, "Secured by Sales at Scale" |
| P5.5 | done | determined-hopper | P5 push | 2026-11-12 | Payment provider: fake provider with HMAC-signed events (`/api/payments/fake`), `handleProviderEvent` is the only path to Paid (signature, dedupe, amount, currency, account, order checked); price re-check before payment; recurring consent; "Simulate successful / declined payment" per UX. Agent tool `check_payment` |
| P5.6 | done | determined-hopper | P5 push | 2026-11-12 | Bank transfer: buyer chooses it → Bank transfer expected; seller "Mark payment received" (only bank-transfer orders, audited) |
| P5.7 | done (partial) | determined-hopper | P5 push | 2026-11-12 | Signed document page `/f/[token]/document` from the write-once snapshot + signature + SHA-256 fingerprint; "Print or save as PDF" via the browser. A stored PDF file comes later |
| P5.8 | done (stub) | determined-hopper | P5 push | 2026-11-12 | Confirmations: system message in the buyer's conversation (EN/HE) and timeline events; seller email is a log stub until D8 |
| PC.A | done | determined-hopper | pilot pass | 2026-11-13 | Pilot completion lane A: migration `0007_company_golive`; Setup · Company (business details, sales rep, support contact on buyer pages, brand color shared with the order form); Settings (users and invites, notifications, contact hours with `isWithinContactHours`); Setup · Go live (checklist from real data, rollout choice, Go live) |
| PC.B | done | determined-hopper | pilot pass | 2026-11-13 | Lane B: structured Playbook editor (field rows with example question, objections, limits, never-do rows; stable keys); Knowledge with topics, suggested/approved/rejected, edit, approve all, and "Questions we couldn't answer" from real `lookup_knowledge` misses |
| PC.C | done | determined-hopper | pilot pass | 2026-11-13 | Lane C: Overview (Needs you queue, period numbers, setup progress, recent activity, sidebar badge); Admin · Activity feed (filters, paging); setup steps show completion |
| PC.D | done | determined-hopper | pilot pass | 2026-11-13 | Lane D: lead-card conversation (take over, reply as a person, hand back; delivery seam for P6); test-lab scenarios with pass/fail checks |
| PC.E | done | determined-hopper | pilot pass | 2026-11-13 | Playwright full-use-case simulation against a deployed site (`docs/e2e-simulation.md`, `npm run test:sim`) |
| P6.1–P6.8 | todo | | | | M6; needs D2, D6 → Milestone B |
| P7.1–P7.5 | todo | | | | M7 |
| P8.1–P8.7 | todo | | | | M8 |
| P9.1–P9.5 | todo | | | | M9 |
| P10.1–P10.6 | todo | | | | Pilot |

Phase rows are split into one row per step when the phase starts.

### Milestones

| Milestone | Definition | Status |
|---|---|---|
| A | Test lab deal → quote → signed form (EN + HE) → fake payment → Paid, as a CI E2E test | todo |
| B | Same deal on a test WhatsApp number, plus takeover and opt-out | todo |
| Pilot | Go-live checklist passes for the pilot seller; first real leads contacted | todo |
