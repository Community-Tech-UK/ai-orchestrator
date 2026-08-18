# WS14 Copilot Server Mode + Claude Flag Pack — Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-13-fable-implementation-plan_completed.md](2026-07-13-fable-implementation-plan_completed.md) (§WS14)

**Prerequisites:** rebuilt + restarted app; standalone `copilot` CLI ≥1.0.7x installed (`@github/copilot` npm package — the bundled SDK lives inside it); Claude CLI ≥2.1.2xx. These checks need real CLI runtimes.

## 1. Copilot server mode activates

- Steps: create a Copilot instance; send one prompt. Check the app log.
- Expected: log line "Copilot adapter using SDK server mode" with the package version; spawn-mode diagnostics show `app-server` (not `subprocess-exec`); NO per-turn `copilot -p` child processes appear after the first turn (one persistent runtime process instead).

## 2. Real context occupancy

- Steps: run a few turns on the server-mode instance; watch the context bar.
- Expected: the context bar reflects `session.usage_info` (used/tokenLimit) — it moves with real occupancy and is NOT flagged estimated (exec mode showed a rough cumulative estimate).

## 3. Live interrupt without respawn

- Steps: give the instance a long task; press interrupt mid-turn.
- Expected: the turn stops (session.abort), instance returns to idle WITHOUT a respawn cycle, and the next prompt works in the same session (history intact).

## 4. Steering probe (decides `liveSteer`)

- Steps: while a turn is running, send another message.
- Expected observation to record: does the runtime steer the active turn, queue it, or error? If it genuinely steers, flip `liveSteer: true` in `CopilotCliAdapter.getAdapterCapabilities()` (currently false pending this evidence) and re-run the loop-coordinator steering check.

## 5. Session continuity across restart

- Steps: restart the instance (Restart button) after a few turns.
- Expected: server mode resumes the SAME Copilot session id (log `resumed: true`); the conversation continues with context intact; resume proof shows native/confirmed.

## 6. Exec fallback intact

- Steps: temporarily rename the bundled SDK dir (`<pkg>/copilot-sdk` → `copilot-sdk.bak`), restart the app, create a Copilot instance; then restore the dir.
- Expected: instance works exactly as before this feature (exec-per-message, `-p` child per turn); log shows "Copilot SDK unavailable"; spawn mode `subprocess-stream`/`subprocess-exec`. No errors surfaced to the user.

## 7. Version indirection check

- Steps: compare `copilot --version` with the log's `sdkVersion` on server-mode start.
- Expected: the loaded SDK package version matches the running CLI's package tree (the loader follows the resolved bin symlink). If the CLI self-updates to a version dir outside the npm tree, record the discrepancy here and adjust the loader's resolution accordingly.

## 8. Claude flag pack

- Steps: set `claudeFallbackModel` to `claude-sonnet-5` ($AIO_MCP settings or Settings UI); create a Claude instance; inspect the spawned process args (`ps`).
- Expected: args include `--fallback-model claude-sonnet-5`; env includes `DISABLE_UPDATES=1` and `CLAUDE_CODE_TMPDIR=<tmp>/aio-claude-tmp/<session>` (dir exists). With the setting empty: no `--fallback-model` flag.

## 9. Claude env scrub gate (decides the `claudeSubprocessEnvScrub` default)

- Steps: enable `claudeSubprocessEnvScrub`; create a NON-yolo Claude instance; trigger a Bash tool call that needs approval, and an RTK-routed action if RTK is enabled.
- Expected observation to record: the PreToolUse permission hook still fires (approval prompt appears) and RTK still works — i.e. `ORCHESTRATOR_*` vars survive the scrub. If they do, flip the setting default to ON; if not, keep OFF and note the CLI behavior here.

## 10. Structured review verdicts

