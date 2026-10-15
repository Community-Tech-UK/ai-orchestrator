# OpenCode provider (MiMo Token Plan) — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-22-opencode-provider_plan_completed.md](2026-09-22-opencode-provider_plan_completed.md)

**Prerequisites:** rebuilt and restarted Harness (`npm run build`, then relaunch the app) so
the OpenCode provider is in the running build. OpenCode 1.18.29 or later on PATH
(`opencode --version`). For checks 1–5, James's MiMo Token Plan key (Bitwarden item
"Xiaomi MiMo Token Plan API key"; base URL `https://token-plan-ams.xiaomimimo.com/v1`, so the
Europe region). These checks use James's real OpenCode home on purpose (spec Decision 6).

Everything an agent could run without the key was verified in-session on the free
`opencode/mimo-v2.6-flash-free` model (plan Task 6.2): streaming, tool rows, thinking, context
meter, YOLO-off allow and reject, interrupt, restart and resume, and a second concurrent
session.

## 1. Sign in with the Token Plan key, and Harness shows OpenCode as signed in

- Steps: in Settings › CLI Health, use the OpenCode sign-in button (or run
  `opencode auth login` in a terminal). Choose **Xiaomi Token Plan (Europe)**, paste the key.
  Then run `opencode auth list` and reopen CLI Health in Harness.
- Expected: `opencode auth list` shows one credential named "Xiaomi Token Plan (Europe)"
  (name only, no key). CLI Health shows OpenCode installed with no sign-in warning, and the
  model picker's OpenCode list gains the `xiaomi-token-plan-ams/*` chat models (no `*-tts*`
  rows) within about 5 minutes (discovery interval) or after an app restart.
- Why deferred: needs James's key typed into OpenCode's interactive login, in his real home.

## 2. A Token Plan session completes a multi-turn tool-using task

- Steps: new session, provider OpenCode, model `xiaomi-token-plan-ams/mimo-v2.6-pro`, YOLO on,
  in a scratch folder. Ask it to read a file, edit another file, then in a second message ask it
  to run a shell command and report the result. Send a third message referring to the first.
- Expected: all three turns finish `end_turn` with tool rows and thinking shown as thinking; no
  HTTP 400 about `reasoning_content` (MiMo's documented OpenCode caveat applies to the Anthropic
  protocol; these built-in providers use the OpenAI-compatible one). The Cost page records the
  turns with token counts and $0 cost (OpenCode reports $0 for the flat-fee Token Plan).
- Why deferred: needs the Token Plan key and live MiMo traffic.

## 3. Effort `high` is applied

- Steps: in the session from check 2 (or a new one on `mimo-v2.6-pro`), set Thinking to High
  in the picker, send a prompt, then run `opencode session list` and inspect the session, or
  start the same model with `opencode acp --print-logs --log-level DEBUG` outside Harness to see
  the variant used.
- Expected: no "Did not set effort" system line in the Harness transcript, and OpenCode's
  record for the turn shows the `high` variant.
- Why deferred: the free model offers no effort option; only Token Plan models do.

## 4. Long-context meter on a 1M model

- Steps: in a `mimo-v2.6-pro` session, send one prompt and read the context meter in the
  instance header.
- Expected: the meter's total is about 1,048,576 tokens (OpenCode's `usage_update.size` for
  the model; models.dev lists a 1,048,576 context), not 200,000.
- Why deferred: needs a Token Plan model; the free model's window is 200,000.

## 5. Rate-limit or plan-exhausted handling

- Steps: when a Token Plan rate limit or credit exhaustion happens naturally, note what the
  transcript shows.
- Expected: during OpenCode's own silent retries, the turn stays busy and AIO's stall notice may
  appear; if OpenCode gives up, the error ("Rate Limited", "usage limit reached …") parks the
  session on the provider-limit path instead of erroring it, and it resumes after the stated
  reset. Record the exact error text here so the classifier's patterns can be confirmed.
- Why deferred: cannot be forced without burning the plan's quota.

## 6. `run_on_node` on `windows-pc`

- Steps: install OpenCode on `windows-pc` (`npm install -g opencode-ai`), sign in there
  (check 1 on that machine), redeploy the worker if it predates this build, then from Harness
  run `run_on_node` with provider `opencode` and a small read-a-file task.
- Expected: the worker reports `opencode` in its detected CLIs, and the task completes with
  output streamed back.
- Why deferred: `windows-pc` was not connected on 2026-09-22 and has no OpenCode install.

## Status — 2026-10-04

