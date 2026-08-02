# Provider/model swap — residual live checks

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check evidence stays in this
> file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Extracted from:**
[`2026-07-16-session-provider-model-swap-plan_livetest_completed.md`](2026-07-16-session-provider-model-swap-plan_livetest_completed.md)
— six of that doc's seven checks passed on 2026-07-31, so it was closed and these two residuals
moved here rather than holding a finished document open.

**Prerequisites:** a rebuilt app for check A; a worker node paired into the **dev** profile for
check B.

---

## A. A swap on a loop-bearing instance should carry the loop with it — **decision first, then test**

The destructive part of this is already fixed and verified (LT-020): a queued swap no longer
SIGTERMs the CLI a loop iteration is running on. A loop now survives the swap and keeps iterating.

What remains is **not a bug with one obvious answer**. After the swap:

- the instance reads the new provider (e.g. `codex`),
- but `LoopState.config.provider` stays on the original (`claude`),
- so from the next iteration `canBorrowParentLoopAdapter('claude', 'codex')` is false and the loop
  stops borrowing the instance's adapter and spawns its own on the old provider.

Observed on both 2026-07-31 runs (`configProvider: 'claude'` while the instance read `codex`).

The original check expected *"the loop continues on the new provider"*. Deciding that in code means
a user-visible provider swap silently re-providers a running loop — changing its cost, its model
behaviour and its session continuity mid-run. That is James's call, not an agent's.

**Options:**

1. **Propagate.** A swap on a loop-bearing instance also switches the loop's configured provider.
   Matches the check as written; means a picker click changes an unattended long-running job.