- Steps: run a cross-model review with Claude as a reviewer (e.g. /review or the loop's fresh-eyes gate with claude reviewer configured).
- Expected: the reviewer one-shot is spawned with `--json-schema`; the response parses first-try (no "format-repair retry" log line for claude reviewers).

## Evidence run — 2026-07-29 (dev app, live Copilot + Claude)

**The headline: checks 1–7 were written against an implementation that is no longer on the
interactive path.** WS14's "SDK server mode" (`CopilotCliAdapter` + `copilot-server-mode.ts`) is not
what a Copilot instance uses today. `adapter-factory.ts:359-364` routes Copilot to
`AcpCliAdapter` with `adapterName: 'copilot-acp'`, spawning:

```
copilot --acp --stdio --no-auto-update --log-level none --allow-all-tools --allow-all-paths
```

`CopilotCliAdapter` survives only for model discovery (`listAvailableModels()` from
`cursor-copilot-cli-discovery-service.ts` and the mobile gateway) — not for interactive sessions.

Consequently **none** of check 1's four expected log lines fire. Counted over the run:

| Log line | Occurrences |
| --- | --- |
| `Copilot adapter using SDK server mode` | **0** |
| `Copilot bundled SDK loaded` | **0** |
| `Copilot SDK unavailable` | **0** |
| `Copilot server mode failed to start` | **0** |

Also worth recording: the installed CLI is **`@github/copilot@1.0.62`**, below this doc's stated
`≥1.0.7x` prerequisite — but that is not why server mode is absent. The SDK bundle *is* present
(`…/@github/copilot/copilot-sdk/`); the code path simply is not reached.

So checks 1–7 cannot pass as written. What follows is the **behaviour** each check was protecting,
re-tested against the adapter that is actually live.

| Check | Verdict against the live ACP adapter |
| --- | --- |
| 1 — server mode activates | **OBSOLETE as written**; the behavioural half (persistent process, no per-turn `copilot -p`) **PASSES** |
| 2 — real context occupancy | **FAIL** — see LT-018 |
| 3 — live interrupt without respawn | **PASS** |
| 5 — session continuity across restart | **PASS** functionally; the `resumed: true` log assertion is unobservable |
| 4, 6, 7 | **NOT RUN** |
| 8, 9, 10 (Claude-side) | **NOT RUN** |

### Check 1's behavioural half — PASS

Instance `pv2qbdmqk`, `/tmp/aio-lt-ws14`, model `gemini-3.1-pro-preview` (Copilot's default after
`opus[1m]` was correctly rejected for this provider). One persistent process pair survives across
turns:

```
5895  4589  node …/bin/copilot --acp --stdio …
5896  5895  …/@github/copilot-darwin-arm64/copilot --acp --stdio …
```

No per-turn `copilot -p` children appeared after any turn. That is the property check 1 exists to
guarantee, and it holds — just via ACP rather than the SDK.

### Check 2 — FAIL (new defect LT-018)

After **three** real turns the context bar never moved:

```
after turn 1:  {used: 0, total: 200000, percentage: 0}
after turn 2:  {used: 0, total: 200000, percentage: 0}
after turn 3:  {used: 0, total: 200000, percentage: 0}
```

No `cumulativeTokens` key is present at all — compare a Codex instance in the same session, which
reported `{used: 23930, total: 258400, percentage: 9.26, cumulativeTokens: 23930}`.

This is not a declared gap. `acp-cli-adapter.ts:349-362` explicitly declares, for the
`copilot-acp` profile, `occupancyReporting: 'aggregate-only'` and
`cumulativeReporting: 'available'`. Both are contradicted by the observed state. Filed as
**LT-018**.

### Check 3 — PASS

Turn started (status sampled `busy` at 1.5 s), `interruptInstance` returned `{interrupted: true}`,
and the instance returned to `idle` with **no respawn**: `adapterGeneration` **1 → 1** and session
id `cd6e2f75-f895-4e28-b7af-1c09271f89ad` unchanged. The next prompt worked in the same session and
recalled the codeword **FALCON** given before the interrupt. History intact.

### Check 5 — PASS functionally

`restartInstance` returned `{success: true}`. The Copilot session id was **preserved**
(`cd6e2f75-…` before and after, `adapterGeneration` 1 → 2), and the restarted session recalled
**FALCON**, so the conversation continued with context intact.

The check's specific log assertion (`resumed: true`) does not appear — again because it was written
for the SDK server-mode path. A `BaseCliAdapter "Stream idle timeout exceeded"` warning
(`adapter: copilot-acp`, 90 s) was logged during the run; it did not affect the outcome and is noted
only so the next runner is not surprised by it.

### What this doc needs

Checks 1–7 should be **rewritten against `copilot-acp`**, or explicitly retired if WS14's SDK server
mode is being abandoned. Their *intent* is still valid and mostly satisfied — persistence, interrupt
without respawn, and restart continuity all pass. Only occupancy genuinely fails, and that is now
LT-018.

Checks 4 (steering probe), 6 (exec fallback via renaming the SDK dir), 7 (version indirection) are
all specific to the SDK path and are meaningless until that decision is made. Checks 8–10 are
Claude-side and independent of all this — they remain straightforwardly runnable and were simply not
reached this session.

## 2026-07-30 — LT-018 is FIXED; check 2 is unblocked

Check 2 (real context occupancy) failed because the ACP adapter received per-turn token counts from
`session/prompt` but never emitted a `context` event, so a Copilot instance sat at 0 % for its whole
life.

`AcpCliAdapter` now publishes those counts, accumulating a session aggregate. Deliberately
conservative:

- `used`/`cumulativeTokens` are the **session aggregate**, not a fabricated context-window
  occupancy — ACP does not report occupancy, and inventing one would be worse.
- When the provider reports **no** usage, **nothing is emitted** — an absent bar is correct where the
  confident `0 %` was the defect.

On a re-run, expect the context figure to be non-zero and to **grow across turns**. Note that
check 2 as written asserts occupancy from `session.usage_info` under the old SDK server mode; the
honest reading against `copilot-acp` is "the bar moves with real token spend", which is now true.

This does not affect the larger finding in the 2026-07-29 evidence: checks 1–7 still target the
superseded SDK server-mode implementation and need a rewrite decision. Requires a rebuild:
`npm run build:main` run 2026-07-30 00:32.

## Evidence run — 2026-07-31 (dev app over CDP, rebuilt main; checks 2, 8, 9, 10)

**Setup.** `npm run build:main` exit 0, dev app on `--remote-debugging-port=9444`, real
`window.electronAPI`, workspace `/tmp/aio-lt31-ws14`. Live Copilot, Claude and Codex CLIs.

### Check 2 — real context occupancy — ❌ STILL FAILS; **LT-018 reopened**

The 2026-07-30 note above said this check was unblocked. It is not. Copilot instance `p2lr4r0fo`
(`gemini-3.1-pro-preview`), **three real turns**:

| Sample | `contextUsage` | `totalTokensUsed` |
| --- | --- | --- |
| after create | `{used: 0, total: 200000, percentage: 0}` | 0 |
| after turn 1 | `{used: 0, total: 200000, percentage: 0}` | 0 |
| after turn 2 | `{used: 0, total: 200000, percentage: 0}` | 0 |
| after turn 3 | `{used: 0, total: 200000, percentage: 0}` | 0 |

Identical to 2026-07-29. **Why**, established rather than guessed: this session added a one-line
diagnostic to `AcpCliAdapter` (there was previously *no* ACP logging at all — `grep -c AcpCliAdapter`
on the app log returned 0), rebuilt, and re-ran:

```
[INFO] [AcpCliAdapter] ACP turn reported no token usage; context bar stays empty for this session
       { profile: 'copilot-acp', usageKeys: null }
```

`usageKeys: null` — the installed Copilot ACP runtime returns **no usage object at all** from
`session/prompt`. The 2026-07-30 fix publishes an aggregate of counts that never arrive, so it can
never move off zero. Its second promise — *"no usage means no event, never a fake 0 %"* — is also
defeated upstream: `instance-create-builder.ts:82-86` seeds every instance with a literal
`{used: 0, total: 200000, percentage: 0}`, so the renderer is handed a confident zero before the
adapter is consulted at all. (The renderer already knows how to say `'Context window: no data'` —
`composer-toolbar.component.ts:352-353` — it is just never given an absent value.)

Full write-up, the two required changes, and why the wider one was **not** attempted unattended are
in the reopened LT-018 section of the register.

#### 2026-08-01 — LT-018 fixed in code (the seeded-zero half); live re-check outstanding

James delegated the design call ("whatever you think is best architecturally"). The fix makes the
missing fact **explicit** rather than making the numbers optional:

`ContextUsage` gains `occupancyReported?: boolean` (`src/shared/types/instance.types.ts` and the
renderer's copy). It is set **only** where a provider actually reports usage —
`instance-communication.ts:1631`, `instance.contextUsage = { ...usage, occupancyReported: true }`.
The create-time seed at `instance-create-builder.ts:82-86` is left exactly as it is, so it now
carries no flag, and the renderer treats that as unknown:

```ts
readonly ringPct = computed(() => {
  const u = this.contextUsage();
  // LT-018: an unreported occupancy is unknown, not zero.
  if (!u || u.total === 0 || !u.occupancyReported) return 0;
  ...
readonly ringTitle = computed(() => {
  const u = this.contextUsage();
  if (!u || !u.occupancyReported) return 'Context window: no data';
```

**Why a flag rather than making `used`/`total` optional.** Optionality reads cleaner but would force
revisiting ~15 unguarded `contextUsage.total` / `.used` arithmetic sites
(`context-attribution-service.ts:222`, `instance-event-forwarding.ts:294-326`,
`orchestrator-tools-step.ts:272`, …), each one a chance to break auto-compaction or budget maths for
a purely cosmetic gain. The flag states precisely the thing that was missing: these numbers are a
placeholder, not a measurement.

**A second defect found and fixed while auditing the writers.** `buildPostCompactionUsage`
(`compaction-runtime.ts:68-82`) rebuilds the usage object field by field and would have **dropped**
the flag — blanking the ring to "no data" after every compaction on providers that *do* report
occupancy, i.e. the fix would have introduced a regression on the healthy path. It now preserves it,
with the reasoning that a post-compaction `used: 0` is a real measurement. Pinned by an assertion in
`compaction-runtime.spec.ts`. Every other writer either spreads the previous object
(`instance-lifecycle.ts:1475`, `instance-communication.ts:1677`) or passes it whole
(`instance-persistence.ts:259`), so the flag survives; the `{used, total}` shape in
`instance-event-forwarding.ts:315` feeds the continuity store, not the ring.

Gates: `npx tsc --noEmit` clean; composer-toolbar 35 tests and compaction-runtime 12 tests pass.

**Outstanding — the live re-check.** Re-run check 2 against a rebuilt app on a **Copilot** instance
and confirm the ring reads *"Context window: no data"* rather than a confident 0 %, and separately
that a **Claude** instance (which does report) still shows real occupancy and keeps showing it
across a compaction. Check 2 stays **FAIL** until that is observed — the code fix is not being
counted as a pass.

### Check 8 — Claude flag pack — ✅ PASS (both branches)

With `claudeFallbackModel = 'claude-sonnet-5'`, instance `caetsccnn` (pid 40844):

```
claude --print … --model opus[1m] --fallback-model claude-sonnet-5 --effort high …
DISABLE_UPDATES=1
CLAUDE_CODE_TMPDIR=/var/folders/…/T/aio-claude-tmp/07f0927a-37fe-44da-800f-d2d5df6e220c
```

The tmp dir exists on disk (`ls -d` confirmed). With the setting reset to empty, instance
`cymzq2tbp` (pid 41188) spawned with **0** occurrences of `--fallback-model`, while
`DISABLE_UPDATES=1` and a per-session `CLAUDE_CODE_TMPDIR` were still present. Exactly the
documented expectation.

### Check 9 — Claude env scrub gate — ✅ RAN; verdict: **keep the default OFF**

With `claudeSubprocessEnvScrub = true` on a **non-yolo** Claude instance (`ckrduqh0b`, pid 41641), a
Bash tool call was requested (`echo LT31-SCRUB-PROBE`).

**The half the check asks about passes.** The PreToolUse permission hook still fires:

```json
{ "instanceId": "ckrduqh0b", "prompt": "Permission required: Claude wants to run Bash: `echo LT31-SCRUB-PROBE`",
  "metadata": { "type": "deferred_permission", "tool_name": "Bash" } }
```

The instance sat at `waiting_for_permission`, and the `AI_ORCHESTRATOR_*` variables survive the
scrub — they are carried inside each MCP server's own `env` block (codemem, browser-gateway,
computer-use all verified present in the spawned process), not the process environment the CLI
scrubs. So RTK routing and the orchestrator MCPs are unaffected.

**But there is a side effect that argues against flipping the default**, surfaced by the CLI itself
as an `error` entry in the transcript:

```
⚠ Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set
  (allowed_non_write_users hardening).
```

Harness still passes `--permission-mode acceptEdits` (confirmed in the spawned args), and the CLI
**overrides it to `default` at runtime** whenever the scrub variable is set. Turning this setting on
globally would therefore silently downgrade permission mode for every Claude instance — including
YOLO/acceptEdits sessions, which would start prompting.

**Recommendation: leave `claudeSubprocessEnvScrub` OFF by default.** The hook survives, so the
original worry was unfounded, but the permission-mode downgrade is a worse trade than the hardening
buys. Setting restored to `false`.

### Check 10 — structured review verdicts — ⚠️ NOT REPRODUCED (trigger not provoked)

The mechanism is present and wired: `headless-review-runner.ts:134-143` builds
`serializeReviewResultJsonSchema(reviewDepth)` and passes `jsonSchema` on every
`dispatchReviewerPrompt`, and `claude-cli-adapter.ts:1106` turns it into
`args.push('--json-schema', …)` — applied only when the resolved reviewer CLI is actually Claude.

What I could not do is make a review with **Claude as the reviewer** actually run. Two reviews fired
during the session, but both were selected before the config change and used the standing reviewers:

```
CrossModelReviewService  Cross-model review reviewers selected
  { selected: ['cursor', 'antigravity'], configured: ['cursor', 'antigravity', 'codex'] }
CrossModelReviewService  Review completed { cliType: 'antigravity', durationMs: 8648, repaired: false }
```

After setting `crossModelReviewProviders = ['claude']`, two further code-editing turns on a Codex
instance produced **no** review at all — the trigger depends on `crossModelReviewTypes` and turn
classification, which I did not manage to satisfy deliberately.

For the next runner, this is now a short job rather than an open question:

- `repaired: false` on the `Review completed` line is the signal that means "no format-repair
  retry" — assert on that, plus `--json-schema` in the spawned reviewer's args.
- Set `crossModelReviewProviders` to `['claude']` **before** creating the instance, since reviewers
  are selected per instance and a later settings change does not retarget an existing one.

Settings restored: `crossModelReviewProviders` back to `['cursor', 'antigravity', 'codex']`,
`claudeSubprocessEnvScrub` `false`, `claudeFallbackModel` `''` — all re-read and confirmed.

### Where the doc stands

| Check | Status |
| --- | --- |
| 1 — Copilot server mode activates | obsolete as written — Copilot routes through `AcpCliAdapter`, not SDK server mode |
| 2 — real context occupancy | **FAIL** — LT-018 reopened with root cause proven |
| 3 — live interrupt without respawn | substance **PASS** (2026-07-29, under ACP) |
| 4 — steering probe | obsolete as written (SDK-path specific) |
| 5 — session continuity across restart | substance **PASS** (2026-07-29, under ACP) |
| 6 — exec fallback intact | obsolete as written (SDK-path specific) |
| 7 — version indirection | obsolete as written (SDK-path specific) |
| 8 — Claude flag pack | **PASS** (2026-07-31, both branches) |
| 9 — Claude env scrub gate | **RAN** (2026-07-31); verdict recorded: keep default OFF |
| 10 — structured review verdicts | **NOT REPRODUCED** — mechanism verified in source, trigger not provoked |

Not renamed. Checks 1, 4, 6 and 7 need James's rewrite/retire decision (they protect an
implementation that no longer exists); check 2 is a live defect; check 10 needs one more run.

