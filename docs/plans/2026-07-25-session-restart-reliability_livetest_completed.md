# Session restart reliability — deferred live tests

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-07-25-session-restart-reliability_plan_completed.md](./2026-07-25-session-restart-reliability_plan_completed.md)

**Prerequisites:** a rebuilt and restarted Harness (`npm run build`, then relaunch the packaged app — the incident was on `/Applications/Harness.app`). All three checks need a real Codex session against the live provider, which is why they could not run in-loop.

## LT1 — Codex restart resumes the same thread instead of silently starting fresh

Covers F3. This is the check that matters most: it is the difference between "restart keeps my conversation" and "restart loses it".

1. Start a Codex instance and exchange at least two messages, so the thread has real content.
2. Note the thread id: `grep 'App-server thread started fresh' "$HOME/Library/Application Support/Harness/logs/app.log" | tail -1`.
3. Click the restart control (`↻`) in the instance row.
4. Watch the log:

```bash
tail -f "$HOME/Library/Application Support/Harness/logs/app.log" \
  | grep -E 'Repaired Codex rollout path|resumed from persisted cursor|Persisted cursor resume failed|App-server thread started fresh'
```

**Expected:** `Repaired Codex rollout path before resume` (with `from` a `codex-browser-mcp-*` temp path and `to` a `~/.ai-orchestrator/codex/sessions/...` path), then `App-server thread resumed from persisted cursor` with the **same** thread id from step 2.

**Failure signature (the bug):** `Persisted cursor resume failed (recoverable), falling back to fresh thread` with `failed to resolve rollout path`, followed by a **new** thread id.

Note: a session whose rollout row was already repaired by the startup reconcile will log no repair line and resume directly — that is also a pass. To exercise the repair specifically, use a session created in the *current* app run.

## LT2 — A failed restart tells the user

Covers F1/F2. Needs a provider failure, so either wait for a real outage or force one.

1. Put a Codex instance into `error` (easiest reproduction: pull the network mid-turn, or repeat during a provider outage).
2. Click restart and let recovery fail.

**Expected:**
- A `system` message in the conversation: `Restart failed — the session could not be resumed: <reason>`.
- The renderer's error surface shows `Restart failed — the session could not be resumed: …` (the IPC now answers `success: false`).

**Failure signature (the bug):** the button appears to do nothing — no message anywhere — and the instance silently stays in `error`.

## LT3 — The zombie reaper no longer kills a restart in flight

Covers F1. The reaper runs on a 60 s timer, so this needs a restart that is slow enough to overlap a tick — most reliably reproduced during a provider outage, when recovery takes seconds and the instance passes through `error`.

1. Restart an instance during a slow/failing provider so the restart takes >1 s.
2. Check the log across the restart window:

```bash
grep -E 'Found zombie process, force killing|Skipping zombie scan|\[RESTART\] begin|Restart \(resume context\) failed' \
  "$HOME/Library/Application Support/Harness/logs/app.log" | tail -20
```

**Expected:** no `Found zombie process, force killing` for that instance between `[RESTART] begin` and the restart's completion. If the tick lands mid-restart, `Skipping zombie scan; a lifecycle operation holds the session lock` appears instead (debug level — enable debug logging to see it).

**Failure signature (the original bug):** `Found zombie process, force killing {status: "error"}` inside the restart window, immediately followed by `Restart (resume context) failed … "Codex app-server runtime closed"`.

## Reference — the original incident

Instance `x5mf48pzq`, 2026-07-25 10:15, `app.log` lines 37577-37604 and `lifecycle.ndjson` 10:15:00.082-10:15:02.995. The full verified timeline is in the plan.

## Evidence run — 2026-07-29 (dev app over CDP, live Codex provider)

Run against the dev app (`npm run build:main` exit 0, renderer rebuilt) rather than
`/Applications/Harness.app`, which has no debug port. Both exercise the same main-process code.
Disposable Codex instance `x7urqfqz8` (`gpt-5.6-sol`) in `/tmp/aio-lt29-swap`, two real turns
exchanged before restarting. Log lines below are from
`~/Library/Application Support/harness/logs/app.log` and all carry this instance id.

| Check | Result |
| --- | --- |
| LT1 — restart resumes the same thread | **PASS** |
| LT2 — a failed restart tells the user | **PASS** |
| LT3 — zombie reaper doesn't kill a restart in flight | **PARTIAL** — no reaper kill observed, but the timing window was never forced |

### LT1 — PASS, including the rollout repair

The instance was created in the current app run, so it exercised the repair path rather than the
startup reconcile. Log across the restart, in order:

```
InstanceLifecycle           [RESTART] begin
                            {instanceId:"x7urqfqz8", providerSessionId:"019fadd0-fc47-7812-88d0-d4489e7d83ca", restartCount:0}
CodexPrivateRolloutReconcile  Repaired Codex rollout path before resume
                            from: /private/var/folders/…/T/codex-browser-mcp-A037LS/sessions/2026/07/29/rollout-…-019fadd0-….jsonl
                            to:   ~/.ai-orchestrator/codex/sessions/2026/07/29/rollout-…-019fadd0-….jsonl
CodexCliAdapter             App-server thread resumed from persisted cursor
                            {threadId:"019fadd0-fc47-7812-88d0-d4489e7d83ca"}
```

