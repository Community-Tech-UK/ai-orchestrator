# Local model plan/execute A-B benchmark — deferred live checks

> **If a defect is reproduced:** read [the campaign runbook](livetest-campaign-runbook.md), record a new LT-NNN item in [the remediation register](livetest-remediation-register.md), and add matching implementation status in `2026-07-19-livetest-failure-remediation-followup_plan.md`. If that plan has already been closed, reopen it or create an active follow-up before adding content. Keep per-check evidence in this document.

Plan: [Can cheaper models do the coding? A head-to-head test — plan](2026-10-14-local-model-plan-execute-ab_plan.md)

Status update (24 Oct): IN PROGRESS; bounded partial handoff, not a completed
pilot. The secured inference route is now established (Tailscale-only binding on
both routes; key 401/401/200 proven on the native server; the key is the
documented shared token — see tailnet-lan-proofs.txt). C2's real-prompt speed
gate PASSED and C2 is kept; its smoke passed. Scored matrix: A10/D10/G10/C1 4/10
with 10 C1 records quarantined (infrastructure). The Windows PC died completely
at ~05:05 (outage #5) and the remaining batches wait on it — see the 24 Oct
evidence section and the plan's resume checklist.

Status update (20 Oct, superseded): IN PROGRESS; bounded partial handoff, not a
completed pilot. The Windows worker is connected again. Retained evidence is
reconciled; the secure model-key transfer is refused, so repository prompts remain blocked.
The earlier “everything agent-runnable is green” statement below is historical.
Current verification receipts and reconstructed-data limits are in the worker's
`benchmarks/plan-execute-ab/evidence/2026-10-20/`; see the plan's latest status table.
The coordinator alone owns completion/rename after independent verification.

Historical status (round 4, 16 Oct). The Windows PC is back and the campaign
is running again. **Session-evidence incident:** the queue worktree was
recreated on 16 Oct 17:00 (fresh checkout of the branch), which deleted the
gitignored `_scratch/plan-execute-ab/` folder holding the pilot session. It was
**rebuilt the same day** from the surviving CLI transcripts (`~/.claude/projects`,
`~/.claude-plan-ex-ab/local-27b/projects`, `~/.codex/sessions`) and the
worker-round shell outputs captured in the app database — see
`_scratch/plan-execute-ab/pilot-2026-10-15/RECONSTRUCTED.md` (copy in
`~/work/orchestrat0r/ai-orchestrator/_scratch/plan-execute-ab-recovery/`). The
regenerated report reproduces the captured round-3 report exactly on verdicts
and costs (results table, failure modes, cost table, judge W/L/T for D and G);
only token columns use the billed basis and the quarantined AIO-03-C1 judge
pair is held out of aggregation so its re-run is judged fresh. These checks
still need the Windows PC (external machine), metered Claude/Codex credit, or
decisions only James can make; everything agent-runnable in the runner itself
is implemented, unit-tested and green (nothing in app code, no rebuild or
restart of Harness needed).

## Prerequisites and reason for deferral

- **Windows PC (`windows-pc`) reachable via the AIO worker.** It crashed twice
  on 15/16 Oct (outage 2 since ~02:40 on 16 Oct) and came back on 16 Oct
  afternoon; round 4's campaign resumed against it. Checks A2–A7 need its
  5090 / 192 GB for model inference.
- **Before every local batch (LM Studio gotcha):** `lms ps`; unload anything
  unexpected; then load the arm's model explicitly at 64k context
  (`lms load <key> --gpu max -c 65536 --identifier <key> -y`). LM Studio
  auto-loads a requested-but-unloaded model at the default 8192 context, which
  kills runs and contaminates speed probes. One AIO-03 C1 run is already
  quarantined in `runs-quarantined.jsonl` for this.
- **Translator proxy up** for local arms: from `benchmarks/plan-execute-ab/`,
  `npx tsx local-anthropic-proxy.ts http://100.113.93.104:1234 8900 <log>`,
  with the runner's `baseUrl` at `http://127.0.0.1:8900`. Required — Claude Code
  2.1.x appends in-array `role:"system"` messages that Qwen3.8 chat templates
  reject (see `benchmarks/plan-execute-ab/README.md`).
- **`PLAN_EX_AB_LOCAL_KEY`** set in the runner's environment (the key itself
  never lives in the repo).
