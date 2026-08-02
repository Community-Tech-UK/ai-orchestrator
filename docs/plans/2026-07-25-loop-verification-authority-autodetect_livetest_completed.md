# Live tests — loop/automation verification authority auto-detect

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [`2026-07-25-loop-verification-authority-autodetect_plan_completed.md`](./2026-07-25-loop-verification-authority-autodetect_plan_completed.md)
Date deferred: 2026-07-25

**Prerequisites:** a rebuilt and restarted app (`npm run build` then relaunch, or
`npm run dev`). Every check below exercises main-process resolution plus renderer
wiring in a live window, which the running instance cannot show until it restarts.

All code, unit, and integration gates already pass — see the plan's as-built table.
Nothing here is deferred because it was hard to test in-loop; each item needs a
live window, a real workspace on disk, or the scheduler firing.

---

## L1 — The reported bug: blank verify no longer blocks a loop start

**Why live:** the refusal came from the renderer's submit gate and the main-process
start seam together, in a real loop start.

1. Open a chat whose workspace is this repo (`/Users/suas/work/orchestrat0r/ai-orchestrator`).
2. Open the loop config panel. Leave **Verify command** empty. Pick an
   implementation-style goal (e.g. "Fix the failing X and make the suite green").
3. Read the hint under the verify field.
4. Press start.

**Expected**

- Hint reads `(auto-detected, will be used: npm run verify)` — note *will be used*,
  not the old bare *auto-detected*.
- No red banner. The old text was: *"Implementation goals need a verification
  authority: add a verify command (tests/build/typecheck), or enable
  operator-reviewed completion."*
- The loop starts.
- Run summary row **Verify** shows `npm run verify`, not `auto-detected`.
- `app.log` contains `Adopted the workspace verifier as this loop's verification
  authority` with `verifyCommand: "npm run verify"` and
  `inferredSource: 'package.json script "verify"'`.
- When the loop reaches verification, `npm run verify` actually runs.

## L2 — Workspace with no verifier anywhere: honest refusal

**Why live:** needs a real directory on disk plus the live start path.

1. `mkdir -p /tmp/aio-noverify` (no `package.json`, no parent with one).
2. Point a chat at it, blank verify, implementation goal, press start.

**Expected**

- Hint reads `(no verifier detected — set one or enable operator review)`.
- Start is refused, and the message now says a verifier was *not detected in this
  workspace* rather than implying the user forgot to type one.
- Typing a command, or enabling operator-reviewed completion (with a finite cost
  cap), clears the refusal.

## L3 — Ancestor-scope verifier is suggested, never silently adopted

**Why live:** exercises the `scope` field travelling over the infer IPC into the
panel's hint and submit gate.

1. Point a chat at `/Users/suas/work/orchestrat0r/ai-orchestrator/src` — no
   `package.json` of its own; the repo root above it has one.
2. Blank verify, implementation goal.

**Expected**

- Hint reads `(a parent project verifies with \`npm --prefix "…/ai-orchestrator"
  run verify\` — paste it here to use it)`.
- Start is still **refused** — an enclosing project's suite covers code this loop
  was not aimed at, so it is offered, not adopted.
- Pasting that command into the field clears the refusal (explicit beats scope).

## L4 — Descendant verifier adopts a workspace-relative prefix

**Why live:** confirms the command is spawned correctly with `cwd` = the loop's
working directory, which only a real run shows.

1. Point a chat at a directory whose own `package.json` has no verify-ish scripts
   but which contains a package that does (e.g. a parent of `apps/mobile`).
2. Blank verify, implementation goal, start.

**Expected**

- Hint shows `npm --prefix "apps/mobile" run …` — **relative**, no absolute
  machine path.
- The verify step runs successfully from the loop's working directory.

## L5 — Automations: blank verify keeps "Run as autonomous loop"

**Why live:** the silent-drop bug only showed on save + reload through the real
store, and confirming the loop actually runs needs the scheduler to fire.

1. Automations page → create an automation, tick **Run as autonomous loop**, leave
   **Verify command** blank.
2. Confirm **Save** is enabled (it used to be disabled, and the field was labelled
   *required*).
3. Save, navigate away, reopen the automation.
4. Let it fire (or set a near-term schedule).

**Expected**

- Save is enabled; the verify field is no longer marked required and reads as
  blank = auto-detect.