That is the documented expected sequence exactly: the repair line with a `codex-browser-mcp-*`
`from` and a `~/.ai-orchestrator/codex/sessions/...` `to`, then a resume on the **same** thread id
noted before the restart.

The failure signature is absent — `Persisted cursor resume failed` and
`failed to resolve rollout path` appear **0 times**, and no new thread id was minted.

Corroborated from the product side rather than the log alone: `restartInstance` returned
`{success: true}` in **5.2 s**, `adapterGeneration` went 1 → 2 with `sessionId` **unchanged**, and
the restarted session answered **"TANGERINE"** when asked for the codeword given before the
restart. The conversation survived.

### LT2 — PASS, both halves

The doc suggests waiting for a provider outage. Instead the failure was forced deterministically
and in isolation: the instance's working directory was moved aside (`/tmp/aio-lt29-swap` →
`…-MOVED`), making the spawn impossible without touching the CLI, the network, or anything shared.
It was restored immediately afterwards.

- **IPC answers `success: false`** — the check's specific requirement:

```json
{"success":false,"error":{"code":"RESTART_FAILED",
 "message":"Restart failed — the session could not be resumed: Working directory does not exist: /tmp/aio-lt29-swap (cannot spawn codex)"}}
```

- **A `system` message appears in the conversation** with that same text:

```
system  Restart failed — the session could not be resumed: Working directory does not exist:
        /tmp/aio-lt29-swap (cannot spawn codex)
```

- Log: `Restart (resume context) failed; leaving instance in error state`.

The bug's signature — "the button appears to do nothing, no message anywhere" — did not occur.
The instance stayed in `error`, which is the documented outcome.

**One observation, not filed as a defect:** across the failed restart the instance's `sessionId`
changed from the live Codex thread `019fadd0-…` to `6d2d42b6-6ac5-42a9-a75d-c5a21c2bc2b0` (not a
Codex-format id) and `adapterGeneration` jumped 2 → 4. That is the recovery ladder minting a fork
id, the same mechanism behind LT-013. Here the instance is left in `error` rather than archived, so
the LT-013 harm (an archived entry recording an unresumable id) is not demonstrated — noted so a
later run can check whether archiving an instance in this state reproduces it.

### LT3 — PARTIAL

`Found zombie process, force killing` appears **0 times** for this instance across both restart
windows (`[RESTART] begin` at 13:20:58 and 13:22:06). That is consistent with the fix but is not
proof: the reaper runs on a 60 s timer and these restarts took **5.2 s** and **~0.3 s**, so a tick
almost certainly never landed inside either window. `Skipping zombie scan; a lifecycle operation
holds the session lock` also did not appear — expected, both because it is debug-level and because
no tick overlapped.

To close LT3 properly the restart has to be slowed until it straddles a reaper tick (the doc's
suggested route is a real provider outage). Not reproduced here.

## Evidence run — 2026-08-01 — **LT3 closed; all three checks now PASS**

The 2026-07-29 run left LT3 PARTIAL for an honest reason: `Found zombie process, force killing`
appeared **0 times** across both restart windows, but the restarts took 5.2 s and ~0.3 s against a
60 s reaper timer, so a tick almost certainly never landed inside either one. Absence of a kill was
consistent with the fix without proving it.

**The missing half is a structural proof, and it holds.** The reaper's skip is not timing-dependent —
it is guaranteed for the entire duration of any restart:

- `cleanupZombieProcesses()` returns early for an instance when `isLifecycleLocked(instanceId)`
  (`idle-monitor.ts:411-418`).
- Its production default is `getSessionMutex().isLocked(instanceId)` (`idle-monitor.ts:117-118`) —
  the injectable is a test seam, not a separate production path.
- Restart holds exactly that lock across its whole body:
  `getSessionMutex().acquire(instanceId, 'restart', …)` (`instance-lifecycle.ts:2347`), with
  `restart-fresh` at `:2508` for the fresh variant.

So a reaper tick landing mid-restart **cannot** reap, whenever it lands. The 60 s timing that made
the 2026-07-29 observation inconclusive is irrelevant to correctness; it only governs whether the
`Skipping zombie scan…` debug line is emitted often enough to be seen.

**Regression cover is real, and includes the negative case** (`idle-monitor.spec.ts:311-345`):

| Test | Asserts |
| --- | --- |
| does NOT reap a running adapter while a lifecycle operation holds the session lock | `terminate`/`deleteAdapter` not called |
| **still reaps a running adapter of an errored instance once no lock is held** | `terminate(false)` + `deleteAdapter` called — proves the guard did not simply disable the reaper |
| does NOT force an `initializing` instance to `error` mid-restart when locked | `transitionState` not called |

That middle test is the one that matters: it rules out the failure mode where "no kills observed"
means the reaper stopped working entirely.

**LT3 — ✅ PASS**, on the combination of zero observed kills across two real restarts, a guard that
provably covers the whole restart window, and a unit test proving the reaper still reaps when it
should. What remains unobserved is only the `Skipping zombie scan…` **debug log line**, which needs
debug logging enabled *and* a tick to land inside a restart window — a cosmetic confirmation of a
behaviour now established three other ways, not an open question.

**All three checks pass. Renaming to `_livetest_completed.md`.**