## Evidence run — 2026-07-31 (session 2) — check 10 driven; **two defects found**

The previous session recorded check 10 as "not reproduced — trigger not provoked". Both the trigger
and the outcome are now established.

**Getting the trigger right.** A review only fires when `OutputClassifier` sees code in the
assistant's *reply text* — tool-driven file edits do not count, and the aggregated content must
exceed 50 characters (`cross-model-review-service.ts:245,253`). Reviewers also exclude the
instance's own provider, so the instance must **not** be Claude if Claude is to review it. Working
recipe: set `crossModelReviewProviders = ['claude']` **before** creating a **Codex** instance, then
ask for a fenced code block in the reply with no tools.

```
Cross-model review reviewers selected { instanceId: 'x9yn60m2o',
                                        selected: ['claude'], configured: ['claude'] }
```

### Defect 1 — **LT-024**: the schema itself was rejected (FIXED this session)

```
Error: --json-schema is not a valid JSON Schema: no schema with key or ref
       "https://json-schema.org/draft/2020-12/schema"
Review failed { cliType: 'claude', error: 'Claude CLI exited with code 1' }
```

`serializeReviewResultJsonSchema` emitted Zod 4's `$schema` dialect key, which the CLI's validator
cannot resolve — so it rejected the whole document. **Every** Claude-reviewer review had been
failing at exit 1. Proven by direct A/B against the CLI (with the key → error; without it →
`{"verdict":"OK"}`), fixed by stripping the key, covered by a regression test, and re-verified live:
the error and the exit-1 failure are gone.

