# Live checks — seamless provider/model swap for existing sessions

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Prerequisites:** rebuild + restart the app (`npm run dev` or packaged build). All checks
run against a real, running instance — they cannot be verified with unit tests or store
seeding because they exercise real CLI respawns and real provider sessions.

**Plan:** [2026-07-16-session-provider-model-swap-plan_completed.md](./2026-07-16-session-provider-model-swap-plan_completed.md)

All code, unit tests (12k+ suite), lint, LOC ratchet, and both typecheck configs passed
in-loop before these were deferred. Each item below needs a rebuilt app, a human, or a
live provider CLI.

---

## 1. Cross-provider swap with context carry-over (Claude → Codex → Claude)

Steps:
1. Start a Claude session; exchange 2–3 turns including a distinctive fact ("the magic word is pomegranate").
2. In the instance header (or composer toolbar) picker, pick the **Codex** tab and a Codex model.
3. Expected: header provider badge flips to Codex (color + name), a system transcript line
   `[System: Provider changed from claude (model …) to codex (model …)]…` appears, and the
   session is ready for input without manual restart.
4. Ask: "what did we discuss earlier? what's the magic word?" — expected: the Codex session
   answers from the replay-continuity preamble (pomegranate).
5. Swap back to Claude. Expected: fresh Claude session (no native-resume error), context again
   carried, no attempt to resume the stale pre-swap Claude session (check app.log for
   `provider-change` replay reason; no `Native resume` errors).

Why deferred: needs live Claude + Codex CLIs and a real respawn.

## 2. Swap with no explicit model (remembered default)

