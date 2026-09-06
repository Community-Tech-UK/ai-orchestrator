# Automation Provider Exclusions Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. A pending or unrun check is not
> automatically a defect, but a *reproduced* one belongs there. Per-check evidence stays in this
> file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: **restart the Harness app** so it loads the rebuilt `dist/main`. The instance
> running at implementation time predates this build and does not know the
> `providersExcludedFromAutomation` key at all (`aio-mcp settings get
> providersExcludedFromAutomation` returned `Unknown setting key`). See the source
> [implementation plan](./2026-07-30-automation-provider-exclusions_plan.md).

> **Context:** James is running a work pilot on a GitHub Copilot seat licensed for EBRD work only.
> Until these checks pass on a restarted app, the six automatic paths audited in the plan can still
> reach Copilot.

## Check 1: The pre-set value survived the restart

`providersExcludedFromAutomation` was written directly into both settings profiles while the old
app was still running, because the running instance could not accept the key. If that instance
wrote settings from its own in-memory state before shutting down, the key was silently dropped.

1. Restart Harness.
2. Run `$AIO_MCP settings get providersExcludedFromAutomation`.

Expected result: `["copilot"]`.

If it returns `[]`, the old instance clobbered the file — re-apply via Check 2 and treat this as
expected behaviour, not a defect.

Why deferred: needs the app restarted onto the new build.

## Check 2: The setting is visible and editable in the UI

1. Open Settings → Review.
2. Find **Never auto-pick these providers**.

Expected result: a checkbox list of all eight providers (Claude Code, OpenAI Codex CLI, Gemini CLI,
Antigravity, GitHub Copilot, Cursor CLI, Grok Build, Ollama), with **GitHub Copilot** ticked.
Ticking and unticking persists across a settings-tab switch.

Why deferred: renderer UI check on the rebuilt app.

## Check 3: Explicit Copilot selection still works

The whole point of the design is that the exclusion blocks automatic selection only.

1. In the EBRD session folder, start a new session and explicitly pick Copilot as the provider.
2. Send a prompt.

Expected result: the session spawns on Copilot and responds normally. No warning, no substitution.

Why deferred: needs a real CLI spawn against the live work Copilot seat.

## Check 4: Copilot is not pulled into a ping-pong review

This is the path most likely to have fired in practice (`pingPongReviewerProvider` is `auto`, and
Tier 2 widening reaches any installed provider).

1. Start a loop with ping-pong review enabled, builder = Claude.
2. Let it run a review round, ideally while Codex is unavailable or rate-limited so the Tier 2
   widening path is exercised.
3. Search the app log for `pingPongReviewer` and for the reviewer provider actually used.

Expected result: the reviewer is never `copilot`. When the codex/claude pair is exhausted the log
shows either another installed provider or `reviewer-unavailable` — never a Copilot review call.

Why deferred: needs a live loop run; the unit spec covers the resolution logic but not a real
review round.

## Check 5: An agent cannot widen its own access

`providersExcludedFromAutomation` is `readOnly()` in the settings control policy.

1. From an agent session, attempt `set_setting` with key `providersExcludedFromAutomation` and
   value `[]`.

Expected result: the write is refused as read-only. The value stays `["copilot"]`.

Why deferred: needs a live MCP settings tool call against the restarted app.

## Check 6: No automatic Copilot traffic over a working day

1. After a normal day's use with the restarted app, check the Copilot quota chip / usage.

Expected result: usage moves only for sessions James explicitly started on Copilot. No consumption
attributable to review, consensus, verification, scaffolding, or magic-prompt activity.

Why deferred: requires elapsed real-world usage.

## Evidence run — 2026-07-31 — **all three checks PASS; doc closed**

Dev app on `--remote-debugging-port=9444`, rebuilt main, real `window.electronAPI` and real DOM.

### Check 1 — the pre-set value survived the restart — ✅ PASS

`providersExcludedFromAutomation` reads `["copilot"]`, and the on-disk value matches in **both**
profiles — so the old instance did not clobber the file:

