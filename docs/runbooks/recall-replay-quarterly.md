# Long-chat recall check (quarterly)

Asks one question: after Claude summarises a long chat at about 300,000 tokens, can it still answer questions about
earlier detail as well as it could before? The answer gates the own-chat context ceiling
(`ownChatContextCeilingTokens`, Phase D Step 5 / Decision 4). Re-run it every quarter, and before changing the ceiling.

Everything lives in `src/main/context/recall-replay/` (library, unit-tested) and `scripts/audit/recall-replay.ts` (driver).
Nothing here is imported by the app at run time except the pass/fail rule (`recall-evidence.ts`) and the compiled-in
evidence record (`src/main/core/config/own-chat-ceiling-recall-evidence.ts`).

## Run it

Run from the repository root, in a normal terminal or an agent session. It needs the Claude CLI signed in.

```bash
# 1. Coverage first. Zero cost, read-only. Lists real chats with a clean cut near 300K.
npx tsx scripts/audit/recall-replay.ts candidates

# 2. The real run. Three distinct conversations, 10-15 questions each. About $4-6 on Sonnet, hard-capped.
npx tsx scripts/audit/recall-replay.ts run --count 3 --model 'sonnet[1m]' --total-budget 8

# 3. Judge the saved record, and only if it passes write it into the app source.
npx tsx scripts/audit/recall-replay.ts evaluate --in _scratch/oct2-phaseD-round2/recall-evidence.json
npx tsx scripts/audit/recall-replay.ts write-evidence --in _scratch/oct2-phaseD-round2/recall-evidence.json
```

If the run stops with "the stored login has only N minutes left", refresh it in a normal terminal with
`claude -p "ok"` and run again. The script never refreshes a login itself (see Safety).

A cheap smoke test of the plumbing: add `--target-tokens 60000 --min-prompts 3 --model sonnet --count 1 --total-budget 1.5`.
A 60K run **cannot pass as evidence**. The rule requires both the requested target and each chat's cut to be
within 240K–360K tokens, as well as passing the other quality checks below.

Exploratory only: `--compact-instructions "<text>"` asks `/compact` to follow extra instructions. The app sends none, so such a run is labelled
`cli-replay-custom-compact` and **can never pass the gate**; use it to see whether different summarising wording would help before changing the app.

## What it does, per chat

1. Copies the transcript, cut at the last finished answer at or just below 300K, into a throwaway project folder the run
   creates and marks. The original is hashed before and after; the run fails if it changed.
2. Writes 10-15 questions about the first ~40% of the conversation. Each answer must be supported by a verbatim quote,
   and every number, path or identifier in the answer must appear in that quote.
3. **Before:** asks the questions in a fork of the full chat.
4. **After:** in a separate fork, runs `/compact`, checks the transcript shows a compaction (`preTokens` and
   `postTokens`), and asks the same questions.
5. A blind judge (candidates shuffled, labelled A/B) grades both sets: correct, partial, wrong, unknown.

The two answering runs use separate forks, so the "before" answers cannot leak into the summary.

## The rule (modelled thresholds)

Observed: the counts. Modelled: these thresholds, chosen by the implementer for "no cap ships if recall is clearly
worse" and kept in `recall-evidence.ts`:

- pooled over all chats, recall after summarising is at most 10 points below recall before (a partial answer counts half);
- no single chat loses more than 25 points;
- recall before is at least 50%, otherwise the questions show nothing;
- at least 3 distinct conversations with 10-15 questions each, each proven summarised from near 300K, record under 120 days old.

With about 36 questions, one question moves the pooled score about 3 points, so the 10-point margin is roughly three
questions: it tolerates noise but refuses a summary that forgets a lot.

## Cost and safety

- Each call has a spend cap and the run a hard total; the run stops before a call it cannot afford.
- The child CLI is given the current **access** token only, never the refresh token, so it cannot refresh (and so cannot
  damage) the stored login. It loads no settings, hooks, MCP servers or tools.
- Output, receipts and evidence hold counts, hashes and costs only. No path, question, answer or transcript text.
- Receipts (`recall-run-receipt.json`) and a seal (`recall-run-seal.json`, hashes of the receipt, evidence, script and
  library) are written before anything generated is deleted. The cleanup receipt follows.
- The throwaway folder is removed only if it carries this run's marker token. Fork state the CLI wrote for the fork
  sessions is removed; the original sessions are never touched.

## After a passing run

`write-evidence` replaces the compiled-in record. The own-chat migration (`settings-migrations-own-chat-ceiling.ts`, already called
from `runSettingsMigrations`) then sets the ceiling to 300,000 once, only where the stored value is still 0, and never changes
`machineContextCeilingTokens` or a value the user chose. A failing, stale or missing record leaves the migration doing nothing and
writing no marker. Before shipping a record, update the ceiling's settings text to say what the check showed, in words and without
the benchmark figures.

## Where results go

Counts from each run belong in the plan history file for the work that asked for the check, not in this runbook or in source.
The only result that lives in source is the compiled-in record in `own-chat-ceiling-recall-evidence.ts`, and it holds a record
only when the rule passes (`write-evidence` refuses anything else). While that constant is `null` the migration is a strict
no-op: it writes nothing, not even its marker.
The kit measures memory only (tools are off on purpose); it cannot say whether the assistant could look a detail up again.
