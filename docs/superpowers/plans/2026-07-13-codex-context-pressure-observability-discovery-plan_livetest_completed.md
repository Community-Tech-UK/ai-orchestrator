# Codex Context-Pressure Controlled Reproduction Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

## Status — completed by consolidation 2026-09-27

Open here: 0 · Closed here: 4 · Transferred decisions: 1 · Failed: 0

The literal runtime protocol, analyzer, privacy checks and Stop/Interrupt drill all passed. LT-601
and LT-602 were confirmed fixed live against HEAD `f04f6748`. The sole remaining choice — whether
to add a new Codex pre-execution approval gate or formalize the live-proven detect-and-interrupt
contract — was moved to
[RES-012](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-012--decide-codex-tool-safety-semantics).
That consolidated decision record is now the only active owner.

## Status — 2026-09-21

Open: 1 · Closed: 4 · Failed: 0
The full literal protocol was run end to end on 2026-09-21 — see
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-plan-queue-worker-full-literal-protocol).
§1's isolation, §2.7's armed bounds, §9's live Stop/Interrupt and §2.5's live target comparison all
passed on a rebuilt, isolated dev instance against a real Codex app-server, with `yoloMode: false`.

What remains is **not** another run. §2.5's *"before approving or allowing each action to execute"*
has no counterpart in the product: Harness disables every Codex command/sandbox/permission approval
(`resolveCodexAppServerApprovalPolicy`), a tool's target first appears in the UI when it is already
running, and `yoloMode: false` maps to Codex's `read-only` sandbox, which restricts writes and not
reads. Closing §2.5 needs a product decision — add a pre-execution gate for Codex, or re-specify the
check as detect-and-interrupt, which is what this run demonstrated working. That decision is
James's.