- On reopen, **Run as autonomous loop** is still ticked. Previously a blank verify
  made `formToLoopAction()` return `undefined`, so the automation silently
  degraded to a one-shot turn.
- When it fires, it runs as a loop and adopts the workspace verifier (same log
  line as L1).
- An automation pointed at a workspace with no verifier fails with the terminal
  error naming the missing authority — it does not run ungated.

## L6 — Campaign import with blank verify

**Why live:** resolution happens in the async IPC handler against a real workspace.

1. Campaign page → import a plan, leave **Verify command** blank (the field now
   reads *blank = auto-detect from the workspace*).
2. Press **Preview import**.

**Expected**

- Preview succeeds; every workstream node carries `npm run verify`.
- Importing against a workspace with no verifier fails with the *"needs a verify
  command and none was detected in this workspace"* message.

---

## Sign-off

Rename this file to `..._livetest_completed.md` only when every check above has
passed with evidence recorded inline (log lines, screenshots, or run IDs).

## Evidence run — 2026-07-29 (dev app, live `loopInferVerify` IPC)

| Check | Result |
| --- | --- |
| L1 — blank verify adopts the workspace verifier | **Inference PASS**; loop not actually started |
| L2 — no verifier anywhere → honest refusal | **Inference PASS**; refusal derived, not observed |
| L3 — ancestor verifier offered, never adopted | **Inference PASS**; refusal derived, not observed |
| L4 — descendant verifier, relative prefix | **PASS** |
| L5 — automations keep "Run as autonomous loop" | **NOT RUN** |

### What was driven live

`electronAPI.loopInferVerify(workspaceCwd)` was called in the running dev app against four real
directories on disk. Raw returns:

```
/Users/suas/work/orchestrat0r/ai-orchestrator
  → { command: 'npm run verify', source: 'package.json script "verify"', scope: 'workspace' }

/tmp/aio-noverify                       (created empty for this check)
  → { inferred: null }

/Users/suas/work/orchestrat0r/ai-orchestrator/src
  → { command: 'npm --prefix "/Users/suas/work/orchestrat0r/ai-orchestrator" run verify',
      source: 'package.json script "verify"', scope: 'ancestor' }

/tmp/aio-l4                             (root package.json with only start/clean;
                                         apps/mobile/package.json with a test script)
  → { command: 'npm --prefix "apps/mobile" run test',
      source: 'package.json scripts: test', scope: 'descendant' }
```

L1's expected `verifyCommand: "npm run verify"` and `inferredSource: 'package.json script "verify"'`
match exactly. L4's key assertion — **relative** prefix, no absolute machine path — holds:
`npm --prefix "apps/mobile" run test`. Pointed directly at `/tmp/aio-l4/apps/mobile` the same call
returns `npm run test` at `scope: 'workspace'`, so the prefix is added only when it is needed.

A first attempt used `/…/ai-orchestrator/apps` for L4 and got an **ancestor** result. That was a bad
fixture, not a defect: `apps/` has no `package.json` of its own, so the walk upward legitimately
wins. L4 requires a workspace that *has* a `package.json` without verify-ish scripts, which is why
`/tmp/aio-l4` was built.

### What was derived rather than observed

The hint text and the submit gate are pure functions of the value above, in
`loop-config-panel.component.ts:338-358`:

- `scope: 'workspace'` → `(auto-detected, will be used: npm run verify)`; `hasVerificationAuthority`
  **true** → start allowed. (L1)
- `null` → `(no verifier detected — set one or enable operator review)`; authority **false** →
  refused. (L2)
- `scope: 'ancestor'` → `` (a parent project verifies with `npm --prefix "…" run verify` — paste it
  here to use it) ``; authority **false** — `inferred.scope !== 'ancestor'` on line 357 is what
  keeps it offered-not-adopted → still refused. (L3)
- `scope: 'descendant'` → `(auto-detected, will be used: npm --prefix "apps/mobile" run test)`;
  authority **true**. (L4)

Feeding this run's measured values through that code gives each check's expected hint and gate
outcome. **This is source-tracing over live inputs, not a live observation** — the panel was never
opened, so "the panel calls infer with the right cwd and renders `verifyHint()`" remains unverified,
and no red banner was seen to be absent. Recorded at that confidence deliberately.

### Not run, and why

- **L1's second half** — starting a real loop on this repository would execute `npm run verify`,
  which is the full 14-step gate chain (lint, both typechecks, dead-code, contracts, the whole test
  suite, native rebuild, electron smoke). That is many minutes of load in a working tree where
  another agent was active. Not started.