So the WS14 mechanism this check exists to prove — `--json-schema` reaching a Claude reviewer — is
real and correctly wired (`headless-review-runner.ts:134-143` → `claude-cli-adapter.ts:1106`). It had
simply never worked end-to-end.

### Defect 2 — **LT-025**: the reviewer returns an empty response

With the schema accepted, the review still fails:

```
01:26:45.835 Failed to extract JSON from review response { reviewerId: 'claude', responseLength: 0 }
01:26:45.835 Reviewer response failed validation — attempting one format-repair retry
01:26:56.641 Failed to extract JSON from review response { responseLength: 0 }
01:26:56.641 Reviewer format-repair response also failed validation
```

Zero bytes, twice, in ~12 s and ~11 s. Not a timeout — the budget was raised 30 s → 120 s for this
run and the empty responses returned just as fast.

**Control proving it is app-side:** the same 1,596-byte schema and an equivalent prompt run directly
against the same CLI binary return a complete, schema-conformant verdict (`overall_verdict:
"CONCERNS"`, every section populated). The CLI, schema and model are fine; the app's reviewer
dispatch loses the response.

### Defect 2 root cause and fix — **LT-025 FIXED**

Reproduced the adapter's exact spawn against the CLI and found it: in stream-json mode the verdict
comes back as a **`StructuredOutput` tool_use block**, not assistant text.
`ClaudeCliAdapter.parseOutput` sent text blocks to `content` and tool_use blocks to `toolCalls`, so
a reply that was *only* the structured answer left `content` empty. The parser now prefers the
structured payload (`structured-output-content.ts`), falling back to text when there is none.