Defects reproduced on 2026-09-21 and filed: LT-601 (a user Stop recorded as a completed turn),
LT-602 (the header chip never shows a session's spawn-time reasoning effort).

### Prior status — 2026-09-06

Open: 1 · Closed: 4 · Failed: 0
Needs a quiet host window so an agent can drive the full literal protocol (§1/§2.5/§2.7/§9's
approval-UI and Stop/Interrupt steps) itself under the already-authorized local UI control; the
baseline/small-ticket/analyzer/privacy substance underneath it has already passed with live evidence.

**Parent plan:** [Codex Context-Pressure Observability Discovery Plan](./2026-07-13-codex-context-pressure-observability-discovery-plan_completed.md)

**Prerequisites:** Use a dedicated, quiet development instance with no other conversations or background provider work. Rebuild and restart its Electron process with `AIO_CODEX_CONTEXT_DIAGNOSTICS=1`; use an authenticated Codex app-server; start a fresh Codex app-server thread for preflight and every measured case; keep one fixed model and reasoning setting across all cases; never reuse the original incident thread.

**Superseded 2026-09-21.** The original deferral read: "This check is deferred because the currently running app has not been rebuilt and restarted with the telemetry in the working tree, and an authenticated provider interaction depends on external state." Both conditions were met on 2026-09-21 — a rebuilt, isolated dev instance ran real authenticated Codex app-server turns with the telemetry enabled.

## 1. Rebuild and start one quiet development instance

1. Close other development instances and do not run any other conversation, background provider task, or reproduction in this instance. Do not use the normal personal app instance for this test.

2. In a dedicated terminal at the repository root, run the exact build and start sequence. Keep this terminal open for the entire test so the development Electron process inherits the diagnostic flag.

   ```bash
   export AIO_CODEX_CONTEXT_DIAGNOSTICS=1
   rtk npm run build
   rtk npm run dev
   ```

3. Wait for this dedicated development instance to finish starting. In a second terminal, set `APP_LOG` to that instance's dedicated log, confirm the file exists, and do not print its contents.

   ```bash
   APP_LOG='<dedicated-development-app-log>'
   test -f "$APP_LOG"
   ```

4. Confirm no unrelated app activity is writing Codex diagnostics. If the dedicated instance or its log cannot be isolated, do not run preflight or any measured case.

## 2. Safety boundary and fixed stop conditions

1. Use only `_scratch/codex-context-pressure/reproduction-workspace/` for provider-visible files. Do not point a case at the repository root, a home directory, the original incident workspace, or any non-disposable directory.

2. Before each case, record the active model and reasoning setting in the result table below and confirm they match every prior case. Do not record credentials, raw thread/instance/session identifiers, or absolute source paths.

3. Stop and interrupt the case at the first occurrence of any one of these conditions:

   1. Occupancy reaches or exceeds 35% in a `token-usage.occupancyPercentage` record.
   2. Ten completed root tool items have been observed. Count `item-completed` records where `rootThread` is `true` and `itemClass` is `command`, `mcp`, `dynamic`, `web`, `file-change`, `collaboration`, or `other`. Treat the bounded `other` class as tool-bearing for safety. Do not count `agent-message`, `reasoning`, or any subagent item.
   3. Three `token-usage` records have occurred after the case's `turn-start`. The `turn-start.baselineUsedTokens` value is a baseline, not one of the three updates.
   4. Codex attempts any access outside the case's disposable workspace copy.
   5. Any diagnostic write fails, the `Context-pressure diagnostic write failed` warning appears, or an expected usage notification/record is missing.

4. These bounds are fixed. If a case stops or does not reproduce the behavior, do not increase output size, tool count, occupancy, or the number of usage updates.

5. Keep the app's tool/activity/approval UI visible throughout every tool-using case. Before approving or allowing each action to execute, compare every displayed target and working directory with the exact `CASE_WORKSPACE` value. Interrupt immediately on any mismatch, parent-directory traversal, unresolved target, or target the UI does not expose clearly enough to verify. Never approve first and inspect afterward.

6. Run the content-safe monitor below in a second terminal before preflight and leave it visible. It accepts only the exact diagnostic observation envelope with schema version 1, plus the fixed diagnostic-failure warning sentinel. It never prints a source log line, correlation, identifier, prompt, path, or arbitrary string. Running counters reset on `turn-start`.

   ```bash
   rtk proxy tail -n 0 -F "$APP_LOG" | rtk proxy node -e '
   const readline = require("node:readline");
   const kinds = new Set([
     "transport-usage", "transport-compaction", "turn-start", "item-completed",
     "token-usage", "compaction-rpc", "compaction-observed", "turn-complete",
   ]);
   const rl = readline.createInterface({ input: process.stdin });
   const toolItemClasses = new Set(["command", "mcp", "dynamic", "web", "file-change", "collaboration", "other"]);
   const itemClasses = new Set([...toolItemClasses, "agent-message", "reasoning"]);
   let rootToolItems = 0;
   let rootCommandItems = 0;
   let rootToolItemsSinceUsage = 0;
   let postBaselineUsageUpdates = 0;
   let stopLatched = false;
   const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
   rl.on("line", (line) => {
     let entry;
     try { entry = JSON.parse(line); } catch { return; }
     if (!entry || entry.subsystem !== "CodexContextDiagnostics") return;
     if (entry.message === "Context-pressure diagnostic write failed") {
       process.stdout.write(JSON.stringify({ kind: "diagnostic-failure", stop: true, stopReason: "diagnostic-failure" }) + "\n");
       stopLatched = true;
       return;
     }
     const data = entry.data;
     if (entry.message !== "context-pressure-observation"
       || !data || data.schemaVersion !== 1 || !kinds.has(data.kind)) return;
     if (data.kind === "turn-start") {
       rootToolItems = 0;
       rootCommandItems = 0;
       rootToolItemsSinceUsage = 0;
       postBaselineUsageUpdates = 0;
       stopLatched = false;
     }
     if (data.kind === "item-completed" && data.rootThread === true && toolItemClasses.has(data.itemClass)) {
       rootToolItems += 1;
       rootToolItemsSinceUsage += 1;
       if (data.itemClass === "command") rootCommandItems += 1;
     }
     if (data.kind === "token-usage") {
       postBaselineUsageUpdates += 1;
       rootToolItemsSinceUsage = 0;
     }
     const occupancy = number(data.occupancyPercentage);
     let stopReason;
     if (!stopLatched && occupancy !== undefined && occupancy >= 35) stopReason = "occupancy";
     else if (!stopLatched && rootToolItems >= 10) stopReason = "root-tool-items";
     else if (!stopLatched && postBaselineUsageUpdates >= 3) stopReason = "usage-updates";
     else if (!stopLatched && data.kind === "turn-complete" && rootToolItemsSinceUsage > 0) stopReason = "missing-tool-usage";
     if (stopReason) stopLatched = true;
     const statuses = new Set(["completed", "interrupted", "failed", "unknown"]);
     const out = {
       kind: data.kind,
       transportSequence: number(data.transportSequence),
       turnSequence: number(data.turnSequence),
       requestSequence: number(data.requestSequence),
       itemSequence: number(data.itemSequence),
       occupancyPercentage: occupancy,
       rootToolItems,
       rootCommandItems,
       itemClass: itemClasses.has(data.itemClass) ? data.itemClass : undefined,
       rootThread: typeof data.rootThread === "boolean" ? data.rootThread : undefined,
       postBaselineUsageUpdates,
       completionStatus: statuses.has(data.completionStatus) ? data.completionStatus : undefined,
       stop: Boolean(stopReason),
       stopReason,
     };
     process.stdout.write(JSON.stringify(out) + "\n");
   });
   '
   ```

7. The first monitor row with `stop: true`, the fixed diagnostic-failure row, or a UI target mismatch is the interruption point. Use Stop/Interrupt immediately, before approving another action or waiting for another provider event. Missing expected usage is checked at the next terminal record and during per-case analysis; treat either discovery as an immediate failure and do not start another measured case.

## 3. Prepare disposable workspaces and run preflight

1. From the repository root, create one template and a separate copy for each case. Replace `<run-id>` with one UTC value such as `20260714T120000Z` and retain the same value throughout the run.

   ```bash
   RUN_ID=20260714T120000Z
   WORKSPACE_ROOT=_scratch/codex-context-pressure/reproduction-workspace
   RAW_INPUTS=_scratch/codex-context-pressure/reproduction-$RUN_ID-raw-inputs

   rtk proxy mkdir -p "$WORKSPACE_ROOT/template/src" "$RAW_INPUTS"
   ```

2. Create `$WORKSPACE_ROOT/template/src/index.ts` with exactly this synthetic, non-sensitive content:

   ```ts
   const answer: number = 'forty-two';

   console.log(answer);
   ```

3. Make a fresh copy immediately before every case. Never reuse or refresh a thread after changing its case workspace.

   ```bash
   CASE=baseline
   CASE_WORKSPACE="$WORKSPACE_ROOT/$RUN_ID-$CASE"

   rtk proxy rm -rf -- "$CASE_WORKSPACE"
   rtk proxy mkdir -p "$CASE_WORKSPACE"
   rtk proxy cp -R "$WORKSPACE_ROOT/template/." "$CASE_WORKSPACE/"
   ```

4. Open the new thread with `CASE_WORKSPACE` as its working directory. Confirm the app shows the fixed model and reasoning setting before sending the prompt.

5. Before any measured case, use `CASE=preflight`, make another fresh workspace copy, and open a fresh disposable thread. Start the monitor in section 2, then send exactly:

   > Reply with exactly `preflight ready`. Do not use tools.

6. Preflight passes only if the monitor shows, in order for that fresh turn, one `turn-start`, at least one `transport-usage`/`token-usage` pair, and one terminal `turn-complete`. It must show no diagnostic failure, stop condition, unrelated turn, or missing usage. Discard the preflight thread and workspace. Do not treat preflight as a measured baseline and do not continue if it fails.

## 4. Isolate evidence for one case

1. Use a fresh case shell for each case. Keep the already selected dedicated app log location, conversation-ledger location, case-specific instance identifier, and fresh-thread rollout location in local shell variables. Do not print their values or write them into the sanitized evidence directory. Enable fail-fast shell behavior and install the cleanup trap before the prompt is sent; the raw byte-range copy is then deleted on normal exit, analyzer/privacy failure, or interruption.

   ```bash
   set -euo pipefail
   LEDGER_DB='<conversation-ledger-db>'
   CASE_INSTANCE_ID='<case-instance-id>'
   CASE_ROLLOUT='<fresh-thread-rollout-jsonl>'
   CASE_EVIDENCE=_scratch/codex-context-pressure/reproduction-$RUN_ID-$CASE
   CASE_RAW_LOG="$RAW_INPUTS/$CASE.app.log"

   cleanup_case_raw() {
     if [ -n "${CASE_RAW_LOG:-}" ]; then
       rtk proxy rm -f -- "$CASE_RAW_LOG"
     fi
   }
   trap cleanup_case_raw EXIT
   trap 'exit 130' INT TERM HUP
   ```

2. Immediately before sending the case prompt, record the app-log inode and byte length without printing log content:

   ```bash
   CASE_LOG_INODE=$(rtk proxy stat -f %i "$APP_LOG")
   CASE_LOG_START=$(rtk proxy stat -f %z "$APP_LOG")
   ```

3. Run exactly one case. Watch the live diagnostic counters, apply the stop conditions continuously, and use the interruption procedure in section 9 if any condition fires.

4. Immediately after completion or interruption, verify that the app log did not rotate or truncate, then copy only the case byte range into the temporary raw-input directory. If either check fails, mark the case failed and do not reconstruct or merge log files.

   ```bash
   test "$(rtk proxy stat -f %i "$APP_LOG")" = "$CASE_LOG_INODE"
   CASE_LOG_END=$(rtk proxy stat -f %z "$APP_LOG")
   test "$CASE_LOG_END" -ge "$CASE_LOG_START"
   CASE_LOG_BYTES=$((CASE_LOG_END - CASE_LOG_START))
   rtk proxy dd if="$APP_LOG" of="$CASE_RAW_LOG" bs=1 skip="$CASE_LOG_START" count="$CASE_LOG_BYTES"
   ```

5. The temporary case log is content-bearing. Do not open, print, commit, or attach it. Delete it after the analyzer and privacy checks succeed.

## 5. Baseline case

1. Use `CASE=baseline`, a new workspace copy, and a fresh thread.

2. Send exactly this prompt:

   > Reply with exactly `baseline complete`. Do not use tools.

3. Capture the starting baseline and every ending usage record available before `turn-complete`. This case measures fixed thread/system overhead for the selected model and reasoning setting only.

4. Exact operational expectation: zero root tool-bearing `item-completed` records, at least one `transport-usage` immediately followed by its normalized `token-usage`, and a terminal `turn-complete` with `completionStatus: completed`. Root `agent-message` and `reasoning` completions are expected response lifecycle observations and do not fail the baseline. A tool call, workspace access, tool-bearing item completion, or absent usage record fails this case. Apply the fixed stop conditions even if the response has not completed.

## 6. Small synthetic TypeScript case

1. Use `CASE=small-ticket`, a new workspace copy, and a fresh thread.

2. Send exactly this prompt:

   > Within this disposable workspace only, inspect `src/index.ts`, identify the deliberately planted TypeScript type error, and report it without editing any file. Use no more than five targeted tool calls. Do not search parent directories, install dependencies, or read any other file.

3. Fail and interrupt if the provider edits a file, exceeds five tool calls, reads another file, accesses outside the disposable workspace, or reaches any fixed stop condition.

4. Exact operational expectation: no more than five root tool-bearing `item-completed` records in total, followed by the next `transport-usage`/normalized `token-usage` pair, then `turn-complete` with `completionStatus: completed`. Root `agent-message` and `reasoning` completions are allowed after that usage pair and do not count toward the tool bound. A root tool-bearing item without its next usage pair fails the case. Record the request-boundary timeline. Treat observed payload and serialized byte counts as byte observations, never as retained-token measurements.

## 7. Optional bounded-output comparison

Run this section only if the offline findings plus the baseline and small-ticket cases still cannot distinguish whether tool-output retention drove the next usage update. Otherwise mark both cases `not required` and give the evidence that resolved the question.

1. Use `CASE=output-4k`, a new workspace copy, and a fresh thread. Send exactly this prompt:

   > Within this disposable workspace only, run exactly one command: `node -e "process.stdout.write('x'.repeat(4096))"`. Then reply exactly `done`. Do not run any other tool, read a file, or edit a file.

2. Use `CASE=output-32k`, another new workspace copy, and another fresh thread. Send exactly this prompt:

   > Within this disposable workspace only, run exactly one command: `node -e "process.stdout.write('x'.repeat(32768))"`. Then reply exactly `done`. Do not run any other tool, read a file, or edit a file.

3. Apply the same stop conditions to each case independently. Compare only the next raw usage update from each case. The controlled difference is output byte length; do not infer exact tokenization or retention from byte counts.

4. Exact operational expectation for each output case: exactly one root tool-bearing `item-completed` record with `itemClass: command`, followed by the next `transport-usage`/normalized `token-usage` pair, then `turn-complete` with `completionStatus: completed`. Root `agent-message` and `reasoning` completions are allowed after that usage pair. Any additional root tool-bearing completion or absent next usage pair fails that case.

## 8. Analyze each case separately

1. Use one evidence directory per case. Never pass log, instance, or rollout inputs from two threads to one analyzer invocation.

2. When the provider capture instance belongs only to this case and the rollout is from this case's fresh thread, run the complete source command:

   ```bash
   rtk npx tsx scripts/analyze-codex-context-pressure.ts \
     --log "$CASE_RAW_LOG" \
     --db "$LEDGER_DB" \
     --instance "$CASE_INSTANCE_ID" \
     --rollout "$CASE_ROLLOUT" \
     --out "$CASE_EVIDENCE"
   ```

3. If a provider-capture instance is shared across cases, omit both `--db` and `--instance` instead of creating a mixed pseudo-timeline. If the case rollout is unavailable, omit `--rollout`. Run the analyzer with every remaining case-specific source and retain the resulting limitation codes. The minimum case-log-only command is:

   ```bash
   rtk npx tsx scripts/analyze-codex-context-pressure.ts \
     --log "$CASE_RAW_LOG" \
     --out "$CASE_EVIDENCE"
   ```

4. Confirm each evidence directory contains only `summary.json`, `timeline.jsonl`, and `report.md`. Compare cases only after every case has its own report. Compare baseline overhead; `last.totalTokens` and deltas; cumulative and cached-input deltas; root/subagent item counts; observed payload/serialized bytes; and explicit compaction records.

5. Expected content-free diagnostic sequence for a normal bounded case:

   1. One `turn-start` with `schemaVersion`, `at`, `turnSequence`, and nullable `baselineUsedTokens`.
   2. For each provider usage update, one `transport-usage` followed by one `token-usage`. `transport-usage` contains `transportSequence`, a 12-character lowercase hexadecimal `threadCorrelation`, `contextWindow`, and `last`/`cumulative` numeric snapshots. `token-usage` contains `turnSequence`, `requestSequence`, the same usage snapshots, the previous/current deltas, occupancy, root-item count, and observed payload bytes since the prior usage.
   3. Zero or more `item-completed` records with only item class, root/subagent classification, byte counts, and numeric sequences.
   4. One `turn-complete` with completion status, request/root/subagent counts, observed payload bytes, peak usage/percentage, and compaction count.

6. A bounded case is not expected to compact. If the provider compacts, require a `transport-compaction` and `compaction-observed` pair. A `compaction-rpc` record is expected only when an existing app action requested compaction, and its stages must be recorded separately as `requested`, then `accepted` or `failed`. RPC acceptance alone is not proof that compaction occurred.

7. If a transport usage record lacks its corresponding normalized `token-usage`, if the sequence is malformed, or if the analyzer reports malformed diagnostic records, fail the case and stop the reproduction. Do not repair evidence by hand.

8. Apply the per-case terminal assertions before recording a pass: baseline has zero root tool-bearing completions; small ticket has at most five root tool-bearing completions and a subsequent usage pair; each output case has exactly one root tool-bearing command completion and a subsequent usage pair. Root `agent-message` and `reasoning` completions remain visible but do not count toward these tool assertions. The final diagnostic record for an uninterrupted case is `turn-complete` with `completionStatus: completed`.

## 9. Interruption procedure

1. Immediately use the app's existing Stop/Interrupt control. Do not send another prompt, steer the turn, request compaction, or wait for an additional usage update.

2. Record which fixed stop condition fired, the last diagnostic kind and numeric sequence visible, and whether a `turn-complete` with `completionStatus: interrupted` followed. Do not record prompt/output bodies or raw identifiers.

   The required interrupted terminal sequence is: the first bounded `stop: true` monitor row or verified UI target mismatch; immediate use of Stop/Interrupt; then one terminal `turn-complete` with `completionStatus: interrupted`. If the terminal record is missing or has another status, mark the case failed and do not continue in the same process.

3. Capture the bounded log range and run the analyzer exactly as in sections 4 and 8. Mark the case `stopped by bound`; that is a valid safety outcome but not a successful reproduction.

4. If Stop/Interrupt does not promptly stop provider work, terminate the development process, mark the case failed, and do not start another case in the same process.

## 10. Pass/fail and evidence record

Record the fixed run settings before the first case:

| Setting | Recorded value (run 2026-09-21) |
| --- | --- |
| Run ID | `20260921T043700Z` |
| Rebuilt/restarted development instance | yes — `build:main` + `build:renderer`, then a fresh Electron process on an isolated, empty profile |
| `AIO_CODEX_CONTEXT_DIAGNOSTICS` | `1`, verified present in the running main process's environment |
| Model | `gpt-5.6-luna`, identical across preflight, baseline, small ticket and the interruption drill |
| Reasoning setting | `low`, identical across all cases; verified on the instance record — the header chip misreports it, see LT-602 |
| Authenticated app-server available | yes — real Codex app-server turns, occupancy reported on every case |
| Dedicated quiet instance isolable | yes — sole unpackaged Electron process, host load 4.70/5.89/6.33, zero pre-existing `CodexContextDiagnostics` lines and the installed app provably unable to emit them |
| Session interactivity | automated but driving the real renderer: live target comparison against the tool UI and a real click on the app's Stop control |

Prior attempt, 2026-09-06 and earlier: no run started — no dev instance had been rebuilt or
restarted with the flag, the host was not quiet, and the session could not drive the Stop UI.

Fill one row per case. Leave unrun cases as `pending` or `not required`; never infer a result.

| Case | Required status | Model | Reasoning setting | Settings match | Stop condition | Diagnostic sequence | Privacy check | Evidence directory | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | required | `gpt-5.6-luna` | `low` | yes | none fired; peak occupancy 13.553% | `turn-start` → 2 `item-completed` (no tool-bearing) → `transport-usage` → `token-usage` → `turn-complete` completed | pass, all 4 steps | `reproduction-20260921T043700Z-baseline` | **pass** |
| Small ticket | required | `gpt-5.6-luna` | `low` | yes | none fired; peak occupancy 12.729% | `turn-start` → `item-completed` ×1 `command` (bound 5) → usage pair → usage pair → `turn-complete` completed | pass, all 4 steps | `reproduction-20260921T043700Z-small-ticket` | **pass** — 1 tool call, file byte-identical |
| 4 KiB output | only if retention unresolved | n/a | n/a | n/a | n/a | n/a | n/a | not created | **not required** — §6's per-request deltas (32726 → 32893, +167 after a 58-byte tool output) resolved the retention question |
| 32 KiB output | only if retention unresolved | n/a | n/a | n/a | n/a | n/a | n/a | not created | **not required** — same evidence |
| Interruption drill (not a measured case) | §9 exercise | `gpt-5.6-luna` | `low` | yes | §2.5 target mismatch, detected while the tool was still `phase: running` | `turn-start` → `item-completed` ×1 `command` → usage pair → `turn-complete` **interrupted** | pass, all 4 steps | `reproduction-20260921T043700Z-interrupt-drill` | **stopped by the §2.5 control, as designed** |

Evidence directories were removed after their reports were read, per §12.2 — `_scratch/` is
disposable and generated reproduction evidence is not committed.

A case passes only when it remained inside all bounds, used its fresh thread/workspace, emitted the expected sequence with no diagnostic failure, produced a separate analyzer report, and passed the privacy checks. A case may still be scientifically inconclusive; record that separately from operational pass/fail.

## 11. Privacy verification

1. Define the complete sanitized output set and require every file to exist. These scans are fail-closed and never print a matched source value.

   ```bash
   SANITIZED_FILES=(
     "$CASE_EVIDENCE/summary.json"
     "$CASE_EVIDENCE/timeline.jsonl"
     "$CASE_EVIDENCE/report.md"
   )
   for file in "${SANITIZED_FILES[@]}"; do
     test -f "$file"
   done
   ```

2. Structurally validate the JSON/JSONL against the analyzer's explicit content-free key and bounded-string allowlists. This permits numeric fields such as `contentBytes`, `inputTokens`, `outputTokens`, and the provider-event count key `output` while rejecting every unknown key, arbitrary string value, object body, or raw identifier. The validator prints only a fixed failure message, never the rejected key or value. A failure requires an analyzer fix; never edit evidence by hand.

   ```bash
   rtk proxy node -e '
   const fs = require("node:fs");
   const [summaryPath, timelinePath] = process.argv.slice(1);
   const keys = new Set(`
     schemaVersion sources diagnosticLog providerCaptures rollout provided available
     acceptedRecords malformedRecords counts timelineEvents diagnosticKinds
     providerEventKinds rolloutEntryTypes coverage rawDiagnosticUsageNotifications
     normalizedContextEvents rolloutTokenCountEvents itemSizeObservations
     compactionMarkers turnBoundaries limitations source at sequence kind
     transportSequence contextWindow last cumulative totalTokens inputTokens
     cachedInputTokens outputTokens reasoningOutputTokens turnSequence
     baselineUsedTokens itemSequence itemClass rootThread observedPayloadBytes
     serializedItemBytes requestSequence previousLastTotalTokens lastTotalDelta
     cumulativeTotalDelta occupancyPercentage rootItemsSincePreviousUsage
     observedPayloadBytesSincePreviousUsage stage lastKnownUsedTokens rootItems
     subagentItems peakUsedTokens peakPercentage compactionsObserved
     completionStatus rawProvenancePresent contentBytes statusClass usedTokens
     inputShareRatio entryType subtype serializedLineBytes itemObservation
     compactionMarker tokenUsage transport-usage transport-compaction turn-start
     item-completed token-usage compaction-rpc compaction-observed turn-complete
     output tool-use tool-result status context error exit spawned complete other
     session-metadata response-item event-message turn-context compaction
   `.trim().split(/\s+/));
   const strings = new Set(`
     diagnostic provider-capture rollout transport-usage transport-compaction
     turn-start item-completed token-usage compaction-rpc compaction-observed
     turn-complete output tool-use tool-result status context error exit spawned
     complete other session-metadata response-item event-message turn-context
     compaction token-count message reasoning tool-call tool-result web-search
     file-change command mcp dynamic web collaboration agent-message user-message requested
     accepted failed completed interrupted unknown busy idle waiting working
     diagnostic-log-not-supplied provider-captures-not-supplied
     provider-capture-table-unavailable rollout-not-supplied
     raw-diagnostic-usage-unavailable normalized-context-events-unavailable
     rollout-token-count-events-unavailable item-size-observations-unavailable
     compaction-markers-unavailable turn-boundaries-unavailable
   `.trim().split(/\s+/));
   const inspect = (value) => {
     if (value === null || typeof value === "number" || typeof value === "boolean") return;
     if (typeof value === "string") {
       if (!strings.has(value)) throw new Error("privacy failure");
       return;
     }
     if (Array.isArray(value)) {
       for (const child of value) inspect(child);
       return;
     }
     if (!value || typeof value !== "object") throw new Error("privacy failure");
     for (const [key, child] of Object.entries(value)) {
       if (!keys.has(key)) throw new Error("privacy failure");
       inspect(child);
     }
   };
   try {
     inspect(JSON.parse(fs.readFileSync(summaryPath, "utf8")));
     for (const line of fs.readFileSync(timelinePath, "utf8").split("\n")) {
       if (line) inspect(JSON.parse(line));
     }
   } catch {
     process.stderr.write("privacy failure: generated schema is not content-free\n");
     process.exit(1);
   }
   ' "$CASE_EVIDENCE/summary.json" "$CASE_EVIDENCE/timeline.jsonl"
   ```

3. Reject the actual source locations/identifier, known synthetic values, UUID-shaped values, URLs, and secret-assignment shapes without echoing the checked values or matching lines.

   ```bash
   for forbidden in \
     "$APP_LOG" "$LEDGER_DB" "$CASE_ROLLOUT" "$CASE_INSTANCE_ID" "$CASE_WORKSPACE" \
     'baseline complete' 'preflight ready' 'forty-two' 'reproduction-workspace' \
     'src/index.ts' 'xxxxxxxxxxxxxxxx'; do
     test -n "$forbidden"
     if rtk rg -q -F -- "$forbidden" "${SANITIZED_FILES[@]}"; then
       echo 'privacy failure: source value detected'
       exit 1
     fi
   done

   if rtk rg -q -i \
     -e 'https?://' \
     -e '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}' \
     -e '(secret|token|password|api[_-]?key)[[:space:]]*[:=]' \
     "${SANITIZED_FILES[@]}"; then
     echo 'privacy failure: URL, UUID, or secret-shaped value detected'
     exit 1
   fi
   ```

4. Manually inspect the generated Markdown tables for numeric sequences, bounded classes/statuses, counts, byte lengths, percentages, and documented limitation codes only. Record `privacy check: pass` only after the automated checks exit zero and the bounded schema is manually confirmed. Do not attach or commit raw inputs or generated reproduction evidence.

## 12. Cleanup and completion

1. After each analyzer and privacy check succeeds, delete that case's temporary raw app-log segment. Do not delete or modify the source app log, ledger database, or provider rollout.

   ```bash
   rtk proxy rm -f -- "$CASE_RAW_LOG"
   ```

2. After all required cases have been recorded and their evidence has been incorporated into the canonical findings, remove the disposable workspaces and remaining raw-input directory. Keep sanitized evidence only until the findings have been checked, then remove it too because `_scratch/` is disposable.

   ```bash
   test "$WORKSPACE_ROOT" = '_scratch/codex-context-pressure/reproduction-workspace'
   rtk proxy rm -rf -- "$WORKSPACE_ROOT" "$RAW_INPUTS"
   ```

3. Stop the development process started for the reproduction and clear the flag from the shell:

   ```bash
   unset AIO_CODEX_CONTEXT_DIAGNOSTICS
   ```

4. Update this document with the actual rows and source-indexed observations. The operational bar
   was satisfied on 2026-09-21. The later product-contract choice was transferred to RES-012 on
   2026-09-27 so it no longer keeps this source checklist active.


## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| §5 Baseline case operational pass | 2026-08-18, reconfirmed 2026-08-25 (batch I) | Live Codex app-server run, correct diagnostic sequence, 0 tool-bearing items; found+fixed LT-148 en route |
| §6 Small-ticket case operational pass | 2026-08-18, reconfirmed 2026-08-19 (batch P2) | 3/5 tool calls used, file unedited (byte-verified), 21/21 diagnostic records accepted on reanalysis |
| §7 Optional bounded-output comparison | 2026-08-18 | Marked "not required" per the section's own exit condition — retention question already resolved by §5/§6's per-request usage deltas |
| §8 analyzer + §11 privacy validator pipeline | 2026-08-19 (batch N1: 6/6 records; batch P2: 21/21 records), reconfirmed 2026-08-25 (batch I: 6/6) | 3 real runs, 0 malformed each time, all 4 §11 privacy steps pass each time; found+fixed LT-222 and LT-223 along the way |

Defects found and fixed during the above runs (not open): LT-148, LT-222, LT-223 — see
`docs/plans/livetest-remediation-register.md`.

## Evidence run — 2026-09-21 (Plan Queue worker, full literal protocol)

Run under the standing local-UI-control authorization (2026-08-26). This is the run the
2026-08-31 residual asked for: sections 1–12 executed against a live Codex app-server, with the
app's own UI watched in real time and its own Stop control used, rather than `yoloMode: true`
plus post-hoc log reading. Two defects were reproduced en route and filed as LT-601 and LT-602.

**Fixed run settings**

| Setting | Recorded value |
| --- | --- |
| Run ID | `20260921T043700Z` |
| Rebuilt/restarted development instance | yes — `build:main` and `build:renderer` from the worker's own checkout, then a fresh Electron process on an isolated, empty profile |
| `AIO_CODEX_CONTEXT_DIAGNOSTICS` | `1`, verified present in the running main process's environment |
| Model | `gpt-5.6-luna`, identical across preflight, baseline, small ticket and the interruption drill |
| Reasoning setting | `reasoningEffort: 'low'`, identical across all cases; verified on the instance record, **not** on the header chip — see LT-602 |
| Authenticated app-server available | yes — real Codex app-server turns, occupancy reported on every case |
| Dedicated quiet instance isolable | yes — see §1 below |
| Session interactivity | automated, but driving the real renderer: real target comparison against the live tool UI and a real click on the app's Stop control |

### §1 — one quiet development instance

- One dedicated dev Electron process, its own empty profile, its own debug port. No other
  unpackaged Electron process was running; `ps` confirmed exactly one, and it was this run's.
- Host load at launch was `4.70 5.89 6.33` — quiet by the campaign runbook's ~30 threshold.
- **Diagnostic isolation is provable even though the log is shared.** The dev app writes `app.log`
  into the *production* profile (the `LogManager` fixes its path at import, before
  `AIO_DEV_USER_DATA_PATH` is applied), so §1.3's "dedicated development app log" does not exist as
  written. What matters for this protocol is that no *unrelated* activity writes Codex diagnostics,
  and that is verifiable rather than assumed: the installed app's process environment does **not**
  carry `AIO_CODEX_CONTEXT_DIAGNOSTICS`, so it cannot emit these records, and the log contained
  zero `CodexContextDiagnostics` lines before this run started. Every such line in the file is this
  run's. Each case's byte range was checked for a clean line boundary before analysis (first line
  parsed as JSON every time).
- The installed app was left running: it hosts this worker's own session and cannot be closed from
  inside it. §1.1 asks that the dedicated instance be quiet and that the personal instance not be
  used for the test; both hold.

### §2/§3 — bounds, monitor, workspaces, preflight

- Disposable workspaces created under `_scratch/codex-context-pressure/reproduction-workspace/`,
  one fresh copy per case, `git check-ignore` confirmed. Template file byte-identical throughout.
- The §2.6 content-safe monitor ran for the whole session and produced every row quoted below.
- **Preflight passed** on a fresh thread and a fresh workspace: one `turn-start`, one
  `transport-usage` → `token-usage` pair, one terminal `turn-complete` with
  `completionStatus: completed`, occupancy 13.55%, no diagnostic failure and no latched bound. The
  preflight thread and workspace were then discarded.
- **Monitor imprecision worth carrying forward (not a product defect).** §2.6's `itemClasses`
  display allowlist omits `user-message`, which is a real emitted class, so the first
  `item-completed` of every turn prints `itemClass: undefined`. It is not in `toolItemClasses`
  either, so no counter or stop condition is affected — the effect is cosmetic. Note §11.2's own
  string allowlist *does* include `user-message`; the two lists disagree. §2.6 was left unedited so
  this run stays measured against the same protocol as the previous ones.

### §5 — baseline case: pass

```
turn-start            turnSequence=1
item-completed        itemSequence=1  rootThread=true  (user-message)
item-completed        itemSequence=2  itemClass=agent-message  rootThread=true
transport-usage       transportSequence=1
token-usage           requestSequence=1  occupancy=13.553%  rootToolItems=0
turn-complete         completionStatus="completed"  rootToolItems=0
```

Zero root tool-bearing completions, one `transport-usage` immediately followed by its normalized
`token-usage`, terminal `turn-complete` completed. Reply was exactly `baseline complete`. Workspace
file byte-identical (sha256 match against the template). No bound fired.

### §6 — small-ticket case: pass, driven with the tool UI watched live

Run with **`yoloMode: false`** — the configuration the earlier residual said was missing. A
supervisor held a CDP connection to the renderer and, every 400 ms: expanded any collapsed tool
group so the target was actually on screen, read every displayed tool target out of the live UI,
compared it against the exact `CASE_WORKSPACE` value, and read the monitor for a latched bound —
with the app's Stop control armed to fire on the first mismatch or bound.

```
turn-start            turnSequence=1
item-completed        x3   reasoning / agent-message / (user-message)   rootToolItems=0
item-completed        itemSequence=4  itemClass=command  rootThread=true  rootToolItems=1
transport-usage       transportSequence=1
token-usage           requestSequence=1  occupancy=12.665%
item-completed        x2   reasoning / agent-message
transport-usage       transportSequence=2
token-usage           requestSequence=2  occupancy=12.729%
turn-complete         completionStatus="completed"  rootToolItems=1  rootCommandItems=1
```

- 1 root tool-bearing completion against a bound of 5, followed by its usage pair, then a completed
  terminal record. No bound fired; peak occupancy 12.73%.
- The single displayed target was `/bin/zsh -lc 'rtk cat src/index.ts'` — workspace-relative, no
  absolute path outside `CASE_WORKSPACE`, no parent traversal. Zero violations across the turn.
- File unedited, byte-verified. The planted `const answer: number = 'forty-two'` error was
  identified correctly.

### §7 — optional bounded-output comparison: not required

This run resolved the exit condition on its own evidence rather than by inheritance. The
small-ticket report shows the per-request usage split directly: request 1 at 32726 used tokens,
request 2 at 32893 (+167) after a 58-byte tool output was returned. The next usage update is
attributable to the tool result without a synthetic 4 KiB/32 KiB comparison, so both output cases
stay `not required`.

### §8 + §11 — analyzer and privacy: pass on three independent cases

Every case was analysed separately, with all three sources supplied — case log byte range,
conversation ledger + that case's instance id, and that case's own fresh-thread rollout. No case
shared an evidence directory, a thread or an analyzer invocation.

| Case | Diagnostic records | Provider captures | Rollout entries | Malformed | Limitations |
| --- | ---: | ---: | ---: | ---: | --- |
| baseline | 6 | 14 | 15 | 0 / 0 / 0 | `compaction-markers-unavailable` |
| small ticket | 12 | 276 | 24 | 0 / 0 / 0 | `compaction-markers-unavailable` |
| interruption drill | 8 | 50 | 21 | 0 / 0 / 0 | `compaction-markers-unavailable` |

Each evidence directory contained exactly `summary.json`, `timeline.jsonl` and `report.md`. All four
§11 steps passed for all three cases: the complete sanitized set present; the content-free key and
bounded-string validator accepting every record; the forbidden-value, URL, UUID and secret-shape
scans finding nothing; and manual inspection of each `report.md` showing only numeric sequences,
bounded classes, counts, byte lengths, percentages and documented limitation codes. No case
compacted, which is expected for a bounded case.

### §9 — interruption procedure: exercised for real

A dedicated drill on a fresh thread and a fresh workspace, deliberately provoking the §2.5 mismatch
condition rather than simulating it: the prompt asked for one read of a path **outside**
`CASE_WORKSPACE` (the template file, still inside the sanctioned reproduction tree) followed by a
long generation. The supervisor saw the target in the live UI while it was still
`"phase": "running"`, flagged `outside-workspace:…/template/src/index.ts`, and clicked the app's own
Stop control — no approval, no second prompt, no compaction request.

```
turn-start            turnSequence=1
item-completed        x3   reasoning / agent-message / (user-message)
item-completed        itemSequence=4  itemClass=command  rootThread=true
transport-usage       transportSequence=1
token-usage           requestSequence=1  occupancy=13.650%
turn-complete         completionStatus="interrupted"
```

§9.2's required terminal sequence held: detected mismatch → immediate Stop → one terminal
`turn-complete` with `completionStatus: interrupted`. Provider work stopped promptly (the essay was
never generated), the session settled to `idle`, and the drill was analysed and privacy-checked
exactly as in §4 and §8. Recorded as a drill, not as a measured case.

**Two findings from this drill:**

1. **LT-601 (filed).** The instance record read `lastTurnOutcome: "completed"` after that Stop,
   while the diagnostics and the transcript both said interrupted.
2. **Read confinement is not what §2.5 assumes.** `yoloMode: false` maps to
   `approvalMode: 'suggest'` + `sandboxMode: 'read-only'` (`adapter-factory.ts:281-282`), and
   `read-only` restricts writes, not reads: the out-of-workspace `cat` returned the file's
   contents. See the §2.5 note below.

### §2.5 — the one requirement that cannot be met as written

Everything in §2.5 that is enforceable was enforced: the tool/activity UI was visible and expanded
throughout every tool-using case, every displayed target and the displayed working directory were
compared against the exact `CASE_WORKSPACE` value continuously, and the first mismatch produced an
immediate Stop — demonstrated on a real mismatch, not asserted.

What has no counterpart in the product is *"before approving or allowing each action to execute"*.
For Codex, Harness never asks:

- `resolveCodexAppServerApprovalPolicy` (`app-server-initializer.ts:40-53`) returns a granular
  policy with `sandbox_approval`, `rules`, `skill_approval` and `request_permissions` all `false`;
  only `mcp_elicitations` is `true`. No approval prompt appeared at any point in either tool-using
  case, and the supervisor recorded zero approval-UI observations.
- The target first becomes visible in the UI with the tool already at `"phase": "running"`. There is
  no pre-execution moment at which a target could be inspected and then allowed.
- With `yoloMode: false` the enforcement is the Codex `read-only` sandbox, which blocks writes but
  not reads outside the working directory — confirmed live by the drill.

So the safety property §2.5 is reaching for is real, but the control it specifies does not exist on
this path. The honest statement is: this run performed continuous live target comparison with an
armed interrupt, and proved the interrupt fires, but it could not approve-then-execute because
Harness does not gate Codex tool calls that way. Closing §2.5 needs a product decision (add a
pre-execution gate for Codex, or re-specify the check as detect-and-interrupt), not another run.
That is the one item left for James.

### §12 — cleanup

Each case's temporary raw log segment was deleted immediately after its analyzer and privacy checks
passed. Disposable workspaces, the raw-input directory and the sanitized evidence directories were
removed; the source app log, ledger and rollouts were not touched. All dev instances were
terminated and the dev app, its renderer server and the monitor were stopped.

One environmental note for the next runner: the app itself writes `.ao/activity.jsonl` into every
session's working directory (`ActivityStateDetector`, `activity-state-detector.ts:192-198`), so a
case workspace legitimately contains one file the template did not. It is written by the Harness
main process, not by the provider, and a "workspace unchanged" assertion should exclude it.

### Status after this run

| Section | Result |
| --- | --- |
| §1 quiet dedicated instance | pass, with the shared-log deviation stated and diagnostic isolation proved |
| §3 preflight | pass |
| §5 baseline | pass |
| §6 small ticket (non-YOLO, UI watched live) | pass |
| §7 optional output cases | not required, resolved on this run's own usage deltas |
| §8 analyzer | pass, 3 cases, 3 sources each, 0 malformed |
| §9 Stop/Interrupt | pass, real mismatch → real Stop → terminal `interrupted` |
| §11 privacy | pass, all 4 steps, 3 cases |
| §2.5 approve-before-execute | **cannot be met as specified** — no approval gate exists for Codex; needs a product decision |

Defects reproduced and filed: LT-601, LT-602.

## Historical residual and 2026-09-27 transfer

Every session from 2026-07-16 through 2026-08-25 recorded the same residual: §1's machine-wide
quietness and §2.5/§2.7/§9's live approval-UI comparison and Stop/Interrupt requirements were never
literally satisfied — cases above were run with `yoloMode: true` in a disposable workspace instead of
a human or a verified Computer Use capability watching and approving each tool call in real time.

**2026-08-31 correction:** the earlier claim that no Computer Use capability exists is obsolete —
local UI control now carries standing authorization (2026-08-26). What remains is a quiet host window
long enough to run the full 12-section protocol (including §1's isolation and §9's live Stop/Interrupt
use) end to end under that authorization; this is a scheduling constraint, not an unavailable
capability. Sections 1–12 above are the exact steps to run; do not shortcut §1/§2.5/§2.7/§9 to declare
this complete. Rename to `_livetest_completed.md` only when a run under those sections literally
passes, per §12.4's own completion bar.

**2026-09-21 update.** This residual was run, not re-deferred. Sections 1–12 were executed against
a real Codex app-server on a rebuilt, isolated dev instance with `yoloMode: false`, the tool UI
watched and its targets compared continuously against `CASE_WORKSPACE`, and the app's own Stop
control used on a real mismatch — producing a terminal `turn-complete` with
`completionStatus: interrupted`. Full evidence is in
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-plan-queue-worker-full-literal-protocol).