Open: 2 (Check 5 cannot be forced; Check 6 is the packaged-app/`windows-pc` check, handled by the orchestrating session) · Closed with current evidence: 4 (Checks 1-4, one with a noted figure discrepancy). Evidence: [Evidence run — 2026-10-04 (batch C)](#evidence-run--2026-10-04-batch-c).

## Evidence run — 2026-10-04 (batch C)

Dev app from the working tree (HEAD `3d05e250e` plus other sessions' uncommitted work), isolated profile
`/tmp/aio-lt-1004-c`, CDP port 9481, focus emulation on. OpenCode 1.18.34. Real OpenCode home, as the spec requires.
Working folder `/tmp/aio-lt-1004-c-work` (deleted at cleanup). Evidence copies: `_scratch/lt-2026-10-04/c/`
(`log-c-slices.ndjson`, `log-acp-turn-completed-check*.ndjson`, `lifecycle-snapshot-*.ndjson`, screenshots, `notes.md`).
Launch note: `npx electron .` self-relaunches into a child that died within seconds under this shell on four attempts;
launching the same Electron binary directly with `--no-sandbox --js-flags=--max-old-space-size=8192
--remote-debugging-port=9481` (the flags the relaunch itself passes) stayed up.

### Check 1 — sign-in state and the model picker: PASS (end state observed; I did not perform the sign-in)

- `opencode auth list` shows exactly one credential, `Xiaomi Token Plan (Europe)`, type `api` (name only). Its
  `auth.json` was last written 22 Sep 14:18, so the key was typed by James on the day this check was deferred;
  I did not type or touch any credential.
- Harness `diagnoseAllClis` for OpenCode: `overall: healthy`, probes `cli_installed` and `cli_shadow_check` pass
  (v1.18.34), no recommendations. Note this build has no `authenticated` probe for OpenCode, so "no sign-in warning"
  means "no warning exists to show", not "an auth check passed".
- The live picker (`app-compact-model-picker`, OpenCode rail, `unifiedCatalog.displayModelsForProvider('opencode')`)
  lists ten `opencode/*` rows plus exactly four Token Plan rows: `xiaomi-token-plan-ams/mimo-v2.5`, `mimo-v2.5-pro`,
  `mimo-v2.6-flash`, `mimo-v2.6-pro`. No `*-tts*` row appears (the catalog holds four tts ids for that provider; they are
  filtered out). Screenshot `shot-opencode-picker.png`.

### Check 2 — multi-turn tool-using Token Plan session: PASS

Instance `iypujfrde`, OpenCode, `xiaomi-token-plan-ams/mimo-v2.6-pro`, YOLO on. Turn 1 (23:30:44): read `alpha.txt`
(3 lines, answered correctly) and edit `beta.txt` (file on disk now reads the requested line). Turn 2: ran
`uname -s && wc -l alpha.txt beta.txt` and reported the output correctly. Turn 3: asked what the first message
referred to; answered `alpha.txt` and the `beta.txt` change correctly.

- Each turn ended `ACP turn completed ... stopReason: "end_turn", classifierReason: "completed"`
  (`log-acp-turn-completed-check2.ndjson`). `errorCount` 0; no HTTP 400, no system or error rows in the transcript.
- Tool rows (`tool_use`/`tool_result`) present; thinking is attached to each assistant message as `thinking` blocks
  (3, 2 and 1 blocks), not as visible text.
- Cost: `costGetEntries` has three entries for the session, `cost: 0`, `isEstimated: false`, with real token counts
  (for example input 163, output 25, cache-read 30720, reasoning 10); `costGetSummary` groups them under the model with
  `totalCost: 0`. (Read through the cost IPC, not the Cost page UI.)
- Observation: the doc's "thinking shown as thinking" holds as a data shape (separate `thinking` field); I did not look at
  the rendered transcript.

### Check 3 — effort `high` is applied: PASS

Second instance `ipcitmao7` created with `reasoningEffort: "high"`, same model. One prompt completed (`end_turn`).
No "Did not set effort" line: the transcript has exactly the user and assistant rows. OpenCode's own record
(`opencode export ses_ef6f3f4eaffei7pJKwGqBrPtgh`): both messages carry `variant: "high"` (assistant tokens: reasoning 65).
For contrast, session 1 (no explicit effort; the picker said "Thinking: Provider default") recorded `variant: "low"`
on every message, so the explicit `high` was visibly applied, and the default is not the `high` a reader might assume.
(Where the `low` default comes from, OpenCode or Harness, I did not establish.)

### Check 4 — long-context meter on a 1M model: PASS on intent, figure differs from the doc

Meter total reads **1,000,000** (`contextUsage.total`; "3% ... 1,000,000" in the instance header), not 200,000. The doc
expected about 1,048,576. The figure is Harness's, not OpenCode's own: `applyOpenCodeGenerationBudget` writes
`limit.context` into the per-session OpenCode config with a hard-coded `1_000_000` fallback
(`src/main/cli/adapters/opencode-generation-budget.ts:69`, comment cites MiMo's published 1M window), and OpenCode's
ACP `usage_update.size` echoes that config value (confirmed with a bare ACP client: I configured 1048576 and the
`usage_update` reported `size: 1048576`). The models.dev catalog in the same app says 1,048,576. So the check's
literal number is superseded by the later hardening work; the occupancy percentage is about 4.6% high as a result.
Not filed as a defect (deliberate, documented in source); James may want the fallback aligned to 1,048,576.

### Check 5 — rate limit or plan exhausted: NOT RUN

Cannot be forced without burning the plan. The live plan is at 34.07B of 38B tokens (about 90%), so a natural limit is
plausible before 22 Oct; record the exact error text here if it happens. Still open.

### Check 6 — `run_on_node` on `windows-pc`: NOT RUN (out of this batch)

Needs the packaged app's paired worker; covered by the orchestrating session per the brief.

### Cleanup

Instances `iypujfrde`, `ipcitmao7` terminated (see the final cleanup record in the provider-hardening evidence run of
this batch). No setting left changed.
