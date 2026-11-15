# Sales at Scale — MVP Plan and Product Decisions

Status: agreed direction, November 2026. Source spec: `Sales_Agent_Product_Spec_HE` (Hebrew, full scope). This document records what we build first, the decisions behind it, and what comes later.

## 1. What the MVP proves

A seller hands us a lead who asked to be contacted. An AI sales agent talks to that lead on WhatsApp, works out what they need, recommends products, handles objections, and ends the conversation with one of two outcomes:

1. **Signed deal and payment.** The buyer receives a link to the seller's order form, prefilled from the conversation, signs it and pays.
2. **Meeting with a person.** The buyer books a slot with the seller's sales rep, who gets the full context.

Everything in the MVP runs in test mode first (test payment, test numbers), then with one pilot seller.

**Pilot:** B2B temperature monitors for commercial fridges (restaurants, kitchens, food retail). The platform must not contain anything specific to this category. Every product and sales detail comes from the seller's own setup.

## 2. Scope

### In the MVP

- Lead intake: manual entry, CSV import, and a simple form/webhook that records consent.
- WhatsApp channel: opening template, free conversation, follow-up templates, human takeover.
- AI sales agent: free-running, guided by a playbook, acting through tools with hard server-side checks.
- Knowledge setup wizard: website, PDF/DOCX documents, catalog spreadsheets, free-text notes and recorded sales calls, turned into approved knowledge and a suggested playbook draft (3.14).
- Markets: one seller account sells in one or more markets, each inheriting the account defaults with overrides (3.13).
- Catalog of generic products and services with neutral units; prices in price lists per currency and market, each item with a one-time and/or recurring price (3.13).
- Quotes, the binding order form and payment, using the payment provider's test mode.
- Meeting booking from seller-defined availability.
- Lead card with a unified timeline, deal state and agent activity.
- Test lab (written chat), agent versions with draft, test, publish and rollback.
- Basic reports: funnel, outcomes, cost.
- Two environments: platform admin and customer (seller) workspace.

### Deferred, but designed for

| Area | Why deferred | What we do now so it is easy later |
|---|---|---|
| Voice calls | Telephony, latency and voice quality are a separate project | Channel-agnostic conversation model; the same agent, deal state, playbook and tools |
| Detailed roles | Not needed with one admin per account | User, role and scope tables exist; only two roles are defined |
| External lead API, CRM, inventory sync | Depends on pilot needs | Lead model has a source ID and dedupe rule |
| Visual flow builder | The loose agent model does not need one | Playbook is stored as structured data and could be shown visually later |
| Additional UI languages | English first | All UI strings use translation keys; layouts support RTL |
| Advanced QA (scoring, sampling, staged rollouts) | Needs volume | Every conversation is stored with agent version, tools used and knowledge used |

## 3. Key decisions

### 3.1 Conversation control: a loose agent with hard tool checks

We do not use a fixed stage-by-stage flow or a visual flow builder. Sales conversations move back and forth, and rigid stages add complexity without adding safety.

| Piece | What it is | Controlled by |
|---|---|---|
| **Deal state** | Live checklist of what is known and missing: qualification fields, products discussed, objections and how they were handled, next best action | Agent updates it, the system stores it with provenance |
| **Playbook** | Sales goal, discovery questions, objection answers, tone, when to offer a meeting, when to hand off | Seller admin, created by the wizard |
| **Knowledge** | Approved facts with a link to their source | Seller admin, created by the wizard |
| **Tools** | Catalog search, fit check, knowledge lookup, create quote, send order form, book meeting, hand off to human, check payment | Platform, with server-side preconditions |
| **Safety rules** | Consent and opt-out, no card details in chat, no promises outside approved knowledge, WhatsApp policy | Platform, always on |

The agent decides what to say and which tool to use. The server decides whether a tool call is allowed. When a tool refuses, it tells the agent what is missing, so the agent can continue the conversation.

"Stages" (new, qualified, quoted, agreed, paid, meeting booked) are derived from the deal state for reporting. They are not gates the agent must pass through.

### 3.2 The binding agreement is the seller's order form, not the chat

- Nothing said in the chat is a binding agreement.
- Each seller defines one **order form template**: their legal text, terms, warranty and privacy wording, and the fields to collect (company, tax ID, billing and delivery addresses, signatory).
- The conversation only fills in the variable parts: buyer details, products and services, quantities, prices, discounts and delivery terms. All prices come from the server-side quote engine.
- The buyer opens the form from a personal link, reviews it, corrects allowed fields, signs (checkbox and typed name, with timestamp, IP and form version recorded) and pays in the same flow.
- The order is binding when the buyer signs. It is paid when a verified payment event arrives.
- A material change (items, quantity, price, delivery) creates a new quote version and a new form. The old link stops working.
- The signed form is stored as an immutable snapshot (PDF plus data) linked to the order.