The scheduling constraint is therefore discharged. What is left is a product question rather than a
run: §2.5's approve-before-execute step has no counterpart for Codex in this app (every command,
sandbox, rules and permission approval is disabled by `resolveCodexAppServerApprovalPolicy`; the
target is first displayed with the tool already at `phase: running`; and `yoloMode: false` gives a
`read-only` sandbox that restricts writes, not reads). Either Harness gains a pre-execution approval
gate for Codex tool calls, or §2.5 is re-specified as the detect-and-interrupt control this run
demonstrated. That decision was transferred without being silently resolved to consolidated
residual RES-012 on 2026-09-27; no open item remains owned here.

> Plan Queue parked work: `queue/2026-07-13-codex-context-press-a9dfe8` — 1 commit(s), reason: land-blocked.

## Evidence run — 2026-09-24 (runtime)

Batch `runtime` of the 2026-09-24 live-test campaign. Repo HEAD `f04f6748`, fix commit `9efc4871`
("Fixing codex", 2026-09-23). Dev app isolated at `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-runtime`,
`--remote-debugging-port=9714`. One Codex instance (`xb9wuzozp`, `gpt-5.6-sol`, `reasoningEffort:
high`), working directory `/tmp/aio-lt-0924-runtime-work`, `yoloMode: true`.