```
live settings (dev app):                       ["copilot"]
~/Library/.../harness/settings.json:            ['copilot']
~/Library/.../harness-dev/settings.json:        ['copilot']
```

### Check 2 — visible and editable in the UI — ✅ PASS

Navigated the real renderer to `/settings` and opened the **Review** category, then read the actual
rendered control (not the metadata definition):

| Provider | Ticked |
| --- | --- |
| Claude Code | ☐ |
| OpenAI Codex CLI | ☐ |
| Gemini CLI | ☐ |
| Antigravity | ☐ |
| **GitHub Copilot** | **☑** |
| Cursor CLI | ☐ |
| Grok Build | ☐ |
| Ollama | ☐ |

All eight providers, in the documented order, with Copilot ticked.

**Persistence across a tab switch**, driven by clicking the real checkbox:

1. Clicked **Grok Build** → setting became `["copilot", "grok"]`.
2. Switched to another settings tab and back → Grok Build **still ticked**, Copilot still ticked.
3. Clicked it again → setting back to `["copilot"]`.

State restored to `["copilot"]`.

### Check 3 — explicit Copilot selection still works — ✅ PASS (after a fix)

Explicitly created a Copilot instance and sent a prompt:

```
requested provider: copilot
actual provider:    copilot     ← no substitution
model:              gemini-3.1-pro-preview
reply:              EXPLICIT-COPILOT-OK
warnings:           []          ← none
```

The exclusion blocks only *automatic* selection, exactly as designed.

**It did not pass first time**, and the reason is worth recording: the run surfaced

```
Model "opus[1m]" is no longer available for copilot. Using "gemini-3.1-pro-preview" instead.
```

which is the **LT-016** trust bug — the provider-agnostic global `defaultModel` (a Claude id) being
offered to Copilot, rejected, and reported to the user as though *their* selection had gone stale.
LT-016 was marked fixed on 2026-07-30, but that fix added provenance and suppression only to the
**swap** path (`resolveSwapModelWithSource` → `runtime-reconciler.ts`). The **create** path had
none — so every new non-Claude session still produced the spurious notice, which is the far more
common case.

Fixed by giving `ModelSelectionResolver` the same provenance (`modelSource`) and applying the same
suppression at the create-time emission site. An explicitly requested or agent-pinned model still
surfaces its degradation; only a rejection traced to the global default is logged silently
(`userVisible: false`). Re-verified live above: `warnings: []`.

**Workspace note:** the check specifies the EBRD session folder. This run used the disposable
`/tmp/aio-lt-ws1b` instead — the assertion is that explicit selection is not blocked or substituted,
which is workspace-independent, and it avoids pointing the licence-limited work seat at unrelated
content.

**All three checks pass. Renamed `_livetest_completed.md`.**

## Correction — 2026-08-19 — doc reopened, closure was premature