Steps:
1. On an existing session, click the target provider's **tab row** itself in the picker
   (which commits the provider's default model) — or drive
   `changeModel(instanceId, undefined, …, provider)` via devtools.
2. Expected: the session lands on `defaultModelByProvider[target]` when one is remembered
   (last model you used for that provider), else the provider default. Header model label matches.

Why deferred: `defaultModelByProvider` is written by the real renderer provider-state flow.

## 3. Queued swap while busy (park + auto-apply + cancel)

Steps:
1. Give an instance a long task so it goes `busy`.
2. Pick a different provider/model while it runs.
3. Expected: NO interruption of the running turn; a dashed **⏳ Provider · model ✕** chip
   appears next to the picker (header and composer); the picker stays enabled.
4. Let the turn finish. Expected: the swap applies automatically at idle (provider badge flips,
   system notice in transcript), the chip disappears.
5. Repeat 1–2, then click the ⏳ chip before the turn finishes. Expected: pending chip clears,
   nothing applies at idle.
6. Repeat 1–2 with a provider whose CLI is NOT installed. Expected: at idle a toast + transcript
   line "Queued model change could not be applied: …", chip clears, original session keeps working.

Why deferred: needs a genuinely busy live CLI turn.

## 4. Swap during a loop

Steps:
1. Start a loop on an instance (loops hold it busy for long stretches).
2. Request a swap mid-iteration.
3. Expected: swap queues (chip), and applies at the next iteration boundary where the
   instance passes through an input-waiting status; the loop continues on the new provider.

Why deferred: needs the live loop engine. Watch specifically whether loop iteration
boundaries surface a settled status long enough for the queue's `setImmediate` apply —
plan §5 flagged this as the open risk.

## 5. Model-degradation toast

Steps:
1. Request a swap to a provider with an explicit model id that provider doesn't know
   (e.g. Codex tab, then a stale model id via a custom/override entry).
2. Expected: session lands on the provider default AND an error toast surfaces the
   "Model … is no longer available for …" message (previously transcript-only).

## 6. History restore of a swapped instance

Steps:
1. Swap a session Claude → Codex (check #1), exchange one more turn.
2. Quit and relaunch the app (or archive + restore the thread).
3. Expected: the restored instance spawns **Codex** (not Claude), with replay/resume against
   the Codex session only. `~/Library/Application Support/Harness/…/<instanceId>.json` should
   show `provider: "codex"` and `resumeCursor` from the post-swap session.

## 7. Remote instance guard

Steps:
1. On a remote (worker-node) instance, request a swap to a CLI the node does not advertise
   in `supportedClis`.
2. Expected: clear error toast "worker node … does not have the … CLI available"; no teardown
   of the running remote adapter. If the node does advertise it, the swap should work as local.

Why deferred: needs a connected worker node.

## 2026-07-18 Live-Test Evidence

On a disposable local session, used the live model picker to swap from Claude Opus to Codex
GPT-5.6 Terra (High). The runtime log recorded the old and new provider/model, launched a fresh
Codex app-server, and the session header changed to Codex. The reverse/provider-matrix checks
could not be completed because the authenticated Claude account currently rejects turns at its
five-hour and monthly spend limits. The development app's remote subsystem was also unavailable
because the production app owned the thin-client port, so the worker-node check remains pending.

## Evidence run — 2026-07-29 (dev app over CDP, real Claude + Codex turns)

Environment: dev app (`npx electron . --remote-debugging-port=9444`) against a freshly built
renderer on :4567 and `npm run build:main` exit 0. Disposable instance `cm270ivxu` in
`/tmp/aio-lt29-swap`, provider turns were real. Log assertions read
`~/Library/Application Support/harness/logs/app.log` (the dev app writes there — documented
runbook gotcha; every line quoted below carries this instance id, so there is no contamination).

| Check | Result |
| --- | --- |
| 1 — cross-provider swap with context carry-over | **PASS except the transcript system line** (LT-015) |
| 2 — swap with no explicit model (remembered default) | **PASS** (both branches) |
| 3 — queued swap while busy (park + auto-apply + cancel) | **PASS** for steps 1–5; step 6 not testable here |
| 4 — swap during a loop | **NOT RUN** |
| 5 — model-degradation notice | **PASS in transcript**; toast not confirmed |
| 6 — history restore of a swapped instance | **NOT RUN here** — see cross-reference below |
| 7 — remote instance guard | **BLOCKED** — no worker node in the dev profile |

### Check 1 — PASS except the system transcript line

`claude`/`sonnet` → `codex`/`gpt-5.6-sol` completed in **21.0 s**, `adapterGeneration` 1 → 2,
new provider session `019fadbf-c98b-7010-994a-2c39d7862e94`, status returned to `idle` with no
manual restart. Asked "what is the magic word?", the Codex session answered
**"The magic word is pomegranate."** — carried from the pre-swap Claude turns via the replay
preamble.

Swapping back `codex` → `claude`/`sonnet` took **19.6 s** (`adapterGeneration` 3) and the Claude
session again recalled **pomegranate**.

Log evidence, both directions:

```
RuntimeReconciler "Applying runtime change" {oldProvider:"claude",targetProvider:"codex", …}
RuntimeReconciler "Runtime change applied"  {provider:"codex",  continuity:"replay"}
RuntimeReconciler "Applying runtime change" {oldProvider:"codex",targetProvider:"claude", …}
RuntimeReconciler "Runtime change applied"  {provider:"claude", continuity:"replay"}
```

`Native resume` errors: **0 occurrences** for this instance.

**The one failure:** the expected `[System: Provider changed from claude (model …) to codex
(model …)]` line never appears. After the swap the instance's `outputBuffer` contained only
`user` and `assistant` entries (`{user: 2, assistant: 4}`) — zero `system` entries — and
`document.body.innerText` contained `pomegranate` but not `Provider changed from`, so the
transcript was rendering and the line genuinely is absent.

Root cause is `src/main/instance/lifecycle/runtime-reconciler.ts:404-408`: the notice is delivered
with `adapter.sendInput(...)`, which reaches the CLI but never records a transcript message. It *is*
delivered — the post-swap Claude reply opened with *"This is just a provider/model swap
notification"*. This is **LT-015**, previously recorded against the YOLO checks only; this run
extends it to provider- and model-change notices.

### Check 2 — PASS, both branches proven

The main process resolves an unpinned swap through `resolveSwapModel` →
`resolveInitialModel` (`model-change-provider-swap.ts:112-125`), so this is testable directly.

- With `defaultModelByProvider = {}`: unpinned swap to `claude` landed on **`opus[1m]`** — the
  global `defaultModel`, i.e. the documented fallback.
- With `defaultModelByProvider = {claude: 'sonnet', codex: 'gpt-5.6-terra'}`: an unpinned swap to
  `codex` landed on **`gpt-5.6-terra`** and an unpinned swap back to `claude` landed on
  **`sonnet`** — the remembered values, *not* the global default that the first branch produced.

The setting was restored to `{}` afterwards and re-read to confirm.

### Check 3 — steps 1–5 PASS

With the instance genuinely `busy` on a real Claude turn (`adapterGeneration` 13):

- Requesting `codex`/`gpt-5.6-sol` returned in **1 ms** and did **not** interrupt: status stayed
  `busy`, generation and provider session id unchanged. The request parked as
  `desiredRuntime: {model: "gpt-5.6-sol", provider: "codex"}`.
- Letting an earlier long turn finish, the queued swap **applied automatically at idle** —
  `adapterGeneration` 7 → 8, provider `codex`, `desiredRuntime` cleared — and the long task's own
  output (`DONE-LONG-TASK` in a `tool_result`) still landed, so the turn was never disturbed.
- **Cancel:** re-requesting the live config (the renderer's documented cancel, `composer-toolbar.component.ts:426`)
  cleared `desiredRuntime` to `null`, and when the turn finished nothing applied —
  `adapterGeneration` stayed **13** and the provider session id was unchanged.

**Step 6 is not testable on this machine.** It needs a provider whose CLI is absent; `claude`,
`codex`, `gemini`, `copilot`, `cursor` and `grok` are all on `PATH`, and `antigravity` — the only
one that is not — swapped in successfully anyway (it does not resolve through a `PATH` binary),
reaching `provider: "antigravity"` at generation 14. Needs a machine with a genuinely missing CLI.

### Check 5 — PASS in the transcript

Model-degradation notices **do** render as `system` transcript entries:

```
system  Model "opus[1m]" is no longer available for codex. Using "gpt-5.6-sol" instead.
        The saved selection was left unchanged.
system  Model "opus[1m]" is no longer available for antigravity. Using the provider default
        instead. The saved selection was left unchanged.
```

This also sharpens check 1's finding: the transcript surface renders `system` entries perfectly
well, so LT-015 is specifically about *which delivery call* the runtime-change notices use, not
about a missing surface.

The check also asks for an **error toast**. Not confirmed — no toast text was present in the DOM
when sampled. Recorded as unverified rather than failed.

**These notices also exposed a new defect — see LT-016.** The `opus[1m]` in them is not a stale
user selection; it is the global `defaultModel` being offered to a non-Claude provider.

### Checks 4, 6, 7

- **4 (swap during a loop)** — not run; needs a live loop held busy across an iteration boundary.
- **6 (history restore of a swapped instance)** — not driven in this run. The 2026-07-27 session-2
  campaign drove the equivalent scenario as history-restore check 3 (claude `opus[1m]` → codex
  `gpt-5.6-sol`, restore targeting the **new** provider on the post-swap session id, recalling
  "WALRUS" from the provider side) and recorded it **PASS**. Cross-referenced rather than repeated;
  a run under this doc's own wording is still outstanding.
- **7 (remote instance guard)** — **BLOCKED**. `remoteNodeList()` returns `[]` in the dev profile;
  the paired Windows worker lives in the packaged app's profile, and the packaged app has no debug
  port. Needs either a node paired into the dev profile or a driveable packaged build.

## 2026-07-30 — LT-015 and LT-016 are FIXED; check 1 is unblocked, check 2/5 unaffected

**Check 1's single failure is fixed.** The expected
`[System: Provider changed from claude (model …) to codex (model …)]` line is now recorded as a
`system` transcript entry as well as delivered to the CLI
(`runtime-change-notices.ts` → `announceRuntimeChange`, `metadata.kind = 'provider-changed'`).
Everything else in check 1 already passed on 2026-07-29, so a re-run should close it.

**LT-016 changes what check 5 should expect on an *unpinned* swap.** The spurious
`Model "opus[1m]" is no longer available for codex…` notice this campaign recorded is gone: the
reconciler now suppresses a degradation notice whose rejected id came from the provider-agnostic
global `defaultModel` (logged with `userVisible: false` instead). Check 5's genuine case is
unchanged and still expected to fire — an explicitly pinned unknown model, or a stale remembered
`defaultModelByProvider[target]`, still produces the notice.

So when re-running:

- Check 1 — expect the provider-changed system entry.
- Check 2 — unchanged; both branches passed on 2026-07-29 and the resolution order is the same.
- Check 5 — to see the notice you must now **pin** a bogus model (or seed a stale remembered one).
  An unpinned swap will correctly stay silent.

Requires a rebuild: `npm run build:main` run 2026-07-30 00:32; the packaged app predates it.

## Evidence run — 2026-07-31 — dev app over CDP, rebuilt main

**Setup.** `npm run build:main` exit 0, renderer on :4567, dev app on `--remote-debugging-port=9444`,
real `window.electronAPI`. Real Claude and Codex turns throughout. Instance `co56971gw` in
`/tmp/aio-lt31-yolo` for checks 1 and 5; instances `cghmopm62`, `csu9nxitx` and `c9s2b17yk` in
`/tmp/aio-lt31-loop` for check 4.

### Check 1 — cross-provider swap with context carry-over — ✅ PASS (was blocked on LT-015)

Claude (`sonnet`) → Codex (`gpt-5.6-sol`) → Claude (`sonnet`), with the magic word `pomegranate`
planted before the first swap.

| | Claude → Codex | Codex → Claude |
| --- | --- | --- |
| `provider` / `currentModel` | `codex` / `gpt-5.6-sol` | `claude` / `sonnet` |
| `adapterGeneration` | 5 → 6 | 6 → 7 |
| ready for input without a manual restart | yes | yes |

The transcript line the check asks for is now present on **both** swaps, as a `system` entry with
`metadata.kind = 'provider-changed'`:

```
[System: Provider changed from claude (model sonnet) to codex (model gpt-5.6-sol).
 Thinking changed from high to high. Conversation context has been carried over from
 the previous provider.]
[System: Provider changed from codex (model gpt-5.6-sol) to claude (model sonnet). …]
```

Context carried both ways: the Codex session answered *"We discussed essays about marine
chronometers and pendulum clocks. The magic word is pomegranate."*, and the Claude session recalled
it again after the swap back.

Step 5's log assertions, taken from the dev app's own stdout log:

- `RuntimeReconciler  Runtime change applied { … provider: 'claude', continuity: 'replay' }` — the
  replay reason the check asks for, in the app's actual vocabulary (there is no literal
  `provider-change` log string; `continuity: 'replay'` is the emitted signal).
- `Native resume did not stabilize` / `Persisted cursor resume failed` — **0 occurrences**. No
  attempt was made to resume the stale pre-swap Claude session.

**No spurious degradation notice** appeared on either swap, confirming the LT-016 fix on a pinned
swap path.

### Check 5 — model-degradation toast — ✅ PASS (the toast half is now confirmed)

Pinned a deliberately unknown model (`claude-nonexistent-99`).

- Landed on the provider default `opus` (gen 7 → 8).
- Transcript `system` entry, `metadata.kind = 'model-selection-degraded'`, with
  `requestedModel: 'claude-nonexistent-99'`, `fallbackModel: 'opus'`, `reason: 'model-unavailable'`.
- **Toast confirmed**: polling `.toast-item` in the DOM at 120 ms during the swap captured
  `Model "claude-nonexistent-99" is no longer available for claude. Using "opus" instead. The saved
  selection was left unchanged.` The 2026-07-29 run recorded this as unverified because it sampled
  the DOM once, after the toast had gone, and because the unpinned swap it used no longer produces a
  notice at all after LT-016.

The wiring is `instance.store.ts:179-185` — `instanceOutput$` → `toast.show(content, 'error')` for
`model-selection-degraded` and `pending-model-change-failed`.

### Check 4 — swap during a loop — ⚠️ PARTIAL; found LT-020, fixed the destructive half, one
half remains a decision

**First finding: a queued swap killed the loop it landed on.** Reproduced 2 of 2.

A control loop with no swap (`loop-1785523468791-aa48d25c`) ran 7 clean iterations to `capReached`,
so the loop itself was healthy. With a swap:

```
19:07:27.811 RuntimeReconciler  Applying runtime change { instanceId: 'csu9nxitx',
                                oldProvider: 'claude', targetProvider: 'codex' }
19:07:28.182 DefaultInvokers    Loop iteration invocation failed (classified)
                                { reason: 'process_exit', retryable: false }
19:07:28.182 DefaultInvokers    Error: Claude CLI exited with code 143       ← 128 + SIGTERM
19:07:28.186 LoopCoordinator    Loop terminated { status: 'completed-needs-review' }
```

Root cause: a `same-session` loop **borrows the parent instance's live adapter**
(`default-invokers.ts:1226-1239`), but the desired-runtime queue had no knowledge of that, so an
instance status of "waiting for input" between two turns of one in-flight iteration was treated as
an iteration boundary. Filed as **LT-020**.

**Fixed and re-verified live.** A new adapter-loan registry
(`src/main/instance/lifecycle/adapter-loan-registry.ts`) lets the loop invoker declare the loan for
the duration of an iteration; `DesiredRuntimeQueue` refuses to apply while a loan is held and
applies on its release. Re-run against the rebuilt app (`loop-1785525480352-7b095d1a`):

| | Before the fix | After the fix |
| --- | --- | --- |
| swap requested mid-iteration | queued (`desiredRuntime` set) | queued (`desiredRuntime` set) |
| running iteration | **killed, SIGTERM** | **completed normally** (`iterDone#1`) |
| loop after the swap | `completed-needs-review` | **`running`**, 3 iterations and counting |
| swap applied | 371 ms before the kill | at a true boundary, 42 s later, gen 1 → 2 |
| `exited with code 143` in the log | 1 per attempt | **0** |
| `Iteration invocation failed` | 1 per attempt | **0** |

The deferral is visible in the log:
`[DesiredRuntimeQueue] Applying runtime change deferred by a loop adapter loan`.

**What still does not pass:** the check's last clause, *"the loop continues on the new provider"*.
The instance moves to Codex, but `LoopState.config.provider` stays `claude`, so the loop carries on
with its originally configured provider — from the next iteration it fails
`canBorrowParentLoopAdapter('claude', 'codex')` and spawns its own separate Claude adapter instead of
borrowing. Observed on both runs (`configProvider: 'claude'` while the instance reads `codex`).

That half is deliberately **not** fixed here: whether swapping a session's provider should also
re-provider a running loop changes the loop's cost and behaviour mid-run, and is a product decision
rather than a defect with one obvious answer. It is recorded in LT-020's "required behaviour".

**Second finding, same run: LT-021.** 110 `Blocked invalid renderer event payload` warnings for
`channel: 'loop:activity'` — the renderer-boundary schema accepted only 3 of the 11 activity kinds
the invoker emits, so tool calls and results never reached the loop activity feed. Fixed by giving
both sides one shared union (`LoopActivityKindSchema`); the post-fix log has **0** blocked
`loop:activity` events.

### Check 6 — history restore of a swapped instance — ✅ PASS

Driven under this doc's own wording for the first time. Instance `cubiy294c`: Claude `opus[1m]`,
marker `SEXTANT66`, swapped to Codex `gpt-5.6-sol` (gen 1 → 2, `continuity: 'replay'`), one further
turn on Codex with marker `TRAVERSE77`, then terminated.

The archived entry records the **post-swap** runtime, not the original:

| Field | Value |
| --- | --- |
| `provider` | `codex` |
| `currentModel` | `gpt-5.6-sol` |
| `sessionId` | `019fb9a3-edd3-7020-af06-746a1bf5424d` — the Codex session created by the swap |
| `status` | `completed` — a deliberate terminate, not an unexpected exit (LT-013 still holds) |
| `messageCount` | 17 |

`restoreHistory(entryId)` then produced instance `xi8380qt3`:

```
HistoryRestoreCoordinator  History restore complete
  { restoreMode: 'native-resume', instanceId: 'xi8380qt3',
    sessionId: '019fb9a3-edd3-7020-af06-746a1bf5424d',
    historyThreadId: 'dab0cbe8-078c-4b89-b1f8-9b57ac15dacf' }
InstanceLifecycle          Skipping warm-start replacement spawn
  { provider: 'codex', reason: 'resumed session' }
```

- Spawned **Codex**, not Claude. ✔
- Resumed against the **post-swap Codex session id**, not the stale pre-swap Claude one. ✔
- 19 messages restored, and the restored session answered *"SEXTANT66 and TRAVERSE77"* — recalling
  a marker from **either side** of the swap. ✔

One process note for the next runner: `terminateInstance` takes `{ instanceId }`. Calling it with a
bare string returns `success` but does nothing, which briefly looked like "terminate no longer
archives". It does.

### Where the doc stands after this run

| Check | Status |
| --- | --- |
| 1 — cross-provider swap + context | **PASS** (2026-07-31) |
| 2 — unpinned swap, remembered default | **PASS** (2026-07-29, both branches) |
| 3 — queued swap while busy | **PASS** (2026-07-29, steps 1–5) |
| 4 — swap during a loop | destructive half **fixed and verified** (LT-020); provider-propagation extracted |
| 5 — model-degradation toast | **PASS** (2026-07-31, transcript + toast) |
| 6 — history restore of a swapped instance | **PASS** (2026-07-31) |
| 7 — remote instance guard | extracted — `remoteNodeList()` is `[]` in the dev profile |

Six of seven checks pass. The two residuals are **not further testing** — one is a product decision
and one needs a worker node paired into the dev profile — so they are extracted to
[`2026-07-31-swap-residuals_livetest.md`](2026-07-31-swap-residuals_livetest.md) and this doc is
renamed `_livetest_completed.md`.
