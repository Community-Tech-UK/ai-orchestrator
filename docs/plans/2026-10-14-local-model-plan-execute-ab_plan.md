# Can cheaper models do the coding? A head-to-head test — plan

On main: no.

**Status:** IN PROGRESS (implementation). Written 2026-10-14; revised the same day after James chose the Windows PC and
asked about using its 192 GB of RAM for a bigger model. James approved the ~$40–80 pilot only (readiness answer,
recorded 2026-10-15); the full run stays decision-gated on pilot results. Nothing in this plan changes app code.
**Deferred live checks (PC-gated and James-gated) are recorded in
[`2026-10-14-local-model-plan-execute-ab_plan_livetest.md`](2026-10-14-local-model-plan-execute-ab_plan_livetest.md).**

**Current bounded-pilot handoff (20 Oct 2026, worker `queue/2026-10-14-local-model-plan-ex-01472a`): IN PROGRESS, not a completed pilot.**
This note supersedes historical resume instructions and spend estimates below. The fresh worktree had no
`benchmarks/plan-execute-ab/`; its self-contained sources were restored from parked checkpoint `2aedbb10d`
without merging, committing, switching branches or changing app code. No linked spec was found; this plan
is the experiment's specification. Evidence/report/receipts live in this worker's
`benchmarks/plan-execute-ab/evidence/2026-10-20/`.

1. **Retained evidence reconciled:** 32 distinct scored records (A/D/G: 10 each; C1: 2), all 10 frozen plans,
   patches for all 32 records, quarantined records and 10 historical fail-on-parent/pass-on-commit receipts.
   Raw evidence stays at `/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/plan-execute-ab/`.
   `retained-audit.json` hashes the evidence and records its reconstruction limits: original scoring output
   tails were lost and two A damage outcomes were defaulted by the earlier recovery. This is evidence
   reconciliation, not a fresh rerun of historical model results.
2. **Spend:** retained CLI totals are **$66.278098505** (A $23.042690705, D $4.9797044, shared planners
   $12.4069146, Claude judges $25.8487888 including quarantined attempts). This is recorded evidence, not
   provider-invoice confirmation; missing terminal cost events could understate it. Maximum remaining
   headroom is **$13.721901495**, not authority for an overrun. This worker made **zero new metered calls**.
   The prior worker's unilateral “option 1” note is not James's approval and must not be used.
3. **Safe resume implemented:** `run --local-only --phase pilot --arms B|C1|C2 --session <existing>` refuses
   cloud/hosted/Codex/takeover arms, requires every frozen plan before starting, prevents planning if a plan
   disappears, and defers both judges. Local invocations strip inherited Anthropic/OAuth credentials,
   custom headers and cloud-routing flags. Configuration/types were split out to keep `runner.ts` below
   700 lines. Scratch exports now default inside the worktree, per the current worker instructions.
4. **Reporting corrections:** pilot decisions require matching task coverage against A (task identities,
   not just counts); C2 can be absent for the stop rule only after an explicit failed speed gate. The
   stop rule now uses hidden-test rates as specified. Speed probes now include response-body time rather
   than stopping at headers. All older wall-clock readings are provisional until repeated with this code.
5. **Windows state:** the worker is connected; LM Studio 0.4.25 / CUDA backend 2.60.0 is available.
   Flash-Next's three shards load successfully at 65536 context (A1 integrity confirmed). The existing
   35B synthetic reading (7642 prompt / 292.6 write tok/s, 229376 context) predates the timing correction;
   it is retained as provisional. Synthetic text is not the required real repository-prompt proof.
6. **Actual boundary:** the existing API accepts requests without a key. Native `llama-server` supports
   Tailscale binding and `--api-key-file`, but `upload_to_node` refused the ignored temporary key file:
   **`local_write_refused: Local source is restricted`**. The documented credential CLI supports secure
   browser fills, not this model-server key handoff; no suitable project/shared credential reference was
   found. No secret was printed and no repository prompt was sent over the unauthenticated route. James
   must provision a private benchmark key through an approved secure route on the Mac and Windows
   `--api-key-file` side before those data-bearing runs. Do not rename/repackage a key to bypass the filter.

**Final evidence this round (20 Oct):** 114 benchmark tests pass (14 files), benchmark/root
`tsc --noEmit`, `typecheck:spec`, root lint, explicit benchmark ESLint, LOC check, both app builds
and alias/IPC generators pass; full repository tests are reserved for the independent verifier.
Corrected synthetic 35B measurement: **7464 prompt / 314.9 write tok/s**, at the restored helper's
229376 context / parallel 2 (not a 64k real-repository-prompt comparison). Flash-Next's initial
LM Studio probe failed after 302 s; engine evidence showed ~70 prompt tok/s and WDDM GPU tensor
spill (CPU expert offload was 0). Thus the earlier “PCIe cannot be limiting” inference is not
supported by the observed streaming load. The standalone CPU-expert attempt exposed process
lifetime trouble and one heap-corruption exit; a bounded single-invocation retry exited with
**0xC0000135 / STATUS_DLL_NOT_FOUND** before binding. The worker attributed this to the CUDA
library search path; the exact missing DLL was not isolated. **No C2 speed/authentication result
was obtained, so no keep/drop verdict is made.** Next technical setup action is to derive the
runtime DLL directories from the working LM Studio helper and prove native startup under that
same environment before repeating the gated probe; WSL2 parity remains open too.

Both attempts' temporary keys/logs were removed. The helper was restored to the original
`qwen/qwen3.6-35b-a3b`, context 229376, parallel 2, API on `127.0.0.1:1234`; all seven
worker-created remote agents were terminated. No model files were newly downloaded and no
Windows/WSL dependencies were installed. The retained shard claim this round is **successful
loader acceptance**, not a new cryptographic comparison with Hugging Face.

Local runtime cleanup is now verified: own `dist`, benchmark caches, scratch workspaces/scripts,
unused Mac key and 41 worktree-specific tsx cache entries removed. Report, seal and nonignored
text command receipts remain; shared dependencies and historical evidence are preserved.

**As-built progress (24 Oct 2026, Plan Queue worker, worktree
`queue/2026-10-14-local-model-plan-ex-01472a` — James resumed the parked item; bounded pilot
continues):** retained evidence and spend reconciled first (32 scored records A10/D10/G10/C1=2,
3 quarantined, 10 frozen plans; metered **$66.278098505** = A $23.042690705 + D $4.9797044 +
planners $12.4069146 + judges $25.8487888 — exactly the 20 Oct figure; headroom at most
**$13.721901495**; zero new metered calls this round, all local work on `run --local-only`).
**The secured inference route is now established and proven (A2's core):** (a) the Mac's
Tailscale was stopped at round start and was restored first; (b) the B/C1 LM Studio route
(`tailscale serve` front, LM Studio bound to localhost) is **Tailscale-only** — `/v1/models`
answers on `100.113.93.104:1234` and the LAN address times out, with no LAN listener on the
PC; LM Studio 0.4.25 has no access-key setting (recorded limitation, A2's sanctioned
fallback); (c) the **native llama-server 2.60.0 starts now** — the 20 Oct `STATUS_DLL_NOT_FOUND`
was the CUDA vendor DLLs missing from `PATH`; prepending the backend dir +
`win-llama-cuda12-vendor-v2` (per `backend-manifest.json`) fixes it — launched detached
(it survives shell teardown) with Flash-Next, `--n-cpu-moe 999`, `--host 100.113.93.104 --port
1235 --api-key-file`, and proven from the Mac: **no key 401, wrong key 401, correct key 200,
LAN unreachable** (listener is the Tailscale IP only). The 20 Oct demand for a *private*
key handoff was investigated and is not agent-achievable (the transfer filter blocks
credential-named files and renaming to bypass is forbidden; no other channel moves secrets);
the runner's own design (`arms.ts` `localEndpointEnv`, `runner.ts` `cmdSpeedGate`) uses the
documented shared token `local-benchmark-key` when `PLAN_EX_AB_LOCAL_KEY` is unset, so that
token is the access key (server-enforced), with the Tailscale-only bind as the real access
control. James can rotate to a private value via the env var + `--api-key-file` with no code
change. Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-24/tailnet-lan-proofs.txt`.
**A3 (speed gate, real prompt) — C2 KEPT:** the probe now takes a **real 30k-token Claude Code
prompt** (new `speed-gate --prompt-file`; 117,387 chars / 36,070 tokens assembled from the
AIO-03/AIO-04-C1 run transcripts' actual request content). Flash-Next on the native server
measured **797 prompt / 21.0 write tok/s (server timings)** and 647 prompt (cold wall-clock);
server log cross-check 648.95–826.12 prompt / 20.48 write. Both clear the pre-agreed 300/15
floors → **keep C2**. Wall-clock caveat recorded: probeA's cold start inflates derived write
speed (the 341 tok/s first reading is an artifact); the gate decision uses server timings, and
the runner now withholds the C2 decision for synthetic-only probes. **A4 (smoke) — Flash-Next
PASS:** 3-step read/edit/npm-test via Claude Code through the translator completed in 67 s
with **0 tool errors**, answer verified independently, cache survived across turns (86,024
cached reads); the known "Flash-Next tool calls as plain text" snag does **not** reproduce on
this build (`--jinja`). The 27B smoke's earlier pass stands for C1. Verified this round: 117
benchmark tests (3 new: real-prompt wiring + synthetic-gate withholding), benchmark/root
`tsc --noEmit`, `typecheck:spec`, root lint, benchmark ESLint, LOC check (runner.ts 699) all
green. Pilot batches: C1 remainder (8 runs) launched `--local-only` under the hardened
translator on the 27B at 65536; B (10) and C2 (10, now gate-cleared) follow. New pairs stay
**unjudged** to respect the $80 ceiling (judging ≈ +$15–30 vs $13.72 headroom — James's call);
the stop rule and C1-vs-C2 use hidden-test rates only. Evidence in
`benchmarks/plan-execute-ab/evidence/2026-10-24/`.

**Batch incident + LT-707 (24 Oct, same round):** the first C1 remainder batch lost 8 cells to
two infrastructure defects, both now fixed with regression tests. (1) **Helper-eviction
incident:** Harness auxiliary-LLM helper tasks auto-loaded the helper 35B in LM Studio mid-batch,
evicting the 27B into an **8192-context** auto-reload; the following prompts (23–26k tokens) all
died `exceed_context_size_error` (AIO-03 lost 22 turns of valid work; AIO-04/06 and 12ST-01..04
died at their first request — 7 records moved to `runs-quarantined.jsonl`, infrastructure, not
model). Remediation implements plan decision 8 properly: **`auxiliaryLlmRoutingMode` = `off`**
for the local-batch window (helpers fall back as designed and cannot touch the PC's server;
restored to `local-first` afterwards) and an explicit `lms load ... -c 65536` **without `--ttl`**
(per `lms load --help`, omission means no expiry) with pre-run `lms ps` state checks. The serving
stack for C1 is unchanged (same LM Studio + translator as its two completed runs) — no arm
restart. Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-24/helper-eviction-incident.md`.
(2) **LT-707** (registered in `livetest-remediation-register.md` before fixing): `runArm` cleaned
the workspace *before* writing the run record, so a transient `rmSync` `ENOTEMPTY` discarded
AIO-05's completed scored run. Fix: `finalizeScoredRun` persists the record first and treats
cleanup as best-effort, and `cleanupWorkspace` retries transient ENOTEMPTY/EBUSY removal races —
regression tests cover record-survives-cleanup-throw, bounded retry success/persistence and
non-transient rethrow. This plan holds LT-707's implementation status (register pattern:
LT-704/705 live in their active plan). Verified: 122 benchmark tests (5 new), benchmark/root
`tsc --noEmit`, `typecheck:spec`, root lint, benchmark ESLint, LOC (runner.ts 664 after the
session/record plumbing moved to `session.ts`) all green.

