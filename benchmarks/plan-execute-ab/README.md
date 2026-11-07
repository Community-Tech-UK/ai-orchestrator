# plan/execute A-B benchmark

Runner for the experiment in
`docs/plans/2026-10-14-local-model-plan-execute-ab_plan.md`: can cheaper models
execute plans that Claude writes? Nothing here touches app code; it is a
self-contained benchmark folder.

## Historical scoring dependencies and contract versions

The runner and public `verify-task` path install each export with its own frozen
lockfile before coding or scoring: `npm ci --ignore-scripts --no-audit --no-fund` or
`pnpm install --frozen-lockfile --ignore-scripts`. It never links the current
repository's dependencies into a historical coding workspace. Setup failure
stops that cell before coding/scoring and does not become a model failure.
Dependency manifests, lockfile hashes, Node version, command and install exit are
retained under the session's `scoring/<task>-<arm>-run<n>/` directory with full
scoring command results. Scoring refuses missing or stale install receipts.
The runner also retains the pre-coder receipt in memory, so deleting the local
receipt and every manifest cannot turn a dependency-bearing task into an empty
fixture. Missing test executables (directly or through npm/pnpm) leave the cell
unscored as an infrastructure error; ordinary test failures remain outcomes.
Root install scripts stay disabled. When the frozen install contains Electron
or better-sqlite3, setup explicitly materializes Electron's executable and
rebuilds only better-sqlite3 for the Node test runtime. Those commands and exits
are retained too. This prepares tests without running the app or the repository's
global Git-hook/ignore installers; it is not an Electron packaging environment.
Install downloads, Electron archives, native compiler headers and temporary build
files use the export's recorded `_scratch/dependency-install-cache`, so cleanup
can remove owned runtime files without guessing which shared cache entries changed.

Setup and scoring refuse exports with any ancestor `node_modules`, including
real paths and symlink targets, or installed Node global-module directories.
The command environment clears `NODE_PATH`, removes inherited dependency-bin
paths, and supplies the export's own `.bin`. npm/npx runs offline with install
consent disabled and a fresh export-owned cache, so missing tools cannot escape
through a shared cached install. Global Node/npm/pnpm/coder CLIs remain available.
`AIO_TEST_SUMMARY=0` is forced for coder tools and scoring, so test failures cannot
trigger extra model calls through a historical quiet-runner summary stage.

The default export path remains inside the checkout. With the repository's
dependencies installed, that location now fails the preflight deliberately.
Using an ancestor-free location must first comply with the user's worktree/copy
rules; the runner never moves exports elsewhere automatically. The resumed
pilot still needs a permitted clean location and fresh controls before accepting
new model scores.

No Node/filesystem hooks remain. A standard macOS `sandbox-exec` prototype was
rejected by the outer sandbox (`sandbox_apply: Operation not permitted`), and an
independent review proved Node-only hooks could not stop native esbuild from
bundling an ancestor dependency. Exact failed implementation snapshots, hashes
and raw reproductions are retained with the scoring evidence.

The ten pilot parents require five different AIO lockfiles and two 12steps
lockfiles. Parent and fixed revisions share identical dependency inputs within
each task, so both controls use the same frozen install. A single present-day
install is not a valid substitute for those seven historical dependency sets.

Bank version 2 declares AIO-01's `aio-01-startup-order-v2` amendment. The scorer
checks its SHA-256, preserves the complete original hidden spec, and applies the
additions-only patch immediately before running the hidden command. Its new
ordering assertion observes a blocked startup writer and rejects entering the
safety backup first, including a bogus fix that merely delays by microtasks.
New score records carry the contract version, amendment hash and dependency
fingerprint. Old records without those fields remain historical results; loading
the new bank does not reclassify or rescore them. AIO typechecks retain the same
TypeScript program while allowing an 8 GiB heap for the historical graph.

## What it measures

Eight arms (see `arms.ts`) run the same coding tasks:

| Arm | Planner | Coder |
|---|---|---|
| A | none | Claude Opus 5.5 (baseline) |
| B | none | Qwen3.6-35B-A3B on the 5090 |
| C1 | Opus 5.5 (frozen plan) | Qwen3.8-27B on the 5090 |
| C2 | Opus 5.5 (same plan) | Qwen3.8-Flash-Next (5090 + system RAM) |
| D | Opus 5.5 (same plan) | Claude Sonnet 5.5 |
| E *(optional)* | Opus 5.5 (same plan) | GLM-5.3 hosted |
| G *(optional)* | none | Codex |
| F *(full run only)* | Opus 5.5 | best of C1/C2, Opus takeover on stall |

Scoring is hidden tests first, then no-damage checks, then two blind judges
(Claude Opus 5.5 and Codex) that each compare an arm's patch with arm A's in
both presentation orders. Judges never override tests, and a judge that cannot
answer is recorded as `judge-unavailable` — there is deliberately **no** silent
fallback to another model (the sibling `orchestrator-benchmark` judge quietly
ran Claude twice when the OpenAI key was missing).

## Layout

| File | Purpose |
|---|---|
| `runner.ts` | CLI: `run`, `plan`, `speed-gate`, `self-test`, `mine`, `verify-task`, `report` |
| `arms.ts` | Arm table, CLI invocation builders, prompt builders |
| `agent-cli.ts` | `claude` / `codex` non-interactive runs with stream parsing, turn caps and usage capture |
| `task-export.ts` | Throwaway workspace export inside the worktree (plain file export + one baseline commit, no history) |
| `task-bank.ts` | Load/validate `tasks/task-bank.json` |
| `scorer.ts` | Hidden-test scoring + no-damage checks |
| `judge.ts` | Blind dual-judge comparison, label stripping, both-orders rule |
| `monitor.ts` | Arm F takeover monitor (2 failed test runs or 15 turns without an edit) |
| `model-control.ts` | Model load/unload + helper-model reload on the Windows PC |
| `speed-gate.ts` | 30k-token prompt/write speed probe and the C2 keep/drop gate; persists measurements to `speed-gate.json`; per-run probe for local runs |
| `report.ts`, `decision-rules.ts` | Aggregation and the plan's pre-agreed decision rules |
| `stats.ts` | 95% uncertainty ranges: Wilson score per arm (task as the unit), Newcombe gaps vs A |
| `cost.ts` | Metered cost from the CLI's billed `total_cost_usd`: cost per solved task (plan step 13) |
| `mine-tasks.ts` | Commit mining + fail-on-parent/pass-on-commit verification |
| `self-test.ts` | Dry harness proof (no model calls) |

## Quick start

```bash
cd benchmarks/plan-execute-ab

npx vitest run --config vitest.config.ts    # benchmark tests (root test config excludes benchmarks)

npx tsx runner.ts self-test                # dry harness proof, no model calls
npx tsx runner.ts run --dry-run            # show the matrix without running
npx tsx runner.ts mine --repo-id ai-orchestrator --since 2026-08-01
npx tsx runner.ts verify-task --task-file tasks/one-task.json  # one task, not the whole bank
npx tsx runner.ts speed-gate               # C2's prompt/write speed floor
npx tsx runner.ts run --phase pilot        # the pilot (spends metered Claude/Codex)
npx tsx runner.ts report --session <dir>
```

`run` writes everything to `_scratch/plan-execute-ab/<session>/` (runs.jsonl,
patches, plans, judge logs, report.json, report.md). Throwaway workspaces live
under `_scratch/plan-execute-ab/workspaces` and are removed after each run. The runner reloads
Harness's helper models on the PC when local runs finish and on Ctrl+C
(decision 8 in the plan).

`speed-gate` appends every measurement to `_scratch/plan-execute-ab/speed-gate.json`
(history kept; the report and decision rules use the newest Flash-Next decision).
Each local run also records a per-run speed probe in its run record, and the
report renders both under "Local model speeds". Run counts follow the plan's
design: pilot 1 run per arm per task; full run 3 runs for cloud arms (A, D, E,
G) and 2 for local arms (B, C1, C2, F — time budget); `--runs N` overrides all.