This replaces the earlier idea that the agent judges buyer agreement. The agent can create a quote as soon as the minimum fit fields are known, because a quote is only an offer. The buyer's signature is the agreement.

### 3.3 Channel: WhatsApp only, channel-agnostic underneath

- One conversation model with a `channel` field. WhatsApp now, voice later.
- One lead timeline across channels.
- The agent, playbook, knowledge and tools do not know which channel they run in. The channel layer handles formatting, templates, buttons and delivery status.
- Agent memory is the deal state plus a rolling summary, not the full raw history. This keeps long WhatsApp threads manageable and lets a future voice call pick up where the chat stopped.
- The WhatsApp 24-hour service window is first-class: the agent, timeline and settings show window status, and outside the window only approved templates can be sent.
- Check Meta's "coexistence" option early if the pilot seller already uses the WhatsApp Business app on the same number.

### 3.4 Follow-ups are part of the MVP

- Each seller sets a follow-up policy: when, how many times and which approved template for each situation (no reply to the opener, quote sent but not signed, form signed but not paid, meeting no-show).
- A follow-up is cancelled automatically when the buyer replies, signs, pays, opts out or a human takes over.

### 3.5 Commercial rules stay strict

- Prices, discounts, taxes and totals are always computed on the server from the published catalog.
- Discounts above the seller's limit, or a product marked "requires custom pricing", send the quote to the seller admin for pricing instead of the buyer.
- The catalog supports one-time and recurring lines (for example a sensor plus a monthly monitoring plan) and quantities per site.
- Before payment opens, price, availability and quote validity are checked again.
- A paid order requires a verified payment event that matches amount, currency, seller and quote. Duplicate events are handled once.
- Every commercial action has an idempotency key.

### 3.6 Payment provider

- Build a payment provider interface: create checkout, verify event, refund, issue invoice, recurring charge.
- If the pilot seller is registered in Israel, a local provider (for example Cardcom, Grow, PayPlus or Tranzila) is likely needed for tax invoices and recurring billing. Stripe availability for Israeli merchants must be checked before choosing. This is still open.
- "Pay by bank transfer / invoice" is a valid outcome for B2B buyers: the form is signed and the order waits for manual payment confirmation by the seller admin.

### 3.7 Consent

- In the MVP we only contact leads who submitted their details and agreed to be contacted.
- Each lead stores its consent record: source, exact wording, time and channel. A lead without a consent record cannot enter the sales flow.
- Opt-out requests ("stop") are honoured immediately in every channel and cancel scheduled messages.
- Voice and recording consent will be separate flags on the same record later.

### 3.8 Users and roles

- The permission model (user, role, scope) is built fully, but only two roles are defined:
  - **Platform admin:** can do everything in every seller account. Acting inside a seller account shows a clear "acting as" banner and is written to the audit log.
  - **Seller admin:** can do everything inside their own account.
- Tenant isolation is enforced in every query, file, search index, tool call and provider event from day one.
- Sensitive actions (publish, export, delete, financial actions) are written to an audit log from day one.

### 3.9 Languages

- Platform UI: English. All strings use translation keys and layouts support RTL, so Hebrew and other languages can be added without redesign.
- Buyer conversations: English and Hebrew from the start. The agent answers in the buyer's language.
- Knowledge stays in its source language. Sensitive commercial wording (price terms, warranty, legal text) uses approved translations, not live machine translation.
- The order form template has a version per language.

### 3.10 Agent versions

- A published agent version is a fixed package: playbook, approved knowledge snapshot, tools, LLM model and settings, and test results.
- Changes are made in a draft, tested in the test lab, then published. Rollback is one action.
- Each conversation records the agent version it ran on.
- A model change is a new version and goes through the test lab like any other change.

### 3.11 Meetings and notifications

- The seller admin sets weekly availability in the platform. The agent offers free slots, the buyer picks one, and both sides receive a confirmation with a calendar invite. Google Calendar sync comes later.
- Takeover requests, custom-pricing quotes, meetings and failed payments notify the seller admin by email or WhatsApp, so nothing waits unseen in the platform.

### 3.12 Technical baseline already on `main`

