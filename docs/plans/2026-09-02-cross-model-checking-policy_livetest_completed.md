# Live tests — Cross-model checking policy

## Final status — 2026-09-27

Open: 0 · Closed: 2 · Transferred: 6 · Failed: 0

The seat-capability premise and LT-G are closed. LT-A through LT-F remain valid, agent-runnable
checks that require one rebuilt coordinator using the real `lawrencj` enterprise routing profile;
they are preserved together as
[AR-005](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-005--enterprise-copilot-cross-model-policy-campaign).

## Status — 2026-09-06
Open: 6 · Closed: 1 · Failed: 0 (LT-G not runnable — no CLI entrypoint exists yet)
Needs `npm run build:main` + Electron relaunch, then a live `lawrencj` Copilot seat exercising real reviews in an EBRD scratch repo for LT-A through LT-F.

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-09-02-cross-model-checking-policy_plan_completed.md](./2026-09-02-cross-model-checking-policy_plan_completed.md)

## Why these are deferred

Every remaining check needs a rebuilt and restarted app plus a live Copilot seat
issuing real API calls. None of them can be settled by unit or integration tests,
because the thing being proven is that a *real* enterprise seat serves a
*different-family* model to a *real* checker. All agent-runnable gates already
pass (typecheck ×2, lint, size ratchet, `build:main`, full suite 20597 tests).

## Prerequisites

- `npm run build:main`, then relaunch Electron. The installed app is running
  older `dist/main` and cannot provide evidence for this uncommitted code.
- The `lawrencj` Copilot profile signed in, protected-routed to
  `/Users/suas/work/ebrd` (already configured; verify in Settings › GitHub
  Copilot Accounts before starting).
- A scratch repository under `/Users/suas/work/ebrd/` you are willing to have an
  agent edit.
- `providersExcludedFromAutomation` still contains `copilot` — the carve-out is
  supposed to work *despite* that, so do not remove it for the test.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| The `lawrencj` seat serves models from two distinct provider families (core premise for LT-A) | 2026-09-02 | Direct `COPILOT_HOME` probe, one trivial prompt per model: `gpt-5.6-terra`, `gpt-5.3-codex`, `claude-opus-5`, `claude-sonnet-5` work; `grok-4.6`, `grok-4.5`, `gemini-3.7-flash`, `claude-sonnet-4.6` refused. Confirms build-on-Opus / check-on-GPT (or the reverse) runs inside the employer licence, without needing the app. |

### Notes from the 2026-09-02 probe

Only OpenAI and Anthropic models are usable on this seat — a candidate table
that picked an xAI or Google second checker against an Anthropic builder would
fail every time. Separately, `copilot` validates `--model` against the
account's real entitlements *before* sending, so a non-entitled model produces
`Error: Model "X" from --model flag is not available.` — not the API's "not
available for integrator … Available models: [...]" form. The entitlement
parser previously only recognised the API form, so the common (client-side)
refusal taught the cache nothing and a dead model was re-picked forever. Both
are now fixed: `parseCopilotUnavailableModelFlag` + `recordCopilotModelRefusal`
learn from the client-side form too, after which the round-robin falls to
OpenAI depth (`gpt-5.5`) instead of a dead xAI candidate. The first checker of
a given kind still fails once per process before the cache learns.

---

## LT-A — Enterprise ticket work is checked on the same seat, different family

**Steps**

1. Start an interactive Copilot session in a repo under `/Users/suas/work/ebrd/`.
2. Confirm the session resolved to the `LAWRENCJ` profile (instance header /
   `app.log` `copilot_account_route_resolved`).
3. Have it make a small code change and go idle so the in-session cross-model
   review fires.
4. Read `app.log` for `Cross-model review reviewers selected`.

**Expected**

- `licencePinned: true`.
- Every entry in `selected` is `copilot:<model>`.
- No entry's model is Anthropic-family if the builder ran an Anthropic model
  (and vice versa) — check the builder's model in the instance header.
- With `crossModelReviewMaxReviewers: 2`, **two** entries with **two distinct
  models**. One entry means the pass-6 collapse has regressed.

**Why not automatable:** needs a live seat, a real idle-trigger, and real
provider spawns.

---

## LT-B — The checker actually runs on the seat and returns a verdict

**Steps**

1. After LT-A, find the reviewer spawn in `app.log` and confirm
   `attachCopilotRoute` resolved origin `review` to the `lawrencj` profile.
