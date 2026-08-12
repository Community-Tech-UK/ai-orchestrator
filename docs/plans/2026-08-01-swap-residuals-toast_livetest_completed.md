# Live test — remote-swap refusal toast (extracted residual)

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Extracted from:** `2026-07-31-swap-residuals_livetest_completed.md` (check B), which closed with
every other assertion evidenced. This is the single residual.

**Prerequisite — and it is the whole reason this is deferred:** a **packaged** build launched with
`--remote-debugging-port`, with **no agent session hosted inside it**. The 2026-08-01 run could not
do this: the agent process was a child of the packaged app (pid 83454), so relaunching it would have
killed the run. Re-pairing `windows-pc` into the dev profile was rejected as the alternative — a
worker serves one coordinator at a time, so it would have disconnected the app James was using.

## The single check

On a **remote** (worker-node) instance, request a provider swap to a CLI the node does not advertise
in `supportedClis`. `windows-pc` advertises `["antigravity","copilot","cursor"]`, so `claude` or
`codex` is the refusal case.

- **Expected:** an error **toast** in the renderer reading
  `Cannot switch provider: worker node "windows-pc" does not have the Claude Code CLI available.`
- **Also expected:** the remote adapter keeps running — the instance stays live, `adapterGeneration`
  unchanged, no `process_exit`.

## What is already verified, so do not re-do it

The behaviour behind the toast is proven at `2026-07-31-swap-residuals_livetest_completed.md`,
check B. In short:

- the guard is remote-aware and reads the node's advertised `supportedClis`
  (`src/main/instance/lifecycle/model-change-provider-swap.ts:71-94`);
- it emits exactly the message above (`:88-91`), with regression cover at
  `model-change-provider-swap.spec.ts:180-188`;
- **no teardown happens on refusal** — the guard throws at `runtime-reconciler.ts:135`, and the
  first `deleteAdapter`/`terminate` is `:182`, with nothing torn down in between.

So this check is **only** about whether that error surfaces in the UI instead of dying in the main
process. If the toast appears with the right text and the instance survives, it passes.

Rename this file `2026-08-01-swap-residuals-toast_livetest_completed.md` when it does.

## Evidence run — 2026-08-11 (dev app, CDP on 9444)

**Result: the UI plumbing this check exists to test is PROVEN LIVE. The doc stays open on one
residual — the remote branch's message string was not observed on a real remote instance.**

### The prerequisite was wrong about which app was needed

The doc defers on "a **packaged** build launched with `--remote-debugging-port`". That is not
actually required. The thing under test is renderer-side (does a main-process throw reach the user
as a toast), and the **dev app** serves that with a debug port and no agent session inside it. The
packaged app matters only because `windows-pc` is paired to it — see the residual below.

### A local refusal exercises the same throw site

`assertSwapTargetCliAvailable` has two refusal branches in one function
(`model-change-provider-swap.ts`): remote/unsupported-CLI at `:87-92`, and local/not-installed at
`:98-103`. Both throw from the same function into the same site (`runtime-reconciler.ts:135`),
travel the same IPC channel, and are handled by the same renderer code. So a local refusal proves
everything except the string.

`gemini` is the usable local refusal: it is a valid `CliType` and therefore a valid swap target
(`cli-registry.ts:15`), but it is deliberately excluded from `SUPPORTED_CLIS` (`:18`, "superseded by
antigravity"), so detection never reports it available and `resolveCliType` cannot return it.
Confirmed live — `detectClis()` → `['claude','codex','antigravity','copilot','ollama','cursor','grok']`,
no `gemini`. (`antigravity` was tried first and is the wrong probe: it is **detected and available**
even though `command -v antigravity` finds nothing, so a swap to it succeeds.)

### What was observed

Driving the production renderer path — `InstanceStore.changeModel` → `InstanceListStore.changeModel`
(`instance-list.store.ts:523-527`) — on a live local Claude→antigravity session:

| Assertion | Observed |
| --- | --- |
| main refuses, does not die silently | IPC → `success:false`, `error.code: CHANGE_MODEL_FAILED` |
| message reaches the renderer verbatim | `Cannot switch provider: the Google Gemini (legacy) CLI is not installed or not available.` |
| it surfaces as an **error toast** | rendered `.toast-item toast-error`, `visible: true`, text verbatim |
| adapter keeps running | `adapterGeneration` 4 → **4** |
| instance stays live | `processId` 27043 → **27043**, `status` idle → **idle**, no `process_exit` |
| provider unchanged | `antigravity` → **antigravity** |

The other UI route to the same call — `composer-toolbar.component.ts:423-435` (`settleSelection`),
which talks to IPC directly and bypasses the store — has its own `toast.show(response.error?.message, 'error')`
plus a picker-label rollback, so neither entry point drops the failure.

### A trap worth recording: the dev-app window is occluded, and that fakes a rendering bug

The first three attempts read `.toast-stack` as **absent** while the `ToastService` signal plainly
held the toast. That looks exactly like a real "toast never renders" defect and is not one:
`document.hidden === true`, `visibilityState: 'hidden'`, and **`requestAnimationFrame` never fires**,
so Angular's zoneless scheduler never flushes. `ng.applyChanges()` rendered it immediately.

Fix for any renderer check in this repo: send `Emulation.setFocusEmulationEnabled {enabled:true}` and
`Emulation.setPageVisibilityOverride {visibility:'visible'}` on the CDP connection before evaluating.
After that, `document.hidden:false`, rAF fires, and the DOM updates on its own with no forced CD.
This is the same class as LT-032. Harness: `_scratch/lt-2026-08-11/cdp-eval.mjs`.

### Decision — 2026-08-11: closed on branch equivalence (James)

James accepted the equivalence argument below ("go with your recommendations"), so this doc is
**renamed `_livetest_completed.md`**.

Stated plainly so the basis is auditable rather than implied: the **remote** branch's message string
(`worker node "windows-pc" does not have the Claude Code CLI available.`) was **never observed at
runtime**. What was observed is the local branch of the same function, and what closes the check is
that the two differ only in the string they throw:

- same function, `assertSwapTargetCliAvailable` — remote at `:87-92`, local at `:98-103`;
- same throw site into `runtime-reconciler.ts:135`;
- same IPC channel and error envelope (`CHANGE_MODEL_FAILED`);
- same renderer handlers, both of which toast `response.error.message` verbatim.

The remote string itself has regression cover at `model-change-provider-swap.spec.ts:180-188`. If
that guard's message is ever reworded, the unit test — not this doc — is what catches it.

### The residual — why this file was not renamed before that decision

The message the check names (`worker node "windows-pc" does not have the Claude Code CLI available.`)
comes from the **remote** branch, and no worker node is paired into the dev profile — a worker serves
one coordinator at a time, so pairing it here would disconnect it from the app James uses. The
packaged app has the node but no debug port, so its toast cannot be observed either.

What remains unproven is therefore **only the string literal**, which already has regression cover at
`model-change-provider-swap.spec.ts:180-188`. Everything the check was extracted to test — that the
error surfaces in the UI instead of dying in the main process, and that the instance survives — is
now evidenced live. If James is happy to accept the local branch as equivalent, this closes as-is;
otherwise it needs a packaged build with a debug port and no agent session inside it.

Cleanup: instance `cj6xq7338` terminated, `/tmp/aio-lt-swap` removed.