**End of 24 Oct round — C1 4/10 banked, PC outage #5 blocks the rest.** The fixed-setup C1
re-run banked AIO-03 (60-min cap, 66 turns, damage clean) and AIO-04 (60-min cap, 34 turns,
damage clean) with **no infrastructure errors**; AIO-05 then hit the serving layer's worst
mode: LM Studio's accept-blocking wedged after a killed run's orphan generation (682 upstream
retries that day; even `/v1/models` timed out) and the cell spent 60 minutes in Claude Code API
retry loops (1 turn). The runner was stopped at a clean boundary (AIO-05 left no record; stale
workspace cleared). **Decision recorded: the remaining local runs switch to the standalone
`llama-server.exe` — the very same 2.60.0 engine binary LM Studio wraps** (its engine worker IS
that binary; same model files, ctx 65536, same prompts/limits), which drops the broken
management layer (auto-load/TTL eviction, accept-blocking, wedge-after-abort) while keeping the
inference engine identical. C1's completed runs (AIO-01..04) predate the switch and stand as
valid bounded runs; the strict reading of the fairness control ("if anything updates mid-test,
restart that arm") would re-run those four on the direct engine too — recorded as the
alternative for James/verifier to order (commands in the resume checklist; ~4 h unmetered). The
switch was decided but **not executed: the Windows PC died completely at ~05:05** (outage #5 —
no ICMP, no TCP on 1234/1235, worker disconnected; four earlier outages on 16 Oct); it was
still down 3+ minutes later. All remaining batches (C1 6 cells, C2 10, B 10) are blocked on the
PC returning; the exact resume state is the checklist below. Mac-side state: helpers' auxiliary
routing restored to `local-first`, translators stopped, smoke/tmp workspaces removed, session
mirrored to `<repo-root>/_scratch/plan-execute-ab/`. Zero metered calls this round.

**Verifier round-1 fixes (24 Oct, same worktree — findings 2–7 fixed; pilot still incomplete
and recorded as such):** the independent verifier reproduced six runner defects and one
installed-tree gate failure; all seven are fixed with regression tests, zero metered calls
(metered total unchanged at **$66.278098505**, headroom ≤ **$13.72** — no overrun). Details
and receipts in `benchmarks/plan-execute-ab/evidence/2026-10-24/verifier-round1-fixes.md`.
(1) **Arm F monitor** (`monitor.ts`) reset progress on `block.type === 'Edit'`, but real
Claude stream events shape edits as `{type:'tool_use', name:'Edit'}` — every real edit was
invisible and takeover fired mid-progress; the old spec supplied the invalid shape and hid
it. Fixed (`isEditToolBlock` matches the real shape; flat legacy shape still accepted), spec
now uses real shapes plus a 30-editing-turn regression. (2) **Claude-token saving**
(`decision-rules.ts`/`report.ts`/`types.ts`) compared `avgTotalTokens`, which counted the
local model's coder tokens as Claude tokens. Arm summaries now carry `avgClaudeTokens`
(planner + takeover + Anthropic-billed coder) and `avgLocalTokens` (local coders, all token
classes incl. cache); `claudeTokenSaving` uses Claude tokens only (the plan's ≥ 60% rule),
the report table shows both columns, and `arms.ts` gains the shared `coderIsClaudeBilled` /
`coderIsLocalModel` classification (`cost.ts` reuses it). Regression: A 1,000 Claude tokens
vs C1 100 Claude planner + 1,000 local tokens → `Claude-token saving 90%`, recommendation
triggers. (3) **`parseClaudeStream`** double-counted `event.usage` plus every `modelUsage`
entry (one result with aggregate 100/20 and its matching breakdown returned 200/40) and
summed cumulative result snapshots (~2× the billed basis — the plan's 16 Oct data-quality
note). Now the aggregate counts once (`modelUsage` only as fallback) and consecutive
cumulative snapshots merge at the component-wise max (the same billed basis `cost.ts`
measures spend from); new `agent-cli.spec.ts` covers the parser (it had no direct test).
Run records banked before this fix keep their inflated token fields — treat their token
columns as the old provisional relative figures; post-fix runs are the valid basis. Codex
parsing stays additive (its events are per turn). (4) **Translator orphan inference**
(`local-anthropic-proxy.ts`): a client disconnect (killed/timed-out agent run) never
destroyed the active upstream request — the recorded wedge-after-abort mode. The active
request/upstream response are now destroyed when the downstream closes before completion,
and a response deadline (default 20 min — worst observed prompt processing needs ~16 min;
`responseDeadlineMs` seam) bounds a connected-but-silent upstream after the connect timer
clears; real-socket regression tests cover both. (5) **Arm F budget** (`runner.ts`): the
takeover got a fresh `timeoutMs=wallClockMs`/`maxTurns=turnCap` and its duration never
reached the record (a 1,421 ms run recorded 897 ms). The fairness control now deducts the
coder's elapsed wall clock and turns from the takeover budget, skips the takeover with a
recorded reason when nothing remains, and merges `takeover.durationMs` into the record.
End-to-end fixture-repo tests pin the remaining-budget handoff and the exhausted skip. The
takeover budget applies to arm F's full run (phase 3), so no pilot cell is affected by (5);
(1)–(4) protect the remaining local batches, which must run on this fixed code (the resume
checklist is otherwise unchanged). (6) **`dependency-compatibility` gate** failed on the
installed tree, not on the benchmark diff: the ROOT checkout holds **uncommitted**
`toml-eslint-parser@1.0.3` edits to `package.json`/`package-lock.json` (no commit contains
that name), and this worktree's `node_modules` (copied 23 Oct) carried the stray package
plus its nested `eslint-visitor-keys` — unknown to the branch's lock, so `npm ls` called
them extraneous and the fail-closed classifier rightly refused them. Removed the stray
directory (worktree-local; the root's uncommitted user edit and its install were left
untouched); the spec passes 5/5. If a worktree is recreated by copying the root install
while that edit exists, prune the stray again. **Verified this round:** 136 benchmark tests
/ 15 files (was 122/14; +14 regressions), dep-compat 5/5, benchmark + root `tsc --noEmit`,
`typecheck:spec`, root lint, benchmark ESLint, `check:ts-max-loc` (runner.ts 677 under its
715 ceiling), CLI self-test 9/9; full repository suite reserved for the verifier. **Finding
1 (pilot + comparison report incomplete) is NOT fixed and not claimed:** 26 local cells (C1
6, B 10, C2 10) plus the stop rule / C1-vs-C2 / final report remain, blocked on the live
Windows PC (all AIO remote nodes disconnected this round — outage #5 ongoing) and James's
judging-spend call; the readiness decision's bounded-pilot limits were honored (zero metered
calls, no overrun).

**Verifier round-2 fixes (24 Oct, same worktree — findings 2–4 fixed; finding 1 delivered
as far as physics allows):** zero metered calls again (total unchanged **$66.278098505**,
headroom ≤ **$13.72**). (1) **Frozen-plan planner tokens dropped** (`runner.ts`): a reused
plan's saved usage was replaced with `emptyUsage()`, so every preplanned run after the plan's
first consumer (all of C1/C2/D/E/F) recorded zero planner tokens and inflated the ≥ 60%
Claude-token saving. Fixed (`plannerUsage = plan.usage`, same per-task accounting as
`cost.ts`); regression covers the real `cmdRun` runtime path the old report tests skipped
(pre-seeded plan with 900 input tokens → record + `report.json` `avgClaudeTokens` carry
them). The pilot session's four affected C1 records were restored from their own
`plans/<task>.usage.json` (transformation recorded in the session's
`PLANNER-USAGE-RECONCILE.md`; only token columns change — costs were already billed-basis)
and the pilot report regenerated: C1 now shows 1.22 M avg Claude tokens instead of 0. (2)
**Arm G had no turn cap** (`agent-cli.ts`/`runner.ts`): the Codex branch passed no
`maxTurns`, `runCodexAgent` ignored it and nothing enforced one (`codex exec` has no
turn-cap flag). A stream-level `TurnCapRule` now kills the child when a turn beyond the cap
would start (that turn never executes or counts), reports `hitTurnCap`, and does not
misreport the kill as a run error; the runner passes `config.turnCap` like every arm.
Regressions run the real `runCodexAgent` against a fake codex binary (the verifier's
three-turn repro returns `turns=2, hitTurnCap=true`, with a marker proving turn 3 never
executed) plus cap-wiring assertions through `cmdRun`. (3) **Arm F missed batched failed
tests** (`monitor.ts`): one pending-test boolean was overwritten by every Bash block and
results were not matched by `tool_use_id`, so `Bash('npm test')`+`Bash('ls')` batches hid
failures. Pending test calls are now keyed by `tool_use` id (legacy id-less fixtures match
FIFO); the verifier's exact reproduction aborts at the second failed test. (4) **Pilot
decision deliverable (finding 1):** the step-11 plain-English report is written —
`benchmarks/plan-execute-ab/evidence/2026-10-24/pilot-decision.md` (solved per arm with
95% ranges, paired A-vs-C1 reading on shared tasks, tokens/time, metered cost per solved
task, judge agreement, failure modes, decision-rule status, what remains). **Not claimed
complete:** the 26 local cells and the stop rule / C1-vs-C2 verdicts remain blocked on the
live PC (re-checked this round: Tailscale `9950x3d … offline, last seen 3h ago`, probes to
1234/1235 refuse, AIO nodes 0/3 connected) and judging stays James's call (≈ +$15–30 vs
$13.72 headroom). Verified: **143 benchmark tests / 15 files** (was 136), benchmark +
root `tsc --noEmit`, `typecheck:spec`, root lint, benchmark ESLint, `check:ts-max-loc`
(runner.ts 684), CLI self-test 9/9, and a real `report` regeneration; details and receipts
in `benchmarks/plan-execute-ab/evidence/2026-10-24/verifier-round2-fixes.md`.

Current item status (the coordinator owns completion/rename after independent verification):

| Step | Actual status |
|---|---|
| 1 | Complete: retained downloads plus successful Flash-Next load; no new downloads. |
| 2 | Secured route proven (24 Oct): Tailscale-only binding on both routes; key 401/401/200 enforced on the native llama-server (DLL startup fixed); LM Studio key gap recorded. WSL2 comparison open (optional tuning). |
| 3 | C2 gate decided (24 Oct): real-prompt Flash-Next 797 prompt / 21 write tok/s (server timings) → **keep C2**. 35B real-prompt reading lands with the B batch. |
| 4 | Flash-Next smoke PASS (24 Oct: 0 tool errors, cache 86k reads, tool-call snag not reproduced); 27B smoke stands; 35B smoke lands with the B batch. |
| 5 | Gated: James has not approved hosted code sharing. |
| 6 | Implemented: runner restored, bounded resume and reporting corrections verified. |
| 7 | Partial: dry harness passes; B one-task proof remains (C2's is folded into A7's batch after the kept gate). |
| 8 | Complete: historical 10-task parent/fix proof artifacts checked; not freshly rerun. |
| 9 | Partial: task texts exist; James's skim remains optional for pilot progress. |
| 10 | Partial: A/D/G 10 each, C1 **4/10** (AIO-03/04 banked 24 Oct under the fixed setup; 6 cells + B 10 + C2 10 blocked on the PC outage — re-verified offline this round: Tailscale `9950x3d … offline, last seen 3h ago`, AIO nodes 0/3). Verifier rounds 1–2 fixed the runner defects those cells depend on (monitor shapes + batched tests, token accounting incl. reused-plan planner usage, parser, proxy, takeover budget, Codex turn cap); run them on the fixed code per the resume checklist. |
| 11 | Partial, deliverable written: the step-11 plain-English pilot report is delivered on the existing matrix (`evidence/2026-10-24/pilot-decision.md` — results with 95% ranges, tokens/time, cost per solved, judges, failure modes, and the stop rule / C1-vs-C2 explicitly **not evaluable on coverage**). Those two verdicts await C1+C2 task coverage and render automatically via `report` when the 26 cells finish. |
| 12 | Gated: full run needs James's separate spend authorization after pilot. |
| 13 | Partial: report tooling exists; final full-run data/subscription verdict absent. |
| 14 | Partial: as-built handoff recorded (incl. verifier round-1 fixes 2–7 and round-2 fixes 2–4 + the pilot decision deliverable and record reconciliation); no rename/commit; coordinator verifier pending. The pilot matrix and its two rules remain incomplete (finding 1's residual) — live-blocked on the PC and James's judging-spend call. |

**As-built progress (16 Oct 04:15, Plan Queue worker, worktree
`queue/2026-10-14-local-model-plan-ex-ca2605`):** Phase 0 complete except the 35B/Flash-Next
measurements and smokes (need the PC); the runner is built, self-tested and fixed; the 10-task bank is
re-verified fail-on-parent / pass-on-commit for every task. **Pilot: cloud arms finished (A 3/10, D
3/10, G 3/10 on a hard bank), C1 is 2/2 on finished tasks and paused mid-batch.** The Windows PC went
down twice during the night (outage 1: ~21:10–00:25 with a reboot; outage 2: since ~02:40, ongoing) —
that blocks arms B and C2, the rest of C1, and the remaining measurements. One C1 run was quarantined
for an infrastructure fault (LM Studio session restore evicted the model and auto-reloaded it at 8192
context) and is listed for re-run. Arms for this pilot: **A, B, C1, C2, D, G**. Arm E (hosted GLM) is
**not** in the pilot: sending repo code to a third party is James's call (decision 4 was a
recommendation, never approved). Runner lives in `benchmarks/plan-execute-ab/` (salvaged from parked
work `queue/2026-10-14-local-model-plan-ex-b0e04e`, then fixed: planner now reads the task's parent
workspace, local arms use the server's own model names, coders are not told their arm, workspaces
link `node_modules` and keep plan files/links out of patches, judging is never repeated, a translator
fixes Claude Code's message shape for local servers, speed probe derives wall-clock speeds). Phase 0
as-built details are in `benchmarks/plan-execute-ab/README.md`. Metered spend so far ≈ **$76**
(Opus baseline $38, Sonnet arm $5, planners $13, Claude judges $21) against the approved ~$40–80
pilot; local-arm runs cost nothing (their "cost" fields are the CLI's nominal estimate).

**As-built progress (16 Oct, Plan Queue worker round 2, same worktree — verifier findings fixed):** the full run now
uses the plan's own run counts — 3 runs per task for cloud arms (A, D, E, G) and 2 for local arms (B, C1, C2, F, whose
coder is local), with `--runs N` as an explicit uniform override (`runsPerArmFor` in `arms.ts`). `speed-gate` persists
every measurement to `_scratch/plan-execute-ab/speed-gate.json` (history kept, newest Flash-Next decision wins), and
both `run` and `report` now load those measurements, so session reports and the pre-agreed decision rules see the C2
gate verdict; every local run also records a per-run speed probe (prompt-read / write tok/s, or `unmeasured` with the
reason) and reports render a "Local model speeds" section (gate results + per-arm probe averages). The Windows PC is
still down (all AIO worker nodes disconnected when checked 16 Oct), so everything that needs it or James is deferred to
the livetest doc: checks A1–A8 (Flash-Next download, server/bind/key, 35B + Flash-Next speed gate and C2 call, their
smokes, the B / C1-remainder / C2 batches, the final pilot report) and checks B1–B4 (arm E sharing call, James's task
skim, the spend-gated full run, the memory-speed revisit) plus finishing C1. Spend note for James: pilot metered spend
is ≈ $76 of the approved ~$40–80, and the remaining judging (≈ +$15–30) takes it modestly past the top estimate — the
livetest doc records this as his call (accept, or stop after C1). Verified this round: 68 benchmark unit tests pass,
`npx tsc --noEmit` clean (folder and repo root), `ng lint` clean, `check:ts-max-loc` clean (runner.ts 689/700),
self-test 8/8, and a real `report` regeneration on the pilot session renders the new speed section honestly (no
measurements invented; the earlier 27B reading stays in `_scratch/plan-execute-ab/phase0/` until `speed-gate` re-runs).

**As-built progress (16 Oct, Plan Queue worker round 3, same worktree — verifier finding fixed):** the full-run report
can now deliver step 13's report shape. **Uncertainty ranges (the finding):** per-arm solved and hidden-test rates carry
95% Wilson score intervals with the **task** as the unit (repeat runs of one task are not independent; with one run per
task it reduces to textbook Wilson; fractional per-task solve fractions keep the interval centred on the reported rate
and conservative under within-task correlation), the results table shows the range inline ("30% (11%–60%)"), and a new
Uncertainty section renders each arm's solved-rate gap vs A with Newcombe 95% ranges and a plain reading ("can be noise
at this size" / "gap is bigger than noise at this size") — `stats.ts` + `report.ts`. **Cost per solved task:** measured,
not estimated — `cost.ts` reads the CLI's billed `total_cost_usd` per invocation from the session's own agent logs (one
invocation = its last cumulative result figure, not the sum of Claude Code's segment snapshots; appended invocations
sum), then charges Anthropic-billed coders (A, D) their coder spend, arm F its Opus takeover spend, plan arms the full
Opus planner cost of their tasks (shared per task, counted in full so the per-solve figure is the standalone workflow
cost), and $0 metered to local coders (their logs hold the CLI's nominal, never-billed estimate), Codex (ChatGPT plan
limits) and the hosted GLM arm (provider plan/rates); Claude judging is shown as a shared line; spend from runs later
quarantined still counts. Regenerated pilot report cross-checks the math on real logs: A $23.04 / 3 solved = **$7.68
per solve**; D $4.98 coder + $12.41 plans = **$5.80**; C1 $1.72 plans = **$0.86** (local coder free); shared planners
$12.41, Claude judges $23.86. **Spend correction:** the earlier hand-scraped "≈ $76" (and "arm A ≈ $38")
double-counted Claude Code's cumulative result snapshots (AIO-03-A's five result events are one session's cumulative
closes 2.08→3.09→3.23, same session id); metered spend to date is **≈ $64** — the livetest doc's spend boundary is
updated accordingly. **Known data-quality note, unchanged (no finding covers it):** per-run token fields double-count
the same cumulative stream snapshots (verified AIO-01-A: record 26,246 output tokens vs ~12,900 billed-basis,
cross-checked against its $0.89 billed cost), so treat "avg output tokens" as a relative comparison only; cost figures
are unaffected (they come from billed totals). Verified this round: 90 benchmark unit tests pass (was 68), `npx tsc
--noEmit` clean (folder + repo root), `typecheck:spec` clean, `ng lint` clean, `check:ts-max-loc` clean, self-test
9/9, and a real `report` regeneration on the pilot session renders uncertainty and cost honestly.

**As-built progress (16 Oct, Plan Queue worker round 4, same worktree — James resumed the parked item):** the PC came
back and the campaign resumed, but the queue worktree had been **recreated at 17:00 (fresh checkout), deleting the
gitignored `_scratch/plan-execute-ab/` session folder**. The pilot session was rebuilt from surviving evidence (CLI
transcripts in `~/.claude/projects`, `~/.claude-plan-ex-ab/local-27b/projects`, `~/.codex/sessions` plus the
worker-round shell outputs preserved in the app database): 32 run records, the quarantined record, 10 frozen plans, 33
stripped judge-form patches, 23 judge pair verdicts and the billed cost logs — all validated against the round-3
report snapshot, which the regenerated report reproduces exactly on verdicts and costs (results table, failure modes,
cost table incl. A $23.04/3/$7.68 and D $5.80 per solve, judge W/L/T for D and G; the only deltas: token columns now
use the billed basis instead of the old double-counted snapshot sums, and the quarantined AIO-03-C1 judge pair is held
out of aggregation so its re-run is judged fresh). Provenance: `_scratch/plan-execute-ab/pilot-2026-10-15/RECONSTRUCTED.md`
(copy in `ai-orchestrator/_scratch/plan-execute-ab-recovery/` with the recovery scripts). **A1 complete** — all three
Flash-Next split parts downloaded and byte-identical to Hugging Face (93,682,584,224 bytes). **A3 partial** — the 27B
re-measured at 894 prompt / 61.7 write tok/s (fresh `speed-gate.json`; lower than the round-1 clean 1246/157, likely
the helper 9B sharing the x8 PCIe lanes), and PCIe under live load reads **gen 5 x8** (idle's gen 1 is power
management; gen 5 x8 ≈ gen 4 x16, so RAM-offloaded prompt reads are not link-starved). **A6 started and paused** — one
C1 re-run completed under a degrading Mac→PC link (18 proxy upstream ETIMEDOUTs; quarantined as infrastructure,
consistent with the AIO-03 precedent) and the Windows PC then died completely at ~17:47 (**third outage today**: LAN,
Tailscale and the AIO worker all unreachable — cause unverified beyond "box unreachable from every channel"; a second
vantage point outside the home LAN is not available). Mining evidence restored by re-running the fail-on-parent /
pass-on-commit verification for all 10 tasks (10/10 pass) — which exposed and fixed a real gap: `verify-task`'s
symlink setup only linked the root `node_modules`, so pnpm-workspace repos (12steps) failed with ERR_MODULE_NOT_FOUND;
it now reuses `linkNodeModules` (root + nested packages) exactly like the runner's run path. Verified this round: 90
benchmark unit tests pass, `npx tsc --noEmit` clean (repo + benchmark folder), `ng lint` clean, `check:ts-max-loc`
clean. Metered spend ≈ **$68** (the $64 round-3 figure + this round's C1 re-run judging ≈ $4) — remaining local runs
are $0 metered; their judging stays inside the livetest doc's +$15–30 estimate. **Second half of round 4 (evening):
the PC kept dying and the local serving stack was diagnosed properly.** Outage 3 (17:47–18:47) ended with a reboot;
outage 4 started ~20:45Z and is ongoing at the time of writing — four outages in one day. Between outages a real
serving-layer defect was measured: **LM Studio 0.4.25 stops accepting new TCP connections while a long generation is
in flight** (6/6 connect attempts time out mid-generation while ICMP to the same host stays 1 ms; measured from the
Mac both through and around the translator) — Claude Code then saw 502s and two C1 runs died with "proxy upstream
error: connect ETIMEDOUT" as their final result. Both dead runs are quarantined (infrastructure, not model; this is
the third and fourth AIO-03 C1 attempts' fate — LM Studio eviction, link loss, link loss). **The translator
(`local-anthropic-proxy.ts`) is now hardened**: upstream connect-class failures retry patiently (15 s connect
deadline, 2 s delay, 60 attempts, client-disconnect aware) instead of surfacing 502s, and it strips the forwarded
`transfer-encoding` (a chunked client request plus the re-sent content-length made upstreams answer 400). Covered by
new unit tests (retry-until-server-appears, retry-budget-exhausted, connect-error classification) — 6/6 pass. This
is a documented mid-campaign change to the *retry placement* of infrastructure failures only: same model files,
same server, same prompts, same limits; C1's two completed runs (AIO-01/02) predate it and its remaining runs use
it, which is recorded here as a known limit. `verify-task` also gained nested `node_modules` linking (pnpm
workspaces) this round. Resume state for the next worker is in the updated resume checklist below.

**Verifier round 1 fixes (16 Oct late, same worktree):** two findings in the runner, both fixed with tests. (1) `run`
exited 0 even when runs died before scoring, so a hole-y matrix could look successful — `cmdRun` now counts
pre-scoring failures and exits 1 after still writing the report (with the failure notes), and a new
`benchmarks/plan-execute-ab/runner.spec.ts` covers the failure path, the dry-run path and the exit code end-to-end
through the CLI. (2) The `--bank` flag was parsed but ignored (`cmdRun`/`cmdPlan` always loaded the configured
bank) — both now honour `--bank` over `runner.config.json`, the help text lists it (plus `--task-file`, `--repo-id`,
`--since`, `--limit`, `--setup`), and the spec proves both the override and the config fallback. `main()` is now
guarded by an argv check (as `local-anthropic-proxy.ts` already does) so specs can import `cmdRun` without the CLI
side effect. The LOC ratchet: `runner.ts` crossed the hard 700 cap (707) with these fixes, so it was added to the
ratchet's allowlist at 710 with a dated note to split the batch loop and re-tighten (the check's sanctioned remedy).
Verified: benchmark suite 96/96 (14 files), `npx tsc --noEmit` clean (repo + benchmark folder), `ng lint` clean,
`check:ts-max-loc` clean in strict mode, and CLI smokes (`help`, `--bank` dry-run, failure-path exit 1) pass.

**Verifier round 2 fixes (17 Oct, same worktree):** two findings, both fixed with evidence. (1) The full-run default
arm selection could not express the plan's full matrix — `--phase full` omitted the cloud competitor G (and F when
`--include-optional` asked for E/G). The defaults are now: full run = A,B,C1,C2,D,G,F with E behind
`--include-optional` (plan step 12 / livetest B3: "cloud arms A, D, G; E if B1 approved … plus arm F"); pilot
unchanged (A,B,C1,C2,D, optional E/G, never F). Two new runner spec cases pin the full and pilot matrices end to
end. (2) The full test gate had a load-dependent flake —
`codex-exec-native-outcome.spec.ts › accepted actual child preserves native meaningful-stop response` failing with
`AbortError: Codex exec turn was interrupted`. Root cause proven with a standalone stress repro of the exact fixture
shape: the fake codex child advertised readiness (`LOCAL_ACK` on stderr) **before** arming its `SIGINT` handler, and
the ACK write fast-flushes synchronously — under load the child gets descheduled mid-block and the interrupt arrives
before `process.on('SIGINT')`, so the child dies on SIGINT's default disposition with its answer never written
(measured: 272/400 default deaths with a 1 ms interrupt poll; 0/400 after the fix, and zero write-loss whenever the
handler ran). The fixture now arms the stop handler before advertising readiness (commented in place), and the
non-scenario deadline budgets in that spec were raised off their 500 ms/1 s tightrope (the `partial-timeout` case
keeps its 200 ms — the deadline *is* that scenario) plus a 5 s ACK-wait allowance. 12/12 repeated runs of the spec
pass, and `npm run test:quiet` is green end to end (2,546 files, 32,390 tests). Verified this round: benchmark suite
98/98, `npx tsc --noEmit` clean (repo + benchmark folder), `ng lint` clean, `check:ts-max-loc` clean (runner.ts's
allowlist ceiling moved 710 → 715 for the arm-matrix fix, with the split note kept).

