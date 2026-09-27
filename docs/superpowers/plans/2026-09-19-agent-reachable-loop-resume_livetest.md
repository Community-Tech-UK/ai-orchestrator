# Agent-Reachable Loop Resume — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: none — this was a direct request ("we should have the ability to resume a loop"), implemented
without a plan document.

**Prerequisites:**

- Rebuild and restart the packaged Harness app from this checkout, and rebuild the CLI binary
  (`npm run build:main && npm run build:aio-mcp-dist`). The parent process registers
  `orchestrator_tools.loop.*`; the app that was running while this was implemented does not.
  Confirmed on 2026-09-19 against the then-running app:
  `aio-mcp loop failed: Unknown orchestrator-tools RPC method: orchestrator_tools.loop.list`.
- Run the checks from a Harness-spawned agent shell, so `$AIO_MCP`,
  `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET`, `AI_ORCHESTRATOR_INSTANCE_ID` and
  `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY` are injected. Do not print those values.
  The capability token is a separate, concurrent change by another session that landed in
  `orchestrator-tools-rpc-client.ts` on 2026-09-19; without it every `aio-mcp` socket command,
  not just `loop`, fails with "parent socket/instance id missing". If you see that message,
  the app predates the capability change — rebuild and restart it before judging these checks.
- The spawn-depth refusal (a session at `maxSpawnDepth` may run `loop list` but not `loop resume`)
  is covered by `src/main/mcp/orchestrator-tools-rpc-server.spec.ts` and is not repeated here;
  reproducing it live would need a nested session at the ceiling.

Already verified in-loop on 2026-09-19 and not repeated here: argv parsing and refusal messages
(`src/main/mcp/loop-cli.spec.ts`), RPC payload/result validation
(`src/main/mcp/orchestrator-tools-rpc-loop.spec.ts`), the resumable/`live`/checkpoint rules
(`src/main/orchestration/default-loop-cli-operations.spec.ts`), the shared resume sequence
(`src/main/orchestration/loop-resume.spec.ts`), and a full CLI → real Unix socket → RPC server →
coordinator round-trip that lists a parked loop and resumes it
(`src/main/mcp/loop-cli.integration.spec.ts`), the spawn-depth refusal
(`src/main/mcp/orchestrator-tools-rpc-server.spec.ts`), the renderer handler's no-checkpoint and
fail-closed-restore branches (`src/main/ipc/handlers/__tests__/loop-handlers.spec.ts`), and the
mobile thin client restoring a loop parked before a restart
(`src/main/event-bus/thin-client-command-executor.spec.ts`), and the durable provider-limit
auto-resume automation doing the same (`src/main/automations/automation-runner.spec.ts`).
The mobile and automation tests were each confirmed to fail with their fix reverted. `npx tsc --noEmit`, the spec typecheck,
`npm run lint`, `npm run lint:fast`, `npm run check:ts-max-loc`, `npm run build:main`,
`npm run build:renderer` and `npm run build:aio-mcp-dist` all pass, and every spec listed above is
green.

## Status — 2026-09-24 (loops batch)

Open: 1 (check 3, mobile — assessed, not attempted) · Closed: 1 (check 1) · Failed: 1 (check 4's
message text; new defect LT-642) · Not run: 1 (check 2 — scope-safety decision, see evidence run)