`speed-gate --prompt-file <text>` probes with real agent prompt text (the plan's
step-3 requirement: "a real 30k-token Claude Code prompt", e.g. one taken from a
benchmark run transcript). Without it the probe uses synthetic filler and the
C2 gate **records the reading but withholds the keep/drop decision** — a
synthetic-only measurement is a setup reading, not the gate.

## Configuration (`runner.config.json`)

- `repoPaths`: local clones used for task export and mining.
- `localArms`: per-model server endpoint for the local arms. `apiKeyEnv` names
  an environment variable; the key itself never lives in this repo. Each local
  endpoint gets its own `configDir` so the Anthropic login is never sent to the
  local server (a fresh config folder holds no stored login token). Set
  `PLAN_EX_AB_LOCAL_KEY` before running local arms. `servedModelName` is the
  name the model server itself answers to (LM Studio keys, e.g.
  `qwen3.8-27b`) and is what Claude Code sends as `--model`. `servingSetup`
  names the serving stack behind the endpoint (e.g.
  `llama-server-2.60.0-27b-65536-translator-blocks-v2`); it is copied into every run record so the
  fairness control ("same model files, server build and settings throughout;
  restart that arm" on change) is machine-checkable — a run without it records
  `unrecorded`, an arm with several setups is flagged mixed in the report and
  withheld from every decision rule. Change the serving stack ⇒ update this
  field first and restart the arm's batch.
- `wallClockMinutes` (60) and `turnCap` (75): the same limits for every arm.
- Model load/unload on the Windows PC is **out of band** (see Phase 0 notes
  below): run each local arm as its own `--arms X` batch and load that arm's
  model on the PC before the batch. With no `modelControl` block the runner
  warns and runs anyway.

## Phase 0 as-built (2026-10-15)

- **Model server for B/C1: LM Studio 0.4.25 on the Windows PC** at
  `http://100.113.93.104:1234` (Tailscale address). It speaks Claude Code's
  Anthropic message format natively (`/v1/messages`, verified with text and
  tool-use responses), so no translator is needed. Models downloaded into
  `~/.lmstudio/models/qwen/...`: `Qwen3.8-27B-UD-Q6_K_XL.gguf` (25.3 GB, arm
  C1) and `Qwen3.8-Flash-Next-UD-IQ4_XS` (3 split parts, 93.7 GB, arm C2 —
  Unsloth 4-bit, inside the plan's 94–111 GB range; the smaller of the two
  4-bit quants so the speed gate measurement lands sooner).
- **Model control is out of band.** SSH to the PC is blocked (port 22 times
  out), LM Studio's REST API has no load/unload, and the AIO worker's
  `exec_on_node` refuses `lms`. Load/unload therefore runs via the AIO worker
  agent (`run_on_node`, antigravity provider) between arm batches; the runner
  is invoked once per arm with that arm's model already loaded at 64k context
  (`lms load <key> --gpu max -c 65536 --identifier <key> -y`). LM Studio
  auto-loads a requested-but-unloaded model at the default 8192 context, so
  always load explicitly first. Decision 8 (helper reload) is done manually at
  the end of local batches. WinRM (port 5985) is open on the PC and is the
  candidate channel if per-run automation is ever wanted.
- **Coders are not told their arm.** The coder prompt is identical across arms
  (only the frozen plan differs); an earlier draft named the arm in the prompt.
- **Workspaces install their historical frozen dependencies.** The earlier host
  `node_modules` symlink was replaced during the 27 October scoring repair.
  Dependencies, the frozen plan and `_scratch` stay excluded from captured patches.
- **Claude Code needs the bundled translator (`local-anthropic-proxy.ts`).**
  Claude Code 2.1.x appends trailing `role: "system"` messages to `messages`
  (context-management reminders). Qwen3.8's GGUF chat template raises
  `Jinja Exception: System message must be at the beginning` on that shape, and
  every agentic run died on the first turn. The proxy lifts in-array system
  messages into the top-level `system` field and forwards everything else
  unchanged (it also fixes the forwarded `content-length`). Run one per upstream:
  `npx tsx local-anthropic-proxy.ts http://100.113.93.104:1234 8900 <log>` and
  point the runner's `baseUrl` at `127.0.0.1:8900`. Evidence:
  `_scratch/plan-execute-ab/phase0/proxy-lift.log` (smoke run 1/2 died without
  the proxy; run 3 through it completed the 3-step tool task cleanly).
- **Speed measurement**: `speed-gate` probes every configured local arm; the
  300 prompt / 15 write tok/s keep/drop gate applies only to C2. Two probes on
  real ~30k-token prompts (unique nonce prefix each, so no prompt cache is
  shared) derive prompt and write speed from wall clock when the server
  reports no timings (LM Studio's Anthropic endpoint does not; llama.cpp
  `timings` are used when present). Clean 27B reading (27B alone on the 5090):
  **1246 prompt / 157 write tok/s** (`phase0/speed-gate-27b-clean.txt`). An
  earlier 667 tok/s sample was contaminated by LM Studio auto-loading a
  not-loaded model at the default 8192 context during a probe — never probe a
  model name that is not explicitly loaded.
- **Cache survival (plan fairness control) verified:** identical-prefix API
  requests show `cache_read_input_tokens` > 0 and a 19.3x cold-to-warm speedup;
  agentic runs show tens of thousands of cached-read tokens per turn.
- **Gotcha — LM Studio session restore vs loaded models.** After a reboot LM
  Studio restores previously loaded models (the helper 35B + 9B) and can evict
  the benchmark model from the 5090; the next request then auto-loads the
  benchmark model at the **default 8192 context with a 1h TTL** and runs die
  with `exceed_context_size_error`. Before every local batch: `lms ps`, unload
  anything unexpected, and load the arm's model explicitly
  (`lms load <key> --gpu max -c 65536 --identifier <key> -y`). One AIO-03 C1
  run was quarantined for this (see `runs-quarantined.jsonl` in the session).
  A command bridge (`_scratch/pc-setup/model-bridge.cjs`, whitelisted `lms`
  commands + shared key) was built so the runner's `modelControl` could do this
  per run; it did not come up cleanly over the worker channel and is kept as a
  candidate for the full run. The Windows PC also crashed twice on 15/16 Oct
  (see the plan's step notes) — local arms are only as reliable as the box.
- **Pilot spend (re-measured 16 Oct from billed per-invocation totals):** Opus baseline arm A ≈ $23.04, Sonnet arm
  D ≈ $4.98, Opus planners ≈ $12.41, Claude judges ≈ $23.86 — metered ≈ $64. An earlier hand-scraped "≈ $76 / arm A
  ≈ $38" double-counted Claude Code's cumulative result snapshots (one invocation's result events repeat the session
  total as it grows; `cost.ts` takes the last figure per invocation). Local-arm "cost" numbers in agent logs are the
  CLI's nominal estimate, not billed.

## Uncertainty and cost in the report (plan step 13)

`report` renders per-arm **uncertainty ranges** and **cost per solved task**:

- Solved and hidden-test rates carry 95% Wilson score ranges with the **task** as
  the unit (repeat runs of one task are not independent; with one run per task it
  is textbook Wilson). The results table shows the range inline; the Uncertainty
  section also renders each arm's solved-rate gap vs A with Newcombe 95% ranges
  and says plainly when a gap can be noise.
- Cost comes from the CLI's billed `total_cost_usd` per invocation (logs only; one
  invocation costs its last cumulative figure). Anthropic-billed coders (A, D) are
  charged their coder spend, arm F its Opus takeover spend, plan arms the full Opus
  planner cost of their tasks (shared per task, counted in full — the standalone
  workflow cost), and local coders, Codex (ChatGPT plan limits) and the hosted GLM
  arm (provider plan/rates) get $0 metered. Claude judging is a shared line. Spend
  from runs later quarantined still counts: the money was spent either way.