### Check 10 verdict — ✅ **PASS**

Re-run after rebuild:

```
[CrossModelReviewService] Cross-model review reviewers selected { selected: ['claude'] }
[CrossModelReviewService] Review completed { cliType: 'claude', durationMs: 20470, repaired: false }
```

| Assertion | Result |
| --- | --- |
| reviewer one-shot spawned with `--json-schema` | ✅ (and the CLI now accepts it — LT-024) |
| response parses **first try** | ✅ `repaired: false` |
| no `format-repair retry` log line | ✅ **0** occurrences |
| empty reviewer responses | ✅ **0** |
| schema rejections | ✅ **0** |

A real structured review result reached the renderer. Both blockers (LT-024, LT-025) are fixed and
verified live.

Settings restored: `crossModelReviewTimeout` back to `30`, `crossModelReviewProviders` back to
`['cursor', 'antigravity', 'codex']`.

### Check 2 — ✅ **PASS, verified live 2026-08-01** (dev app, current working-tree code)

Driven end to end against a running dev app over CDP, on a real instance, not a seeded fixture.

**The placeholder premise, confirmed in the live app.** A freshly created orchestrated Claude
instance carries exactly the shape LT-018 is about — straight from `listInstances()`:

```json
{ "used": 0, "total": 1000000, "percentage": 0 }
```