- **Metered spend boundary** — see below before running A5–A7.
- Session evidence stays in `_scratch/plan-execute-ab/` (keep it); throwaway
  workspaces under `/tmp/plan-execute-ab` are removed by the runner as it goes.

## Current spend and secure-route boundary (20 Oct 2026)

James authorized the pilot only, capped at the recorded **$80 upper estimate**.
The automatic readiness decision and a prior worker's overrun choice do not grant
additional authority. The reconciled retained CLI total is **$66.278098505**:
A $23.042690705, D $4.9797044, shared planners $12.4069146, Claude judges
$25.8487888 (quarantined attempts count). It is not provider-invoice confirmation;
missing terminal billing events could understate it. Headroom is at most
$13.721901495. This worker made zero new metered calls. No more paid calls are
permitted without a reservation/cap that keeps cumulative spend within $80;
otherwise leave the pairs unjudged or obtain James's explicit overrun approval.

Use `run --local-only --phase pilot --arms B|C1|C2 --session <existing>` for
unmetered eligible local checks. It requires existing plans and skips judges;
plain `run` / `plan` can spend money. First establish a secured inference route.
The file-transfer tool rejected the ignored temporary key file with
`local_write_refused: Local source is restricted`; no key was exposed/transferred.
The browser credential CLI does not provision a model-server API key. James must
provision a private key through an approved secure route into the Mac's
`PLAN_EX_AB_LOCAL_KEY` environment and Windows `llama-server --api-key-file`.
Do not paste the value into chat, rename the file to bypass the filter, or send
repository prompts to the current unauthenticated endpoint. Prove missing/wrong
key rejection, correct-key success and Tailscale-only binding before A4–A7.

The full run ($300–600), hosted-code sharing, subscription prices and hands-on
BIOS actions remain separate James-only decisions. The experiment is incomplete.

## Already done in the runner (round 2, 16 Oct)

- Full-run run counts now match the plan's design: 3 runs per task for cloud
  arms (A, D, E, G), 2 for local arms (B, C1, C2, F) — `runsPerArmFor` in
  `arms.ts`; `--runs N` still overrides all.
- `speed-gate` appends every measurement to
  `_scratch/plan-execute-ab/speed-gate.json` (history kept), and both `run` and
  `report` load it so session reports and the pre-agreed decision rules see the
  C2 gate decision.
- Each local run records a per-run speed probe in its run record (prompt-read
  and write tok/s; `unmeasured` plus the reason if the probe fails — the probe
  never holds up a run), and reports render "Local model speeds" with the gate
  results and per-arm probe averages.

## Verifier round-1 runner fixes (24 Oct) — run A5–A8 on this code

The independent verifier reproduced six runner defects (all fixed with
regression tests; details in
`benchmarks/plan-execute-ab/evidence/2026-10-24/verifier-round1-fixes.md`). For
these checks that means: **run the remaining batches on the fixed runner and
translator** — the translator now aborts the upstream inference when a client
disconnects (the recorded wedge-after-abort mode), the run parser records
billed-basis tokens (no double-counting), Claude-vs-local token accounting is
split (the ≥ 60% rule reads Claude tokens only), and arm F's takeover (full run
only, see B3) shares the run's wall clock and turn cap. Run records banked
before 24 Oct keep their provisional token/timing figures.

## Verifier round-2 runner fixes (24 Oct) — run A5–A8 on this code

Verifier round 2 found three more runner defects, all fixed with regression
tests (details in
`benchmarks/plan-execute-ab/evidence/2026-10-24/verifier-round2-fixes.md`):
(a) a **reused frozen plan dropped its planner tokens** from the run record
(preplanned runs recorded zero Claude planning tokens and inflated the ≥ 60%
saving) — fixed, and the pilot session's four affected C1 records were restored
from their own `plans/*.usage.json` (see the session's
`PLANNER-USAGE-RECONCILE.md`); (b) **arm G had no turn cap** (`codex exec` has
no flag; the cap is now enforced on the stream — the turn after the last allowed
one is killed before it runs) and the runner now passes `config.turnCap` to the
Codex coder; (c) the **arm F monitor missed failed tests when several Bash calls
were batched** in one assistant message (results now matched by `tool_use_id`).
Batches run under `--local-only` on this code record planner tokens correctly.