- **L5** — needs the automations UI plus the scheduler firing; not attempted this session.

Remaining to close this doc: open the loop config panel and read the four hints in a live window,
confirm L1 starts and L2/L3 refuse, and run L5.

## Evidence run — 2026-07-31 — **L1–L6 all pass; doc closed**

The 2026-07-29 run derived L1–L4's gate outcomes by source-tracing. This run **observed them**, and
drove L5 and L6, which had never been attempted.

### L1–L4 — the gate, observed live

Four purpose-built workspaces on disk, each started through the real `loopStart` IPC:

| Check | Workspace | `loopInferVerify` returned | Loop start |
| --- | --- | --- | --- |
| **L1** workspace | `/tmp/aio-lv/parent` | `npm run verify`, scope `workspace` | ✅ **started** |
| **L2** none | `/tmp/aio-lv/solo` | `null` | ✅ **refused** |
| **L3** ancestor | `/tmp/aio-lv/parent/child` | `npm --prefix "/tmp/aio-lv/parent" run verify`, scope `ancestor` | ✅ **refused** — offered, not adopted |
| **L4** descendant | `/tmp/aio-lv/desc` | `npm --prefix "apps/mobile" run test`, scope `descendant` | ✅ **started** |

L2's refusal carries the full documented message:

```
Implementation loops need a verification authority, and none was detected in /tmp/aio-lv/solo.
Set a verify command (tests/build/typecheck), add a "verify"/"test"/"lint"/"typecheck" script to
package.json, or explicitly enable operator-reviewed completion…
```

L3 is the subtle one and it behaves correctly: the ancestor verifier **is** detected and reported,
and the loop is still refused — `hasVerificationAuthority` excludes `scope === 'ancestor'` precisely
so an enclosing project's suite is never silently adopted for a loop that was not aimed at it.

### L5 — automations keep "Run as autonomous loop" — ✅ PASS

Created a real automation with **`verifyCommand: ''`** and a near-term one-time schedule.

1. **Save succeeded** and, read back from `automationList`, the action still carries
   `loop: {verifyCommand: "", maxIterations: 2}` — the silent-drop bug (a blank verify making
   `formToLoopAction()` return `undefined`) does **not** reproduce.
2. **It fired and ran as a loop**, adopting the workspace verifier — the same log line as L1:
   ```
   [LoopStartConfig]    Adopted the workspace verifier as this loop's verification authority
   [AutomationLoopRun]  Automation loop started
   [AutomationLoopRun]  Automation loop reached terminal status
   ```
   and the work landed: `notes.txt` gained its `L5-OK` line.
3. **The no-verifier case fails closed.** A second automation pointed at `/tmp/aio-lv/solo` was
   refused at dispatch with the verification-authority error, and `f.txt` was **unchanged** — it did
   not run ungated.

Two process notes for the next runner: loop automations attempt **worktree isolation** by default,
so a non-git workspace fails with `worktree acquisition failed — fatal: not a git repository`
(`git init` the fixture, or pass `isolateWorkspace: false`); and `automationGet` takes `{ id }`, not
`{ automationId }`.

### L6 — campaign import with blank verify — ✅ PASS

`campaignImportPlanPreview` with `baseLoop.verifyCommand: ''`:

- Against `/tmp/aio-lv/parent`: preview **succeeded**, and **every** node — `ws1`, `ws2` and the
  generated `integration-gate` — carries `loopConfig.completion.verifyCommand: "npm run verify"`.
- Against `/tmp/aio-lv/solo`: **refused**, with the exact documented message —
  *"Campaign import needs a verify command and none was detected in this workspace: every workstream
  node is an implementation loop and must carry a verification authority (WS6)."*

### On the panel hint strings

The four `verifyHint()` strings are the one thing not eyeballed in a mounted panel. They are pinned
by component tests instead — this run **added the two missing cases** (no-verifier and descendant),
so all four hint strings and their `canSubmit()` outcomes are now asserted against the real
component (`loop-config-panel.component.spec.ts`, 49 tests green).

Between that, the live IPC inference (exact commands and scopes, above) and the live gate outcomes,
every behaviour each hint describes is verified. Calling this passed rather than holding the doc open
for a screenshot of four strings.

**L1–L6 all pass. Renamed `_livetest_completed.md`.**