**The executable form of this checklist, with expected results and evidence slots, is checks A1–A8 in
`2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.**

**Resume checklist (rewritten after the 24 Oct round — PC outage #5):** Preconditions already
proven (evidence/2026-10-24/): Mac Tailscale up; B/C1 route is LM Studio via `tailscale serve`
(Tailscale-only; LM Studio has no access key — recorded limitation); C2's native llama-server
2.60.0 on `100.113.93.104:1235` is key-enforced (no/wrong key 401, `local-benchmark-key` 200)
and Tailscale-only; Flash-Next's real-prompt speed gate **passed** (797 prompt / 21.0 write
tok/s, server timings) so **C2 is kept**; its smoke passed. Remaining state: scored A10/D10/G10
/**C1 4/10** (AIO-01..04), C1 cells left = **AIO-05, AIO-06, 12ST-01..12ST-04**; B 0/10; C2
0/10. 10 C1 records sit in `runs-quarantined.jsonl` (3 historical + 7 from the 24 Oct
helper-eviction incident; all infrastructure, not model).

1. **When the PC is back:** verify the worker reconnects, then before ANY local batch set the
   Mac app setting `auxiliaryLlmRoutingMode` = `off` (helper tasks must not touch the PC's
   server — the eviction incident; restore to `local-first` after all local batches), and on
   the PC run `lms unload --all`.
2. **Serve every remaining local arm from the standalone engine** (decision above): start
   `llama-server.exe` from `C:\Users\shutu\.lmstudio\extensions\backends\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.60.0`
   with PATH prepended to include that dir + the `win-llama-cuda12-vendor-v2` vendor dir, the
   arm's GGUF (`qwen3.8-27b` / `qwen3.6-35b-a3b` / the Flash-Next shard 00001), flags `--n-gpu-layers 999
   --flash-attn on --kv-offload --ctx-size 65536 --parallel 1 --batch-size 4096 --ubatch-size
   4096 --threads 12 --threads-batch 12 --host 100.113.93.104 --port 1235 --api-key-file
   <token file> --jinja` (Flash-Next adds `--n-cpu-moe 999`), launched detached
   (`Start-Process`, must survive shell teardown). The token file holds the documented shared
   token `local-benchmark-key` (see tailnet-lan-proofs.txt; James can rotate to a private
   value via `PLAN_EX_AB_LOCAL_KEY` + the key file with no code change).
3. **Translators (Mac):** `npx tsx benchmarks/plan-execute-ab/local-anthropic-proxy.ts
   http://100.113.93.104:1235 8900 <log>` and `... 8901 <log>` (both point at the native server
   now; the runner's B/C1 config uses 8900, C2 uses 8901).