### LT-602 — header chip spawn-time reasoning effort: **CONFIRMED FIXED LIVE**

Immediately after `createInstance`, `listInstances()` already read `reasoningEffort: "high"` on the
main-process side (first poll, ~0.5 s after create). Selecting the instance in the real renderer
(`InstanceStore.setSelectedInstance`, found via `ng.getComponent` on `app-composer-banners`) and
reading `app-instance-header`'s rendered text gave, verbatim:

```
Codex Codex·GPT-5.6 Sol· Thinking: High▾
```

`Thinking: High` on the very first render, no second event or refresh needed — the header chip now
publishes the spawn-time effort. Fix: the separate `state-update` emit in
`src/main/instance/instance-lifecycle.ts` right after `resolvedReasoningEffort` is computed,
annotated in the diff as "The early created event intentionally precedes model resolution. Publish
the resolved effort separately so passive renderer sessions … do not keep showing 'Provider
default'."

### LT-601 — a user Stop is recorded as a completed turn: **CONFIRMED FIXED LIVE**

Sent a long essay prompt to the same instance, confirmed `status: busy`, then called
`interruptInstance`. Immediately after, `listInstances()` read `lastTurnOutcome: "interrupted"`
(not `"completed"`, which is what the 2026-09-21 drill on this same document found), and the output
buffer's last four entries were:

