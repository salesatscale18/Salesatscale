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

## Knowledge pipeline (`lib/pipeline`)

- Stage 0 (no AI): one corpus document from the ready sources (by id, sections by position, each
  tagged `<section source locator>`), an input hash (prompt versions, model, corpus, stage data) and
  an estimate (chars/3.5 tokens). A finished run with the same hash is reused with no call.
- Stage 1 (facts) and stage 2 (playbook) send the same tools, system and corpus block (5-minute cache
  breakpoint), so stage 2 reads the cache. Output comes through two strict tools in one fixed tool
  list, not `output_config.format`, because changing the output format between requests breaks the
  cache. Prompts are versioned in `lib/pipeline/prompts/`.
- Corpora over about 150K tokens: stage 1 per source on `pipeline_light`, stage 2 on a trimmed corpus.
- Every run needs a confirm click after the estimate; tests use `ScriptedPipelineLlm`.

`aiUsageThisMonth(db, accountId)` and `platformUsageThisMonth(db)` (`lib/ai/usage.ts`) roll this up
per UTC calendar month.

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

## Tests

Tests never call the real API: the agent uses `ScriptedLlm`, the availability check a fake
`models.retrieve`.