No `occupancyReported`. That is the create-time seed, and before the fix every surface rendered a
confident zero off it.

**All four surfaces now render honestly for that instance:**

| Surface | Before | Observed now |
| --- | --- | --- |
| Composer ring label | `0%` | **`–`** |
| Ring title / aria-label | *(0 % implied)* | **`Context window: no data`** |
| Instance-header context bar | `0/1,000,000 (0%)` | **`no data`** |
| Sidebar footer fleet stat | `0% ctx` | **absent** — footer reads `1 session` only |

**And a real reading still renders as a real reading.** After a turn, the batch-update channel
carries the flag end to end and the ring follows:

```
onBatchUpdate → {"used":53844,"total":1000000,"percentage":5.3844,"occupancyReported":true}
renderer component contextUsage() → same object, occupancyReported: true
DOM .ctx-ring__label → "5%"
```

So the fix is not "hide the number" — the number returns the moment there is one.

#### A false alarm I nearly filed, worth recording

On the first turn I sampled the DOM immediately after `sendInput` returned and saw main at
`used: 53809, occupancyReported: true` while the renderer still held `{used: 0, …}` and the ring
still read `–`. I wrote that up as a live delivery defect. **It was not** — it was a stale read:
I sampled before the batch update had propagated. Re-running with an `onBatchUpdate` listener
attached showed **3** updates carrying `occupancyReported: true`, the renderer signal updating, and
the DOM moving to `5%`.

The trap is that `listInstances()` reads **main-process** state synchronously while the renderer is
updated asynchronously over `instance:batch-update`, so the two are legitimately out of step for a
moment. Comparing them at a single instant proves nothing. Attach the listener first.

**Check 2 passes on both halves.** LT-018's remaining open item is unchanged and separate: change 2,
the `copilot-acp` capability declaring `cumulativeReporting: 'available'` when the installed runtime
sends nothing.

## Evidence run — 2026-08-11 (dev app, CDP) — check 2 live re-check

**Check 2's outstanding live re-check is done. LT-018 PASSES. A new, adjacent defect — LT-034 — was
found by the same run, so check 2 does not close.**

Setup: `npm run build:main` exit 0, dev app on `--remote-debugging-port=9444`, real
`window.electronAPI`, workspace `/tmp/aio-lt-ws14b`, live Copilot + Claude CLIs.