2. Confirm a review verdict is produced (review card in the UI, or
   `review:completed`).

**Expected**

- No `automation-disallowed` failure, despite `copilot` being on
  `providersExcludedFromAutomation` — this is the §4.3 carve-out working.
- A parsed verdict, not an infrastructure error.

---

## LT-C — Seat entitlement learning on a refused model

**Steps**

1. Temporarily set `crossModelReviewModelByProvider.copilot` to a model the seat
   does **not** serve — `claude-sonnet-4.6` is known-absent from this seat.
2. Trigger a review in a **non**-EBRD workspace (so the configured model is used
   rather than a licence-pinned one).
3. Read `app.log`.

**Expected**

- A `model_call_failure` / "not available for integrator" error, followed by
  `Learned Copilot seat entitlements from a model refusal` with a `modelCount`.
- The *next* review for that profile does not choose the refused model again.

**Restore** the setting afterwards.

---

## LT-D — Ping-pong stays on the seat

**Steps**

1. Run a loop with ping-pong enabled, builder = Copilot, in an EBRD repo.
2. Read `app.log` for `Ping-pong reviewer pinned to the enterprise Copilot seat`.

**Expected**

- The reviewer is `copilot` on the `lawrencj` profile with a model from a
  different family than `iteration.model`.
- The reviewer is **not** Claude/Codex/Cursor, even though the normal ping-pong
  rule is "different provider than the builder".

---

## LT-E — `manual-only` blocks rather than silently proceeding

**Steps**

1. Set the `lawrencj` profile's automation policy to `manual-only`.
2. Trigger a review (and a ping-pong round) in an EBRD repo.

**Expected**

- `Checker plan blocked — enterprise seat forbids automatic use` in `app.log`.
- **No** Copilot reviewer spawns, and **no** Claude/Codex/Cursor reviewer spawns
  either — blocked means blocked, not fall back off-seat.

**Restore** `allow-routed` afterwards.

---

## LT-F — Non-EBRD work is unaffected

**Steps**

1. Trigger an in-session review in this repo (`~/work/orchestrat0r/ai-orchestrator`).

**Expected**

- `licencePinned` absent/false; reviewers are the normal configured providers.
- No Copilot reviewer (it is still excluded from automation outside a protected
  enterprise scope).
- Behaviour indistinguishable from before this change.

---

## LT-G — `aio review --reviewers none` spawns nothing

> **NOT RUNNABLE — the command has no entrypoint.** `runReviewCommand`
> (`src/main/cli-entrypoints/review-command.ts`) is exported and unit-tested but
> has no runtime caller anywhere in `src/`; only its *types* are imported. It is
> not wired to any binary or MCP subcommand, so `aio review` cannot be invoked.
> Pre-existing, not caused by this work — but it means the `--implementer` flags
> added here sit on an unreachable surface, and the pass-8 phantom-checker fix
> cannot be exercised end to end. Wiring that command is its own task.

**Steps**

1. From a repo under `/Users/suas/work/ebrd/`, run
   `aio review --reviewers none --json`.

**Expected**

- Zero reviewer dispatches, zero Copilot spawns.
- This is the pass-8 defect: it used to force one billed review inside an
  enterprise scope.

### Evidence run — 2026-09-27 — PASS after LT-659 correction

The command now has a real source entrypoint (`npm run review` invokes
`src/main/cli-entrypoints/review-command.ts`). A first live run in a disposable, remote-free Git
repository under `/Users/suas/work/ebrd/` proved the old “unrunnable” note stale but exposed
LT-659: the CLI selected zero reviewers, then failed before returning a result because its plain
Node process tried to construct Electron's settings store (`Please specify the projectName
option`).

The headless service now falls back to settings defaults with the local advisory pass disabled
when the Electron settings manager is unavailable. Normal Electron-hosted calls still use the
persisted settings snapshot. A regression test first failed on the original implementation, then
the focused headless/CLI suites passed **21/21**.

The same live command was repeated against the same disposable EBRD repository:

```text
npm run review -- --cwd <disposable-ebrd-repo> --target <empty-tree> --reviewers none --json
exit 0
reviewers: []
findings: []
infrastructureErrors: []
summary: No reviewers available for headless review.
```

No provider adapter was dispatched and no Copilot call was made. LT-G passes.