Full write-up: [Evidence run — 2026-09-24 (loops batch)](#evidence-run--2026-09-24-loops-batch).

## Status — 2026-09-24 (verify-loops)

Check 4's message-text fix (LT-642) re-checked against the **working tree** (uncommitted fixes) —
**CONFIRMED FIXED LIVE**. Full write-up: [Evidence run —
2026-09-24 (verify-loops)](#evidence-run--2026-09-24-verify-loops).

## Status — 2026-09-19

Open: 4 · Closed: 0 · Failed: 0

## Outstanding checks

### 1. `loop list` finds the real parked loop through the rebuilt app

Why deferred: needs the rebuilt parent process — the RPC method does not exist in the app that was
running when this was written.

1. `$AIO_MCP loop list`

Expected: `loop-1789608176316-f9af53a7` is listed as `provider-limit (parked)`, with its workspace
`/Users/suas/work/orchestrat0r/ai-orchestrator`, the goal "Please work through all the livetests,
fix any issues you find.", the park reason "Parked on a recorded provider limit from loop-quota",
and the line `resume: aio-mcp loop resume loop-1789608176316-f9af53a7`. Exit code 0.

Evidence to record: the command output verbatim.

Note: no `loopProviderLimitResume` automation exists for this run (checked read-only against
`rlm.db`: zero rows in `automations` whose `action_json` mentions it). Nothing was going to resume
it on its own — which is why the manual route matters here. The automation path was fixed in the
same change for future parks, not to rescue this one.

State on 2026-09-19 (read-only from `loop-mode.db`): that run is `provider-limit` with
`ended_at` NULL, a 6,643-byte checkpoint exists, and its isolated worktree
`.worktrees/task-please-work-through-all-the-li-mu4ui30h` is still registered in
`git worktree list`. If any of those three have changed by the time this runs, pick another parked
loop from `$AIO_MCP loop list` and say which.

### 2. `loop resume` actually restarts that loop and it begins an iteration

Why deferred: needs the rebuilt app, and starts real provider work that spends tokens.

1. `$AIO_MCP loop resume loop-1789608176316-f9af53a7`
2. Watch the loop in the app's Loop panel, and
   `~/Library/Application Support/harness/logs/app.log`.

Expected: the CLI prints `Resumed loop-1789608176316-f9af53a7 (re-hydrated from its stored
checkpoint): provider-limit -> running` and exits 0. The log carries
`Loop resumed via aio-mcp loop CLI` followed by the coordinator's `Loop resumed`. The Loop panel
shows the run as running, and an iteration starts in the existing worktree — not in the repository
root. `$AIO_MCP loop list` no longer lists it as resumable.

Evidence to record: CLI output, the two log lines, and the iteration's working directory.

### 3. Resuming a parked loop from the mobile client works after a restart

Why deferred: needs the rebuilt app and a paired mobile client.

Background: `loop:resume` on the thin client previously called `coordinator.resumeLoop` only, which
returns false for any loop the coordinator no longer holds in memory — so a mobile resume of a loop
parked before a restart was a silent no-op. It now shares the renderer's restore-then-resume path.

1. With a loop parked and the app freshly restarted, resume it from the mobile client.

Expected: the loop starts running, the same as check 2. Before this change it would have appeared
to do nothing.

Evidence to record: the mobile UI state and the `Loop resumed` log line.

### 4. A terminal loop is refused with a non-zero exit code

Why deferred: needs the rebuilt app.

1. Pick a terminal run from `$AIO_MCP loop list --all --limit 20` (for example a `cap-reached` or
   `cancelled` one).
2. `$AIO_MCP loop resume <that-id>; echo "exit=$?"`

Expected: `aio-mcp loop failed: Loop <id> is <status>, which is terminal. Only paused loops and
provider-limit loops parked with no end time can resume.` and `exit=1`. Nothing starts.

Evidence to record: the command output and the exit code.

---

## Evidence run — 2026-09-24 (loops batch)

Run against `$AIO_MCP` (`/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp`), which
per this doc's own design talks to the **packaged** app — i.e. James's real running Harness, not this
batch's disposable dev app. `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET` /
`AI_ORCHESTRATOR_INSTANCE_ID` / `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY` were present in this
agent's own environment (never printed).

### Check 1 — `loop list` finds the real parked loop · PASS

`$AIO_MCP loop list`, exit `0`:

```
loop-1789608176316-f9af53a7 | provider-limit (parked) | started 2026-09-17T01:22:58.949Z | 0 iteration(s)
  workspace: /Users/suas/work/orchestrat0r/ai-orchestrator
  goal: Please work through all the livetests, fix any issues you find.
  why: Parked on a recorded provider limit from loop-quota
  resume: aio-mcp loop resume loop-1789608176316-f9af53a7
```

Matches the check's expected id, workspace, goal, park reason and resume hint exactly.

### Check 2 — `loop resume` actually restarts that loop · NOT RUN (scope-safety decision)

`loop-1789608176316-f9af53a7`'s workspace is the **real** `ai-orchestrator` checkout, and this
campaign's hard rule is "never point a loop at the ai-orchestrator repo" / only run loops against a
disposable scratch repo under `/tmp/aio-lt-0924-loops-work/`. Actually resuming this loop would spend
real provider tokens and run a real, unsupervised agentic turn inside a live worktree of the
production repo (`.worktrees/task-please-work-through-all-the-li-mu4ui30h`) while other sessions may
be relying on it — indistinguishable in effect from this batch pointing a loop at that repo itself,
even though the loop was parked by someone else before this batch started. Judged out of scope for an
agent-run batch; not attempted. The mechanism itself already has in-loop coverage per this doc's own
prerequisites section (`loop-cli.integration.spec.ts`, a real socket→RPC→coordinator round trip that
resumes a parked loop) — this pass only adds the read-only `loop list` and the terminal-refusal check
below.

### Check 3 — mobile-client resume after a restart · assessed, not attempted

A synthetic mobile-gateway client *can* in principle be paired on loopback against a dev app (per the
`devapp-mobile-gateway-blocked-by-firewall` pattern from an earlier campaign: bind `'all'` +
loopback, pair a synthetic client, drive it over the gateway's own protocol). But this check
specifically needs **the packaged app**, because it is exactly the packaged app that holds the real
parked loop, has been "freshly restarted", and would need a synthetic mobile client paired against
*it* — a materially bigger and riskier step than the dev-app case the memory note describes: it means
minting a real mobile-gateway pairing against James's live profile, and then, to see anything happen,
actually resuming a real parked loop against a real repo (the same objection as check 2). Not cheap
or safe enough for this batch to attempt; recommend a dedicated pass with explicit authorisation if
mobile-resume coverage is wanted, using a disposable parked loop in a scratch repo rather than the
three real ones currently parked.

### Check 4 — a terminal loop is refused with a non-zero exit code · exit code PASSES, message text
FAILS (new defect LT-642)

Two different real terminal loops from `$AIO_MCP loop list --all --limit 20`:

```
$AIO_MCP loop resume loop-1789605860183-bf4aaa91   # cancelled
→ aio-mcp loop failed: Cannot restore non-paused loop checkpoint: cancelled
→ exit=1

$AIO_MCP loop resume loop-1788642269159-5d07a91f   # cap-reached
→ aio-mcp loop failed: Cannot restore non-paused loop checkpoint: cap-reached
→ exit=1
```

The **exit code (1) and the refusal itself are correct** — nothing started for either loop. But the
**message text does not match** what this check (and the codebase's own tests) specify: `Loop <id> is
<status>, which is terminal. Only paused loops and provider-limit loops parked with no end time can
resume.` Root cause and full write-up: **LT-642** below.

### Defects filed from this run

**LT-642 (P3) — resuming an old terminal loop (one no longer held live in memory) prints the wrong,
confusing refusal message, even though it still safely refuses.**

*Observed:* `$AIO_MCP loop resume <id>` for two different real terminal loops
(`cancelled`, `cap-reached`) — both from before this session, so neither was held live in the
packaged app's in-memory coordinator — printed `Cannot restore non-paused loop checkpoint: <status>`
instead of the documented/tested `Loop <id> is <status>, which is terminal. Only paused loops and
provider-limit loops parked with no end time can resume.` The exit code is still `1` and nothing
starts in either case — this is a message-quality defect, not a safety one.

*Root cause (verified by reading code, high confidence):* `resumeLoopRun`
(`src/main/orchestration/loop-resume.ts:50-93`) only reaches its own well-worded
`notResumableReason()` (`:95-108`, exactly the string this check expects) when the coordinator
already holds the loop's state **in memory** (`state` truthy after `coordinator.resumeLoop()` /
`getLoop()`). For any loop whose only remaining record is its on-disk checkpoint — which is the
normal case for a loop that finished before the current app session, i.e. after almost any restart —
the guard `if (!ok && !state)` at `:59` takes the checkpoint-restore branch instead and calls
`coordinator.restoreLoopFromCheckpoint(checkpoint)`, which throws the unrelated, unfriendlier
`` `Cannot restore non-paused loop checkpoint: ${state.status}` `` at
`src/main/orchestration/loop-coordinator.ts:1202-1203` for any checkpoint whose status isn't `paused`
or `provider-limit` — before `resumeLoopRun` ever gets a chance to build the nicer message. The
existing unit test for the terminal-refusal message
(`src/main/orchestration/default-loop-cli-operations.spec.ts:203-215`,
`'throws the refusal reason when the coordinator declines the resume'`) only covers the case where
the terminal state is *already live in memory* (`liveStates: [live]`, `checkpoints: {}`); there is no
test for a terminal loop reachable only via checkpoint, which is exactly the gap this live check
found and exactly why the doc's own expected text was never actually reachable for two real loops out
of the three checked.

*Required behavior:* resuming any terminal loop — whether its state is live in memory or only on
disk — prints the same clear `Loop <id> is <status>, which is terminal…` message and exits
non-zero.

*Acceptance:* `resumeLoopRun` (or `restoreLoopFromCheckpoint`) recognises a checkpoint whose own
`status` is terminal (anything other than `paused`/`provider-limit`-with-`endedAt: null`) and routes
it through `notResumableReason()`'s message before throwing, rather than surfacing
`restoreLoopFromCheckpoint`'s internal, implementation-facing error text. A regression test covering
a terminal loop reachable only via checkpoint (not live in the coordinator) should accompany the fix.

*Owning doc + check:* this doc, check 4.

### Cleanup

Both commands run this section were read/refusal-only (`loop list`, and two refused `loop resume`
attempts that started nothing). Nothing was created, resumed, or modified in James's real profile or
any repo.

## Evidence run — 2026-09-24 (verify-loops)

Batch `verify-loops`, driven against the **working tree** (dist/main rebuilt ~03:00 from today's
uncommitted fixes, not HEAD `f04f6748`). Never resumed a loop whose workspace is the real
`ai-orchestrator` repo — instead created a disposable terminal loop of our own in a scratch repo
(`/tmp/aio-lt-0924-verify-loops-work/repo1`) and resumed it via the dev app's own orchestrator-tools
socket, which required a restart to reproduce the checkpoint-only (not-live-in-memory) path check 4
actually needs.

### Check 4 — a terminal loop is refused with the documented message · CONFIRMED FIXED LIVE

1. Ran a short Claude loop (`loop-1790215260126-8d148a43`) to a real terminal `completed` status in
   the scratch repo (the same run used for this campaign's stranded-worktree-rescue LT-2/LT-4 check).
2. Restarted the dev app (killed and relaunched only this batch's own verified pid,
   `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-verify-loops`, same profile and port) so the coordinator no
   longer holds the run in memory — the exact condition the LT-642 fix targets (a checkpoint-only
   terminal loop, reachable only via `loop-mode.db`, not the live coordinator map).
3. Spawned a fresh Claude instance in the restarted app (`workingDirectory` still the scratch repo) and
   asked it to run, via its own Bash tool (which carries the Harness-injected
   `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET`/`_INSTANCE_ID`/`_CAPABILITY` env — the same
   `$AIO_MCP` route the doc specifies, just pointed at this dev app's own socket instead of the
   packaged app's), and report the verbatim output:

   ```
   $AIO_MCP loop resume loop-1790215260126-8d148a43; echo "EXIT_CODE=$?"
   ```

   Verbatim result: `aio-mcp loop failed: Loop loop-1790215260126-8d148a43 is completed, which is
   terminal. Only paused loops and provider-limit loops parked with no end time can resume.` and
   `EXIT_CODE=1`.

This is the **exact** documented/tested message this check specifies, for a run that was genuinely
terminal-only-via-checkpoint (not live in memory) — the precise gap the loops batch's pre-fix run hit
(`Cannot restore non-paused loop checkpoint: completed`). Exit code 1, nothing started. **LT-642 is
confirmed fixed live**, closing the "live re-check pending" note in the remediation register.

### Cleanup

The loop-resume verification instance was terminated (`window.electronAPI.terminateInstance`);
`window.electronAPI.listInstances()` returned `[]` at the end of the batch. The scratch repo and
electron profile were removed. The dev app restart used only this batch's own recorded pid, confirmed
against the pre-existing process snapshot before killing.