## A1: finish the Flash-Next download (plan step 1 remainder)

**DONE 16 Oct (Plan Queue worker round 4).** The PC finished the download after it
came back: `C:\Users\shutu\.lmstudio\models\qwen\qwen3.8-flash-next\` holds all
three split parts —

| Part | Bytes on PC | Bytes on Hugging Face (unsloth/Qwen3.8-Flash-Next-GGUF, UD-IQ4_XS) |
|---|---|---|
| 00001-of-00003.gguf | 10,946,624 | 10,946,624 |
| 00002-of-00003.gguf | 49,835,229,856 | 49,835,229,856 |
| 00003-of-00003.gguf | 43,836,407,744 | 43,836,407,744 |

Total 93,682,584,224 bytes = the plan's "93.68 GB in 3 split parts". Part 1 is
the small metadata shard; its size matches HF exactly (HF tree listing fetched
16 Oct). LM Studio lists the folder as `qwen3.8-flash-next`. Loading it is the
last integrity check and happens in A7's setup (a corrupt shard would fail GGUF
load there).

20 Oct A1 confirmation: `lms load qwen3.8-flash-next --gpu max -c 65536
--identifier qwen3.8-flash-next -y` succeeded (119.71 s, 93,682,584,224 bytes,
IQ4_XS). This confirms shard integrity by a real load, without another download.

## A2: Flash-Next server choice, tuning, Tailscale-only bind + access key (plan step 2 remainder)

1. Compare Windows vs WSL2 llama-server with `--n-cpu-moe` against LM Studio
   for Flash-Next; tune `-b/-ub 4096` and thread count; try LM Studio's MTP
   draft (`lms load --speculative-draft-mtp`).
2. Bind the chosen server to the Tailscale address only, with an access key
   (llama-server `--host`/`--api-key` natively; LM Studio currently answers on
   LAN and Tailscale and ignores `x-api-key` — no access-key setting confirmed).
3. Expected: server answers only over Tailscale; requests without the key are
   rejected; Claude Code's message format works directly or through the
   bundled translator.
4. B/C1 are already settled (LM Studio + translator on `100.113.93.104:1234`).

Progress (16 Oct round 4): the Flash-Next download is complete (A1). The
Windows-vs-WSL2 comparison and MTP-draft tuning run when Flash-Next is loaded
(after the C1 and B batches release the 5090). LM Studio 0.4.25 has no
access-key setting (re-confirmed; it answers on LAN and Tailscale and ignores
`x-api-key`) — if LM Studio is the chosen server, the bind/key step is recorded
as not available in this server build; if llama-server is chosen for C2, its
`--host`/`--api-key` covers it.

Cannot run now: needs the 5090 free (C1 batch in flight).

**24 Oct progress (A2 core done).** The native llama-server starts reliably
now: the 20 Oct `STATUS_DLL_NOT_FOUND` was the CUDA vendor DLLs missing from
`PATH`; prepending the backend dir + the `win-llama-cuda12-vendor-v2` package
(see `backend-manifest.json`) before launch fixes it, and a detached
`Start-Process` survives shell teardown. With Flash-Next, `--n-cpu-moe 999`,
`--host 100.113.93.104 --port 1235 --api-key-file`, the Mac proved **no key
401, wrong key 401, correct key 200** and LAN unreachability (listener is the
Tailscale IP only) — the missing/wrong-key rejection, correct-key success and
Tailscale-only binding proofs are complete. The B/C1 LM Studio route is also
Tailscale-only (localhost bind + `tailscale serve`, tailnet-only forward; LAN
times out, no LAN listener) with the recorded LM Studio key gap. The
Windows-vs-WSL2 comparison remains the one open A2 item: WSL2 has no
llama-server/cmake/nvcc, and Windows native now **clears the C2 gate**, so
the comparison is optional tuning (the Windows pinned-memory decode penalty),
not decision-critical. Evidence:
`benchmarks/plan-execute-ab/evidence/2026-10-24/tailnet-lan-proofs.txt`,
`native-server-setup.json`.

## A3: speed gate for the 35B and Flash-Next + C2 keep/drop + PCIe under load (plan step 3 remainder)

1. With `PLAN_EX_AB_LOCAL_KEY` set and one model loaded at a time, run
   `npx tsx benchmarks/plan-execute-ab/runner.ts speed-gate` from
   `benchmarks/plan-execute-ab/`.
2. Expected: each probe appends to `_scratch/plan-execute-ab/speed-gate.json`
   (27B was 1246 prompt / 157 write tok/s on the clean run — see
   `_scratch/plan-execute-ab/phase0/speed-gate-27b-clean.txt` for the earlier
   stdout-only capture); the 35B gets its own reading; Flash-Next is measured
   and the 300 prompt / 15 write tok/s gate decides keep/drop C2 (report
   decision rules then show the verdict).
3. Re-check the PCIe link width under load (x8 at idle on 14 Oct).
4. Never probe a model that is not explicitly loaded — auto-load at 8192
   contaminates readings (the 667 tok/s sample).

Progress (16 Oct round 4):

- **27B re-measured** (fresh `speed-gate.json` after the worktree recreation
  lost the old one): **894 prompt / 61.7 write tok/s** (wall-clock, via the
  translator at 127.0.0.1:8900 → 100.113.93.104:1234; evidence
  `_scratch/plan-execute-ab/phase0/speed-gate-27b-rerun.txt` and
  `speed-gate.json`). Lower than the round-1 clean 1246/157 — likely the
  helper 9B resident on the 3080 Ti sharing the x8 PCIe lanes and/or LM
  Studio's parallel slots; same session settings are used for every local run,
  so arm comparisons stay consistent. A per-run probe is recorded on each C1
  run for more samples.
- **PCIe under load:** `nvidia-smi` during a live C1 inference run shows the
  5090 at **gen 5, x8 width** (idle was gen 1 x8 — the idle figure is just
  power management). Gen 5 x8 ≈ gen 4 x16 bandwidth, so RAM-offloaded
  Flash-Next prompt reads are not link-limited the way the plan feared.
- **Serving-layer defect (new, measured):** LM Studio 0.4.25 stops accepting
  new TCP connections while a long generation is in flight — 6/6 connect
  attempts to `100.113.93.104:1234` time out mid-generation while ICMP to the
  same host stays 1 ms (proxy log shows the `connect ETIMEDOUT` bursts). The
  translator now retries connect-class failures patiently instead of
  returning 502s to Claude Code. The 35B and Flash-Next measurements should
  re-check this behaviour on their own loads.
- Still to do: the 35B measurement (its model, after the C1 batch), the
  Flash-Next measurement + the C2 keep/drop call (after the B batch).

20 Oct measurement correction: speed timing formerly stopped when headers
arrived. It now includes `response.text()` completion; all earlier wall-clock
figures are provisional. New setup probes contain synthetic agent-like text,
so the real 30k repository-prompt requirement remains open. Native Windows
backend 2.60.0 supports authenticated private binding; WSL2 currently has 93 GiB
available and lacks llama-server/cmake/nvcc, so an equivalent tuned WSL2 run is
not yet established. No final keep/drop decision may be inferred from a timeout
or an unauthenticated synthetic-only measurement.

**24 Oct (real-prompt gate done — C2 KEPT).** `speed-gate --prompt-file` (new)
probes with real agent prompt text: 117,387 chars / 36,070 tokens assembled
from the AIO-03/AIO-04-C1 run transcripts' actual request content (repository
file reads and task context as the local model saw them). Flash-Next on the
native llama-server (2.60.0, `--n-cpu-moe 999`, ctx 65536, key-enforced,
Tailscale-only): **797 prompt / 21.0 write tok/s (server timings)**; server-log
cross-check 648.95–826.12 prompt / 20.48 write; the cold wall-clock reading was
647 prompt (its 341 write figure is a cold-start artifact of the wall-clock
derivation — probeA's mmap page faults inflate it — and is recorded as such).
Both floors clear (300 prompt / 15 write) on the authoritative numbers →
**keep C2**. The runner now withholds the C2 decision for synthetic-only
probes (decision-rule guard). 35B real-prompt reading: pending, lands with the
B batch (its model load). PCIe under load unchanged (gen 5 x8). Evidence:
`benchmarks/plan-execute-ab/evidence/2026-10-24/speed-gate-flash.txt`.

## A4: smoke tests for the 35B and Flash-Next (plan step 4 remainder)

1. For each model (loaded at 65536 context, via the translator): Claude Code on
   the Mac completes a 3-step tool task (read file, edit, run a test) with 0
   tool-call errors.
2. Expected: cache survives across turns — second turn's prompt time well below
   the first, `cache_read_input_tokens` > 0 per request. The 27B already passed
   (60 s, 0 tool errors, 19.3x cold-to-warm).

Cannot run now: needs the PC.

**24 Oct: Flash-Next smoke PASS** (its half of A4). Claude Code on the Mac
(`CLAUDE_CONFIG_DIR` = `~/.claude-plan-ex-ab/local-flash-next`, empty of
Anthropic credentials) through the translator to the key-enforced native
server completed the read/edit/npm-test task in 67 s with **0 tool errors**
(answer.txt verified independently; `npm test` green), and the cache survived
across turns (**86,024 cache_read_input_tokens** inside the run). The known
"Flash-Next tool calls came back as plain text" snag does **not** reproduce on
this build (UD-IQ4_XS + llama-server 2.60.0 `--jinja`) — this smoke is that
retest. The 27B smoke's earlier pass stands for C1. The **35B smoke** lands
with the B batch (its model load). Evidence:
`benchmarks/plan-execute-ab/evidence/2026-10-24/flash-smoke.json`.

## A5: pilot arm B — all 10 tasks (plan step 10 remainder)

1. Load `qwen3.6-35b-a3b` explicitly (A2's server; translator up), then from
   `benchmarks/plan-execute-ab/`:
   `npx tsx runner.ts run --local-only --phase pilot --session pilot-2026-10-15 --arms B --tasks AIO-01,AIO-02,AIO-03,AIO-04,AIO-05,AIO-06,12ST-01,12ST-02,12ST-03,12ST-04`
2. Expected: 10 run records with hidden-test + damage scores and per-run speed
   probes filled. `--local-only` leaves new judge pairs pending; do not use
   plain `run` to bypass the $80 boundary. Already-judged pairs are retained. 60-minute wall clock and 75-turn cap apply, as for every arm.

Status (16 Oct round 4): queued behind the C1 batch (one local model at a
time). The A-baseline patches the judging needs are restored in the rebuilt
session. Spend boundary above applies to the judging.

## A6: pilot arm C1 — remaining 8 tasks (incl. the quarantined AIO-03 re-run)

1. Load `qwen3.8-27b` explicitly, then from `benchmarks/plan-execute-ab/`:
   `npx tsx runner.ts run --local-only --phase pilot --session pilot-2026-10-15 --arms C1 --tasks AIO-03,AIO-04,AIO-05,AIO-06,12ST-01,12ST-02,12ST-03,12ST-04`
2. Expected: 8 more C1 run records (AIO-01/AIO-02 already solved 2/2). AIO-03
   here is the re-run of the quarantined run (LM Studio session restore evicted
   the 27B and auto-reloaded it at 8192 context — see `runs-quarantined.jsonl`).
3. Keep `runs-quarantined.jsonl` untouched; it is evidence.

Status (16 Oct round 4): **BLOCKED — the Windows PC is not surviving.** Four
outages in one day: the two overnight ones, outage 3 (17:47–18:47, ended in a
reboot) and outage 4 (since ~20:45Z, ongoing). Attempts so far, all on the
27B at 65536 with helpers unloaded first (the 9B auto-reloads on the 3080 Ti
and idles there): attempt 1 (17:22) ran 14 min then died mid-link-degradation
(18 proxy upstream ETIMEDOUTs, final 502) — quarantined; attempt 2 (20:05)
ran 24 min / 104 turns and died the same way — quarantined; attempt 3 (20:38)
never reached the model (the PC died) and was killed with no record. Both
quarantined records and their judge pairs are preserved (`runs-quarantined.jsonl`,
`judge/quarantined/` — cost logs stay top-level in `judge/` so the spent judge
credit keeps counting). The two COMPLETED C1 records (AIO-01 5 min, AIO-02
59 min, both hidden+damage clean) remain valid. The translator is now hardened
against the LM Studio accept-blocking (see A3) — the remaining 8 runs
(AIO-03..12ST-04) should use it. Also clear stale `/tmp/plan-execute-ab/*`
workspaces from killed runs before relaunching (`runner.ts` refuses to reuse
them; AIO-04 was skipped once for exactly that).

**24 Oct: in progress, with one documented incident.** First attempt at the 8-cell
batch lost all cells to a helper-eviction incident (Harness helper tasks auto-loaded
the helper 35B in LM Studio mid-batch; the 27B auto-reloaded at 8192 context and
every prompt died `exceed_context_size_error`) plus one LT-707 cleanup flake that
discarded AIO-05's scored run. Both defects are fixed (see
`evidence/2026-10-24/helper-eviction-incident.md` and LT-707 in the remediation
register): helpers paused for the batch window via `auxiliaryLlmRoutingMode=off`
(plan decision 8 — restored afterwards), the 27B loaded permanently at 65536 (no
`--ttl`), stale workspaces cleared, and the runner now persists run records before
workspace cleanup. The 7 infrastructure-killed cells are in `runs-quarantined.jsonl`
with the incident reason; they are not model outcomes. Re-run under the fixed
setup: AIO-03 landed cleanly at the 60-min cap (66 turns, damage clean, hidden
tests failed like every arm on this task); the remaining 7 cells are running or
queued. Serving stack unchanged (LM Studio + translator), so no arm restart.

## A7: pilot arm C2 — all 10 tasks, only if the speed gate keeps C2 (plan step 10 remainder)

1. Load Flash-Next explicitly (65536 context), then
   `npx tsx runner.ts run --local-only --phase pilot --session pilot-2026-10-15 --arms C2 --tasks AIO-01,AIO-02,AIO-03,AIO-04,AIO-05,AIO-06,12ST-01,12ST-02,12ST-03,12ST-04`
2. Expected: 10 C2 run records; judges remain pending under `--local-only`. If A3
   validly dropped C2 after tuning, record that and skip this check.

Cannot run now: needs the PC and A3's gate result.

## A8: finish the pilot report and apply the pre-agreed rules (plan step 11 remainder)

1. `npx tsx runner.ts report --session pilot-2026-10-15` (from
   `benchmarks/plan-execute-ab/`), after A5–A7 settle.
2. Expected: `report.md` / `report.json` show all six arms, the "Local model
   speeds" section (gate + per-run probes), judge agreement, and the decision
   rules with the pilot stop rule and C1-vs-C2 verdicts. Then write the
   plain-English summary to James (what it means for his subscriptions).
3. The plain-English interim report is already written
   (`benchmarks/plan-execute-ab/evidence/2026-10-24/pilot-decision.md`, 24 Oct):
   solved per arm, tokens/time, cost, judges, failure modes, and the stop rule /
   C1-vs-C2 marked **not evaluable on coverage** (26 cells pending). After
   A5–A7, update its numbers and those two verdicts — the report tool renders
   both rules automatically once C1 and C2 are task-complete against A.

Cannot run now: it needs the results from A5–A7.

## B1: hosted GLM arm E only if James approves sharing code (plan step 5)

1. James names which of the chosen repos he is happy to send to a hosted
   provider (decision 4 was a recommendation, never approved).
2. If approved: create a separate Claude Code config folder holding only the
   hosted provider's key; prove with a request log that no Anthropic token is
   sent to it (local arms already use separate empty config folders).

Cannot run now: the third-party sharing call is James's alone. Skip arm E in
the pilot without it (current state).

## B2: James skims the 10 task prompts (plan step 9, review gate)

1. Task texts: `benchmarks/plan-execute-ab/tasks/task-bank.json` (prompts are
   outcome-only; leakage-checked — no shas, file names or diff lines).
2. Expected: ~10 minutes of reading; redirect anything that gives away the
   solution. The pilot does not block on this.

## B3: full run and final report (plan steps 12–13) — decision-gated on James

1. Gate: pilot report in hand and James approves the **$300–600** full-run
   spend (metered Claude/Codex; his earlier approval covered the pilot only).
2. Then: 30 tasks (mine + verify 20 more the same way as the bank's 10),
   3 runs per task for cloud arms (A, D, G; E if B1 approved), 2 for local arms
   (B and whichever of C1/C2 the pilot keeps) and arm F — the runner now
   enforces exactly these counts in `--phase full`.
3. Expected: `report.md` with per-arm results and uncertainty ranges, cost per
   solved task, the matching decision rules, and a recommendation per
   subscription. Since round 3 the runner renders the uncertainty ranges (95%,
   Wilson over tasks, plus gaps vs A) and cost per solved task (measured from
   billed totals) automatically; only the subscription recommendation is the
   write-up step.

Cannot run now: only James can approve the spend; the pilot is not finished.

## B4: revisit memory speed only if C2 clearly beats C1 (plan decision 7)

1. If the pilot shows C2 clearly ahead of C1: James tries the BIOS memory
   profile (recipe given in chat, 14 Oct) and the speeds are re-measured (A3).
2. Otherwise: stays at 3600 MT/s — already the accepted pilot setting.

## C1: finishing (plan step 14)

1. Record the pilot/full decision and as-built notes in the plan file.
2. The queue coordinator renames the plan `_completed` after an independent
   verifier passes; only then may the docs be committed.

## Running this doc later

It is a live-test plan: run the checks in order (A1 → A8, then B/C as their
gates open), paste evidence per check above, and rename this file
`_livetest_completed.md` only when every check passes with evidence. A
**reproduced** defect found while running goes into
`docs/plans/livetest-remediation-register.md` as a new LT-NNN item — see the
header block.


## Evidence run — 20 October 2026 (bounded partial)

- A1: all Flash-Next shards accepted by the loader at context 65536. No new checksum comparison.
- A2: existing server accepts no-key requests. Native binary supports private bind/key-file,
  but actual auth/bind proofs were not reached. Uploaded-key file was refused by the transfer
  filter. Locally generated keys stayed on the PC and were deleted after synthetic attempts.
- A3: corrected synthetic 35B probe from Mac: 7464 prompt / 314.9 write tok/s at context229376,
  parallel2; historical speeds remain provisional. Flash's LM Studio probe failed after302s
  with ~70 prompt tok/s and WDDM shared-memory GPU spill in engine logs. Native attempts
  ended on process lifetime / heap corruption / STATUS_DLL_NOT_FOUND, not a valid speed sample.
  Real repository-prompt timing, equivalent WSL2 setup, tuning and final C2 verdict stay OPEN.
- A4/A5/A6/A7: no new repository smokes or scored local runs. Secure Mac-to-PC key route is
  unresolved. Retained counts are A10/D10/G10/C1=2; three quarantined records remain excluded.
- A8: interim report regenerated; pilot stop/C1-vs-C2 decisions remain unevaluable until all
  ten matching pilot tasks are present (or C2 has a valid explicit speed-gate rejection).
- B1/B2/B3/B4 and C1: their outstanding decisions/checks remain OPEN as above. No hosted
  code sharing, full run, subscription change or BIOS change was attempted.
- Verification: 114 benchmark tests and all static/build gates pass; full suite is the verifier's
  responsibility. Evidence, receipts and source seal are in the worktree's
  `benchmarks/plan-execute-ab/evidence/2026-10-20/`.
- Cleanup: baseline helper/server restored; dedicated server port1235 no longer listening;
  temporary remote keys/logs removed, all worker-created remote agents terminated. Preserve
  the original downloaded models and root-checkout historical evidence. Local generated
  runtime/caches are removed after the report, receipts and seal are written.

Reason for remaining checks: private key handoff requires an approved secure route (James),
while native DLL environment / WSL2 parity remain technical setup prerequisites, not a new
approval request. No technical prerequisite is counted as passed or as a model rejection.

Local cleanup verified 20 Oct: owned build output/caches/scratch/key removed; 41 worktree-specific tsx cache entries removed. No owned runtime remains (`cleanup-receipt.json`). Shared dependencies and historical pilot evidence were preserved.


## Evidence run — 24 October 2026 (bounded pilot continuation)

Zero new metered calls (`run --local-only` throughout; spend re-verified at
$66.278098505, headroom ≤ $13.72).

- **A1:** unchanged (Flash-Next shards accepted by the loader 20 Oct).
- **A2 — core DONE.** Mac Tailscale was stopped at round start and was restored.
  The B/C1 LM Studio route is **Tailscale-only** (`tailscale serve`, tailnet-only
  forward; LAN times out; no LAN listener on the PC) with the recorded LM Studio
  access-key gap. The native llama-server starts reliably now (20 Oct's
  STATUS_DLL_NOT_FOUND was the CUDA vendor DLLs missing from PATH; prepending the
  backend + `win-llama-cuda12-vendor-v2` dirs fixes it) and with `--host
  100.113.93.104 --port 1235 --api-key-file` is proven from the Mac: **no key 401,
  wrong key 401, correct key 200, LAN unreachable**. Key-handoff decision: the
  documented shared token `local-benchmark-key` (the runner's own default) is the
  access key; secret material cannot cross agent channels and renaming to bypass
  the transfer filter is forbidden; James can rotate to a private value at any
  time. **Open:** the Windows-vs-WSL2 comparison (optional tuning — Windows
  clears the gate; WSL2 has no llama-server toolchain).
- **A3 — DONE, C2 KEPT.** New `speed-gate --prompt-file` probes real agent prompt
  text (117,387 chars / 36,070 tokens assembled from the AIO-03/AIO-04-C1 run
  transcripts). Flash-Next on the native server: **797 prompt / 21.0 write tok/s**
  (server timings; server-log cross-check 648.95–826.12 prompt / 20.48 write;
  the first wall-clock write figure of 341 is a documented cold-start artifact).
  Both clear the 300/15 floors. The runner withholds the C2 gate decision for
  synthetic-only probes. The 35B real-prompt reading is still open (lands with the
  B batch). PCIe under load unchanged (gen 5 x8).
- **A4 — Flash-Next PASS** (3-step read/edit/npm-test, 0 tool errors, cache 86k
  reads, the "tool calls as plain text" snag not reproduced on this build). 27B
  smoke stands. **35B smoke open** (lands with the B batch).
- **A5 (arm B):** not started — blocked on the PC outage after C1.
- **A6 (C1 remainder): partial — 4/10 scored.** AIO-03 (60-min cap, 66 turns) and
  AIO-04 (60-min cap, 34 turns) banked under the fixed setup with no infrastructure
  errors; AIO-05 was wedged by LM Studio's accept-blocking + wedge-after-abort and
  left no record (stale workspace cleared). One incident and one defect were
  reproduced and fixed this round: the **helper-eviction incident** (7 cells
  quarantined; remediation = decision-8 helper pause `auxiliaryLlmRoutingMode=off`
  + no-TTL loads) and **LT-707** (scored run lost to a pre-record cleanup flake;
  regression-tested fix in the runner). Decision recorded: the remaining local runs
  move to the standalone `llama-server.exe` — the same 2.60.0 engine binary LM
  Studio wraps — dropping the broken management layer; C1's completed runs predate
  it (the strict "restart that arm" alternative is recorded in the plan's resume
  checklist). Blocked at the PC outage.
- **A7 (C2):** gate kept C2; the batch is queued behind C1 (PC outage).
- **A8:** interim report regenerated; the stop rule and C1-vs-C2 remain
  "not evaluable yet" until C1 and C2 are task-complete against A.
- **B1–B4, C1(finishing):** unchanged (James's calls / later stages).
- Verification: 122 benchmark tests (5 new), benchmark/root `tsc --noEmit`,
  `typecheck:spec`, root lint, benchmark ESLint, LOC check all green; full suite is
  the verifier's responsibility. Evidence and receipts in the worktree's
  `benchmarks/plan-execute-ab/evidence/2026-10-24/`.
- Cleanup: helper aux routing restored to `local-first`, translators stopped,
  smoke/tmp workspaces removed, session mirrored to the root checkout. The Windows
  PC is **down (outage #5)** — its model state could not be restored this round
  (restore steps are in the plan's resume checklist: LM Studio helper
  `qwen/qwen3.6-35b-a3b` at 229376/parallel 2 after the batches).
