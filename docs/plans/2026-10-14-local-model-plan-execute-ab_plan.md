# Can cheaper models do the coding? A head-to-head test — plan

**Status:** proposed, not started. Written 2026-10-14; revised the same day after James chose the Windows PC and asked
about using its 192 GB of RAM for a bigger model. Untracked; keep it that way until the test is run and the decision
is recorded (then rename `_completed`). Nothing in this plan changes app code.

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

1. [ ] On the Windows PC, via the worker: download Qwen3.8-27B (6-bit) and Qwen3.8-Flash-Next (Unsloth or AesSedai
   4-bit) into LM Studio's model folder.
   - Nothing on the PC changes beyond new model files until a test window starts.
2. [ ] Choose the server for each model: LM Studio, or llama-server on Windows or WSL2.
   - For Flash-Next, compare Windows and WSL2 llama-server and tune `--n-cpu-moe`, `-b/-ub 4096` and the thread count.
   - Bind to the Tailscale address only, with an access key.
   - Confirm Claude Code's message format works directly or through a translator.
3. [ ] **Speed gate:** for each local model, measure prompt-read and write speed on a real 30k-token Claude Code prompt
   from the Mac, and check the PCIe link width under load. Apply the speed gate.
4. [ ] Smoke test each local model: Claude Code on the Mac completes a 3-step tool task (read file, edit, run a test)
   without tool-call errors, and the prompt cache survives across turns (second turn's prompt time well below the
   first).
5. [ ] If decision 4 is yes: set up a separate Claude Code config folder holding only the hosted provider's key. Prove
   with a request log that no Anthropic token is sent to it.
6. [ ] Build the runner in a new self-contained folder, `benchmarks/plan-execute-ab/` (TypeScript, no app-code
   changes). It handles task export, arm launch, model load/unload on the PC, time limits, hidden-test scoring,
   token and speed capture, the blind judge, and the report.
   - Do **not** reuse `benchmarks/orchestrator-benchmark/judge.ts` as-is. Without an OpenAI key, its "Codex" judge
     silently runs Claude, so both judges are Claude.
   - Do **not** reuse that runner's `git stash` fallback; this repo forbids stash.
   - Each run works in a throwaway copy under `/tmp` on the Mac. No branches or worktrees in this repo.
   - Results go to `_scratch/plan-execute-ab/` (already ignored by git).
   - The runner reloads Harness's helper models on the PC when local runs finish, or if it is stopped (decision 8).
7. [ ] Runner self-test: one known-easy task through every arm, with a deliberately broken patch to prove scoring
   catches failures.

### Phase 1: task bank (half a day + James's skim)

8. [ ] Mine candidate commits (decision 3) and confirm the fail-on-parent / pass-on-commit rule for each.
9. [ ] Write task texts; leakage check; size mix; James skims the list.

### Phase 2: pilot (one overnight run)

10. [ ] 10 tasks × arms A, B, C1, C2, D (+ E, G if approved) × 1 run.
11. [ ] Pilot report: solved per arm, tokens and time, judge agreement, failure modes seen (looping, tool errors,
    ignoring the plan), and C1 vs C2. Apply the stop rule. Report to James in plain English.

### Phase 3: full run (only if the pilot passes and James approves the spend)

12. [ ] 30 tasks, 3 runs for cloud arms and 2 for the kept local arms, plus arm F.
13. [ ] Final report: per-arm results with uncertainty ranges, cost per solved task, the matching decision rule, and
    a recommendation on each subscription.

### Finishing

14. [ ] Record the decision and as-built notes here; rename this file `_completed`. Commit only if James asks.

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