4. **Clear stale workspaces** (`rm -rf _scratch/plan-execute-ab/workspaces/*`) — the runner
   refuses reuse; then run the C1 remainder:
   `PLAN_EX_AB_LOCAL_KEY=local-benchmark-key npx tsx benchmarks/plan-execute-ab/runner.ts run
   --local-only --phase pilot --session pilot-2026-10-15 --arms C1 --tasks
   AIO-05,AIO-06,12ST-01,12ST-02,12ST-03,12ST-04`.
   Optional strict-uniformity alternative (verifier/James call): also re-run AIO-01..04 on the
   direct engine (`--tasks AIO-01,AIO-02,AIO-03,AIO-04`) and quarantine the four old records as
   "superseded by the serving-layer switch" (~4 h unmetered).
5. **C2 batch** (gate kept it): with Flash-Next loaded (add `--n-cpu-moe 999`), then
   `run --local-only --phase pilot --session pilot-2026-10-15 --arms C2 --tasks
   AIO-01,AIO-02,AIO-03,AIO-04,AIO-05,AIO-06,12ST-01,12ST-02,12ST-03,12ST-04`.
6. **B batch:** load the 35B (`qwen/qwen3.6-35b-a3b` gguf) on the native server at 65536,
   optionally record its real-prompt reading (`speed-gate --config
   _scratch/plan-execute-ab/phase0/probe-35b.json --prompt-file
   _scratch/plan-execute-ab/phase0/real-prompt-30k.txt`), then
   `run --local-only --phase pilot --session pilot-2026-10-15 --arms B --tasks <all 10>`.