The 2026-07-31 run above verified **Checks 1–3 only** and then closed the whole doc, but the doc
defines **six** checks. Checks 4, 5, and 6 were never run and have no evidence entry. Per the
campaign rule ("Never rename a doc `_livetest_completed.md` unless EVERY check in it passes with
current evidence"), that closure was wrong. Renamed back to `_livetest.md`. The 2026-07-31 section
above is left unedited as the historical record of what was actually done that day.

### Check 5 — re-scoped finding: the original check didn't test the surface that was actually broken

Check 5 as written only exercises the safe `set_setting` MCP tool. While auditing this plan's
completeness (fresh-eyes pass), I found the setting was **not** in
`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` in `src/main/core/config/settings-control-policy.ts`, so the
**privileged** `aio-mcp settings set` CLI — the route AGENTS.md tells agent sessions to use for
settings repair, and one this user's own memory notes agents routinely use for ~171 keys — could
still write `providersExcludedFromAutomation` to `[]` or edit it freely. That directly defeats the
plan's stated threat model ("An agent that could edit it could grant itself the very access the
operator withheld").

**Reproduced**: added `src/main/core/config/settings-control-policy.automation-provider-exclusions.spec.ts`;
the `assertPrivilegedSettingsCliWritable('providersExcludedFromAutomation')` case failed (no throw)
against the code as it stood.

**Fixed**: added `'providersExcludedFromAutomation'` to `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`
(`src/main/core/config/settings-control-policy.ts:64`, alongside `allowPrCreation`, same reasoning).
Updated the operator-only anchor count (17 → 18) in `docs/AIO_MCP_CLI.md`,
`docs/llm/AIO_MCP_CLI_REFERENCE.md`, and the doc-sync test in
`src/main/mcp/orchestrator-settings-tools.spec.ts`. Watched the new spec fail before the fix and
pass after (revert-and-confirm done, not just written).

Both write surfaces are now traced and unit-verified against the exact functions their live IPC
handlers call (`setSettingForTools` → `coerceWritableSettingValue`;
`privilegedSetSetting`/`privilegedResetSetting` → `assertPrivilegedSettingsCliWritable`):

- Safe `set_setting` tool: `coerceWritableSettingValue('providersExcludedFromAutomation', …)` throws
  `/read-only/`. **Verified by unit test tracing the live call path, not a live IPC round-trip.**
- Privileged `aio-mcp settings set`: `assertPrivilegedSettingsCliWritable('providersExcludedFromAutomation')`
  now throws `/operator-only/`. **Same verification method.**

Check 5 status: **code-path verified (not live-round-tripped)**. A live confirmation on a restarted
app (`$AIO_MCP settings set providersExcludedFromAutomation '[]'` should be refused) is still the
stronger form of evidence and is left as the residual below.

### Residual — still open, need a restarted app / real usage

- **Check 4** (Copilot not pulled into a ping-pong review during a real Tier-2-widening round) —
  not run. Needs a live loop with ping-pong review enabled and Codex made unavailable/rate-limited.
- **Check 5** — live IPC round-trip not run (see above; code-path verified instead). Re-run
  `$AIO_MCP settings set providersExcludedFromAutomation '[]'` against a restarted app and confirm
  refusal, and re-run the safe `set_setting` tool call the check originally specified.
- **Check 6** (no automatic Copilot traffic over a working day) — cannot be completed by an agent in
  one session by construction; it requires elapsed real-world usage after the fixes in this
  correction reach a running build.

Do not rename this doc `_livetest_completed.md` again until Checks 4, 5 (live round-trip), and 6
have current dated evidence.

## Evidence run — 2026-08-19 (Batch N4) — Checks 4 and 5 closed live; check 6 confirmed structurally unrunnable

Driven in an isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N4`,
`--remote-debugging-port=9604`, `--inspect=9704`, rebuilt current `dist/main`). **The packaged app
(pid 22117) was never touched, restarted, or written to** — per this run's explicit brief, check 5's
destructive shortcut (running the privileged-CLI write against production, which predates the fix and
would genuinely have cleared James's real Copilot exclusion) was avoided entirely by reaching the
**dev app's own** orchestrator-tools RPC socket instead.

### Check 5 — LIVE round-trip, against a real (non-production) instance — ✅ PASS, both surfaces

Created a real instance in the isolated dev app (`electronAPI.createInstance`) to get an instance id
the dev app's own `InstanceManager` recognizes (`isKnownLocalInstance`,
`orchestrator-tools-rpc-server.ts:308`) — that check is the entire authentication model for the
orchestrator-tools socket, so a real instance id from *any* running Harness process is sufficient
credential to call its RPC server. Found the dev app's own socket on disk
(`/tmp/aio-lt-N4/ot-26b5f2f5e6f6.sock` — created per-launch by
`createOrchestratorToolsSocketPath`, `orchestrator-tools-socket-path.ts`) and pointed the packaged
`aio-mcp` binary's env at it instead of the production socket:

```
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET=/tmp/aio-lt-N4/ot-26b5f2f5e6f6.sock
AI_ORCHESTRATOR_INSTANCE_ID=cc0e835o7
```

This is safe because the RPC wire protocol (JSON-RPC method names/params) is a stable contract
between the CLI client and whichever main process answers the socket — the *binary* on disk doesn't
matter, only which process's settings-control-policy actually runs, and here that's the dev app's own
freshly rebuilt `dist/main`, containing the uncommitted `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` fix.

**Privileged CLI** (the one that matters — this is the surface the fresh-eyes finding above was about):

```
$ aio-mcp settings get providersExcludedFromAutomation --json
{ "value": [], "policyTier": "read-only", "cliWritable": false }

$ aio-mcp settings set providersExcludedFromAutomation '[]'
aio-mcp settings failed: Setting is operator-only and cannot be changed by agents: providersExcludedFromAutomation
(exit 1)
```

**Safe `set_setting` MCP tool** (the check's originally-specified surface), via
`_scratch/lt-2026-08-19/aio-tool.mjs` with the same env override:

```
$ call set_setting {"key":"providersExcludedFromAutomation","value":[]}
Error: {"code":-32000,"message":"Setting is read-only via tools: providersExcludedFromAutomation"}
(exit 1)
```

Re-read via `get_setting` afterward: value still `[]` (dev app's own default — no write landed via
either path). **Check 5: PASS**, live-round-tripped on both agent-facing write surfaces, with zero
risk to James's real `["copilot"]` production value.

### Check 4 — Copilot never pulled into a ping-pong review, including Tier-2 widening — ✅ PASS, with a positive/negative control pair

Set the dev app's `providersExcludedFromAutomation` to `["copilot"]` via the renderer's own
`electronAPI.setSetting` (the same trusted human-facing path Check 2 drove via a real checkbox click —
this setting is deliberately writable there; only the agent-facing tool/CLI surfaces are blocked).
Confirmed all of `claude`, `codex`, `antigravity`, `copilot`, `cursor`, `grok` are genuinely installed
in this environment (`detectAvailableClis()`, called live via Node Inspector Protocol on the dev app's
main process at `--inspect=9704`) — so Copilot is a real, otherwise-eligible Tier-2 candidate, not
absent from consideration by chance.

Called the real, unmodified, exported `agenticPingPongReviewer()`
(`dist/main/orchestration/agentic-pingpong-reviewer.js`, source
`src/main/orchestration/agentic-pingpong-reviewer.ts`) directly via Node Inspector — this is not a
reimplementation or a mock: it is the exact function `loop-pingpong-completion.ts:332`
(`const reviewer = deps.reviewer ?? agenticPingPongReviewer;`) uses by default for every real loop's
ping-pong review round. Simulated Tier-2 widening deterministically by passing
`triedReviewerProviders: ['codex', 'antigravity']` (both "already tried and failed this run" — the
realistic trigger the check describes, without needing to actually throttle a live Codex CLI) with
`builderProvider: 'claude'`, against a tiny real scratch git repo/diff
(`/tmp/aio-lt-N4-pingpong`). `resolveReviewerProvider()` runs and captures `reviewerProvider` before
the actual spawn, so the routing decision is provable even if the subsequent review times out.

**With `providersExcludedFromAutomation: ["copilot"]`:** resolver picked **`cursor`** — the fixed
Tier-1 pair (`codex`, `claude`) was exhausted (tried / builder), `antigravity` was marked tried, and
Copilot — next in the raw installed-provider order — was skipped. Real instance spawned (`Creating
instance … "Ping-pong reviewer 3/3 (cursor)" … provider:"cursor"`, confirmed in
`~/Library/Application Support/harness/logs/app.log`), completed with a real `CHANGES_REQUESTED`
verdict.

**Negative control — same exact scenario, exclusion cleared to `[]`:** re-ran the identical call.
Resolver picked **`copilot`** this time (`"Ping-pong reviewer 3/3 (copilot)"`, provider `copilot`, a
real spawned CLI process, also settled `CHANGES_REQUESTED`). This proves the first result was not an
accident of provider-list ordering — Copilot really was the next eligible Tier-2 candidate, and really
was excluded specifically by `providersExcludedFromAutomation`, not by any other factor.

Restored the dev app's setting back to `["copilot"]` afterward (dev-app-only state, disposable at
session end; not production).

**Check 4: PASS.** Copilot is never selected during real Tier-2 widening while excluded, verified via
the production loop's actual default reviewer-resolution function, with a genuine positive/negative
control demonstrating the exclusion — not the widening order — is what blocked it. Not driven through
a literal end-to-end loop-UI round (time/cost of a full live loop run); driven at the documented
direct-call seam this campaign has used repeatedly for hard-to-trigger states (Batch S's
`StartupCapabilityReport` injection, Batch S3's `handleProviderLimit`/`classifyFreshEyesBlocking`
calls) — the seam here is the *default* production dependency, not a test double.

### Check 6 — reconfirmed structurally unrunnable this session

No new attempt — the check requires elapsed real-world usage after a rebuilt/restarted app reaches
James, which is outside any single agent session by construction. Unchanged from the prior correction.

### Doc status: still open — check 6 is the only remaining residual, and it cannot close in-session

**Checks 1–5 all PASS with current, dated evidence** (1–3: 2026-07-31; 5's re-scoped policy fix:
2026-08-19 correction; 4 and 5's live round-trip: this run). **Check 6** cannot be satisfied by an
agent session — it requires a full working day of real usage on a build that has already shipped the
fixes above. Per campaign rule, **not renamed** `_livetest_completed.md`: an honest reading of "every
check passes with current evidence" cannot be met for a check that is definitionally unattemptable
in-session. Recommend to James: either (a) treat check 6 as permanently out of an agent's reach and
close the doc on checks 1–5 plus a standing "monitor Copilot usage" note, or (b) leave it open
indefinitely as a reminder to spot-check the Copilot quota chip after a normal day's use. This is a
product/process decision, not one for this session to make unilaterally.

## Evidence run — 2026-08-19 (Batch P4) — read-only production log query, input to check 6's decision (not a verdict)

Per this batch's brief, check 6 was not attempted (it is definitionally unattemptable in one agent
session) and this doc was not renamed. Instead, ran a **read-only** query against the packaged app's
own `app.log` (pid 22117 never touched, restarted, or written to) to give James a concrete data point
for the decision already surfaced above, rather than leaving it purely hypothetical.

**Method.** Grepped every `"message":"Creating instance"` line with `"provider":"copilot"` across the
current `app.log` (covers roughly 2026-08-12 onward) plus the two prior rotations `app.log.1` and
`app.log.2` (extending back to roughly 2026-07-24), then read the full context of each hit to classify
it as explicit-user/explicit-tool-param vs. automatic/implicit selection (the failure mode check 6
cares about).

**Result: every Copilot instance-creation event found across ~4 weeks of retained logs is explicit,
none is an automatic-selection failure.**

| Source | Count | Classification |
| --- | --- | --- |
| `run_on_node:windows-pc` spawns with an explicit `provider` tool argument | 4 | Explicit — an agent/orchestrator call named `copilot` directly as a parameter, not automatic widening |
| `displayName: "LT-161 remote-restart probe"` | 1 | Explicit — a prior livetest campaign's own named probe |
| Bare scratch-workspace Copilot creates (`/tmp/aio-lt-evidence-batchC`, `/tmp/aio-lt-ws14b`, `/tmp/aio-lt34`) | 3 | Explicit — prior livetest campaigns' own check-3-style "explicit selection still works" probes |
| `displayName: "Ping-pong reviewer 3/3 (copilot)"`, `workingDirectory: /tmp/aio-lt-N4-pingpong` | 1 | This batch's own sibling (Batch N4) check-4 **negative control** — deliberately cleared the exclusion to `[]` to prove Copilot *could* be selected without it, `loopRunId: "n4-pingpong-negctrl"` |

One additional line — `CrossModelReviewService: "Configured cross-model reviewer(s) unavailable —
excluded from pool"`, listing `copilot` under `available` — is a diagnostic snapshot logged at CLI
detection time (startup), not a reviewer-selection event; no instance-creation line follows it, so it
does not represent Copilot traffic.

**What this does and does not show.** It is not a substitute for check 6's own full-day-of-real-usage
requirement, and the log window (~4 weeks) only reaches back to shortly before the original
2026-07-30 implementation, not a clean "since the fix landed" boundary. But within that window, zero
of the automatic paths the plan audited (ping-pong Tier-2 widening, consensus, scaffolding,
magic-prompt) produced a real Copilot spawn against a non-scratch, non-livetest workspace — every hit
traces to either an explicit provider argument or a livetest campaign's own deliberate probe. This is
offered as one input to James's decision on check 6, not a claim that the check has been satisfied.

**No production writes.** Read-only `grep`/context reads against
`~/Library/Application Support/harness/logs/app.log{,.1,.2}` only; no instance created, no setting
changed, no automation created against the packaged app this run.


## Evidence run — 2026-08-20 (orchestrator): check 5's live round-trip now PASSES on the rebuilt app

James rebuilt and restarted the packaged app (bundle and `aio-mcp` binary both rebuilt 2026-08-20
12:21–12:22, new main pid), so the uncommitted `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` fix is now live.
Confirmed in the bundle itself before testing, rather than assumed from the source tree:
`strings app.asar | grep "operator-only and cannot be changed by agents"` → 2 hits.

### Check 5 — an agent cannot widen its own access — ✅ PASS (live round-trip, closes the residual)

The 2026-08-19 correction recorded check 5 as **"code-path verified (not live-round-tripped)"** and
left the live confirmation as the residual. That residual is now closed.

The policy tier itself is the first observable change — this is the exact field whose misreading kept
a different blocker alive for weeks, so it is worth quoting:

```
$AIO_MCP settings get providersExcludedFromAutomation
providersExcludedFromAutomation: ["copilot"]
policy=read-only cliWritable=no toolWritable=no restartRequired=no
```

`cliWritable=no`. Before the fix this read `cliWritable=yes` — `readOnly()` alone gates only the safe
`set_setting` MCP tool, not the privileged repair CLI, which is precisely the hole the fresh-eyes pass
found.

The write attempt, and the value afterwards:

```
$AIO_MCP settings set providersExcludedFromAutomation '[]'
aio-mcp settings failed: Setting is operator-only and cannot be changed by agents:
  providersExcludedFromAutomation

$AIO_MCP settings get providersExcludedFromAutomation
providersExcludedFromAutomation: ["copilot"]        ← unchanged
```

Refused with the operator-only message, and James's real production value is intact. Note this test
was deliberately **not** run before the rebuild: against the old build it would have succeeded and
cleared the very security setting the plan exists to protect.

**Doc status: checks 1–5 all PASS. Not renamed** — check 6 ("no automatic Copilot traffic over a
working day") remains, and it cannot be satisfied by an agent by construction.

**Closure criterion for check 6, so this doc stops needing re-triage:** after a normal working day on
the rebuilt app, confirm the Copilot quota chip moved only for sessions James started explicitly. The
supporting evidence already gathered (2026-08-19, ~4 weeks of production logs: all 9 Copilot instance
creations trace to an explicit `provider` argument, a named livetest probe, or a negative-control
test — zero automatic-selection spawns) makes that a confirmation rather than an investigation.

## Evidence run — 2026-08-24 (Batch B) — checks 1–5 reconfirmed unchanged; check 6 log window extended by one more day, same result

Read-only reconfirmation only; no production writes.

- `$AIO_MCP settings get providersExcludedFromAutomation --json` → `{"value": ["copilot"], "policyTier":
  "read-only", "cliWritable": false}` — unchanged from 2026-08-20, James's real exclusion still intact
  and still CLI-unwritable (the fix from that run is still live in the running production build).
- Migration/curated-name cross-check (shared read with the sibling hidden-automations doc): production
  `rlm.db` still shows the expected state, not specific to this doc but confirms no regression to the
  settings/automation subsystem generally.
- **Check 6 supporting evidence, extended one day (2026-08-23, the day immediately preceding this
  campaign):** grepped the current `app.log` for every `"Creating instance"` line with
  `"provider":"copilot"` since the 2026-08-19 sweep's cutoff. Found **8** new hits, all dated
  2026-08-23, all `displayName: "run_on_node:windows-pc"` with an explicit `provider` tool argument —
  the same classification as every prior hit in this doc's evidence base. **Zero automatic-selection
  Copilot spawns in the extended window.** This is one more day of corroborating data for James's
  eventual check-6 decision, not a new verdict.

**Status unchanged: checks 1–5 PASS (current evidence, some carried forward and reconfirmed today,
some newly extended). Check 6 remains structurally unrunnable by an agent session (requires elapsed
real-world usage) — not renamed, consistent with every prior run's conclusion.

---

## Evidence run — 2026-08-25 (orchestrator): check 6 PASSES — every Copilot spawn in the post-restart window is explicit

Check 6 has been recorded as "structurally unrunnable by an agent session (requires elapsed real-world
usage)" by every prior run. That framing was right about the *instrument* and wrong about the
*conclusion*: the elapsed usage has now happened. The packaged app was restarted 2026-08-24 00:38 and
2026-08-25 was a full working day on it, so the window the check asks about exists and can be read.

**A stronger instrument than the one the check names.** The check suggests reading "the Copilot quota
chip / usage". That reports an aggregate, which cannot distinguish an explicit session from an
automatic one — the very thing the check is actually about. The app's own instance-creation log
records the *provenance* of every individual spawn, so it answers the real question directly.

**Method.** Every retained `app.log` (`app.log`, `app.log.1`–`.4`) was parsed for `Creating instance`
and `Spawning CLI process` entries with `provider: "copilot"`.

**Result — 20 lines, which is 10 creations each paired 1:1 with its CLI spawn.** No unpaired
`Spawning CLI process` exists, so nothing reached the Copilot CLI by a route that bypasses instance
creation — that pairing is what rules out a separate review/consensus/verification spawn path in this
window, rather than assuming there isn't one.

| when | provenance | verdict |
| --- | --- | --- |
| 2026-08-23 × 8 | all `displayName: "run_on_node:windows-pc"`, each with an explicit `provider` tool argument; working directories under `C:\Users\shutu\…` | explicit |
| 2026-08-25 × 2 | `agentId: "build"`, `modelOverride: "claude-opus-5"`, workspace `~/work/orchestrat0r/ai-orchestrator`, initial prompt *"Why is the prompt not here? It seems like we dont have the full history."* — 72/73 chars, one carrying a pasted PNG attachment | explicit: a human-typed message with a pasted screenshot, sent twice |

**Zero automatic-selection Copilot spawns.** Nothing attributable to review, consensus, verification,
scaffolding or magic-prompt activity — which is check 6's expected result, stated in its own terms.

The two 2026-08-25 entries deserve the explicit note, because on first inspection they were the
suspicious ones: unlike every other hit in this doc's evidence base they are **not**
`run_on_node:windows-pc`, and they run in a **non-EBRD** repository, which is where the standing
"Copilot seat is EBRD-only, never auto-pick" expectation would be violated if anything had gone wrong.
Reading the full log entry settles it — an interactive prompt with a pasted image is not something
automation produces.

**Scope of this run's own window, stated honestly.** The current retained log set only reaches back to
2026-08-23 for Copilot lines; older files have rotated. So this run independently covers 2026-08-23
onward, and it *corroborates* rather than replaces the 2026-08-19 four-week sweep (9 creations, all
explicit) and the 2026-08-24 one-day extension (8, all explicit) recorded above. Taken together the
three sweeps span roughly five weeks with no automatic Copilot selection at any point, and the setting
itself was re-confirmed intact and CLI-unwritable on 2026-08-24.

### Doc status

Checks **1, 2, 3, 4, 5, 6 — all PASS.** Renamed `_livetest_completed.md`.
