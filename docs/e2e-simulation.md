# End-to-end simulation: one customer, from setup to closed deals

A Playwright run that drives the real product in a browser, the way a pilot
customer and their buyers would. It replaces the outside connectors with
their test doubles:
- the test channel instead of WhatsApp;
- the fake payment provider instead of a real one;
- logged email stubs instead of sending email.

Everything else is real: pages, server actions, database, migrations, pricing,
signatures and verified payment events.

Spec: `tests/e2e/simulation/full-use-case.spec.ts`. Config: `playwright.sim.config.ts`.

## Run it

```bash
E2E_BASE_URL=https://salesatscale18.vercel.app \
E2E_EMAIL=e2e+clerk_test@salesatscale.test \
E2E_PASSWORD='<password>' \
npm run test:sim
```

- `E2E_EMAIL` must be a **super admin** (listed in `SUPER_ADMIN_EMAILS`) on a Clerk **development** instance. `+clerk_test` addresses accept the code `424242` on dev instances.
- Each run creates its own seller account, "E2E Polar <run id>", with its own leads and orders. Run it only where test data is acceptable. Today that is production, which is used for development and testing until go-live (decision D9).
- `E2E_AGENT=1` adds the live agent chat in the test lab. It calls the Anthropic API and costs money, so it is off by default.
- An HTML report is written to `playwright-report/simulation/`.

## What it covers

| Step | Actor | What happens | What is checked |
|---|---|---|---|
| 1 | Platform admin | Creates the seller account (EN + HE) and enters it | Account created, invite issued, acting-as works |
| 2 | Seller | Catalog: 3 products (volume tier, monthly plan), fit rule, publish | Saved to draft, rule text, published |
| 3 | Seller | Company details and support contact, knowledge fact, playbook discount limit, publish the agent version | Saved, fact listed, version live |
| 4 | Seller | Order form: sample legal text in both languages, bank details | Settings saved, preview switches to RTL |
| 4b | Seller | Test lab: start a chat, take over, reply as a person, hand back (no model needed); contact hours; users; Go live checklist → Go live | Reply shown, hand back works, all checks pass, "Live since" |
| 5 | Seller → buyer (phone) | Lead 1 (EN): quote with a one-click fit fix → order form → missing fields refused → sign → declined card → successful card → signed document | Test-payment strip, EN/HE switch, no horizontal scroll, decline message, Paid only after the provider event, document fingerprint, lead Won, timeline |
| 6 | Seller → buyer (HE) | Lead 2: discount above the limit (self-approval with the reason logged) → Hebrew order form → bank transfer → Overview "Needs you" → seller marks received | RTL page, "Confirm bank transfer" in Needs you, Paid after marking |
| 7 | Seller → buyer | Lead 3: the catalog price changes after the link was sent → buyer accepts the new total | "The price has changed", new link, old link says "The offer was updated" |
| 8 | Seller | Opt out a lead | Opted out, no quote possible |
| 9 | Seller, platform admin | Orders tab, Overview, Admin activity | 3 orders, 2 paid; Needs you; went-live in the audit feed |
| 10 (opt-in) | Buyer ↔ agent | Live test-lab chat: qualify → quote → order form | Agent replies; trace shows the quote and order-form tools |

## What it does not cover (outside connectors)

- WhatsApp: delivery, templates, the 24-hour window.
- Real card payments and tax invoices.
- Sending email.

These get recorded-fixture integration tests when their phase is built (P6, P10).

## Other test layers

- **Unit and integration** (`npm test`, PGlite): business rules, permissions, account isolation, the agent tool loop with a scripted model, payment-event verification.
- **Smoke** (`npm run test:e2e`): local dev server, signed-out pages.