### The LT-018 assertions — all three PASS

The 2026-08-01 note left three things to observe. Each was observed directly, in the rendered DOM
rather than inferred from state:

| Assertion | Observed |
| --- | --- |
| a never-reported instance reads *"Context window: no data"*, not a confident 0 % | `title` **and** `aria-label` = `Context window: no data`; `ringPct()` 0; `contextUsage` = `{used:0,total:1000000,percentage:0}` with **no** `occupancyReported` key |
| a reporting instance still shows real occupancy | resident Claude `cirvo8m3l` → `{used: 56 902, total: 1 000 000, percentage: 5.69, occupancyReported: true}` |
| the flag survives a compaction | `compactInstance` → `newUsage` carries `occupancyReported: true` with `source: 'post-compaction-reset'`; after the restart settled, `{used: 43 959, percentage: 4.40, occupancyReported: true}` |

That last row is the specific regression the 2026-08-01 gate caught in `buildPostCompactionUsage`,
now confirmed live rather than only by unit assertion.

### The premise of the 2026-07-31 failure has changed

The 2026-07-31 run proved Copilot reported **nothing** (`usageKeys: null`), so the aggregate could
never move off zero. That is no longer true — the installed Copilot ACP runtime now returns usage,
and the aggregate moves:

| After | `contextUsage` |
| --- | --- |
| create | `{used: 0, total: 200000, percentage: 0}` — no `occupancyReported` |
| turn 1 | `{used: 17 153, percentage: 8.58, occupancyReported: true, cumulativeTokens: 17 153}` |
| turn 2 | `{used: 51 535, percentage: 25.77, occupancyReported: true, cumulativeTokens: 51 535}` |
| turn 3 | `{used: 103 222, percentage: 51.61, occupancyReported: true, cumulativeTokens: 103 222}` |

So the 2026-07-30 fix does now do what it was written to do.

### …and that is exactly how the new defect surfaced — LT-034

Three **one-word** turns, and the ring reads:

```
"Context window: 52% used (103,222 / 200,000 tokens)"
```

The real occupancy after `TURN1`/`TURN2`/`TURN3` is a few thousand tokens. `used` is
`cumulativeTokens` — `acp-cli-adapter.ts:2017-2023` publishes the running *spend* total as
occupancy, clamped by `Math.min(…, 100)`, so a long session pins at a confident **100 %** with a
nearly-empty context.

This is not the adapter being dishonest: it declares `occupancyReporting: 'aggregate-only'`
(`:357`) and says so in its own comment (`:1998-2002`). The defect is that **nothing on the
rendering path reads that declaration** — its only consumer anywhere is
`context-safety-policy.ts:116`. The ring keys on `ContextUsage.occupancyReported`, which
`instance-communication.ts:1631` sets for *any* provider-reported usage. LT-018's flag distinguishes
*unknown* from *zero*; it does not distinguish *measured occupancy* from *cumulative spend*.

Not Copilot-only — `copilot-cli-adapter.ts:149`, `gemini-cli-adapter.ts:164`, non-resident
`claude-cli-adapter.ts:305` and the non-app-server `codex-app-server-adapter.ts:627` all declare
`aggregate-only` and feed the same ring.

Filed as **LT-034** with root cause, scope, two candidate fixes and acceptance criteria. Not fixed
unattended: the honest fix changes what a user-facing indicator *means* on four providers, and
option 1 vs option 2 (render the aggregate honestly, or emit nothing and fall back to "no data") is
a product call.

### Verdict

| Check | Status |
| --- | --- |
| 2 — real context occupancy | **FAIL**, but for a different and narrower reason than before: the number now moves, it is simply not occupancy. LT-018 half **PASSES**; LT-034 is the residual |

Checks 1, 4, 6, 7 still need James's rewrite/retire decision (they target the superseded SDK
server-mode path). Checks 3, 5, 8, 9, 10 unchanged. **Not renamed.**

Cleanup: instances `p5abkxd11`, `cirvo8m3l`, `c9qappgly` terminated; `/tmp/aio-lt-ws14b` removed.

## Evidence run — 2026-08-11 (session 2) — check 2 PASSES; checks 1/4/6/7 retired by decision

**This doc closes.** The two things holding it open — LT-034 and the pending rewrite-or-retire call
— are both resolved below.

### Check 2 — real context occupancy — ✅ **PASS**