Agreed with the parallel sessions through the team channel (issue #2, `docs/TEAM.md`, `CLAUDE.md`):

- Stack: Next.js 16 (App Router), TypeScript, Clerk for sign-in, Drizzle ORM on Neon Postgres, deployed on Vercel.
- Platform admin = the existing `super_admin` role (set only from `SUPER_ADMIN_EMAILS`), working under `/sadmin`. All authorization checks run on the server.
- Seller admin is scoped to one seller account, so it does not fit the current global `user_role` enum. Proposal for when the data model is built: a `seller_accounts` table and an `account_members` table (account, user, role), with `seller_admin` as the only MVP role. Every seller-side query filters by the account. This is a schema change, so it must be claimed in the team channel (one migration in flight at a time).
- Workflow: direct pushes to `main` through the release queue, after `npm run lint` and `npm run build` pass.

### 3.13 Markets, price lists and a generic catalog (decided 15 Nov, after the first UAT)

The platform serves any seller in any industry, and its purpose is to help sellers expand into new markets. Nothing in it may assume the pilot's product or a single country.

**Account and market**
- The **account** is the seller company: legal details, brand, owner and users, our billing to them. It holds the defaults.
- A **market** is where and how the seller sells: countries or regions, selling languages, time zone, currency, price list, its WhatsApp number (later its phone numbers), order-form legal texts, tax handling (prices with or without VAT), payment methods, contact hours and holidays, follow-up rules, and an optional playbook overlay for local tone and customs.
- Every market setting shows "Same as account default" with an Override switch. Most sellers override only a few things.
- Every lead is assigned a market at intake (phone country code, a form field, or the intake key's market). The market decides language, hours, prices, legal texts and channel for that lead.
- Creating an account creates its first market, the **home market**, from the values in the create form. The create form says "Home market" instead of "Market", and selling languages belong to the market.
- MVP: the UI supports adding markets; leads, quotes, orders, price lists, WhatsApp numbers and order-form texts carry a market reference from now on.

**Catalog and price lists**
- A **catalog item** describes what is sold: name, description, SKU, kind (**Product** or **Service**), unit, fit rules. It holds no price.
- **Units** are neutral: a pick list (item, user/seat, site/location, device, licence, hour, day, month, kg, package) plus a custom unit with singular and plural forms. No interface text uses pilot words as examples.
- A **price list** holds prices: name, currency, prices shown with or without VAT, valid from. For each item it can give a **one-time price**, a **recurring price** (monthly or yearly), or both, each with optional volume tiers. An item may be left out of a price list, which means it is not sold where that list applies.
- Each market uses one price list. Several markets can share one (for example euro markets), or each can have its own. "Copy price list and adjust by X%" helps create new ones.
- A quote freezes the price list and its version, like it freezes the catalog version.
- **Setup and installation fees** are separate Service items (usually per site), so they appear on their own line on quotes, order forms and invoices and can be discounted or waived within the limits. A fit rule **"Add automatically with"** adds them when a product is added, optionally per site; the seller marks whether the buyer can remove them.
- MVP: one price list is created with the home market; the model allows many.

**Plan and limits**
- Until billing exists, the plan only sets defaults. The monthly spend cap and the daily new-conversation limit are enforced from P6 (when WhatsApp and AI costs start): a warning to the seller at 80%, and at 100% no new outgoing conversations (replies to buyers already in a conversation continue). Until then the admin form says they are not enforced yet.

### 3.14 Knowledge from sources, including recorded sales calls (P8)

- **Sources:** website pages, documents (PDF, DOCX), price lists (CSV, XLSX), free-text notes, and recorded sales calls (MP3, WAV, M4A). Recorded calls are now in the MVP; they are the best evidence of how the seller actually sells.
- **Calls** are transcribed with speakers separated and the language detected. From each call the system suggests: discovery questions, objections with the answers that worked, the usual order of the conversation, product facts, and pricing or discount patterns.
- Every suggestion links to its source, down to the timestamp in a recording. The admin approves, edits or rejects it.
- **Generate playbook draft** builds the playbook (sales goal, fields to learn, objections and answers, limits, hand-off rules) from approved knowledge and call patterns, so the admin starts from a solid base and improves it.
- Safeguards: prices and discounts heard on calls are never used without explicit approval; facts about a specific customer are excluded from general knowledge; the uploader confirms the seller may use the recordings; personal data in transcripts is masked.
- "Add fact" remains the manual way to add one approved fact; it is also used when the seller answers a question the agent could not.

## 4. End-to-end MVP flow

1. A lead arrives (form, webhook, CSV or manual entry) with a consent record. The system checks phone, duplicates, consent and contact hours.
2. The agent sends an approved opening template on WhatsApp.
3. The buyer replies. The agent converses freely, guided by the playbook, and fills the deal state.
4. The agent recommends products via catalog search and fit check, and answers questions from approved knowledge with sources.
5. The agent handles objections using the objection library.
6. One of three paths:
   - **Order:** the agent creates a quote (server-priced) and sends the personal order-form link. The buyer reviews, signs and pays. A verified payment event marks the order paid, and the buyer and seller get confirmations.
   - **Meeting:** the agent offers slots, the buyer books one, and the seller admin receives the meeting with full context.
   - **Human:** the buyer asks for a person or the agent cannot proceed. Automation pauses and the seller admin takes over in the same chat.
7. Follow-ups run according to the seller's policy until an outcome or opt-out.

## 5. Screens

### Customer (seller) workspace — MVP

1. **Overview:** funnel, outcomes (paid, signed, meetings), items needing attention, cost.
2. **Leads list:** filters, status, owner, next action.
3. **Lead card:** unified timeline, deal state with provenance labels (buyer said / agent inferred / verified), agent activity (tools and knowledge used), quotes and orders, WhatsApp chat with takeover.
4. **Conversations inbox:** live WhatsApp threads, handoff requests, takeover.
5. **Setup wizard:** company profile, sources, extracted knowledge, gap questions, catalog, playbook, order form template, go-live checklist.
6. **Knowledge center:** sources, processing status, facts with sources, contradictions.
7. **Catalog:** products, variants, one-time and recurring prices, fit rules, custom-pricing flag.
8. **Playbook:** qualification fields, guidance and objection library, limits (discounts, meeting and handoff rules), follow-up policy.
9. **Agent versions and test lab:** draft, written test chat with tool and source trace, scenario tests, publish, rollback.
10. **Quotes and orders:** versions, form status, signature, payment status, manual payment confirmation.
11. **Meetings:** availability and booked meetings.
12. **Settings:** users, WhatsApp connection and templates, payment provider, notifications, contact hours.

### Buyer-facing — MVP

13. **Order form and payment page** (mobile-first, English and Hebrew RTL): seller identity, items, totals, terms, signature, payment, and states for expired link, price changed, payment pending and paid. Branded with the seller's logo and color (logo, pay button); Sales at Scale appears only as a small "Secured by Sales at Scale" line.
14. **Meeting booking page** (if not done fully inside WhatsApp).

### Platform admin — MVP

15. **Accounts:** list, create and pause seller accounts, "acting as" entry.
16. **Activity overview:** accounts, aggregate funnel, failures, cost per provider, alerts.
17. **Operations:** failed jobs, retries, provider status, usage and cost per account.

## 6. Go-live checklist (per seller)

A seller cannot contact real buyers until all of these pass:

- WhatsApp number connected and the opening and follow-up templates approved.
- Knowledge reviewed and approved.
- Catalog published.
- Order form template completed for each conversation language.
- Payment provider connected (or bank transfer enabled).
- Meeting availability set.
- At least one test conversation for each outcome passed in the test lab.

## 7. Open decisions

1. Payment provider for the pilot (depends on where the pilot seller is registered).
2. WhatsApp provider: Meta Cloud API directly or a BSP, and whether the pilot seller needs coexistence.
3. LLM provider and model for the agent.
4. E-signature level: is checkbox plus typed name enough for the pilot seller, or is a signature provider required?
5. Pilot seller's catalog, pricing model (hardware plus subscription) and discount limits.
6. Retention periods for conversations and documents.

## 8. Next steps

1. **Visual guidebook (design system):** colors, type, components, status language, RTL rules. Align before designing screens. First version: https://claude.ai/artifact/JqDhGuh7uQXqV1er6vwQgu (private until shared).
   Palette chosen: **Trust Blue**. Blue for main actions and links, violet for the AI agent, warm rose for people on the seller's team, green only for won outcomes.
2. **First screens:** lead card with timeline, deal state and takeover; seller overview; playbook in the setup wizard. Draft: https://claude.ai/artifact/Q4qUgGrnwScxyysAd1iHdM (private until shared).
3. **All MVP screens drafted** on the same canvas, each with a note below it explaining its functions: seller workspace (8 screens), agent setup wizard (8 steps plus versions and test lab), buyer pages (order form, payment, confirmation, updated offer in Hebrew, meeting booking) and platform admin (activity, accounts, operations and usage).
4. **Review round:** collect feedback on the canvas, then finalise the screens.
5. **Technical architecture document:** data model (tenant, lead, consent, conversation, message, deal state, quote, order form, order, payment attempt, agent version), channel adapter interface, payment provider interface, tool contracts.
6. **Build:** start with one end-to-end path using a small catalog and test payments, then add the wizard and test lab.
7. **Phase 2:** voice channel, more roles, external lead API and CRM, more languages.
8. **After the first UAT (15 Nov):** markets, price lists and the generic catalog (3.13) land before P6; knowledge from sources and recorded calls (3.14) in P8. Designs on the canvas page "Markets, pricing and knowledge".