## Rules baked into the runner

- Each run works in a throwaway copy of the task's **parent** commit under
  `_scratch/plan-execute-ab/workspaces` with git history removed (a single `benchmark baseline` commit), so no
  run can find the answer in `git log`. No branches or worktrees in any repo;
  the repo-wide stash ban is respected (no stash anywhere).
- Hidden tests are withheld until scoring time and copied in from the real
  commit afterwards.
- The blind judge strips co-author trailers and model-identifying comments and
  counts a win only if the subject wins in **both** presentation orders.
- Known fairness limit (recorded in the plan): the coder processes run on the
  Mac with general filesystem access, so a wandering agent could find the real
  repositories on disk. All arms share the same exposure, so comparisons stay
  relative; hidden tests and damage checks measure outcomes.

## Operational notes (16 Oct)

- **Probing one model at a time:** `speed-gate` probes every endpoint in
  `runner.config.json`, and probing a model LM Studio has not loaded makes it
  auto-load at the default 8192 context, which then fights the loaded model
  for the GPU. To take a clean measurement, point `--config` at a copy whose
  `localArms` holds only the loaded model (see `runner.config.probe.json`,
  an untracked helper kept in this folder during campaigns).
- **`verify-task` uses the same frozen setup and scorer as real runs.** Both
  parent and fixed exports receive the declared hidden amendment; the fixed
  revision must pass hidden tests and damage checks. One export is reused
  sequentially and removed on success or failure. The old `--setup` donor modes
  are removed. Structured command, setup and score receipts stay in the evidence
  directory after the export is removed.