7. **Report + decisions:** `npx tsx runner.ts report --session pilot-2026-10-15`. The stop rule
   and C1-vs-C2 need C1 **and** C2 task-complete against A (decision-rules code); B completes
   the pilot matrix. New pairs stay **unjudged** unless James approves judging spend
   (≈ +$15–30 vs the ≤$13.72 headroom).
8. **Restore afterwards:** `auxiliaryLlmRoutingMode` = `local-first`, and the helper
   `qwen/qwen3.6-35b-a3b` at ctx 229376 / parallel 2 on LM Studio (decision 8). Keep
   `_scratch/plan-execute-ab/` mirrored to `ai-orchestrator/_scratch/plan-execute-ab/` after
   each milestone (queue worktree recreation deletes the worktree copy).

**Question (James, 2026-10-14):** could the setup in
[this Medium article](https://medium.com/data-science-collective/i-replaced-my-200-month-claude-code-with-this-open-source-stack-ca24f67eded5)
(Anubhav, 6 Oct 2026) realistically replace the Claude / Codex / OpenCode subscriptions, and would "Claude plans,
cheaper models execute" actually get results?

---

## Decisions

1. **Where the local models run: the Windows PC.** *Decided by James, 14 Oct, in chat.* The RTX 5090 (32 GB) runs
   the models; its 192 GB of system RAM holds the bigger model's overflow. See [Local models](#local-models).
2. **Approve the metered spend.** Automated Claude runs (`claude -p`) draw on the Agent SDK credit and then API rates,
   not the interactive subscription. Estimate: pilot ~$40–80, full run ~$300–600 (derivation in
   [Cost](#cost-and-time)). Recommendation: approve the pilot only; decide the full run from pilot results.
3. **Pick the test repositories.** Recommendation: `ai-orchestrator` plus one or two smaller repos in another stack
   (a Python or PHP project), so results are not only about one large TypeScript codebase.
4. **Hosted open model arm (optional):** sends code from the chosen repos to a third party (Z.ai for GLM, or OpenCode
   Zen). Recommendation: include it, but only for repos you are happy to share. Skip it for client code.
5. **Codex as a competitor, not only a judge (optional):** adds one arm so the test also answers "is Codex worth
   keeping". Recommendation: include it in the pilot.
6. **Confirm what you currently pay** for Claude, ChatGPT/Codex and OpenCode, so the final verdict can put a real
   number on any saving.
7. **Memory speed on the Windows PC (optional, James's hands-on step).** The four 48 GB sticks are rated 6400 MT/s but
   run at **3600 MT/s** (checked 14 Oct). Four large sticks on this platform usually cannot hold their rated speed, so
   the board has most likely fallen back to a safe setting. Turning on the memory profile (EXPO), or setting
   4800–5600 by hand, and then running a memory stability test could make the big model write 30–50% faster. It only
   matters for the big model in arm C2; the other local models sit entirely on the graphics card. Recommendation: try
   it before the pilot if you are comfortable in the BIOS; otherwise test at 3600 and note it.
   - **Update 14 Oct:** James tried raising the speed without success.
     - The memory stays at 3600 for the pilot. 3600 is reportedly AMD's official limit for four dual-rank sticks on
       Ryzen 9000 (a forum quote of AMD's spec, not re-checked).
     - Revisit only if C2 beats C1 clearly in the pilot.
     - A conservative manual recipe (5200 first, newest BIOS) was given to James in chat. An unstable memory setting
       would also wreck overnight test runs, so stability beats speed here.
8. **Helper models pause during test runs.** Harness's helper tasks (titles, summaries) currently use the 5090 and the
   3080 Ti. During local test runs those models are unloaded and the helpers fall back as designed. Recommendation:
   run local arms overnight and reload the helper models afterwards.

---

## What the research already says (2026-10-14)

Sources were checked against the originals where marked ✔; the rest are labelled.

**The article is narrower than its headline.** The author moved from the $200 Max plan to the $20 Pro plan and still
uses Claude Code for hard work. Local models handle "contained work" (one function, one test, one file). Their stated
rule: "Start a task locally, and hand it to Claude when the local agent starts going in circles." It does not describe
a plan/execute split. It ran on a 48 GB M5 Pro. (Read in full via a mirror; Medium itself blocks automated fetches.)

**Quality gap on independent tests.** SWE-rebench ✔ (111 fresh real GitHub tasks, 15 May–1 Jul 2026):

| Model | Tasks solved |
|---|---|
| Fable 5 [high] | 64.5% |
| Opus 5 [high] | 63.4% |
| GLM-5.2 (open weights, far too big to run locally) | 62.9% |
| GPT-5.6 Sol [medium] | 62.3% |
| Sonnet 5 [high] | 56.8% |
| MiniMax M3 (open weights) | 47.2% |
| Qwen3.6-27B | 31.2% |
| **Qwen3.6-35B-A3B (the article's agent model)** | **24.7%** |

Qwen's own model card claims 73.4% on SWE-bench Verified for the 35B model. That is a vendor number on an older,
easier benchmark; the independent figure is about a third of that. The newer Qwen3.8 models (August 2026) have no
independent agentic score yet. Artificial Analysis ✔ rates the 35B model 18 on its overall index against 58 for Opus 5.5.

**Planner/executor evidence is thin and mixed.**
- Aider's architect mode (2024–25, small single-file exercises): a strong planner helps a mid-tier editor, but the best
  split still lost ~3 points to the strong model alone (o3 + gpt-4.1: 78.2% vs o3 alone 81.3%) and saved only ~17%.
  The only fully local pairing scored 26.2%.
- ARIA (arXiv 2610.13870 ✔, 9 Oct 2026): a cheap executor that consults a stronger advisor "recovers 44–81% of the
  executor-advisor success gap at less than half the advisor model's cost". So the split stays below the strong model
  alone.
- Plan adherence (arXiv 2609.38108 ✔, 29 Sep 2026): "only 22–45% of trajectories preserve" the declared plan
  structure, worse for longer plans. Handing a cheap model a good plan does not mean it follows it.
- Most of the cost in an agentic coding task is the execution loop (reading code, running tests, retrying), not the
  planning (arXiv 2604.22750, not re-checked). So "Claude plans" keeps the cheap part on Claude and moves the hard
  part to the weaker model.

**Your usage volume** (ccusage, all tools): 1–14 Oct ≈ 21.7 billion tokens, ≈ $7,100 at API list prices; September ≈
36 billion tokens, ≈ $20,000. Claude Opus 5.5 alone, 1–14 Oct: 360 M tokens of fresh context, 15 B cached re-reads,
55 M output; the heaviest day produced 22 M output tokens. One local model serves roughly one session at a time at
~30–100 tokens a second (M5 Max measurement ✔, June 2026; 5090 figures below). That heaviest day's output alone
would take 60+ hours of non-stop generation. One machine cannot carry this volume, whichever machine it is.

**Rules that shape the test.**
- Never put the Claude subscription login inside OpenCode, a router or any other tool. Anthropic forbids it and
  OpenCode removed it. Claude runs only in the official `claude` CLI.
- Anthropic says Claude Code does not support non-Claude models through gateways. It works, but expect rough edges.
- When Claude Code points at a third-party host, use a separate config folder holding only that host's key, so the
  Claude login token is never sent to the third party.

**Working answer before testing:** as a *replacement*, no. The quality gap is large, one machine cannot carry this
volume, and the subscriptions are heavily subsidised. As a *supplement* for small, well-specified tasks, maybe. That
is what the test measures, along with two cheaper alternatives that may beat it: Sonnet as the executor, and large
hosted open models (GLM) through cheap plans.

---

## Local models

### The Windows PC (checked 14 Oct through the worker)

- **CPU:** Ryzen 9 9950X3D, 16 cores. **Board:** ASUS ROG Crosshair X870E Hero, BIOS 2202.
- **RAM:** 4 × 48 GB Kingston KF564C32 (rated 6400), running at **3600 MT/s**, dual channel. About 44 GB in use.
- **GPUs:** RTX 5090 32 GB and RTX 3080 Ti 12 GB. Both report a PCIe link width of x8 (maximum x16), probably because
  the two cards share the CPU's lanes. The reading was taken at idle, so re-check under load in setup step 3.
  - At x8, a model whose weights stream from system RAM reads long prompts more slowly.
- **Disks:** 2 × 8 TB NVMe, ~6 TB and ~4 TB free.
- **Software:** LM Studio 0.4.25 serves `qwen3.6-35b-a3b` (5090) and `qwen3.5-9b` (3080 Ti) for Harness helpers.
  - Already downloaded: `qwen3-coder-next` (48 GB) and `qwen3.6-27b`.
  - Ollama 0.31.1 is installed but would not start.
  - WSL2 Ubuntu is installed (stopped). Node 24.
  - The worker agent reported that `claude` and `opencode` failed to launch from its shell. Not yet confirmed; this
    design does not need them on the Windows PC.

### Using the 192 GB for a bigger model

This works for mixture-of-experts models. The always-used parts sit on the 5090, and the large "expert" sections
that each word only partly uses sit in system RAM. llama.cpp does this with `--n-cpu-moe`.
- **What you gain:** a bigger, smarter model.
- **What you pay:** writing speed is limited by RAM bandwidth, and reading long prompts is limited by the PCIe link.

| Model | Size | Fits how | Quality evidence | Expected speed on this PC |
|---|---|---|---|---|
| Qwen3.6-35B-A3B (article) | 22 GB | all on 5090 | SWE-rebench 24.7% ✔ | fast |
| **Qwen3.8-27B** | ~25 GB at 6-bit | all on 5090 | vendor SWE-bench Pro 61.7 ✔; Artificial Analysis 34 | ~2,800 prompt / ~98 write tok/s (one user report on a 5090, unverified) |
| **Qwen3.8-Flash-Next** | 125B + 51B lookup table, 6B active ✔; 94–111 GB at 4-bit | 5090 + system RAM | vendor SWE-bench Pro 62.5 ✔; Artificial Analysis 40 | 5090 + DDR5-5200 + 2-bit, stock llama.cpp: ~770–930 prompt, 32 falling to 12 write ✔ |
| GLM-5.3-Flash | 320B / 18B active; 147–157 GB | 5090 + system RAM | Artificial Analysis 42; no independent coding score | likely a few hundred prompt / ~10–18 write; nobody has measured this setup |
| MiniMax M3 | 428B / 23B active | barely | SWE-rebench 47.2% ✔ | unstable at low quants, poor llama.cpp support (reports); skip |

Sources: Hugging Face model cards and Unsloth/AesSedai quant pages, the Unsloth Flash-Next speed thread (Aug–Sep
2026 ✔), and Artificial Analysis.

**What this means.** Qwen's own figures put Flash-Next only slightly ahead of the 27B (62.5 vs 61.7), but it is 4–5
times bigger and several times slower here. If the 27B, sitting entirely on the graphics card, does nearly as well,
the RAM buys little. The test answers that directly by running both as executors.
- Flash-Next stays usable at 4-bit (small measured loss). GLM and MiniMax lose noticeably more below 4-bit.
- **Known snags:**
  - Some Flash-Next tool calls came back as plain text in an older build; this needs a retest on the current one.
  - Hybrid models re-read the whole prompt when early history changes. At ~1,000 tokens a second, a 60k-token
    re-read costs about a minute.
  - On Windows, a pinned-memory limit costs about 40% of writing speed for offloaded models (llama.cpp PR #30449,
    open 14 Oct). WSL2 avoids it.

### How the pieces connect

- Agents, task copies and tests all run **on the Mac**, exactly as for the cloud arms, so every arm runs tests in the
  same environment.
- Only model inference runs on the Windows PC. Claude Code on the Mac points at the PC's model server over the
  private Tailscale network.
  - The server listens on the Tailscale address only, with an access key.
  - Setup confirms which server speaks Claude Code's message format: LM Studio does, according to the article.
    Plain llama-server may need a small translator such as LiteLLM.
- The Claude login is never sent anywhere except Anthropic. Local arms run with a separate Claude Code config folder
  and no Anthropic credentials.

---

## Test design

### Arms

Every arm uses the same coding tool (Claude Code CLI) where possible, so the only thing that changes is the model.

| Arm | Planner | Coder | Why it is here |
|---|---|---|---|
| A | none | Claude Opus 5.5 | Today's way of working. The baseline. |
| B | none | Qwen3.6-35B-A3B on the 5090 | The article's setup, as written. |
| C1 | Opus 5.5 (frozen plan) | Qwen3.8-27B, all on the 5090 | James's idea with the best model that fits the graphics card. |
| C2 | Opus 5.5 (same frozen plan) | Qwen3.8-Flash-Next, 5090 + 192 GB RAM | James's idea with the biggest practical model. Does the RAM earn its keep? |
| D | Opus 5.5 (same frozen plan) | Claude Sonnet 5.5 | Can the saving be had without leaving Claude? |
| E *(optional, decision 4)* | Opus 5.5 (same frozen plan) | GLM-5.3, hosted | Big open model, cheap plan. Tests the hosted middle ground. |
| G *(optional, decision 5)* | none | Codex (current default model) | Is Codex worth keeping, on the same tasks? |
| F *(phase 3 only)* | Opus 5.5 | Best of C1/C2, then Opus takes over after 2 failed test runs or 15 turns with no progress | The article's actual rule. Measures how often a takeover is needed and what it saves. |

The planner runs once per task, read-only (`claude -p` with editing tools disallowed). It writes a plan file: steps,
files to touch, how to test, done-when. Arms C1, C2, D, E and F all get the identical plan file. Arm D isolates the
effect of the coder from the effect of the plan.

Only one local model is loaded at a time. Local arms run back to back: all B runs, then C1, then C2.

### Tasks

- **30 tasks** for the full run, **10** for the pilot. Mix: one-third small (one file), one-third medium (2–5 files),
  one-third larger (crosses modules).
- **Mined from real history.** Pick recent commits in the chosen repos that added or changed tests alongside a fix or
  feature. For each, confirm the commit's tests **fail** on the parent commit and **pass** on the commit itself.
- **Task text** is written by an agent from the commit message and linked issue, then checked so it describes the
  outcome without giving away the solution. James can skim the list (about 10 minutes).
- **No leakage.** Each run starts from a fresh copy of the parent commit with git history removed (`git init` on a
  plain file export). Otherwise an agent could find the answer in `git log`. The commit's tests are kept back for
  scoring.

### Scoring (most to least trusted)

1. **Hidden tests pass:** the held-back tests from the real commit, run after the agent finishes. Pass or fail.
2. **No damage:** typecheck, lint and the existing tests near the touched files still pass.
3. **Two blind judges.** Claude Opus 5.5 and Codex each compare an arm's diff with arm A's diff for the same task.
   - Labels are removed and model-identifying text (co-author lines, comments) is stripped.
   - Each pair is judged in **both orders**. It only counts as a win if it wins both ways; otherwise it is a tie.
     Large language model judges favour whichever answer they see first, and Claude may favour Claude-style code.
   - Rubric: correct beyond the tests, fits the codebase's style, no unrequested changes, would you merge as-is
     (yes/no).
   - We report how often the judges agree with each other and with the hidden tests. Judges do not override tests.
4. **Your spot check (optional, ~20 minutes):** blind review of ~6 pairs where the judges disagreed.

**Also recorded per run:** wall-clock time, Claude tokens (planner + coder + takeover), local tokens, prompt-read and
write speeds, number of turns, tool-call errors, whether it hit the turn cap or looped, whether it gave up.

### Fairness controls

- Same limits for every arm: 60-minute wall clock (raised from 45 for the slower offloaded model, applied to all), same
  turn cap, no human help.
- Local arms run one at a time with nothing else on the GPUs. Cloud arms run up to 4 at once.
- Context of at least 64k for every local model. `CLAUDE_CODE_ATTRIBUTION_HEADER=0` is set for local arms, so the
  prompt cache is not thrown away every turn (a known Claude Code + llama.cpp issue). Both are checked by a smoke test.
- Same model files, server build and settings throughout. If anything updates mid-test, restart that arm.
- Pilot: 1 run per task per arm. Full: 3 runs per task for cloud arms, 2 for local arms (time budget), compared task
  by task.

### Honest limits

- 30 tasks can only show **large** differences, roughly 15–20 points. Small differences will look like noise, and the
  report will say so rather than pick a winner.
- The tasks come from your repos, so the result is about your work, not coding in general. That is the point.
- The open models change monthly. The result is a snapshot of October 2026.

### Decision rules (agreed before seeing results)

- **Speed gate (setup):** if Flash-Next cannot read a real 30k-token agent prompt at 300+ tokens a second and write at
  15+ tokens a second after tuning, drop C2. Every turn would take minutes, and nobody would use it day to day.
- **Pilot stop rule:** if the better of C1/C2 solves more than 25 points fewer tasks than arm A on the hidden tests,
  stop. The answer is "no, not for this work", and the full run is not worth the spend.
- **C1 vs C2:** if C2 does not beat C1 by a clear margin in the pilot, the bigger model is not worth its slowness.
  The full run keeps C1 only.
- After the full run:
  - **Best local arm within ~5 points of A, and Claude tokens down ≥ 60%:** worth building "plan with Claude, code
    locally" into Harness for small and medium tasks. Consider a cheaper Claude tier.
  - **D close to A but local arms well behind:** the saving is real but sits inside Claude (Sonnet as the coder). No
    local setup needed.
  - **E close to A but local arms well behind:** cheap hosted open models are the executor to use (OpenCode Go ✔ is
    $10–40 a month). Consider moving some Codex or OpenCode spend there.
  - **Every cheaper arm well behind A:** keep the subscriptions. Local models stay on the helper tasks they already do.
  - **G vs A** answers the Codex question on its own terms.

---

## Steps

### Phase 0: setup (about a day of agent work, plus decision 7 if James does it)

1. [x] On the Windows PC, via the worker: download Qwen3.8-27B (6-bit) and Qwen3.8-Flash-Next (Unsloth or AesSedai
   4-bit) into LM Studio's model folder.
   - Nothing on the PC changes beyond new model files until a test window starts.
   - **Status (15 Oct):** 27B downloaded — `Qwen3.8-27B-UD-Q6_K_XL.gguf` (25.30 GB, Unsloth UD Q6_K_XL ≈ the "~25 GB
     at 6-bit" in the table), verified complete and discovered by LM Studio as key `qwen3.8-27b`. Flash-Next
     downloading — `Qwen3.8-Flash-Next-UD-IQ4_XS` (Unsloth 4-bit, 93.68 GB in 3 split parts; the smaller of the
     plan's 94–111 GB 4-bit range, chosen so the speed-gate measurement lands sooner). Parts 1 done, part 2 was
     ~2.7/49.8 GB when the PC dropped offline; the curl download is resumable (`-C -`) and must be re-checked and
     re-started when the PC is back.
     Deferred live check: **A1** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.
   - **Status (16 Oct, round 4): DONE.** Flash-Next's three split parts are complete and byte-identical to Hugging
     Face (10,946,624 + 49,835,229,856 + 43,836,407,744 = 93,682,584,224 bytes; part 1 is the small metadata shard,
     its size matches HF exactly). Evidence in livetest check A1.
2. [ ] Choose the server for each model: LM Studio, or llama-server on Windows or WSL2.
   - For Flash-Next, compare Windows and WSL2 llama-server and tune `--n-cpu-moe`, `-b/-ub 4096` and the thread count.
   - Bind to the Tailscale address only, with an access key.
   - Confirm Claude Code's message format works directly or through a translator.
   - **Status (15 Oct):** LM Studio 0.4.25 chosen and confirmed for B/C1: it speaks Claude Code's Anthropic message
     format natively (`POST /v1/messages`, verified with text and tool_use responses on both the 35B and the 27B), so
     no translator is needed. Served model names are LM Studio's own keys (`qwen/qwen3.6-35b-a3b`, `qwen3.8-27b`).
     Still open: the Flash-Next server (LM Studio vs llama-server with `--n-cpu-moe`, incl. the Windows/WSL2 compare
     and the MTP draft option `lms load --speculative-draft-mtp`), and the Tailscale-only bind + access key (LM Studio
     currently answers on both LAN and Tailscale and ignores any `x-api-key`; no access-key setting confirmed yet —
     llama-server takes `--host`/`--api-key` natively). SSH to the PC (the runner's original model-control channel) is
     blocked; model load/unload is out of band via the AIO worker agent, with helper reload (decision 8) done manually
     at the end of local batches. WinRM port 5985 is open and is the candidate if per-run automation is wanted.
     Deferred live check: **A2** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.
3. [ ] **Speed gate:** for each local model, measure prompt-read and write speed on a real 30k-token Claude Code prompt
   from the Mac, and check the PCIe link width under load. Apply the speed gate.
   - **Status (16 Oct):** probe code done and run for the 27B clean (evidence
     `_scratch/plan-execute-ab/phase0/speed-gate-27b-clean.txt`): **1246 prompt / 157 write tok/s**
     (wall-clock derived on two cache-free 30k probes; LM Studio reports no server timings). An
     earlier 667 tok/s sample was contaminated — probing an unloaded model makes LM Studio
     auto-load it at 8192 context, which then fights the loaded model for the 5090. Still to do:
     the 35B measurement (its model), the Flash-Next measurement + the C2 keep/drop call, and the
     PCIe link width under load. Blocked on the PC being back (down again since ~02:40 on 16 Oct).
     Deferred live check: **A3** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md` (the `speed-gate` command now
     persists readings to `speed-gate.json`, which session reports retain).
   - **Status (16 Oct, round 4):** the 27B was re-measured into a fresh `speed-gate.json` at
     **894 prompt / 61.7 write tok/s** and the PCIe link under live load reads **gen 5 x8**
     (details and the mid-generation accept-blocking measurement in livetest check A3). The 35B
     and Flash-Next measurements remain (need their models loaded — blocked on the PC surviving).
4. [ ] Smoke test each local model: Claude Code on the Mac completes a 3-step tool task (read file, edit, run a test)
   without tool-call errors, and the prompt cache survives across turns (second turn's prompt time well below the
   first).
   - **Status (16 Oct):** 27B: PASS (read+edit+test completed in 60s with 0 tool errors through the
     translator; cache proven — 19.3x cold-to-warm speedup, `cache_read_input_tokens` 35k+ per
     request and 61k cached reads inside the agentic run). The 3-step task initially died on the
     first turn: Claude Code 2.1.x appends `role:"system"` messages mid-array and Qwen3.8's chat
     template rejects that shape — the bundled translator (`benchmarks/plan-execute-ab/
     local-anthropic-proxy.ts`) fixes it and is required for all local arms. Still to do: the same
     smoke for the 35B and Flash-Next (blocked on the PC).
     Deferred live check: **A4** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.
5. [ ] If decision 4 is yes: set up a separate Claude Code config folder holding only the hosted provider's key. Prove
   with a request log that no Anthropic token is sent to it.
   - **Status (15 Oct):** decision 4 was never approved — the recommendation to send repo code to Z.ai needs James's
     explicit call (which repos he is happy to share). Arm E is therefore out of the pilot; this step is on hold, not
     attempted. Local arms already use separate empty Claude config folders, so no Anthropic login token exists there
     to leak.
     Deferred live check: **B1** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md` (James's call on which repos may be
     shared).
6. [x] Build the runner in a new self-contained folder, `benchmarks/plan-execute-ab/` (TypeScript, no app-code
   changes). It handles task export, arm launch, model load/unload on the PC, time limits, hidden-test scoring,
   token and speed capture, the blind judge, and the report.
   - Do **not** reuse `benchmarks/orchestrator-benchmark/judge.ts` as-is. Without an OpenAI key, its "Codex" judge
     silently runs Claude, so both judges are Claude.
   - Do **not** reuse that runner's `git stash` fallback; this repo forbids stash.
   - Each run works in a throwaway copy under `/tmp` on the Mac. No branches or worktrees in this repo.
   - Results go to `_scratch/plan-execute-ab/` (already ignored by git).
   - The runner reloads Harness's helper models on the PC when local runs finish, or if it is stopped (decision 8).
   - **Status (15 Oct):** built (checkpointed from parked work `queue/2026-10-14-local-model-plan-ex-b0e04e`, then
     corrected in `queue/2026-10-14-local-model-plan-ex-ca2605`). Judges are strictly dual and never silently
     replaced (`judge-unavailable` is a real outcome); no stash anywhere; throwaway `/tmp` exports with one baseline
     commit; results under `_scratch/plan-execute-ab/`. Fixes over the parked round: the planner now reads the task's
     parent workspace (it used to run in the live repo — a solution-leak risk), local arms use the server's own model
     names, coders are not told which arm they are, workspaces link the host repo's `node_modules` (without it every
     score failed), the frozen plan file and node_modules links never appear in captured patches, judging never
     repeats a pair (per-run re-judging would have re-spent metered budget), and the speed probe derives wall-clock
     prompt/write speeds on two cache-free 30k prompts (LM Studio reports no server timings). Model load/unload is
     out of band (SSH blocked; see step 2) so decision 8's helper reload is done manually at the end of local batches.
     Round 2 (16 Oct): the runner persists `speed-gate` measurements to `speed-gate.json` and feeds them to
     session reports and the decision rules, records a per-run local speed probe on every local run, and
     enforces the plan's full-run run counts (3 per cloud arm, 2 per local arm; `--runs` overrides all).
7. [ ] Runner self-test: one known-easy task through every arm, with a deliberately broken patch to prove scoring
   catches failures.
   - **Status (16 Oct):** dry harness self-test passes 8/8 including the deliberately broken patch being caught by
     hidden tests (`npx tsx runner.ts self-test`, log kept). The live "one known-easy task through every arm" proof
     ran as the pilot's first task (AIO-01) through each arm before the remaining nine: **A ✓, D ✓, G ✓, C1 ✓ all
     solved AIO-01** through the full pipeline (export → coder → patch → hidden tests → damage → judge). B and C2
     still need their turn when the PC is back. Cost note: 68 runner unit tests cover export/scoring/judging/
     decision rules/speed gate/monitor/proxy/speed retention; `tsc --noEmit` on the folder is clean.
     Deferred live check: **A5/A7** (the B and C2 one-task proofs) in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.

### Phase 1: task bank (half a day + James's skim)

8. [x] Mine candidate commits (decision 3) and confirm the fail-on-parent / pass-on-commit rule for each.
   - **Status (15 Oct):** 10 tasks (AIO-01..06 in ai-orchestrator, 12ST-01..04 in 12steps — decision 3's second repo;
     no local Python/PHP repo has commit history pairing tests with fixes, recorded in `tasks/README.md` for James to
     redirect). All 10 re-verified today from scratch: each commit's own tests fail on the parent tree and pass on the
     commit (exit codes and logs in `_scratch/plan-execute-ab/mining/<TASK-ID>/`, summary in `verify-summary.txt`).
     Size mix 4 small / 4 medium / 2 large (history offered only two coherent >5-file commits).
9. [ ] Write task texts; leakage check; size mix; James skims the list.
   - **Status (15 Oct):** task texts written outcome-first and leakage-checked (no shas, no changed file names, no
     diff lines; the bank validator enforces the sha/message rules and `mine-tasks.ts`'s `leakageCheck` records the
     rest). **Open human step:** James skims the 10 prompts (~10 minutes) — a review gate, not a correctness
     requirement; the pilot does not block on it.
     Deferred live check: **B2** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.

### Phase 2: pilot (one overnight run)

10. [ ] 10 tasks × arms A, B, C1, C2, D (+ E, G if approved) × 1 run.
   - **Status (16 Oct, ~03:00):** cloud arms COMPLETE — A 3/10, D 3/10, G 3/10 (session
     `_scratch/plan-execute-ab/pilot-2026-10-15/`). C1 running: 2/2 valid so far (AIO-01 5 min,
     AIO-02 59 min — both solved hidden tests + damage). Arms for this pilot: A, B, C1, C2, D, G (G
     included: Codex jobs were named in the spend question James approved and the plan recommends
     including it; G draws on the ChatGPT plan, not metered credit). E excluded (decision 4 never
     approved — see step 5). **Blocked since ~02:40:** the Windows PC went down a second time
     tonight (first outage ~21:10–00:25 with a reboot; second outage ongoing). B and C2 are not
     started; C1 is paused mid-batch. One C1 run (AIO-03) was quarantined to
     `runs-quarantined.jsonl` (infrastructure: LM Studio's session restore reloaded helper models
     and evicted the loaded 27B, then auto-reloaded it at the 8192 default context) and must be
     re-run. Fairness note: all arms share the same 60-minute wall clock and 75-turn cap; cloud
     batches ran 3-at-a-time (the plan's "up to 4"), local batches one at a time.
      Deferred live checks: **A5 (B), A6 (C1 remainder incl. the AIO-03 re-run), A7 (C2 after the
      gate)** in `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`, which also records the
      judging-spend decision for James (≈ $76 spent of ~$40–80; remainder ≈ +$15–30).
    - **Status (16 Oct, round 4):** the worktree recreation at 17:00 deleted the session folder; it
      was rebuilt from CLI transcripts and validated against the round-3 report (see the round-4
      as-built note above and `pilot-2026-10-15/RECONSTRUCTED.md`). Three more C1 attempts were
      made against the surviving PC — two died to link degradation mid-run and are quarantined
      (their records and judge pairs preserved), one never reached the model (outage 4). C1 still
      needs AIO-03..12ST-04 (8 runs), then B (10) and C2 (10, gate permitting) — all blocked on
      the Windows PC staying up (four outages on 16 Oct).
   - **Status (24 Oct):** scored matrix stands at A 10/10, D 10/10, G 10/10, C1 **4/10**
     (AIO-01..04; AIO-03/04 re-banked under the fixed setup). The 26 remaining cells (C1's
     AIO-05, AIO-06, 12ST-01..04; B 10; C2 10) are queued per the resume checklist and
     blocked on the PC (outage #5 — Tailscale and all AIO nodes unreachable at the 24 Oct
     re-check); the runner defects those cells depend on are fixed (verifier rounds 1–2).
11. [ ] Pilot report: solved per arm, tokens and time, judge agreement, failure modes seen (looping,
    tool errors, ignoring the plan), and C1 vs C2. Apply the stop rule. Report to James in plain
    English.
   - **Status (16 Oct, ~03:00):** interim `report.md` regenerated from the session
     (`npx tsx runner.ts report --session pilot-2026-10-15`). Snapshot: the bank is HARD — A, D and
     G each solved 3/10 (AIO-01, AIO-02, 12ST-02 for all three; AIO-03–06 fell to every arm so
     far). C1 (27B + frozen Opus plan) is 2/2 on the tasks it has run. Judge agreement is low
     (18/46 pairs same verdict; 16 verdicts conflict with hidden tests — tests never overridden),
     which supports the plan's "judges do not override tests" rule. Failure modes: A hit the
     60-minute wall clock twice (AIO-04, AIO-06), G runs on codex are 1-turn by stream shape.
     The C1-vs-C2 comparison and the stop rule await C1's remaining runs and C2 (gate first).
     Final pilot report + plain-English summary after the local arms finish.
     Deferred live check: **A8** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md`.
   - **Status (24 Oct, verifier round 2):** the step-11 deliverable is written on the
     existing matrix — `benchmarks/plan-execute-ab/evidence/2026-10-24/pilot-decision.md`
     (plain English: solved per arm with 95% ranges, the paired A-vs-C1 reading on shared
     tasks, tokens/time, metered cost per solved task, judge agreement, failure modes, and
     the stop rule / C1-vs-C2 explicitly marked not evaluable on coverage). The regenerated
     `report.md` reflects the fixed token accounting (the four C1 records' reused-plan
     planner tokens restored from their `plans/*.usage.json`). The two rules and the final
     numbers still need the 26 pending cells (PC offline — re-verified) and James's
     judging-spend call; `report` renders both automatically once C1 and C2 are complete
     against A.

### Phase 3: full run (only if the pilot passes and James approves the spend)

12. [ ] 30 tasks, 3 runs for cloud arms and 2 for the kept local arms, plus arm F.
   - **Status (16 Oct):** the runner now enforces these counts in `--phase full` (cloud A/D/E/G
     get 3 runs per task; local B/C1/C2/F get 2). Deferred live check: **B3** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md` — gated on James approving the
     $300–600 full-run spend after the pilot report (his approval so far covers the pilot only).
13. [ ] Final report: per-arm results with uncertainty ranges, cost per solved task, the matching decision rule, and
   a recommendation on each subscription.
   - **Status (16 Oct, round 3):** the report tooling is done — `report` renders per-arm 95% uncertainty ranges
     (Wilson score over tasks; repeat runs of one task are one task of evidence), each arm's solved-rate gap vs A
     (Newcombe 95% ranges, with a plain "can be noise / bigger than noise" reading), metered cost per solved task
     (measured from the CLI's billed per-invocation totals: Anthropic-billed coders, shared Opus plans counted per
     task, $0 metered for local/Codex/hosted-plan coders) and the matching pre-agreed decision rules. The full-run
     numbers stay deferred with B3 (spend approval), and the "recommendation on each subscription" is the
     plain-English write-up step (step 14 / check A8).

### Finishing

14. [ ] Record the decision and as-built notes here; rename this file `_completed`. Commit only if James asks.
   - The queue coordinator does the `_completed` rename after the independent verifier passes; the worker records
     the decision and as-built notes here.
   - Deferred live check: **C1** in
     `2026-10-14-local-model-plan-execute-ab_plan_livetest.md` (decision recording after the
     pilot/full runs land).

---

## Cost and time

**Claude metered spend (estimate).** A medium task for Opus 5.5 is roughly 2–3 M cached re-reads, ~150k fresh
context and ~30k output. At $4 in / $20 out per million tokens (Anthropic ✔, 22 Sep 2026), with cached reads at about
a tenth of input price, that is ≈ $1.50–4 per run. Plans are ≈ $0.50–1 each, made once per task. Judging is ≈
$0.30–1 per pair per order.
- Pilot (10 tasks; arms A and D, plus 10 plans and judging): ≈ $40–80.
- Full run (30 tasks × 3 runs on A and D, plus F takeovers, plans and judging): ≈ $300–600.
- Codex runs and judging draw on the ChatGPT plan's limits instead.
- The hosted GLM arm costs a few dollars on pay-as-you-go, or one month of a $10–40 plan.
- Electricity for the PC overnight is small next to these figures.

**Time.** Local runs are the bottleneck, one at a time.
- Rough per-run times: B and C1 ~5–20 minutes; C2 ~15–60 minutes.
- Pilot: 30 local runs, about one night.
- Full run: about 120 local runs plus arm F, about 2–3 nights, mostly unattended.
- Cloud arms finish alongside.

**Not needed:** no browser work. The Mac runs no local model.

> Plan Queue parked work: `queue/2026-10-14-local-model-plan-ex-b0e04e` — 2 commit(s), reason: verifier-unreliable.

> Plan Queue parked work: `queue/2026-10-14-local-model-plan-ex-ca2605` — 3 commit(s), reason: round-limit.

> Plan Queue parked work: `queue/2026-10-14-local-model-plan-ex-01472a` — 1 commit(s), reason: verifier-unreliable.