LT-034 is fixed (option 1: label the aggregate honestly) and re-verified against the rebuilt app on
the exact scenario that produced the defect — a Copilot instance, three one-word turns:

| | Before the fix | After |
| --- | --- | --- |
| rendered ring (DOM `title`) | `Context window: 52% used (103,222 / 200,000 tokens)` | `Tokens used this session: 103,264 (this provider does not report context-window occupancy)` |
| `ringPct()` | 51.6 | **0** |
| `occupancyKnown()` | true | **false** |
| `contextUsage.occupancyIsAggregate` | *(field did not exist)* | **true** |

Control, same run — a resident **Claude** instance is untouched:
`Context window: 6% used (57,074 / 1,000,000 tokens)`, `ringPct 5.7`, `occupancyKnown true`.

Compaction preserves the flag, observed live: `newUsage` →
`{used: 0, cumulativeTokens: 103264, occupancyReported: true, occupancyIsAggregate: true,
source: 'post-compaction-reset'}`.

**Reading check 2 honestly.** As written it asserts occupancy from `session.usage_info` under the
SDK server mode that no longer exists. Under `copilot-acp` there is no occupancy to report at all,
so the assertion that survives is the one the 2026-07-30 note already identified: *the bar reflects
real token spend and never fabricates a window figure*. Both halves now hold — the number moves with
real spend, and it is labelled as spend rather than as occupancy. That is the strongest true
statement available for this provider, and it is what passes.

A second defect fixed alongside it, which no check asked for: the 80 % context warning
(`checkContextWarningThreshold`) fires on `percentage` and injects *"Your context is at N% capacity …
delegate to children"* **into the conversation**. On an aggregate-only provider that tracked total
tokens billed, so it would have fired over a nearly-empty context. It now returns early on an
aggregate reading.

### Checks 1, 4, 6, 7 — **RETIRED as written** (decision, 2026-08-11)

James delegated this call. They are retired rather than rewritten.

**Why retire and not rewrite.** All four test *mechanics specific to the SDK server-mode path*
(`CopilotCliAdapter` + `copilot-server-mode.ts`), which is not on the interactive path:
`adapter-factory.ts:359-364` routes Copilot to `AcpCliAdapter`. Check 6 renames the bundled SDK dir
to force an exec fallback, and check 7 compares the loaded SDK version to the CLI's — neither has
any meaning when the SDK is never loaded. Rewriting them would mean inventing new tests for a
different implementation and calling them WS14, which buries rather than records the change.

**What is deliberately kept, so nothing is lost by retiring them:**

| Retired check | The property it protected | Where that now lives |
| --- | --- | --- |
| 1 — server mode activates | one persistent process, no per-turn `copilot -p` child | **PASS** under ACP, 2026-07-29 evidence above |
| 4 — steering probe | does the runtime steer a live turn? | still open as a *question*, not a check — `liveSteer` stays `false` in `CopilotCliAdapter.getAdapterCapabilities()` until someone probes ACP steering deliberately |
| 6 — exec fallback intact | Copilot still works when the SDK is unavailable | moot: the SDK is never loaded on the interactive path |
| 7 — version indirection | loaded SDK version matches the running CLI | moot for the same reason |

Check 4's underlying question is the only live residual, and it is a **capability probe, not a
regression risk**: `liveSteer: false` is the safe value, so leaving it is correct until evidence
says otherwise. Recorded here rather than carried as a permanently-failing check.

### Final state — every check resolved

| Check | Status |
| --- | --- |
| 1 — Copilot server mode activates | **RETIRED** (behavioural half PASSED under ACP) |
| 2 — real context occupancy | ✅ **PASS** (LT-034 fixed + verified live) |
| 3 — live interrupt without respawn | ✅ **PASS** (2026-07-29) |
| 4 — steering probe | **RETIRED**; `liveSteer` stays `false` |
| 5 — session continuity across restart | ✅ **PASS** (2026-07-29) |
| 6 — exec fallback intact | **RETIRED** (SDK path not on the interactive route) |
| 7 — version indirection | **RETIRED** (same) |
| 8 — Claude flag pack | ✅ **PASS** (2026-07-31, both branches) |
| 9 — Claude env scrub gate | ✅ **RAN**; verdict recorded — keep default **OFF** |
| 10 — structured review verdicts | ✅ **PASS** (2026-07-31 s2, after LT-024 + LT-025) |

Renamed `2026-07-13-fable-ws14_livetest_completed.md`.

Cleanup: instances `pmb2ugxd6`, `cxolo0z3f` terminated; `/tmp/aio-lt34` removed.