- **Session evidence lives in `_scratch/plan-execute-ab/`** (gitignored). Queue
  worktree recreation deletes it, so keep a mirror under
  `<repo-root>/_scratch/plan-execute-ab/` and see
  `pilot-2026-10-15/RECONSTRUCTED.md` for how the pilot session was rebuilt
  from CLI transcripts after the 16 Oct loss.


## Bounded pilot resume (20 October 2026)

`run --local-only --phase pilot --arms B|C1|C2 --session <existing-session>`
requires all frozen plans up front, refuses cloud/hosted/Codex/takeover arms,
and skips both judges. Missing plans cannot trigger an Opus call, including
if a plan disappears after preflight. Judging remains pending; an unjudged
local run is not a finished pilot result. Use this mode while preserving the
approved $80 cumulative pilot ceiling. Plain `run` and `plan` can spend money.
The local coder receives a complete environment with inherited Anthropic
credentials, custom headers and cloud-routing flags removed; do not merge the
parent environment back into it.

Current local setup IDs end in `translator-blocks-v2` for the translator that
preserves content blocks. This differs from the older JSON-as-text format.
When a new local matrix is authorised, C1 must restart all ten tasks in a fresh
session using the existing frozen plans. The two retained older C1 cells stay
historical; do not merge them into the new-format arm or modify their original
session and quarantine files.

Pilot stop/C1-vs-C2 decisions wait for all ten matching pilot tasks against A; C2
may be absent for the stop rule only after an explicit failed speed gate.
The stop rule uses hidden-test passes, as specified, rather than tests plus
damage. Configure one loaded model per invocation and first prove the model
server's private binding/authentication. The current key-file transfer was
refused by the file-transfer security filter; no repository prompts were
sent on the unauthenticated route by the 20 October worker.

Speed probes now include response-body time. Earlier wall-clock readings are
provisional until repeated with this version. Setup-only readings use synthetic
agent-like text; they do not prove the real repository-prompt requirement.
Full-run checks, subscription decisions and any budget overrun remain gated.
See `evidence/2026-10-20/` for the report, source-evidence hashes and command receipts.