```
system  "Interrupt requested: unresolved"
system  "Interrupt cancelling: unresolved"
system  "Interrupted — waiting for input"
```

Fix: `noteInterruptSettled()` in `src/main/instance/lifecycle/interrupt-respawn-handler.ts:588-593`
now sets `instance.lastTurnOutcome = 'interrupted'` and emits the `"Interrupted — waiting for
input"` recovery-safe system message before clearing the interrupt bookkeeping — both were absent
before the fix. Targeted specs `interrupt-respawn-handler.spec.ts` and
`instance-communication-turn-outcome.spec.ts` (35 tests) also pass.

### §2.5 approve-before-execute — re-read, not re-run

Per instruction this item was not re-run; restating the decision as recorded 2026-09-21, verified
still accurate against current code: Harness has no pre-execution approval gate for Codex tool
calls (`resolveCodexAppServerApprovalPolicy` still returns every approval field `false` except
`mcp_elicitations`), a tool's target is only visible once it is already `phase: running`, and
`yoloMode: false` still maps to Codex's `read-only` sandbox, which restricts writes, not reads. The
choice is unchanged and still James's: either add a genuine pre-execution gate for Codex, or
re-specify §2.5 as the detect-and-interrupt control the 2026-09-21 run already proved works. This is
correctly a product decision, not a technical prerequisite — nothing here is blocked on a fixture,
worker or missing capability.

Instance `xb9wuzozp` terminated at the end of the batch run.