2. **Refuse.** Reject the swap while a loop is running, with a clear reason ("this session is
   running a loop; stop it first"). Safest; costs the ability to re-provider mid-loop.
3. **Decouple explicitly.** Allow the swap, keep the loop on its own provider, and *tell the user*
   that the loop will carry on with its original provider. Closest to today's behaviour, but stops
   it being silent.

**Steps once decided:**

1. Start a multi-iteration loop on an instance (a verify authority is required in the workspace —
   a `package.json` with a failing `test` script that only passes at the goal state forces real
   iteration).
2. Request a cross-provider swap mid-iteration.
3. Expected (option 1): the running iteration completes, the swap applies at the boundary, and the
   **next** iteration runs on the new provider — assert on `LoopState.config.provider` and on the
   iteration's actual adapter, not just the instance badge.

Why deferred: needs the product decision above.

## B. Remote instance guard — **BLOCKED: no worker node in the dev profile**

Steps:

1. On a remote (worker-node) instance, request a swap to a CLI the node does not advertise in
   `supportedClis`.
2. Expected: a clear error toast — "worker node … does not have the … CLI available" — and **no
   teardown** of the running remote adapter. If the node does advertise the CLI, the swap should
   behave exactly as a local one.

Why blocked: `remoteNodeList()` returns `[]` in the dev profile. The paired `windows-pc` worker is
registered in the **packaged** app's profile, and the packaged app has no remote-debugging port, so
there is no way to drive a remote instance interactively. Unblocking needs either a node paired
into the dev profile or a packaged build launched with a debug port.

---

Rename this file `_livetest_completed.md` only when both checks pass with evidence.

---

## Decision — 2026-08-01: **option 3, decouple explicitly**

James delegated this. The reasoning:

- **Option 1 (propagate)** — a single picker click would silently re-provider an unattended,
  long-running job, changing its cost and its model behaviour mid-flight. Too much consequence for
  too small a gesture.
- **Option 2 (refuse)** — breaks a legitimate action on a session the user owns, purely because a
  loop happens to be running. Safe but paternalistic, and it would regress a case that works today.
- **Option 3 (decouple + say so)** — chosen. The loop keeps the provider it was started with; the
  session moves. **The defect was never that they diverge — it was that nothing told the user.**

Implemented as `describeLoopProviderDivergence` (`src/main/instance/lifecycle/`), which emits a
`system` transcript entry naming both providers and what to do about it:

> *This session is now on codex, but the loop running on it stays on claude — a loop keeps the
> provider it was started with. New messages you send go to codex; the loop's own iterations continue
> on claude. Stop and restart the loop if you want it moved.*

Unit-tested (6 tests): fires on a live loop with a different provider, stays silent when the
providers already match, when there is no loop, and when the loop has finished; still fires for a
`paused` loop; and never throws — a notice must not break a change that already applied.

### LT-030 — found while verifying this, now FIXED

Verifying this live exposed a deeper defect. On a loop-bearing session the swap **cannot deliver any
post-change message at all**: the loop reclaims the adapter the instant the swap lands, the
replay-continuity send hangs, the next send is refused with `Codex app-server runtime already has an
active turn`, and the reconciler reverts the swap. The user sees **no** provider-change notice
either — LT-015's guarantee is silently void on this path.

Measured live (instance `codex`, loop `claude`, loop `running`): **0** provider-change notices,
**0** divergence notices.

Fixed in three parts: transcript-first rendering, a reciprocal interlock (the loop waits for an
in-flight runtime change), and — the actual root cause — folding the replay preamble and every notice
into **one** delivery, because on Codex each `sendInput` starts a model turn and the second was being
refused with `already has an active turn`. Full write-up in the register as **LT-030**.

### Check A — ✅ PASS (2026-08-01)

Live: real Claude loop, swap to Codex mid-iteration.

| Assertion | Observed |
| --- | --- |
| loop survives the swap | `status: running`, no SIGTERM |
| instance moves | `provider: codex` |
| loop keeps its own provider | `config.provider: claude` |
| **the user is told** | `loop-provider-divergence` notice in the transcript, verbatim |
| provider-change notice also delivered | `provider-changed` notice present |
| swap reverted | **no** — 0 `Failed to apply runtime change` |
| runtime collisions | **0** `already has an active turn` |

### Check B — ◐ code-verified 2026-08-01; the toast itself stays unverified

Re-attacked against the **packaged** app, which is where the worker actually lives:
`list_remote_nodes` shows `windows-pc` **connected** (worker agent 0.1.0, latency 36 ms,
`supportedClis: ["antigravity","copilot","cursor"]`) — so a swap to `claude` or `codex` on a remote
instance there is exactly the refusal case this check wants.

It still could not be driven end to end, for a reason worth writing down precisely: the swap is an
IPC call on the app's own renderer bridge, and **the packaged app exposes no remote-debugging
port**. Adding one means relaunching it — and this session's own agent process is a child of that
app (`ps` ancestry: `claude` → `/Applications/Harness.app/Contents/MacOS/Harness`, pid 83454), so
the relaunch would kill the run mid-flight. Re-pairing the worker into the dev profile was the other
option and was rejected: the node can serve one coordinator at a time, so it would have pulled a
live worker away from the app James is actually using.

What *was* verified, by reading the executing path rather than inferring it:

| Assertion | Evidence |
| --- | --- |
| the guard exists and is remote-aware | `model-change-provider-swap.ts:71-94` — reads `getWorkerNodeRegistry().getNode(location.nodeId).capabilities.supportedClis` |
| the message matches the check's wording | `:88-91` emits `worker node "<name>" does not have the <CLI> CLI available.` |
| **no teardown on refusal** | the guard runs at `runtime-reconciler.ts:135`; the first `deleteAdapter`/`terminate` is `:182`. The throw propagates out of the reconciler 47 lines before anything is torn down — there is no teardown between the two |
| an unregistered node is also refused | `:79-83`, distinct message |
| regression cover | `model-change-provider-swap.spec.ts:180-188` asserts the exact refusal string against a node advertising only `claude` |

**Residual: one assertion.** That the refusal reaches the user as a *toast* rather than dying in the
main process. That is a renderer-rendering claim, and it needs a packaged build launched with
`--remote-debugging-port` while no agent session is hosted inside it.

**Check A passes; check B passes on behaviour and structure, with the toast rendering outstanding.**
Extracted to `2026-08-01-swap-residuals-toast_livetest.md` per the 90/10 rule so this doc can close.

