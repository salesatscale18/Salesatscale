# AI models and costs

## Roles

Every model call names a role. The role decides the model id (`lib/ai/models.ts`).

| Role | Used for | Default | Env override |
|---|---|---|---|
| `agent` | The sales agent in buyer chats (new agent versions) | `claude-sonnet-5-5` (user decision 2026-11-16; Opus 5.5 by setting `AGENT_MODEL`) | `AGENT_MODEL` |
| `pipeline` | Turning knowledge into a playbook draft | `claude-sonnet-5-5` | `PIPELINE_MODEL` |
| `pipeline_light` | Cheap bulk steps of the pipeline | `claude-haiku-5-5` | `PIPELINE_LIGHT_MODEL` |

An agent version keeps the model it was created with; `AGENT_MODEL` only affects new versions.

## Prices and cost estimates

- The price table in `lib/ai/models.ts` holds USD per million tokens for input, output, cache read,
  5-minute cache write and 1-hour cache write. The figures come from the Claude API reference
  (2026-11) and must be verified on anthropic.com/pricing.
- `AI_PRICES` (JSON) corrects or adds prices without a deploy, e.g.
  `{"claude-opus-5-5": {"input": 4, "output": 20}}`. Fields left out keep their default.
- `estimateCostMicros(model, usage)` prices one usage record in USD micros. A model without a
  price is left out of totals and listed as "No price for" on the admin account page.
- Haiku 5.5 has a higher price for prompts over 100K tokens; the table uses the lower one.

## Where usage is stored

Each agent reply stores `messages.usage` (JSON): uncached input, output, cache read and cache write
tokens summed over the model calls of that turn, plus the model that answered. A turn that fails
after some calls stores its usage on the "could not reply" system message. The knowledge pipeline
stores usage per stage in `pipeline_runs.usage` (`input`, `output`, `cacheRead`, `cacheWrite`) with
the run's model and `cost_estimate_micros`; both count toward the spend cap and the platform budget.
Live voice calls store their priced cost on `voice_sessions` (see "Voice calls"), which counts too.

## Knowledge pipeline (`lib/pipeline`)

- Stage 0 (no AI): one corpus document from the ready sources (by id, sections by position, each
  tagged `<section source locator>`), an input hash (prompt versions, model, corpus, stage data) and
  an estimate (chars/3.5 tokens). A finished run with the same hash is reused with no call.
- Stage 1 (facts) and stage 2 (playbook) send the same tools, system and corpus block (5-minute cache
  breakpoint), so stage 2 reads the cache. Output comes through two strict tools in one fixed tool
  list, not `output_config.format`, because changing the output format between requests breaks the
  cache. Prompts are versioned in `lib/pipeline/prompts/`.
- Corpora over about 150K tokens: stage 1 per source on `pipeline_light`, stage 2 on a trimmed corpus.
- Limits suggested from sources are never "Never" rules. On approval each either updates a setting
  (discount without approval, an item's custom-pricing quantity in the price list's draft, the
  meeting or hand-over triggers) or becomes an approved exception (`playbook.exceptions`): the agent
  may offer it, and a quote that uses it (`create_quote` `exception`) waits for approval with the
  reason "Exception: <text>".
- Every run needs a confirm click after the estimate; tests use `ScriptedPipelineLlm`.

`aiUsageThisMonth(db, accountId)` and `platformUsageThisMonth(db)` (`lib/ai/usage.ts`) roll this up
per UTC calendar month.

## Agreed follow-ups (no model call)

When a buyer needs time, the agent agrees a time and calls `schedule_follow_up` (part of a normal turn). The platform scheduler (`/api/cron/follow-ups`, every 15 minutes) then sends a fixed template message in the buyer's language (EN/HE, `lib/follow-ups/rules.ts`) with no model call. The model runs again only if the buyer replies, as for any buyer message.

## Check model availability (free)

Admin › Operations › AI shows whether `ANTHROPIC_API_KEY` is set and has a **Check models** button.
It calls the Models API (`client.models.retrieve`) for each role's model id: no prompt, no tokens.
Per role it shows available or not, the display name, the context window and the max output.
A check is reused for 10 minutes and every real check is written to the audit log
(`ai.models_checked`).

## Account spend cap

The cap is set per account (`monthlySpendCapMinor`, in the account currency). The model cost in USD
is converted with approximate rates (`DEFAULT_USD_FX`, override with `AI_USD_FX`, e.g.
`{"ILS": 3.7}`). `spendState(db, accountId)` returns:

- `ok`: under 80% of the cap.
- `warn`: 80% or more. The app shows a banner, and Overview › Needs you shows an item.
- `capped`: 100% or more. No new WhatsApp openers (`spend_cap` refusal), no new test-lab chats
  (in the app or from a tester's phone). Replies in open conversations continue, and a buyer who
  writes first still gets an answer.

Settings shows "AI usage this month: ~X of cap". The admin account page shows the tokens by type
and the cost by model. Usage is an estimate from token counts, not the Anthropic invoice.

## Platform budget (development guard)

`AI_PLATFORM_MONTHLY_BUDGET_USD`: when set and the total platform cost this month is at or over it,
every model call refuses with `AiBudgetError` before reaching the API. The agent then hands the
chat to a person and sends no automated reply. Unset means no guard. A value that is not a number
counts as $0.

## Voice calls (`lib/voice`)

A realtime voice model is the agent in a browser call: browser ⇄ our WebSocket relay ⇄ model.
Our server owns the model connection; the browser never sees the instructions, the tool
definitions or a provider token. The model gets the same playbook (the chat prompt with its chat
lines replaced, `lib/agent/core/voice.ts`) and calls the same tools, which run on our server.

- **Modes** (`VOICE_REALTIME`): `off` (default, no calls), `scripted` (the free fake model,
  `lib/voice/scripted-realtime.ts`: a person can click through a whole call; cost 0, never counted
  in AI spend and never a scenario result for a version) and `live` (the paid realtime model through
  the Vercel AI Gateway; needs `AI_GATEWAY_API_KEY`). `VOICE_MODEL` picks the model
  (default `google/gemini-3.8-live`); `VOICE_MAX_CALL_SECONDS` can shorten the 10-minute maximum.
- **Spend rule**: a live call spends money. In development and testing it needs the owner's
  approval first, with an estimate (CLAUDE.md, "AI spend"). Tests only use the scripted model;
  the Gateway adapter refuses to be built under the test runner or without `VOICE_REALTIME=live`.
- **Prices**: `DEFAULT_REALTIME_PRICES` in `lib/ai/models.ts`, USD per million tokens by modality
  (text in/out, audio in/out, cached in), written down from the product brief (2026-11-19) and to be
  verified on the providers' price pages. `AI_PRICES` corrects them with the keys `textIn`, `textOut`,
  `audioIn`, `audioOut`, `cachedIn`. A call is priced when it ends from the last usage snapshot the
  model reported (snapshots, not increments); without any, from the call length (`usage.estimated`).
- **Where it is stored**: `voice_sessions` (one row per call: mode, model, duration, usage,
  `cost_micros`, answer times, how it ended). Live sessions' `cost_micros` count toward the account
  spend cap, the usage display and the platform budget (`lib/ai/usage.ts`). Spoken turns are
  conversation messages with `voice_session_id`, `spoken_at_ms` and, for agent turns, `answer_ms`.

## Tests

Tests never call the real API: the agent uses `ScriptedLlm`, the availability check a fake
`models.retrieve`, voice calls the free `ScriptedRealtime` with a hand-moved clock.

## Scored test rounds (`tests/e2e/demo/scored-round.spec.ts`)

Nine scripted test buyers (`tests/e2e/demo/buyers.ts`: straight, has a solution, price first, too
expensive, changes quantity, Hebrew, sceptic, think it over, competitor) talk to the real agent
through the buyer simulator (`/chat/<token>`) on a deployed site. Each buyer is a new simulated
buyer on a demo account, added through Leads › Add simulated buyer. The buyer's replies are fixed
steps that react a little to what the agent says. No model plays the buyer, and a buyer sends at
most 10 messages. Each conversation is scored in code against the checklist in
`tests/e2e/demo/score.ts`, with no model grading.

**Paid.** Every buyer message starts one agent turn, and each turn makes a few model calls. Under
the CLAUDE.md AI spend rule, each run needs the user's approval first, with what will run, how many
buyer messages and the estimated cost. Before asking:

- **Count the buyer messages.** A full round of nine is about 42 buyer messages if the agent
  follows the target flow (the dry round sends 42), more if it asks extra questions. The hard limit
  is 90.
- **Estimate the cost per turn.** At the table prices this is roughly $0.02–0.05 on Sonnet 5.5.
  Check it against `messages.usage` from a one-buyer run first (`SCORED_ROUND_BUYERS=1`).

Flags:

| Flag | Effect |
|---|---|
| `SCORED_ROUND_PAID=1` | Required for the paid round. Without it every test is skipped. It is never set in CI, and the spec also skips when `CI` is set. |
| `SCORED_ROUND_DRY=1` | Free. Runs the same scripts and scorer against a fake agent (`fake-agent.ts`), with no browser and no network. Takes precedence over `PAID`. The same dry round runs in `npm test` (`tests/unit/scored-round.test.ts`). |
| `SCORED_ROUND_BUYERS=1,2,6` | Runs only these buyers. The default is all nine. |
| `SCORED_ROUND_ACCOUNT=<slug>` | Reuses that account. Without it, a new demo account is created from /sadmin (free). |
| `SCORED_ROUND_STATE`, `SCORED_ROUND_TURN_MS`, `SCORED_ROUND_QUIET_MS` | Set the state file, the hard timeout per turn (default 180 s), and the quiet time after the reply (default 10 s). |

```
SCORED_ROUND_PAID=1 E2E_BASE_URL=https://salesatscale18.vercel.app E2E_EMAIL=... E2E_PASSWORD=... \
  npx playwright test -c tests/e2e/demo/playwright.config.ts scored-round --workers=1 --trace off
```

**Resuming a run.** The state file is `test-results/scored-round-state.json`. Each step is
recorded before its message is sent. If a run stops, a re-run skips the buyers that already
finished. A buyer that was cut off mid-conversation is not continued: its chat is read back for
free and scored as "interrupted". A paid turn is never retried. Delete the state file to start a
new round.

**Results.** They go to `test-results/scored-round/<timestamp>/`:

- `buyer-<id>-<key>.json` and `.md`: the transcript and its score, one pair per buyer.
- `scored-round-summary.md` and `.json`: score and failed checks per buyer, plus the number of
  buyer messages sent.
