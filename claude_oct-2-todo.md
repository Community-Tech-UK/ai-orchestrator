# AIO October to-do, part 2: land what is built, make the plan queue trustworthy, spend fewer tokens, calm the screen, tooltips everywhere

**Date:** 19 October 2026 · **Author:** Claude (second research pass across every sibling project in `/Users/suas/work/orchestrat0r/`, plus six fresh audits of AIO) · **Status:** backlog, not a plan; **not yet reviewed by James** · **Version:** v2 (corrected after an independent fact-check; Appendix D)

**James's brief (19 October, the same request as 10 October):** "Please check ALL the projects in this folder (except AIO) with a look to improving AIO. Look deeply. I want token wastage reduce in AIO (AI Orchestrator) Looping better, the UX cleaner and easier to understand, tooltips everywhere. Grab examples and ideas from all these projects and then create an claude_oct-2-todo.md file in the root of AIO to turn into a plan going forwards. Check the code deeply for AIO and all the other projects in this folder. Dont cut corners."

**How this list relates to the first one.** `claude_oct-todo.md` (10 October, approved by James) still stands. This list does not repeat its items. Where one of them needs a new angle, this list says "extends A4" (or B2, C6 and so on) and gives only the new part. New items use new letters so nothing collides: **T** spend fewer tokens, **L** loops, the plan queue and scheduled jobs, **U** a calmer screen and plainer words, **H** help and tooltips, **K** keeping house (numbers, storage, versions, documents).

**Lifecycle:** this file is deliberately **untracked**. Turn sections of it into dated `*_plan.md` files before building anything. Rename it to `claude_oct-2-todo_completed.md` only when every item is built, verified or explicitly closed, and never add scope to it after that. (The first list is now tracked by git by accident, through the commit described in L1. K7 covers putting that right.)

**Plans made from this list (20 October 2026).** Every item below is assigned to exactly one of these, and the fact-check's unapplied notes (Appendix D, `_verify-3`) are carried into them:
- [Phase A: safety and truth](docs/plans/2026-10-20-oct2-phaseA-safety-and-truth_plan.md): K1, K2, L1, L3, T2 steps 1-3, T3 step 1, T4, T12, T15.1, H2, U5, U6 step 1, U4's desktop label, K7, plus K3.6's minimal usage line and K3.5's one-off credit check.
- [Phase B: land the built work](docs/plans/2026-10-20-oct2-phaseB-land-built-work_plan.md): L2, H1, T1 items 1, 3, 5 and 7, K4 item 1.
- [Phase C: a queue that finishes](docs/plans/2026-10-20-oct2-phaseC-queue-that-finishes_plan.md): L4, L5, L6, L7, L9, L10, L12, T8, T9, K3 items 1, 2 and 6, T1 items 2, 4 and 6.
- [Phase D: tokens](docs/plans/2026-10-20-oct2-phaseD-tokens_plan.md): T3 steps 2-6, T5, T6, T7, T10, T11, T13, T14, T16, T17, K3 items 3, 4 (which owns T2 item 4), 5, 7 and 8.
- [Phase E: the screen](docs/plans/2026-10-20-oct2-phaseE-calm-screen_plan.md): U1-U4, U6 steps 2-5, U7-U12.
- [Phase F: tooltips](docs/plans/2026-10-20-oct2-phaseF-tooltips_plan.md): H3-H9.
- [Housekeeping](docs/plans/2026-10-20-oct2-housekeeping_plan.md): K4 items 2-8, K5, K6, K8, K9, K10.
- [Later](docs/plans/2026-10-20-oct2-later_plan.md): L11, L13, U13, H10, T15 items 2-7.
- [Decisions for James](docs/plans/2026-10-20-oct2-decisions-for-james_completed.md): the 13 decisions below in plainer words, plus six found missing by the fact-check and the plan review (14-19).
- Deliberate changes from this list, each recorded in its plan: T2 item 2 becomes "own chats keep the larger window" (Phase A Step 6, Decision 3); the `_history` guard moves to Phase A Step 0; Codex keep-3 waits for Decision 19; the run-end summary stays one model-visible message (Phase A Step 5); AGENTS.md's dead remediation-plan pointer is reworded rather than repointed (Phase C Step 12).
- L8 is T4 (Phase A).

---

## Two warnings before anything else

1. **Please don't restart Harness yet.** The newest code (added on 18 October, after your app last started) includes a one-time clean-up of your old, inflated Claude cost figures. On its next start it would also "clean" the figures recorded correctly since your 17 October restart and make them about a fifth too low: by late on 19 October, 613 records would drop from $2,203 to $1,751, and each day adds more ($149 on 18 October, $246 on 19 October). Nothing is lost for good, because the originals are saved first, and these are estimates at published prices, not money you paid. The fix is a few lines (K1) and can be made as soon as you say go. Restart after that, and the October cost fixes start working (K2). If you ever start Harness from the project folder rather than the installed app, note that its built files were refreshed at 21:25 on 19 October and already contain the clean-up, so even a normal reopen from there would run it.
2. **The plan queue can save files into your project's history by mistake, and in one case could delete unsaved files.** This happens when a job's own work folder fails to set up and the queue then works in your main AIO folder instead. It happened once, on 15 October: 152 files were saved into the main code by mistake, including 71 unfinished plans and test checklists and your first to-do list. The same gap leads to an undo step that could delete new files that were never saved to the project's history, which includes your unfinished plans; that has not happened yet. The fix is small and comes first in the plan queue section (L1). Until it is fixed, the queue is safe enough to keep using (this happened once in about 1,660 jobs, and the one half-made folder that exists today is the harmless kind), but as a precaution don't retry a job that was set aside with a work-folder error, because the same job can repeat the mistake.

---

## In plain English

Letters in brackets, such as L2 or T4, point to the detailed sections below. AIO (AI Orchestrator) is the project; Harness is the app you run.

1. **Most of what you approved on 10 October has been built but is not in the app you use.**
   - Only three of the ten October plans reached the main code: the confirmed fixes (Phase 0), the loop work (Phase 2) and the housekeeping.
   - The token-saving plan (Phase 1) is built and waiting for its final check.
   - The calmer screen (Phase 3), the tooltips (Phase 4, in three parts), the "later" items (Phase 5) and the follow-ups are built on side copies that the plan queue gave up on. The copies are 8 to 25 updates out of date, so each needs bringing up to date before it can be added.
   - The plans' own status lines describe the work as built or nearly built. That is true only of the side copies, and none of them says the work is not in your app.
   - Getting this work in is the cheapest win on the list (L2).
2. **The plan queue, which now does the work loops used to do, loses work in avoidable ways.**
   - Claude checkers start the tests running in the background and then stop to wait. The queue reads that as "no answer" and sets the job aside. 39 of 62 Claude checks since 10 October never gave a verdict (L3).
   - A checker can say "pass" even when the test results it reports show a failure, and nothing double-checks it (L4).
   - When the queue hits a temporary limit (all five work folders busy, or an account setting that blocks a second checker), it sets aside every waiting job one after another instead of waiting (L5).
   - It keeps picking up hundreds of copies of plans from evidence folders in the work-finding project. In one run you pressed Skip 272 times in about three and a half minutes (L6).
   - The "372 worker errors" were mostly an old classification step, fixed on 15 October. Real worker failures were 17 in a month.
3. **Token use per day is 2.7 times last month's (most of it cheap re-read text), and Codex is 81% of it.**
   - **Codex nearly doubled its working memory on about 11 October** (272K to 500K tokens), through a change on OpenAI's side. Harness tells Codex to tidy its memory at a percentage of that window, so it now waits much longer. The average size of a request grew by about a third to a half on most days, and on most days 13-19% of requests now pass the size above which OpenAI's published price rises sharply for the whole request (double for input). (Whether that also counts double against your plan allowance is not known yet.) One setting puts the work Harness starts by itself (plan queue, loops, scheduled jobs) back where it was (T2).
   - **Codex's own helper agents now use two-thirds to three-quarters of Codex's input** in the chats that keep records (about half on 10 October). You approved "helpers off" for queue and loop work after a side-by-side trial. The trial is running, and so far queue jobs with helpers off use about 11% less, on a small sample (T3, Decision 13).
   - **51 enormous rounds of work** (a round is the AI's whole response to one message; each of these used over 100 million tokens, and 49 were on Codex) account for almost two-thirds of all token use since 10 October.
4. **The plan queue keeps waking the chat that started it.** Harness treats each queue job as a helper of that chat. Whenever a job finishes, Harness wakes the chat and asks it to write a full report on every helper it has ever had. Together with the queue's own notices, that cost about 5.3 billion tokens on Codex in ten days (counted by order in time, so approximate). The queue's design says the chat should get one summary at the end of a run. Restoring that, and turning notices into quiet notes, fixes it (T4).
5. **Plan files have grown huge** (up to 590 KB) because every round adds notes, and every worker and checker re-reads them. In the Codex sessions run in the AIO folder (15-19 October), re-reading plan text was an estimated 8.5% of what was sent to the model, most of it cheap cached text. A short status section, history in a side file and one queue job per step fix it (T1).
6. **Claude:**
   - Claude's built-in helper agents are now about 30% of AIO's Claude spend (61% in the three weeks before), 86% of it on Opus. Ordinary sessions never ask for a cheaper model for them; the approved trial is waiting with the token-saving plan (T6).
   - The single biggest Claude burst is a research sweep like this one. On 10 October, for the first to-do list, 82 helper agents sent about 12,000 requests in 14 hours, 84% of them to Opus (89% of the cost): about $1,900 at published prices. Running those helpers on Sonnet would have saved about $680 (T6).
   - The long-chat cap is built but switched off. A replay of your own chats suggests a cap near 300K could cut the cost of your long chats by up to about a quarter. That is a model, and the quality of the summaries is still to be tested. It barely helps queue jobs or helper agents (T7).
7. **Copilot, second opinions and scheduled jobs:**
   - Copilot counts each message to its Opus model as 15 "premium requests" against your allowance, and each message to the cheaper models as 1. The queue's checkers and the second-opinion reviewers already use the cheaper models. Two-thirds of Copilot's allowance went on 14 Copilot chats on Opus, 13 of them in the EBRD folder (T8).
   - Second-opinion reviews ran about 37 times a day on 16-19 October, and the number is rising. Each uses two reviewer sessions. Of 236 sessions, 92 failed, 30 ran out of time and 108 finished, and 36 of the 118 reviews (about 30%) were thrown away after finishing because a newer message had arrived. None is recorded in the cost log. The fix (at most 20 a day) is in the main code but not in your running app (T9, K2).
   - Scheduled jobs: many runs find nothing to do (between 39% and 84% of successful runs, depending on how their summaries are read, because no run records a proper result). One failed run used 794 million tokens. Nothing stops a job that runs for 15 hours, and a restart silently kills one-off jobs (L10).
8. **The screen: the clutter has moved from the session header to system messages and the title bar.**
   - Raw Codex log lines appear in chats.
   - A usage limit prints two notes, one ending `"rejected" (seven_day). Resets at 11:00:00 PM` with no date.
   - "Startup degraded" shows whenever any optional tool is not installed.
   - One MiMo account has five names.
   - The plan queue page shows 50 run cards and 35 set-aside jobs with saved work at once.
   - Closing a session also closes its helper sessions without saying so, and "Allow once" actually allows the same request for an hour.
9. **Tooltips: on the main code nothing you would notice has changed.**
   - 48 of 169 icon-only buttons have both a hover hint and a name for screen readers, the same as on 10 October.
   - 358 plain browser hovers remain, and 523 greyed-out controls give no reason.
   - The tooltip work sits on three side copies that clash with each other. Add them together in one go, then a short sweep finishes the job (H1-H3).
10. **Ideas worth copying from the other projects** (mostly new since 10 October):
    - one "pause new work" switch (hermes);
    - a one-line note after each turn saying what it did, with failures counted, plus a warning when an edit failed but the reply glossed over it (hermes, agent-orchestrator, opencode);
    - checkers that get the test results from Harness instead of reporting their own (storybloq);
    - a test that stops prompts quietly growing back (oh-my-opencode-slim, hermes, storybloq);
    - a time limit on scheduled jobs, and resuming them once after a restart (openclaw);
    - Anthropic's own "where your usage went" explanation (Claude Code).
11. **Storage.** Harness's data folder grew about 40 GB in nine days, to 130 GB, plus 64 GB in the Codex store (mostly 443 backup copies). The new clean-up tools are built, but none of them has been used yet (K4).
12. **What you need to do.** Three things:
    - say go for the K1 fix, and restart Harness only after it is in;
    - answer the 13 short questions at the end ("Decisions for James");
    - read the review page (path in the summary message).

    Everything else follows from your 10 October approvals.

---

## How this was produced, and how to trust it

- **Coverage.** 21 research agents, all read-only: six audits of AIO and fifteen scouts for the sibling projects.
  - **AIO audits:** prompts and helper calls, AIO's own usage databases, the providers' transcripts, the plan queue and loops in practice, screen clarity, and tooltip coverage.
  - **Projects scouted:** openclaw (engine and interface), hermes-agent (engine and interface), t3code, opencode, oh-my-opencode-slim, oh-my-codex with claw-code, codex with codex-plugin-cc and CodexDesktop-Rebuild, claude-code with "Actual Claude" and copilot-sdk, storybloq with tura, agent-orchestrator, pi with rtk, jean with nanoclaw, and mempalace-reference with OB1, CodePilot and online-orchestrator.
  - **Reports:** in `_scratch/oct2-audit/*.md` (gitignored, disposable); Appendix B lists them.
- **Freshness.** Every sibling was fetched on 19 October at 21:04. New commits since the first round's snapshot on 10 October, as each scout counted them: openclaw about 7,400 commits, hermes about 3,900, t3code 1,305, oh-my-opencode-slim 331, opencode 329, codex 271, storybloq 251, agent-orchestrator 164, pi 162, oh-my-codex 157, claw-code 152, jean 95, nanoclaw 50, rtk 37, claude-code 15 (plus five Claude CLI releases), copilot-sdk 13 and mempalace 9. CodePilot, OB1, tura, CodexDesktop-Rebuild and codex-plugin-cc had no new commits, so their scouts dug deeper into what the first pass missed.
- **Data windows.** "Now" means 10-19 October 2026. "Before" means the 30 days to 10 October (21 days for the Claude transcript figures). Usage numbers are aggregates from read-only queries of AIO's databases, logs and the providers' own transcripts on this Mac. Agents read only the opening words of sessions to sort them by kind, and no message content appears in any report.
- **Dollars.** Dollar figures are list-price equivalents for comparison. James's Claude and Codex use is on subscriptions, so tokens and plan headroom are the real units.
- **Evidence labels.**
  - **VERIFIED** means the code path was read end to end.
  - **PRESENT-BUT-UNWIRED** means the code exists with no production caller.
  - **ABSENT** means it was searched for and not found.
  - **UNVERIFIED** means it is a lead only.
  - **[checked by Claude]** means the lead author re-traced the claim independently of the agent that found it. Appendix D lists all 24 such checks and every correction made to an agent's report during writing.
- **Where AIO's state was read.** The root checkout as it is now (main at `0190f9133` plus about 150 uncommitted paths from other sessions, this file included) and, where it matters, the queue branches. "On main" does not mean "in your running app": your app last started before the Phase 0 merge (K2).
- **Lessons from the first round, applied.** Bulk research ran on a cheaper model in two waves, with written briefs and incremental reports. Each agent's top claims were re-checked before use, and the draft gets a fresh fact-check before James sees it (Appendix D records the outcome).

---

## What happened to the 10 October list (summary; full table in Appendix A)

| Where it is | Items |
|---|---|
| **On main and running in your app** (merged by 15 October) | A5 core (read-only reviewers, turn and $1 caps, security plugin off for machine sessions), A16 core (Codex thread settings, as a 50/50 trial), B2-B6 and B14-B15 (finish phase, baselines, live questions, spend rows, honest end states, keep-awake, Copilot limits), B8.1-B8.3 (document-only landing merge, runs survive restarts, triage retry), C1 (Close all asks first), E3 (versions and comments) |
| **On main but not in your running app yet** (Phase 0 merge, 18 October 15:34; it starts with the restart after K1) | A0 (true spend numbers: purpose recorder, Copilot fix, helper records, Costs page; per-turn Claude booking itself has run since 17 October), A1 (Compact now writes a summary), A2 (instructions reach OpenCode and Copilot), A3 (loop instructions not re-sent; re-anchor after Claude compacts), A10 (header cost; your `showCost` setting is off), A14 (second opinions only on real changes, 20 a day), C3a (approval buttons name their scope), D1 (tooltip directive fixes), MEM-4 |
| **Built but switched off** | A4 (context ceilings default to 0; see T7) |
| **Built, waiting for its final check** (Phase 1 branch, 29 commits and 466 files, still growing) | A6, A8, A9, A12, A13 (hook, trial, honest Savings), A15, A17, A18, A19, A21, A16 extras |
| **Built, stranded on parked side copies** (8-25 changes behind main) | Phase 3: C2, C3c-g, C4, C8, C9, A20 (memory notes earn their place), A14's "Second opinion" naming. Phase 4 parts 1-3: D1b-D10. Phase 5: C12, C13, D11, part of A11. Follow-ups: 41 of 49 parts, including Codex backup keep-3 |
| **Not built anywhere** | A7, B8.6, B11-B13, C3b, C5, C6, C7, C10, C11 |
| **Dropped with recorded reasons** | A9.1 big pastes; `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` (24 of 26 resumes kept at least 90% cache after edits) |

**Still true from 10 October:** loops have not run since 24 September, so most of the Phase 2 loop work is unexercised. The plan queue is where unattended work happens now.

---

## Headline numbers (10-19 October unless stated)

| Measure | Value | Source |
|---|---|---|
| Tokens processed per day | **3.94 billion, against 1.45 billion in the 30 days before (2.7x)** | `aio2-tokens-db` TD-2 |
| Codex share of all tokens | **81%** (gpt-6.1-sol, 31.6B of 39.0B); Claude Opus 18% and flat per day | TD-2 |
| Where tokens go | Main chats 43%; chats that started a plan-queue run 36% (7.5x the month before); plan-queue workers, checkers and triage 13%; scheduled jobs 8%; loops 0% | TD-2 |
| Single biggest pattern | **51 turns of at least 100M tokens hold 63% of all volume**; all but two are Codex with helper agents; the four biggest used 1.56-1.84 billion tokens each | TD-2, TD-3 |
| Codex helper agents' share of Codex input | **66-73%** depending on how it is counted (49% on 10 October), in Codex chats that keep records (queue and scheduled-job threads leave none); turns that used helpers average 41.8M tokens (7.8M a month ago) | `aio2-tokens-transcripts` TR2-1; `ref2-codex` CX2-3; TD-3 |
| Codex working memory change (about 11 October) | Window 272K to 500K; average input per request 124K to 142-182K (above 164K on every day but 14 October); on most days 13-19% of requests above OpenAI's 272K price line (2x input, 1.5x output for the whole request, per OpenAI's published prices; the effect on plan allowances is unconfirmed), about +22% at list price | CX2-1 |
| Plan text re-read in Codex sessions in the AIO folder (15-19 October) | **About 360M tokens, 8.5% of those sessions' input** | `aio2-tokens-static` TS-1 |
| Plan queue waking the chat that started it | Every queue job ends with a "job finished" message and a "write a full report on all N children" prompt to that chat. On Codex, 629 rounds of work after those prompts and the queue's own notices used **about 5.3B tokens** in 9.9 days (13M per report round, 46M per notice round; counted by order in time) | TD-4; lead re-measurement (T4, Appendix D) |
| Plan queue outcomes since 20 September | 1,661 jobs for 547 documents: 136 landed, 573 set aside, 938 skipped; 62 documents queued five or more times | `aio2-loops-planqueue` LQ-9 |
| "Worker error" set-asides | 355 of 372 were the old classification step (fixed 15 October); real worker failures 17 in a month | LQ-3 **[checked by Claude]** |
| Claude checkers that never gave a verdict | **39 of 62**; 30 of those had a background command still running | LQ-2 **[mechanism checked by Claude]** |
| October plans on main | **3 of 10** (Phase 0, Phase 2, housekeeping) | **[checked by Claude]**, Appendix D |
| Claude built-in helper agents (research sweeps excluded) | **30% of AIO's Claude spend** (61% in the 21 days before); 86% of that on Opus; ordinary sessions set no model on any spawn; forks are on by default since CLI 2.1.302 | TR2-7; `ref2-claude` CC2-4 |
| One research sweep (10 October, for the first list) | About **$1,900** at published prices in 14 hours: 82 helper agents, about 12,000 requests, 84% of them to Opus (89% of the cost); 24% of the whole window's AIO Claude spend. All ran at `max` effort, which was not shown to make them dearer; Sonnet scouts would have saved about $680 | TR2-12; CC2-14 |
| Long-chat cap, replayed on your own transcripts | About 26-28% cheaper at 300K for your own long chats (an upper bound, modelled); plan-queue workers 0-1% at 300K (5-6% at 200K); helper agents 4-6% at 300K (8-11% at 200K) | `ref2-hermes-runtime` HE2R-1 |
| Copilot (it was not idle: the 10 October "no use since 25 September" was a logging gap) | 841 sessions, 16,850 premium requests in 9.9 days. Queue checkers (454 sessions) and second-opinion reviewers (318) all used 1-unit models, about a third of the total; Opus at 15 premium requests each is 65%, all of it in 14 multi-turn Copilot chats, 13 of them in the EBRD folder | TR2-4; `_verify-1` re-count |
| Second-opinion reviews | About 37 a day on 16-19 October and rising (2.5x 10 October), two reviewer sessions each; 61% on Copilot seats. Of 236 reviewer sessions, 92 failed, 30 ran out of time and 108 finished; 36 of the 118 reviews (about 30%) were thrown away as stale after finishing; none recorded | TD-8; `_verify-1` |
| Scheduled jobs | 25 runs a day; **between 39% and 84% of successful runs found nothing to do**, depending on which words in the summary count (TD-6's match: 59%, 0.87B tokens); failed runs averaged 54.6M tokens, but one run used 794M of their 818M and 10 of the 15 cost nothing | TD-6; `_verify-1` re-count |
| Long-running scheduled jobs (30 days) | 51 of 667 runs over an hour; 3 ran 15-18 hours until a restart killed them | `ref2-openclaw-runtime` OC2R-1 |
| Tooltips on main | 48 of 169 icon-only controls with tooltip and name (unchanged); 358 native `title` hovers; 523 of 624 disable-able controls without a reason | `aio2-tooltips` TT2-2 |
| Storage | AIO data folder **129.8 GB (about +40 GB in 9.9 days)**; Codex store 64.3 GB, of which 40.7 GB is 443 backup copies. Binary GB: Finder shows about 139 GB for the data folder. The 10 October total was a rounded figure, so the growth is approximate | TD-10; `_verify-1` |
| Live checks waiting | 73 `*_livetest.md` documents pending (68 completed); the defect register is 1.06 MB | **[checked by Claude]**; TS-3 |

---

## If you only read one list: top 15

| # | Item | Goal | Size | Why first |
|---|---|---|---|---|
| 1 | **K1** Fix the cost-history clean-up before the next restart | Numbers | XS-S | Otherwise the restart shrinks correct figures by about a fifth; blocks every October cost fix from running |
| 2 | **L1** The queue proves it is in the job's own folder before it saves anything to the project history | Loops / safety | S | Has already committed 152 files to main; one path could delete untracked work |
| 3 | **L2** Add the work that is already built to the main code in a safe order, and show "on main: yes/no" | Loops / UX / Tooltips | M | Most of the approved screen, tooltip and token work is written and stranded |
| 4 | **L3** Checkers that wait for their own background tests | Loops | S-M | 39 of 62 Claude checks ended with no verdict |
| 5 | **T2** Keep the Codex work Harness starts by itself under 272K tokens of working memory | Tokens | S | One setting; reverses requests growing by a third or more and the price line where input costs double |
| 6 | **T3** Settle the Codex helper trial for machine work; a cap on runaway turns | Tokens | S-M | Helpers are two-thirds of Codex input; 51 turns hold 63% of all volume |
| 7 | **T4** Stop the queue waking the chat that started it | Tokens / Loops | S-M | About 5.3B tokens in ten days, mostly "write a full report" prompts after every job |
| 8 | **T1** Plan diet: short status block, history aside, one job per step | Tokens / Loops | M | 8.5% of Codex input; bloated plans also make checkers fail |
| 9 | **L4** Harness runs the tests; checkers get the recorded results and say what they did not check | Loops | M | Nothing checks a "pass" against the tests |
| 10 | **L5 + L6** One failure no longer sets aside the whole queue; discovery finds only real plans | Loops | S each | One failure set aside 19, 44 and 269 jobs in a row; 272 manual Skips in one run |
| 11 | **L10** Scheduled jobs: a time limit, a quiet result, a token cap, resume after restart | Loops / Tokens | S-M | Many quiet runs; one failed run used 794M tokens; 15-hour runs; one-off jobs lost |
| 12 | **T6 + T7** Claude helper-agent trial, caps and cheaper research sweeps; long-chat cap for your own chats | Tokens | S | Helpers 30% of Claude spend, one sweep $1,900; up to a quarter of long-chat cost (modelled) |
| 13 | **T8 + T9** Show the 15-request cost wherever Opus is picked on Copilot; cancel second opinions that are already out of date | Tokens | S | 14 Copilot chats on Opus used 65% of Copilot's allowance; about 37 reviews a day |
| 14 | **U1 + U2** One plain message per event (raw text behind Details); hide the status chip when everything is fine | UX | S then M | Unprocessed error text from the AI companies' tools is now the loudest thing on screen |
| 15 | **U5 + U6 + H2** Small trust fixes: closing a session with helpers, "Allow once" means once, a dead tooltip (H3's 22 nameless buttons follow the tooltip landing) | UX / Tooltips | XS-S | Each is small and each currently misleads |

**Key.** Size is a rough guide to the amount of work: XS tiny, S small, M medium, L large. Priority: P0 do first, P1 next, P2 later.

---
## L. Loops, the plan queue and scheduled jobs

The plan queue replaced loops for unattended work (no loop has run since 24 September), so this section is mostly about the queue. Its design is sound: a worker per document in its own work folder, a checker on a different provider, one squash commit per document. The problems below are in the seams.

### L1. The queue proves it is in the job's own work folder before any git write · P0 · S · **[checked by Claude]**
- **What's wrong.**
  - Commit `3be08c73a` (15 Oct 01:48, "Plan queue checkpoint: parked: worktree-error", the Phase 3 plan's job) is on `main`: 152 files and 46,336 lines from the **root checkout**, including `claude_oct-todo.md` and 71 active lifecycle documents (14 `_plan` and 57 `_livetest` files) that the lifecycle says must stay untracked (69 of them are still tracked today). It is the only queue checkpoint commit on any base branch.
  - Mechanism, read end to end:
    - `parkUnlocked` checkpoints whenever `existsSync(item.worktreePath)` (`src/main/plan-queue/plan-queue-item-flow.ts:591-593`).
    - `checkpoint()` runs `git add -A` (no pathspec when the provisioned-paths file is missing, `plan-queue-worktree.ts:299-303`) and then `git commit --no-verify` (`:160-179`). There is no check that the folder is the job's own worktree.
    - A directory under `.worktrees/queue/` that is not a registered worktree resolves to the enclosing root repository. The commit therefore lands on the root's current branch, and `--no-verify` skips the plan-and-spec guard hook.
  - The only identity check, `assertQueueCheckout` (gitfile, top level, branch and common directory; `plan-queue-orphan-checkout.ts:16-31`), is used only by `reattach` (`plan-queue-worktree.ts:128`) and the reconciler report.
  - The same unchecked path feeds:
    - boot recovery (`plan-queue-item-flow.ts:147-151`);
    - Pause (`plan-queue-run-hold.ts:32-33`);
    - squash landing and base sync (`plan-queue-squash.ts`, `plan-queue-landing.ts:72-98`);
    - worst of all, `restoreCheckpointAfterVerification` → `revertToSnapshot` (`plan-queue-run-hold.ts:46-55`, `plan-queue-git.ts:56-90`). Run in the root, that would `reset --soft` the checked-out branch, `restore` every dirty tracked file and `clean -f` every untracked file, including James's active plans. That path has not been seen to run; the commit path has.
  - `removeWithProof` refuses to delete such a directory (good), which leaves it in place, so the same job can repeat the mistake. One half-made folder still exists: `.worktrees/queue/2026-10-10-oct-phase4-tooltips-78d48c`, whose `.git` points at a deleted registration. That is the safe variant: git refuses there instead of walking up.
  - Side effect: every later queue worktree carries a stale committed copy of its own plan, and one Phase 1 checker reviewed the stale copy (the live plan now has a warning about it, `docs/plans/2026-10-10-oct-phase1-token-levers_plan.md:244-250`).
- **Fix.**
  1. **One identity guard before every queue git write.**
     - At the top of `checkpoint()`, `restoreCheckpointAfterVerification`, every `revertToSnapshot` call and `syncItemWithBase` (`plan-queue-landing.ts:72-98`): `assertQueueCheckout(item.worktreePath, item.branchName, run.workspaceCwd)`.
     - Landing needs a variant. The squash builds its commit on a detached HEAD by design, and `restoreItemCheckout` repairs a crash left in that state (`plan-queue-squash.ts:50-70`, `:122`). A branch check would turn that recovery into a permanent `worktree-error`. So before `restoreItemCheckout` (which runs `checkout -f` and must never run in the root), check the gitfile, top level and common directory, but not the branch.
     - Replace each bare `existsSync(worktreePath)` with "exists **and** is this job's worktree". On failure, set the job aside as `worktree-error` with the plain note "The saved work folder isn't this job's own folder; nothing was committed."
  2. Defence in depth: set `GIT_CEILING_DIRECTORIES=<repo>/.worktrees` for every queue git call, so git can never walk up from a queue path into the root.
  3. When worktree creation fails, remove the half-made directory (or its stray `.git` link) and record "folder left behind" on the job.
  4. A test with a plain directory at the saved path: checkpoint, revert and landing must refuse.
- **Already in place:** the squash refuses to land active lifecycle documents (`ACTIVE_DOCUMENT_RE`, `plan-queue-squash.ts:30`, `:72-84`, `:132-133`). The 15 October commit came from a checkpoint in the wrong folder, which fix 1 stops.
- **Done when:** the test passes, and a forced worktree-creation failure leaves `git status` in the root unchanged.
- **Sources:** `aio2-loops-planqueue` LQ-1; `aio2-tokens-static` TS-2.

### L2. Land the work that is already built, as stacks, and make "on main" visible · P0 · M · **[checked by Claude]**
- **What's wrong.** Of the ten October plans, only Phase 0, Phase 2 and housekeeping reached `main`: they are the only October plans with a job in the "landed" state in the queue's own records (loop-mode.db, 19 Oct). A `landed_commit` alone is not proof: land-blocked jobs carry one too, including the two Phase 4 parts, whose prepared commits are not on `main`. The rest sits on queue branches. (The queue lands by squash, so even landed branches are not ancestors of `main`; an ancestry test cannot tell the two apart.)

  | Plan | Branch | Ahead / behind main | Files | Last queue state |
  |---|---|---|---|---|
  | Phase 1 token levers | `queue/2026-10-10-oct-phase1-token-le-528c17` | 29 / 0 | 466 | live: paused checkpoint at 21:43 on 19 Oct, waiting for a free slot |
  | Phase 3 calm screen | `...phase3-calm-scr-a4427f` | 10 / 8 | 217 | set aside, round limit (16 Oct) |
  | Phase 4 part 1 (tools) | `...phase4-tooltips-1b2e67` | 1 / 25 | 125 | set aside, land-blocked (12 Oct) |
  | Phase 4 part 2 (main screens) | `...phase4b-tooltip-8b1f09` | 5 / 8 | 116 | set aside, land-blocked (16 Oct) |
  | Phase 4 part 3 (rest) | `...phase4c-tooltip-7562c5` | 4 / 8 | 109 | set aside, checker unreliable (16 Oct) |
  | Phase 5 later | `...phase5-later-3e8047` | 3 / 8 | 218 | set aside, round limit (16 Oct) |
  | Follow-ups | `...oct-followups-bad1a7` | 5 / 8 | 673 | set aside, round limit (16 Oct) |

  - The 18 October retries of Phases 3, 4b, 4c, 5 and the follow-ups were all set aside with `worktree-error` at round 0, so their branches are empty.
  - The Phase 4 branches were cut from different snapshots of `main`, so they clash: 16 shared files, and each re-implemented the building blocks that part 1 was supposed to provide (TT2-1).
  - **The plans' status lines do not say any of this.** Phase 3's says "Steps 1-6, 11 and 15 are complete and verified in-loop" (`docs/plans/2026-10-10-oct-phase3-calm-screen_plan.md:3`), which is true of its branch, not of the app. Phase 4c's root copy says "0 native `title=` remaining, round 9"; its branch ends at round 3 (`65a144b19`) and still has 143 native-title hosts by template scan. No branch, task worktree or reflog holds a round 9. The claim came from a count that missed bound `[title]=` attributes, not from lost work.
  - Two landings were blocked by an uncommitted edit to `package.json` and `package-lock.json` in the root checkout (a `selfsigned` dev dependency used by one spec). 41 of 51 `land-blocked` set-asides were "root checkout has uncommitted changes to a promoted path". The document-merge fix stopped the Markdown cases after 14 October; code files still block, and nothing retries by itself (LQ-11).
- **Fix.**
  1. **A coordinator task, not a queue job:** merge `main` into each branch, resolve conflicts, run the canonical gates and the fresh-eyes gate, then land. Suggested order:
     - Phase 1 first. Its queue job is still live, so pause it before merging `main` into the branch, or the queue's own checkpoints and base sync can collide with the merge. At merge, set its two context-ceiling defaults (250K and 200K on the branch) to 0; see T1 and T7.
     - then Phase 3, then Phase 5;
     - then Phase 4 as one stack: part 1 rebased, with its copy of the D1 fix dropped because `main` has its own; then parts 2 and 3 as template and copy changes only;
     - then the follow-ups.

     Run `git merge-tree` first to size the conflicts.
  2. **Status lines tell the truth about `main`.** Add one line to every active plan's status block (completed plans stay closed): "On main: yes / no (commit)". Counts in status lines must be pasted command output (for tooltips, `npm run check:ui-hints`), never prose. The coordinator refuses a `_completed` rename while the branch the claim refers to is not merged.
  3. **The queue shows "Ready to review and merge"** for a set-aside job whose checker passed an earlier round, instead of listing it among 35 other set-aside jobs.
  4. **Landing blocks name the file and retry by themselves.** "Waiting: your uncommitted change to package.json overlaps this job." Retry automatically when that file's status changes, and resolve the `selfsigned` edit now.
- **Done when:** each of the six branches is merged or deliberately closed, and every active plan's status block says whether its work is on `main`.
- **Sources:** `aio2-ux-clarity` UX2-5; `aio2-tooltips` TT2-1, TT2-3; LQ-11; lead's branch table (Appendix D).

### L3. Checkers that wait for their own background tests · P0 · S-M · **[mechanism checked by Claude]**
- **What's wrong.**
  - 39 of 62 Claude checker sessions since 10 October never called `plan_queue_report_verdict` (32 of 48 on 19 October; an independent recount found 38). In 30 of the 39, the checker had started a background command (`Bash` with `run_in_background: true`) before its first turn ended. The step just before the turn ended was often a `Monitor` (11) or a `ScheduleWakeup` (2). The checker started the gates and ended its turn to wait.
  - The tracker settles a turn at the first `idle` or provider `complete` after any assistant output (`plan-queue-instance-tracker.ts:141-143`, `:195-197`).
  - `finishVerification` then finds no verdict and counts an errored round. Two errored rounds set the job aside as `verifier-unreliable` (`plan-queue-item-flow.ts:496-505`, `MAX_ERRORED_ROUNDS = 2`).
  - AIO already tracks pending background work per session (`instance-async-work-registry.ts:94-97`, `hasInhibitor`), used by hibernation and the resource governor, but nothing in `src/main/plan-queue/` reads it.
  - All 8 `verifier-unreliable` set-asides on 19 October were this. Each wasted round is a checker session of about 5M tokens counting cache reads.
- **Fix.**
  1. Do not settle a queue turn while `hasInhibitor(id)` is true. Settle when the provider resumes and finishes, or after the existing 10-minute stalled-work check-in. The registry tracks background shells and helper agents only (`claude-cli-async-work.ts:3`), not `Monitor` or `ScheduleWakeup`, but every checker that used those had also started a background shell, so this still covers them.
  2. A turn that ends without a verdict gets **one** cheap nudge in the same session ("call `plan_queue_report_verdict` now with what you found") before it counts as an errored round. `finishVerification` stops the checker first today (`plan-queue-item-flow.ts:468`), so the nudge must come before that stop.
  3. One prompt line for workers and checkers: "Run checks in the foreground. Your turn ending is the signal, so don't end it while a command runs." Workers need it too: 7 of 49 Claude workers started a background command before their first turn ended.
  4. Optional: set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for queue roles and deny `ScheduleWakeup` by name. (`disallowedTools` matches whole tool names, so it cannot switch off only Bash's background mode.)
- **Done when:** the share of Claude checker sessions without a verdict falls below 5%.
- **Sources:** LQ-2; hermes' goal-judge "wait" verdict is the same idea for loops (`ref2-hermes-runtime` leads).

### L4. Harness runs the tests; checkers get receipts and must say what they did not check · P1 · M · **[checked by Claude]**
- **What's wrong.**
  - The checker runs the gates itself (a mean of 5.65 gate runs per stored verdict) and reports their exit codes through the verdict tool.
  - The coordinator stores whatever is reported (`plan-queue-coordinator.ts:480-492`), and a `PASS` goes straight to landing (`plan-queue-item-flow.ts:509-513`). Nothing compares `PASS` with the reported gates.
  - In the database, 8 landed jobs have a final `PASS` whose own `gatesRun` lists a non-zero exit. Their labels ("run 1", "initial", "RED check") suggest earlier failing runs that were then re-run, so this is not proof of 8 bad landings. The point is that nothing checks.
  - 15 of 49 round-limit set-asides ended with a failing gate, and the queue never records which failures were already present on the base branch.
  - The coordinator already has a proper gate runner (own process group, 15-minute limit, output tail) for the post-merge check (`plan-queue-landing.ts:101-120`).
- **Fix.**
  1. Before spawning a checker, the coordinator runs the gate list in the job's worktree and keeps a receipt per gate: command, exit code, duration, a 2 KB tail and the worktree HEAD.
  2. Classify test output four ways: verified, failed, no tests, unrecognised (storybloq's `classifyEvidence`, `storybloq/src/core/setup-verify-parsers.ts:420`).
  3. A red gate goes straight back to the worker with the tail. No checker session is paid for.
  4. The checker gets the receipts table and is told not to re-run a green receipt unless it changes files.
  5. Add a required `not_checked: string[]` to the verdict tool (empty allowed; "TODO" or "not run" rejected). Validate it inside the tool call and return a fixable error while the checker's turn is still open (oh-my-codex's evidence report).
  6. Run the gates once per base commit on a clean checkout of the base, mark each failing receipt "also failing on base" or "new", and let only new failures block. Reuse the loop's failure-key classifier (`loop-verify-baseline-compare.ts`) rather than writing another.
- **Done when:** a `PASS` with an unexplained red receipt is refused by code, and the job card shows "Passed. Not checked: …".
- **Sources:** `ref2-storybloq-tura` SB2-1, SB2-5; `ref2-omx-claw` OMX2-2 (and its counter-check); LQ-12.

### L5. One failure no longer sets aside the whole queue · P1 · S
- **What's wrong.**
  - **Environmental errors are discovered once per job.** A run with one worker slot set aside 19 jobs in a minute on "Maximum concurrent worktrees (5) reached". The 269- and 44-job triage set-asides and the 9 `no-diverse-verifier` set-asides have the same shape: one condition true for every job, discovered per job. `startItem` sets aside on any preparation error (`plan-queue-item-flow.ts:120-127`), and the scheduler then starts the next job, which hits the same wall.
  - **The global cap is invisible to the queue.** It counts only its own jobs per run, across any number of parallel runs, while `WorktreeManager` refuses at 5 (`worktree-manager.ts:110-120`).
  - **One account setting became nine set-asides.** A workspace claimed by two protected Copilot account scopes caused all 9 `no-diverse-verifier` set-asides, each after the worker had already done its round, because checker selection runs only at verification time.
  - **A worker turn that fails is never retried.** It is stopped and set aside at once (`plan-queue-item-flow.ts:279`, `:305-307`).
  - **Nothing caps restart resumes.** Every boot resumes every interrupted job, and no counter of consecutive restart resumes exists.
- **Fix.**
  1. Classify preparation and spawn errors as **transient capacity** (worktree cap, resource governor, load gate, provider at capacity) or **this job**. Transient errors put the job back in the queue with back-off and the words "waiting for a free work folder (5 in use)".
  2. After two identical "this job" errors in a row, pause the run once with one sentence: "Paused: every job fails with the same error. Fix X, then Resume."
  3. Resolve the checker plan, worktree capacity and account fences once at run start (and on any routing change). Refuse or pause with the real reason and a link to the setting.
  4. Retry a worker turn that failed for a transient reason once or twice in the same session (15 s then 45 s, with a "finish the item with a real result" nudge) before setting it aside. Retry only an allow-list of transient failures, never deterministic ones (hermes' `kanban_turn_recovery.py`).
  5. Three restart resumes in a row without a new round sets the job aside as "restarted 3 times without progress", with a Retry button (t3code, pi).
- **Sources:** LQ-4, LQ-5, LQ-7; `ref2-hermes-runtime` HE2R-5; `ref2-t3code` T32-5; `ref2-pi-rtk` PR2-10.

### L6. Discovery that finds only real plans, and remembers what it decided · P1 · S
- **What's wrong.**
  - **Evidence copies get queued.** Discovery walks every `*_plan.md`, `*_livetest.md` and unplanned `*_spec.md` under the pattern, skipping only fixed directory names (`plan-queue-discovery.ts:26-36`). work-finding keeps whole copies of plan trees inside evidence folders, up to 21 levels deep. 495 jobs pointed at 163 such copies, and three runs found 312, 314 and 274 documents. One was cancelled within 7 minutes, one was mass set aside by the old triage, and in one (18 October) James pressed Skip 272 times in 209 seconds. The pattern a run used is never saved (0 of 181 runs).
  - **Decisions are not reused.** 1,661 jobs covered 547 documents; 375 documents were queued in more than one run, 62 five or more times. Every run re-triages unchanged documents, and 13 of 38 answered documents were asked the same question again in a later run.
  - **"Skipped" is mostly not a decision.** 586 of the 938 skipped rows are leftovers of cancelled runs, 314 are James's own Skip presses, and only about 38 are triage decisions.
  - **Single-document runs pay for triage anyway.** Every one gets a model triage pass first (about 67K tokens median; 31 such runs in three days), even when James chose the document himself.
- **Fix.**
  1. Skip folders whose names contain `snapshot`, `evidence`, `observation` or `receipts`, and any plan folder nested inside another plan folder. Honour a per-repository `.planqueueignore`.
  2. Save the pattern on the run. Show "N documents found (M look like copies, hidden)" and ask for confirmation above about 25. Add a "Skip all not started" button.
  3. Remember triage decisions and answers by the SHA-256 of the document and its linked spec. If unchanged, reuse them ("Already decided on 14 Oct"). A cancelled run leaves untouched documents as "not reached", not "skipped".
  4. No model triage for documents James picked explicitly: run the deterministic checks and queue them. The worker can still ask through the existing "needs James" path.
  5. Apply T1's size gate at discovery too, with T1's wording and thresholds, so a document that is too big is listed rather than queued. The gate is defined once, in T1 item 5.
- **Sources:** LQ-6, LQ-8, LQ-9, LQ-10; SB2-4, SB2-10; lead queries of loop-mode.db for the 375 repeat documents, the 13 of 38 repeat questions and the 586 cancelled-run leftovers (reproduced by `_verify-2`).

### L7. Memory between rounds: keep every verdict, give the next checker the history, and stop repeating the same fix · P1 · M
- **What's wrong.**
  - Each verification round starts a brand-new checker session (`plan-queue-item-flow.ts:404-423`) that reads the plan, the spec and the diff cold. Its prompt never sees earlier findings (`plan-queue-prompts.ts:176-217`).
  - Only the last verdict per job survives (`verdict_json` is overwritten each round), and `resume()` resets round, verdict and detail. No event table exists, so park history and repeated findings cannot be measured.
  - Of 136 landed jobs, 83 passed at round 1, 36 at round 2, 11 at round 3 and 6 later. 39 of the 49 round-limit set-asides came from runs capped at 3 rounds.
  - When a fix round changes nothing (same worktree HEAD, same document), a full checker round is still spent.
- **Fix.**
  1. A `plan_queue_item_events` table (time, from and to state, reason, a detail head, verdict summary, round, tokens) and a `plan_queue_verdicts` table (one row per round, findings with stable ids).
  2. Rounds 2 and later give the checker an "earlier rounds" block of at most 12,000 characters: each earlier finding with the worker's claimed fix or dispute, marked "unconfirmed, re-check", plus `git diff <last checked commit>..HEAD`. Keep the whole-diff read. Storybloq traced most of its empty "revise" rounds to cold re-reads.
  3. If worktree HEAD and the document's hash are both unchanged since the last FAIL, do not spawn a checker. Build one progress fingerprint (worktree HEAD, document hash, round) and use it here, in fix 4 and in L5's restart counter, so the "no progress" check exists once. Re-prompt the worker once ("nothing changed since the FAIL; fix each finding or explain with file:line evidence"), then set it aside early.
  4. When the same finding fails twice, add a three-line step-back note to the fix prompt ("Reproduce it and find the cause; if the finding is wrong, say so with evidence"). If it survives a third round, set the job aside as `stuck-on-same-finding` with the evidence. Run this as log-only for a week first.
  5. A queue job whose document already has a set-aside branch from an earlier run offers "Resume the set-aside job" instead of creating a new one.
- **Sources:** LQ-9, LQ-12; SB2-2, SB2-3; `ref2-omo-slim` OMO2-4.

### L8. Stop the plan queue waking the chat that started it · see T4
The queue's jobs are children of the chat that started the run, so every job that ends sends that chat a child result and a "please write a full report on all N children" prompt, each a real model turn. Its own notices (questions, run-end summary, adoption, routing changes) are model turns too. Together that was about 5.3 billion tokens on Codex in ten days. It is a token item first, so it lives in T4.

### L9. A queue page James can read at a glance · P1 · M
- **What's wrong.**
  - The page stacks seven sections: Needs your answer, Runs, Providers and accounts, Start a run, Needs James, Parked work and Reconciler alerts. "Reconciler alerts" always shows, even when empty (`features/plan-queue/plan-queue-page.component.html:6-99`).
  - "Runs" renders the latest **50** runs as full cards (46 of them finished). "Parked work" lists **35** set-aside jobs, each with a raw branch name, free-text detail and 3-4 buttons.
  - Details print verbatim: up to 2,984 characters, and 17 contain absolute `/Users/` paths.
  - Internal words: Parked, Land anyway, Reconciler alerts, livetests, policy-gated, Glob, a raw run kind, "Workers: codex", "PASS — 2 high", and five "(s)" plurals.
  - Two set-aside labels point the wrong way:
    - "The checker kept failing" for what is really L3.
    - "No second model free to check it" for what is really an account-scope conflict (L5).
  - "Still failing after the last check" asserts a cause the queue cannot know; the round limit only says the rounds ran out.
  - The 355 old triage set-asides still show as "The worker stopped with an error".
- **Fix.**
  1. Three tabs:
     - **Now:** questions, running and paused runs, Start a run.
     - **Set aside:** grouped by document, newest attempt only, older ones folded as "2 earlier tries".
     - **Setup:** providers and accounts.

     Finished runs fold into "History (46)", one line each.
  2. One table, `PARK_REASON_HELP: Record<reason, {meaning, next, actions}>`, checked at compile time, so a new reason cannot ship without words. Show the meaning and the next step under the label, and only the buttons that apply. "Choose a checker" for an account conflict; "See what the checker found" before Resume on a round limit.
  3. Fold `detail` behind "Details" and strip absolute paths. Relabel the 355 historical rows "couldn't check readiness (old classification step)", and give a missing document its own reason instead of `worker-error` (`plan-queue-readiness.ts:118`).
  4. Words: Parked → "Set aside"; Land anyway → "Merge without checks"; Glob → "Which files (pattern)"; real plurals; round limit → "Ran out of rounds (3 of 3)" plus the last finding.
  5. Bulk actions only through a preview: "Resume all N set aside for this reason" shows will change / left alone (with reason) / not applicable, then one confirm. Never bulk "Merge without checks" or Discard (storybloq's `triage --apply`).
  6. Hide the empty alerts section, and link the housekeeping "Leftover work folders" card instead of a second list.
- **Sources:** UX2-1; SB2-8, SB2-9; LQ-3, LQ-17; jean's "Mr. Robot" shape (JN-6, in the first list).

### L10. Scheduled jobs: a time limit, a quiet result, a token cap, and a fair restart · P1 · S-M each · **[restart and limit checked by Claude]**
- **What's wrong.**
  - **No time limit.** The automation runner has no wall-clock cap; the only liveness guard is an adapter's no-event stall check. In 30 days, 51 of 667 runs lasted over an hour, and three sat "running" for 15-18 hours until an app restart killed them.
  - **A restart is booked as a failure.** At start-up `failRunningRuns('App restarted before automation run completed')` marks every running run failed and sets a one-time automation's next run to nothing (`automation-runner.ts:128-136`, `automation-store.ts:686-724`). 9 runs ended this way in 30 days, none was retried, and one one-time job was lost for good.
  - **Quiet runs, wrong models and expensive failures (10-19 October).** 25 runs a day. Between 39% and 84% of successful runs found nothing to do, depending on which words in the summary count as "nothing" (TD-6's match: 132 of 225, 0.87B tokens); no run records a proper result. Failed runs averaged 54.6M tokens, but that is one run of 794M: 10 of the 15 failed runs cost nothing. One Opus job ran 18 times, all quiet, at 11.4M tokens a run; a Sonnet monitor doing similar work costs about 40 times less per run. 71 of the 100 enabled automations are pinned to an Opus-family model and none to Sonnet.
  - **The pre-check (A15) is not running.** It is built but waits on the Phase 1 branch.
  - **A run "succeeds" the moment the session goes idle after any output** (`automation-runner.ts:413-415`). There is no structured result, no quiet outcome and no "empty output" check.
  - **Agents can raise a job's cost.** `update_automation` accepts `reasoningEffort` up to `max`, `ultra` or `workflow` and `yoloMode` from any session, and applies them without comparing them with the caller's own settings (`orchestrator-automation-tools.ts:203-208`, `automation-tool-impl.ts:327-346`). 32 of the 100 enabled automations run with auto-approve; who set them is unknown.
- **Fix.**
  1. **Time limit.** A per-job "Stop this run if it takes longer than N minutes" setting. New jobs default to 90 minutes; existing jobs get 1.5 times their longest successful run. On expiry, cancel the session and its children, keep the output so far, and record "stopped after N minutes" (a reason A15's retry rules never retry). openclaw defaults to 60 minutes for agent jobs (`openclaw/src/cron/service/timeout-policy.ts:9-29`).
  2. **Restart.** An app restart marks a run "Interrupted by an app restart". Enabled, unchanged, agent-prompt jobs get **one** fresh retry with "The previous run was cut off by a restart; check what it already did before continuing". Never replay system actions or anything that already delivered, restore a one-time job's next run for the retry, and do not count it towards the failure streak (openclaw `9b2bc0ed7e1`, `2d3cb1c426a`).
  3. **Quiet result, done reliably.**
     - When A15 lands, register an `automation_result` tool from the first turn of every automation session (`{outcome: no_change | done | needs_attention, notify}`), so the tool list never changes mid-run.
     - Do not rely on a text sentinel: openclaw needed three repair commits in a week for `NO_REPLY`.
     - A run that ends with neither a result nor any text is a failure.
     - Never decide failure from the agent's prose.
     - Skip the model call entirely while the delivery destination is known to be unavailable.
  4. **Token cap.** Stop a run past N processed tokens (defaults about 30M for recurring jobs, 100M for one-time jobs) and record "stopped: token cap".
  5. **Cheaper models where they fit.** Default new "check" jobs to Sonnet at low effort, and suggest it on existing monitors whose last 10 runs were quiet.
  6. **Slow down while nothing changes** (opt-in). Double the interval while the normalised output is unchanged (times, dates, durations and ids stripped), cap at 4 times nominal, snap back on any change. Show "Next check in 40 min (no change for 3 checks)" (hermes `/loop`, `hermes_cli/loops.py:598-606`).
  7. **Agents may not raise a job above their own level.** Agent callers cannot raise a job's model tier, effort or auto-approve above the calling session's own (jean's "no escalation" rule, `jean-core/src/agents/self_manage.rs:87-135`). Return a teaching refusal; the human form stays unrestricted. Clamp agent-set effort on machine work at `max`, because `ultra` makes Codex start helpers by itself (T3).
- **Done when:** no run can exceed its limit, a restart leaves "interrupted, will run again" rows instead of failures, and the Automations page shows quiet runs greyed out.
- **Sources:** `ref2-openclaw-runtime` OC2R-1, OC2R-2, OC2R-4; `aio2-tokens-db` TD-6; HE2R-4; `ref2-jean-nanoclaw` JN2-3; LQ-16; CX2-3.

### L11. One "Pause new work" switch · P2 · M
- **What's wrong.** There is no single lever that stops new loop rounds, plan-queue jobs, scheduled runs and wake-ups from starting. The plan queue has its own "Pause all / Resume all", loops pause individually, and quota parking is automatic.
- **Fix.** An `UnattendedPauseService` holding `{engaged, reason, since}`. It is persisted, and an optional sentinel file in the data folder lets a script, an agent (through `aio-mcp`) or the phone gateway engage it when the window is stuck. Every start-of-work point asks it first and skips quietly; running work finishes. A title-bar chip says "Paused: <reason>, Resume". Tooltip: "Stops new loop rounds, queue jobs, scheduled runs and wake-ups from starting. Anything already running finishes."
- **Note.** The hermes engine scout judged this polish, because the queue already has Pause all. The hermes interface scout argued it matters for a runaway or a quota emergency. Kept here at P2.
- **Sources:** `ref2-hermes-ux` HE2U-4 (hermes `agent/estop.py`).

### L12. The live-check backlog and its 1 MB register · P1 · S
- **What's wrong.**
  - **Deferred live checks pile up.** 73 `*_livetest.md` documents are pending (68 completed). Each plan that defers live checks adds one, and none runs unless someone queues it.
  - **The register has grown to 1 MB.** `docs/plans/livetest-remediation-register.md` is 1,058,876 bytes (13,260 lines; 211 of 245 rows closed). Livetest workers are told to file every reproduced defect there (`plan-queue-prompts.ts:101`; runbook), so each filing at least greps the file for the next id. A full read is about 265K tokens.
  - **The instructions point at a closed plan.** AGENTS.md also tells agents to add a matching section to `2026-07-19-livetest-failure-remediation_plan`, which is now `_completed` and closed by James's own rule.
- **Fix.**
  1. Move closed register entries to `livetest-remediation-register-archive-2026.md`, which agents are told not to read, keeping the index.
  2. Add a tiny "next LT id" helper (pure code over the index, or an MCP tool), so filing never needs a read.
  3. Point AGENTS.md at a live remediation plan, not a `_completed` one.
  4. Run a weekly live-check campaign on the Windows PC from the queue, starting with the October plans' livetests once L2 lands.
- **Sources:** TS-3; lead counts (Appendix D).

### L13. Loop and queue odds and ends · P2 · XS-S each
1. **Five dead "paused" loop runs** (9 May, 17 May, 8 June, 10 June, 13 July) are still open. Close them (B1.6 housekeeping, not done).
2. **Receipts for automatic nudges.** The loop queues idle nudges and step-limit continuations with a `source` tag (`loop-idle-nudge.ts:60-95`), but the screen has no handling for them (`rg -i nudge src/renderer` finds nothing). Show each as a collapsed, timestamped row ("Harness nudge, 14:32: not done, 3 items open"), separate from James's own messages (openclaw `aaed6bfc00c`).
3. **A "status-only turn" counter** (no tool calls, short output) on the loop scorecard and the queue round record, so a future wording change that causes narration loops shows up (oh-my-opencode-slim saw 16.8% of messages become status narration).
4. **Harness's own text in summaries.** The restart-compaction summariser receives every `type === 'user'` message as `[user]: …` (`src/main/context/restart-compaction.ts:15`). The verbatim user-message section filters internal inputs, but loop-start and intervention messages carry other metadata kinds. Label Harness-written turns as `[harness]` in the summary input, so a summary never records Harness's words as James's (UNVERIFIED how often it happens; claw-code's reverted `6a797de0` describes this exact failure).
5. **Machine-started workers are unattended.** A worker's question sets the job aside and asks James. Mark queue sessions "unattended", so routine clarifications follow the decision-7 rule from 10 October: go ahead with the recommendation and log it.
- **Sources:** LQ-15; `ref2-openclaw-ux` OC2U-6; OMO2-8; OMX2 leads; HE2R leads.

---
## T. Spend fewer tokens

Codex is now 81% of token volume, so the first five items are about Codex and the plan queue. The Claude items follow.

### T1. Plan diet: a short status block, history aside, one queue job per step · P0 · M · **[sizes checked by Claude]**
- **What's wrong.**
  - **Every queue role is told to read the whole plan.** The worker reads the plan, its spec and every file it changes, then "update[s] the plan's status and as-built notes" each round (`src/main/plan-queue/plan-queue-prompts.ts:80`, `:86`, `:121`). Resumes start by reading the as-built notes (`:163`). Checkers judge "every item ... and every acceptance criterion" from the document (`:186`, `:194`). Triage reads each document in full (`:223`).
  - **There is no size guard anywhere in the queue.** Discovery even reads whole files to take 40 header lines (`plan-queue-discovery.ts:98-105`).
  - **The active plans are huge.** Six of the 12 active plans are 254-590 KB, about 64K-147K tokens per full read at about 4 bytes a token: Phase 1, Phase 3, the follow-ups, the checkout-timeout plan, Phase 5 and Phase 4 part 1. The median is about 170 KB, and nine of the 12 are over 80 KB.
  - **What the bloat is, by section:**
    - Phase 1: the step body (439 KB) has not changed since 15 October. All growth since then is journal: 11 stacked status blocks at the top (5 KB to 42 KB) and as-built notes from 10 KB to 109 KB.
    - Phase 0: 60% of the file is as-built notes from 37 dated rounds.
    - The checkout-timeout plan reached 248 KB in about a day and a half, as a 9-item checklist followed by about 45 dated "continuation / repair / handoff" sections.
    - Across the six largest plans, history-type sections are 12-25% of the bytes (60% in Phase 0) and step sections 32-69%. The plans were also written very large in the first place.
  - **Measured cost, Codex sessions in the AIO folder, 15-19 October.** 1,338 tool calls that read the big plans returned 22.1M characters, 12.4% of all tool output. Held in context until the next compaction, that is **about 360M tokens re-sent across 23,692 model calls, 8.5% of those sessions' input**. 99 of 113 Codex helper threads re-read the plans too. These were ordinary Codex sessions in the root checkout, not queue jobs: no AIO Codex session in that window ran inside a queue worktree, and most of the journal blocks in Phases 0 and 1 were written by such sessions.
  - **Claude queue sessions in other repositories** (median plan 30 KB) spend 21% (workers), 65% (resumes), 22% (checkers) and 45% (triage) of their tool-result text on plan documents. Every one of 62 checker sessions read the plan.
  - **Big plans also fail.** Of the 14 most expensive queue jobs, 9 have plans over 100 KB. A Phase 1 checker is asked to judge 590 KB of plan plus a 2.47 MB diff, which no context holds; Phase 1 had 5 errored checker rounds out of 6.
- **Fix.**
  1. **One replaceable status block, for every session.** Anyone working from a plan keeps one `## Status` block at the top, at most about 1,500 characters (done, next, decisions, open issues, pointers to sections), and rewrites it in place. Nobody adds dated sections. Round evidence goes to `<stem>_history.md` beside the plan, which agents are told not to read unless the status block points there. History lives in commit messages and verdicts (oh-my-opencode-slim's deepwork rules, `src/skills/deepwork/SKILL.md:100-134`).
     - Put the rule in AGENTS.md's "Plan and Spec Filename States" section as well as in the queue prompts. The measured re-reading came from ordinary sessions in the root checkout, which read AGENTS.md and never see the queue prompts.
     - Add `_history` to the plan-and-spec guard hook's pattern and to the squash's `ACTIVE_DOCUMENT_RE` (`plan-queue-squash.ts:30`). Today both match only `_spec`, `_spec_planned`, `_plan` and `_livetest`, so an active history file could be committed while its plan is still open.
  2. **The coordinator enforces it for queue jobs, in plain code.** At each checkpoint, if the document grew by more than 8 KB or holds more than one status block, move every dated section under the as-built heading into the history file, leave a one-line pointer, and log the bytes moved. Move, never delete. Workers, checkers, ordinary sessions and James all edit the root copy, so compare the file's hash just before writing and skip (and log) the move if it changed in the meantime.
  3. **Hand roles the lists, not the document.** The coordinator extracts the unchecked `- [ ]` items and the step's "Done when / acceptance" bullets (at most about 4 KB) and passes them inline. Checkers also get `git diff --stat`, open plan sections only by line range, and from round 2 get the earlier-rounds block (L7). Triage gets the 40-line header discovery already holds.
  4. **Pin the criteria and show the checker the document diff.** Store the plan's SHA-256 and its unchecked items when the job starts, and give the checker "document changes since this job started". Today a worker can delete or reword an unchecked item, and the checker, judging the edited document, cannot see it (storybloq pins approved plans by hash, `src/core/plan-snapshot.ts`).
  5. **Size gate and step-sized jobs.** A plan over about 120 KB is listed "split into step documents, or run the diet first"; over 200 KB it is refused (storybloq's bound). A plan with `## Step N` headings above the limit becomes one queue job per step (a `section` column on the job; the worker prompt says "implement Step 8, lines 2002-2324; read the header and that step only"). Ship the gate as a warning first and refuse only after the one-off diet (item 7): six active plans are over 200 KB today, including the stranded October work that L2 needs to retry. This is the only size gate; L6 points here.
  6. **Close small.** At the `_completed` rename, move journal sections to `<stem>_history_completed.md` and keep an as-built summary of at most about 3 KB, so a completed plan cited as a dependency stays cheap.
  7. **One-off clean-up** (James's call): run the diet over the six active plans above 100 KB. The seven completed plans over 100 KB stay as they are, because completed files are closed; item 6 applies to plans completed from now on.
- **Sequencing warning.** The Phase 1 branch (waiting for its check) ships context ceilings of 250K for James's own chats and 200K for machine-started Claude sessions, and queue checkers count as machine sessions. Codex-built jobs are checked by Claude, which would summarise itself at about 167K tokens, before it can finish reading a 147K-token plan plus the diff. When Phase 1 is merged, set both defaults to 0: the machine ceiling stays 0 for good, and own chats move to about 300K only after T7's recall check.
- **Expected benefit.** About 300M tokens per five days at the 15-19 October pace (about 7% of AIO's Codex input), **if every session obeys the status-block rule** and holds about 25 KB of plan instead of about 150K characters. Most of that comes from the one-off diet (item 7) and the AGENTS.md rule, because the measured waste was in ordinary root-checkout sessions; items 2, 3 and 5 protect queue jobs. Fewer checker failures too, not quantified.
- **Sources:** `aio2-tokens-static` TS-1, TS-4; `aio2-tokens-transcripts` TR2-3; OMO2-1; SB2-10; LQ-13.

### T2. Keep machine-started Codex work under 272K tokens · P0 · S
- **What's wrong.**
  - **The window changed underneath AIO.** On about 11 October Codex's model catalogue (fetched from OpenAI's servers, not a CLI upgrade) raised gpt-6.1-sol's window from 272K to 500K (`~/.codex/models_cache.json`: `context_window=500000`; the repository's bundled catalogue still says 272000). AIO sends only percentage settings: compact after a step at 60% for Harness work and 70% for chats, plus tool-output caps (`src/main/cli/adapters/codex/codex-thread-policy.ts:19-22`). Those now mean 285K and 332K instead of 155K and 181K. Codex's own mid-turn limit rose from 244.8K to 450K.
  - **Requests grew.** Measured on AIO's Codex sessions:
    - average input per request rose from 124K (10 October) to 142-182K (12-19 October; above 164K on every day but 14 October);
    - requests above 200K went from 9% to 33-39%;
    - mid-turn compactions are still 86-98% of all compactions.
  - **A price line is being crossed.** OpenAI's model page says prompts above 272K are billed at 2x input and cache rates and 1.5x output for the whole request (read once, through a summarising tool; re-check the page before relying on the exact multipliers). On most days from 12 October 13-19% of requests crossed it (6% on 14 October), about +22% at list price for 12-19 October ($3,121 to $3,806). Whether plan credits weigh it the same way is unverified; K3's credit read settles it.
  - **The trial measures the wrong thing.** The A16 trial began on 17 October, after the change, so both arms run at the new operating point.
- **Fix.**
  1. Send `model_context_window = 272000` on every Harness-started Codex thread (loops, plan queue, scheduled jobs, children, reviews). One key restores the 10 October operating point: usable 258,400, mid-turn limit 244,800, after-step compaction at about 155K.
  2. Make 500K an opt-in for James's own chats, with the plain warning "Requests above 272K cost double each; Harness keeps unattended work below that line".
  3. Add the key to the "unsupported config" retry pattern (`codex-thread-requests.ts:11-13`), and show the effective window in the context diagnostics.
  4. Teach AIO's price table the long-prompt premium for gpt-6.1-sol and gpt-6-astra (per request, from `thread/tokenUsage/updated`).
- **Done when:** average input per request for machine-started Codex threads is back near 124K and no request exceeds 272K.
- **Expected benefit.** Up to 25-30% less Codex input for the work it applies to, minus some extra compactions. It overlaps with T3, so the two savings do not add up.
- **Risk.** More compactions mean more summary loss. An earlier scout and AIO's own context-safety policy found early compaction harmful, so watch the re-anchor after compaction, and make sure the loop recycle ceiling and this setting never fire at the same point. Codex clamps the setting to the model's maximum, so a wrong value cannot break a thread (`codex-rs/models-manager/src/model_info.rs:19-28`).
- **Sources:** `ref2-codex` CX2-1, CX2-4; `aio2-tokens-transcripts` TR2-9; `_verify-2` S12.

### T3. Codex helper agents: settle the trial for machine work, start-clean helpers for chats, and a ceiling for runaway turns · P0-P1 · S-M · **[defaults checked by Claude]**
- **What's wrong.**
  - **Helpers are most of Codex's input.** Helper threads are 66-73% of AIO's Codex input since 12 October (49% on 10 October), about 15 helpers per root thread, and Codex input per day is 2.4 times the month before.
  - **The side-by-side trial you approved is running.** On 10 October you approved "off for loops and the plan queue; a cheaper setting for your own chats; full on request. Try it side by side first (A16)" (first list, Decision 3). Both settings now default to that trial (`src/shared/types/settings-defaults.ts:160-161`). In its first three days, plan-queue turns with helpers off used about 11% fewer tokens: 7.8M against 8.8M per turn, over 72 and 67 turns, a heavy-tailed sample with no spread measured. Nobody has compared the two arms' checker pass rates. The chat arms are decided by which few heavy sessions happened to hash where.
  - **The "cheaper" chat setting does not reduce the number of helpers.** It allows two at a time at medium effort; 8 of 8 such threads spawned helpers, 51 on average against 13 on the full arm.
  - **Every helper starts as a full copy of the parent.** `spawn_agent` defaults `fork_turns` to "all" unless the model says "none" (`codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:214-238`), so each helper re-reads the whole parent conversation on every request.
  - **The "ultra" effort makes Codex delegate on its own** (`codex-rs/core/src/session/multi_agents.rs:77-110`). AIO offers "ultra" for Codex and for scheduled jobs with only a label.
  - **51 turns of at least 100M tokens hold 63% of all AIO token volume since 10 October.** All but two are Codex with helpers; the four biggest used 1.56-1.84 billion tokens each.
- **Fix.**
  1. **Settle the trial for Harness work** (Decision 13). Add each arm's checker pass rate to the comparison, run it for about a week, then default `codexHelperAgentsHarnessWork` to `off` if "off" is no worse. Keep the trial for chats only if it is redesigned to compare per turn and per thread with medians (K3 gives it an honest unit), and restart the chat arms after T2 lands, because T2 moves their operating point again.
  2. Add a chat arm that steers helpers to start clean: `features.multi_agent_v2.multi_agent_mode_hint_text` with one sentence ("Start helpers only when asked or when work is independent and long; pass fork_turns="none" and put everything the helper needs in the message"), and optionally `agents.default_subagent_model` set to the cheaper model in the catalogue.
  3. The picker says what "ultra" does: "Lets Codex start helper agents by itself; costs much more". Clamp scheduled jobs and Harness work to at most "max".
  4. A per-turn token ceiling for Codex turns, using the token notifications the accounting already receives:
     - at about 150M processed tokens, steer "wrap up and report what's done";
     - at about 300M, interrupt.

     The interrupt is a deliberate stop, not a failure: give it its own set-aside reason ("Stopped by Harness: this turn passed 300M tokens") that L5's retries never retry, and use the same "stopped by Harness" wording for T1's size gate. A "biggest turns this week" list on the Costs page shows the next one.
  5. Store each turn's helper share (child-thread tokens against root tokens), so "helpers cost X%" is a number, not an inference from the "estimated" flag.
  6. Land the Codex "standing notes" fix from the Phase 1 branch (re-sending Harness's notes after Codex compacts) and its trial report.
- **Expected benefit.** If the 51 mega-turns had stopped at 150M each, about 17B of their 24.8B tokens would not have been processed (an upper bound, since some work moves to later turns). Helpers off for all Harness work saves about 11% per plan-queue turn on current evidence (thin: three days, 72 against 67 turns). T2 and T3 act on the same tokens (a smaller window shortens every request, helpers' included, and most mega-turns are helper threads), so their savings do not add up. Measure after T2 lands before judging T3.
- **Sources:** TR2-1; CX2-3, CX2-4; `aio2-tokens-db` TD-2, TD-3; `_verify-2` M3, S11, S15.

### T4. Stop the plan queue waking the chat that started it · P0 · S-M · **[path checked and figure re-measured by Claude]**
- **What's wrong.** The queue wakes its parent chat in three ways, and each one starts a model turn that carries the parent's whole context.
  1. **Its own notices.** `PlanQueueParentMessenger.send()` delivers worker questions, readiness questions, the run-end summary, adoption ("You now own Plan Queue run …"), routing changes and replays as `sendInput(parentId, message, …, { automatedInput: true, internalSource: 'plan-queue' })` (`src/main/plan-queue/plan-queue-parent-messenger.ts:79-96`).
  2. **A "child completed" result after every queue job.** The queue creates its triage, worker and checker sessions as children of the chat that started the run (`parentId: this.host.liveParentId(run)`: `plan-queue-item-flow.ts:212`, `:407`; `plan-queue-triage.ts:133`). When one exits, the general child-completion handler (`src/main/instance/instance-child-completion-handler.ts:85-145`) injects a `child_completed` orchestration response into the parent (`orchestration-handler.ts:1077-1123`).
  3. **"Please write a full report" after every queue job.** When the handler counts no other child still running (`instance-child-completion-handler.ts:143`), it also sends "All N child instances have completed … Please synthesize these results into a comprehensive report for the user" (`orchestration-handler.ts:1129-1156`).
     - Queue jobs never enter the orchestration handler's own child list (`addChild` runs only for children spawned through orchestration commands, `orchestration-handler.ts:196-201`, `:1038`), so it counts zero running children after every queue job, even while other jobs run.
     - The list in the prompt holds every child the chat has ever had, because the completed set is cleared only when the parent closes (`orchestration-handler.ts:96`, `:174`). Each summary appears twice, once in the JSON and once in the prompt text.
     - One chat that started 11 runs on 14-15 October received 43 of these prompts. The last one listed 43 children in 75K characters.
  - **None of this matches the queue's own design note.** The parent "is told about questions … and gets one summary when the run ends" (`plan-queue-messages.ts:1-8`).
  - **Measured since 10 October** (rlm.db `prompt_admissions` and the cost-attribution log, re-run by Claude on 19 October). Every child-result message came from a queue job: 251 `child_completed` messages delivered, all for "Queue …" sessions, and 252 "all completed" prompts delivered, each within a minute of a queue job ending. Each turn in the 53 chats that started a queue run was attributed to the latest message delivered before it:

    | What came just before the turn | Codex turns | Tokens processed | Per turn |
    |---|---:|---:|---:|
    | "All completed, please write a full report" | 282 | 3.67B | 13M |
    | One of the queue's own notices | 30 | 1.38B | 46M |
    | A single child result | 317 | 0.23B | 0.7M |
    | James's own message (for comparison) | 50 | 1.97B | 39M |

    **That is about 5.3B tokens in 9.9 days on Codex (about 0.53B a day), plus 0.2B on Claude.** The split is by time order, so confidence in it is medium; the code path is verified.
  - **Deliveries also fail and collide.** Failed child-result deliveries since 10 October, all queue-driven: 646 "instance or adapter unavailable", 203 "timed out waiting for the Codex turn to accept", 165 "adapter changed" and 112 "previous turn still running". The queue's own notices failed 80 times (37 usage limit, 33 "adapter not spawned").
- **Fix.**
  1. **No child-result messages for queue sessions.** They carry `metadata.planQueueRole`. Have the child-completion handler skip the `child_completed` and "all completed" injections for them, and keep the visible "Child completed" line in the parent's output, which costs nothing. The run-end summary already tells the parent what happened, so this restores the documented design.
  2. **For every other child, report only what is new.** List only children finished since the last "all completed" prompt, include each summary once, and cap the prompt at about 8K characters, leaving the rest in the stored child results.
  3. **Queue notices as quiet notes.** Post them as visible status messages that do not start a turn, and keep `sendInput` only for questions James routes to the parent chat. `notify()` already batches unsent questions into one message (`plan-queue-parent-messenger.ts:53-64`). This changes the design for questions, so add the routing choice as a setting ("Send queue questions to: the queue page / the chat that started the run"), defaulting to the queue page (Decision 6).
  4. Tag any turn that still happens as purpose `plan-queue-parent` and record its `internalSource` on the cost row, so the Costs page counts it with the queue.
- **Risk.** The chat that started a run no longer reacts to queue events by itself unless questions are routed to it. The queue page and the run-end summary carry the same information.
- **Expected benefit.** Up to about 0.39B tokens a day from fix 1 at the current Codex pace, and about 0.14B a day more from fix 3. Fewer failed deliveries and fewer collisions with James's own turns. Fix 2 protects ordinary helper children spawned through orchestration commands: none has sent a child result since these records began on 4 October, so it guards against the same growth rather than saving tokens today.
- **Sources:** TD-4 (code path and the first count, which described the child results as queue notices and counted the queue's own notices as James's prompts); lead re-measurement, 19 October (Appendix D); `_verify-2` M1 and S10.

### T5. Cap Codex's skills list for machine work · P1 · XS
- **What's wrong.** Codex builds an "available skills" block sized as 2% of the window when `skills.max_context_tokens` is unset (`codex-rs/ext/skills/src/render.rs:20-23`, `:128-153`). With the larger window that is a median of 21.1K characters (about 5.3K tokens) in root threads and 39.6K characters (about 10K tokens) in helper threads, re-read on every request. AIO's Codex homes mirror James's whole `~/.codex` (skills, 519 MB of plugins) and set no `skills.*` key.
- **Fix.** `skills.max_context_tokens = 1500` in the same `thread/start.config` for Harness work. Chats keep the default. If a worker prompt names a skill, keep that skill listed through the per-skill config. Also try `skills.include_instructions = false` for plan-queue checkers, which only read and judge.
- **Expected benefit.** About 3.8K tokens per root thread and 8.5K per helper thread on every request: roughly 2-3% of a root thread's input.
- **Sources:** CX2-2.

### T6. Claude helper agents: start the approved model trial, add runaway caps, and run research fan-outs on Sonnet · P1 · XS-S
- **What's wrong.**
  - **Helpers are still a large share.** With research sweeps set aside, Claude's built-in helper agents are 30% of AIO's Claude spend (61% in the 21 days before), 95% of them general-purpose, with 86% of their cost on Opus 5.5. Ordinary sessions set no model on any spawn.
  - **The trial is waiting.** A18's model setting (`CLAUDE_CODE_SUBAGENT_MODEL` behind a trial) is on the Phase 1 branch only.
  - **Four native limits are unset** in `claude-env-pack.ts`:
    - nesting depth (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, default 3; 13% of spawns are nested);
    - concurrency (default 20);
    - spawns per session (default 200; AIO's p99 is 51);
    - forks (`CLAUDE_CODE_FORK_SUBAGENT`). Since CLI 2.1.302, fork helpers, which inherit the whole conversation (about 241K tokens per request), are on by default in `claude -p`, which is how AIO drives Claude. Only 4 forks so far.
  - **Research sweeps are the biggest single Claude burst.** The 10 October sweep cost about $1,900 at list price in 14 hours: 82 helper agents and about 12,000 requests, 84% of them to Opus (89% of the cost). That is a quarter of the whole window's AIO Claude spend. Every request ran at `max` effort, because helpers inherit the lead's effort, but max-effort helper requests were not longer or dearer than high-effort ones (CC2-14), so the saving is in the model: Sonnet scouts would have saved about $680. (This 19 October sweep used Sonnet for most scouts; its cost should be measured once it ends.)
- **Fix.**
  1. Land Phase 1 and start the A18 trial now: general-purpose helpers on Sonnet when the parent is Opus, with reviewers and the fresh-eyes gate kept on the parent's model.
  2. For machine sessions only:
     - `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2` (1 for plan-queue workers);
     - `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=60`;
     - `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=6`;
     - `CLAUDE_CODE_FORK_SUBAGENT=0` for loop and queue workers until the trial shows forks cost no more.
  3. Record fork, depth and foreground or background per helper (the transcript's `.meta.json` has them) alongside the helper-size record from Phase 0.
  4. For research fan-outs: scouts on Sonnet at `high` effort, with Opus and `max` kept for the lead and the synthesis. Do it through AIO's fan-out guidance and the child-spawn default, and show a running cost for the fan-out in the session header.
- **Expected benefit.** Sonnet for half the general-purpose helper spend saves about $0.9K per 30 days at list price (A18 was sized at $5-6K when helpers were the larger half). A research sweep on Sonnet scouts costs about $680 less. The caps are free guards.
- **Sources:** TR2-7, TR2-12; `ref2-claude` CC2-4 (its 43% figure for 17-19 October included this sweep's own agents, so it is not used here).

### T7. Switch on the long-chat cap for James's own Claude chats, not for machine work · P1 · S · **[defaults checked by Claude]**
- **What's wrong.**
  - **The cap is built and off.** A4's ceiling exists on `main` (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` from `context-ceiling.ts`, set in `claude-env-pack.ts:57-59`), but both settings default to 0 with the comment "Replay evidence is unavailable; ceiling remains disabled" (`src/shared/types/settings-defaults.ts:158-159`).
  - **The replay now exists.** It covers AIO's own Claude transcripts for 11-18 October, using hermes's sawtooth method; the modelled baseline matches observed cost within 5% and includes the cost of each compaction. It finds:
    - own chats and other main sessions: 0.72-0.74 of baseline cost at a 300K ceiling, 0.60-0.64 at 200K (AIO's chats mostly pay for re-reading the cache, so trimming pays);
    - plan-queue workers: 0.94-1.00 (they never reach 400K);
    - helper agents: 0.89-0.96 (they mostly pay for cache writes).
  - **Hermes switched its own subagent ceiling off by default** the day after shipping it ("200K-400K caps within 5% once cache prefixes are intact; accuracy never measured", `dcdbc0093d`).
  - **Claude still compacts only near 970K** (3 compactions in 9.9 days).
- **Fix.**
  1. Set `ownChatContextCeilingTokens` to about 300,000 (Claude subtracts its own buffer, so it triggers near 267K), after a recall check: three real long chats through compaction, 10-15 questions each.
  2. Leave `machineContextCeilingTokens` at 0. This also avoids T1's checker collision. Do not extend the cap to helper agents.
  3. Settings text: "Claude summarises earlier at this size. Saves roughly a quarter of the cost of very long chats and keeps recent work."
  4. Re-run the replay script quarterly (K9's measurement kit).
- **Expected benefit.** About 26-28% of own-chat long-session cost at 300K. Not modelled: re-reading detail lost in a compaction, which could eat part of it.
- **Sources:** `ref2-hermes-runtime` HE2R-1; TR2-5; TS-4.

### T8. Copilot: show what Opus costs where it is picked, and read Copilot's own records · P1 · S
- **What's wrong.**
  - **Copilot is busy, and the 10 October picture missed it.** The first sweep saw "no Copilot use since 25 September" because `session-store.db` stops logging that day. The per-session `events.jsonl` files show 841 sessions, 6,644 requests and 16,850 premium requests in 9.9 days, 454 of them plan-queue checkers (each a cold start of about 30K tokens).
  - **One model dominates the cost, and not in unattended work.** Opus 5.5 costs 15 premium requests per message: 729 requests made 65% of all units. Sonnet 5.5, gpt-5.6-terra and gpt-6.1-sol cost 1 each. The queue's checkers (454 sessions, 4,949 requests, exactly 1 unit each) and the second-opinion reviewers (318 sessions, 632 units) already use 1-unit models. All 729 Opus requests were in 14 multi-turn Copilot sessions, 13 of them in the EBRD folder. Whether James typed into them or a parent chat started them is not known without reading their text.
  - **Copilot's own compaction does not always shrink the context.** 2 of 3 compactions on gpt-5.6-terra left it at 282K and 308K, above the 272K limit.
  - **AIO discards the occupancy figure.** It drops Copilot's `usage_update` occupancy, and nothing reads the events files.
- **Fix.**
  1. Make Opus on Copilot an explicit choice that says "15 premium requests each" wherever it can be picked (the chat model picker and account defaults), and show how many premium requests a Copilot chat has used so far. Keep 1-unit models as the default for everything Harness starts by itself, as they already are.
  2. A read-only tail of `events.jsonl` for exactly three event types (`session.usage_record` or `session.usage_checkpoint`, `session.compaction_complete`, `session.shutdown`), keeping numbers only. Show premium requests beside tokens, and recycle a loop or queue session when a compaction leaves it above 90% of its limit.
  3. Copilot CLI below 1.0.100 "may stall for minutes on a hung tool server". Say so in the CLI status page and loop preflight.
- **Expected benefit.** If those 14 sessions' 729 Opus requests had gone to a 1-unit model, Copilot premium use would have been about 60% lower for the same work. The warning lets James decide when Opus is worth it.
- **Sources:** TR2-4 (re-derived by `_verify-1`, which found the split by session type); CC2-10, CC2-11.

### T9. Second-opinion reviews: cancel stale ones, retire failing reviewers, show the daily count · P1 · S
- **What's wrong.**
  - **Volume and failures.** About 37 reviews a day on 16-19 October (2.5 times 10 October) and rising (28, 37 and 43 a day), with two reviewer sessions each, 61% on Copilot seats. Of 236 reviewer sessions, 92 failed, 30 ran past their deadline and 108 finished, and 36 of the 118 reviews (about 30%) were thrown away as stale after their reviewers finished, because a newer turn had arrived meanwhile. There were 88 schema-validation failures.
  - **Nothing is recorded.** A14's guards (only on real file changes, 20 a day) are on `main` but not in the running app (K2), and the cost log has no review purpose yet.
- **Fix.**
  1. Cancel a reviewer session as soon as a newer turn makes its review stale, instead of discarding it after it finishes.
  2. Stop using a reviewer that failed schema validation twice in a day.
  3. Show "Second opinions today: N of 20", with a tooltip.
  4. After the restart, check Copilot premium use per review (T8).
- **Expected benefit.** About 25-45% of reviewer sessions (stale and failed) avoided before the daily cap.
- **Sources:** TD-8.

### T10. AIO's own tools: cap results at the source, give each role only the tools it uses, and stop the catalogue creeping · P1 · S-M
- **What's wrong.**
  - **AIO's own tools now carry a growing share of what Claude re-reads.** The browser-gateway tools make up 12.1% of main-session tool-result text and 16% of what is re-read (calls per day up 3.7 times). The orchestrator tools are 5.3% and 5.2% (4.0 times). Single results reach about 50K characters.
  - **The catalogues grew 8-15% in three days** (browser 52.8 to 60.7 KB, orchestrator 57.3 to 62.5 KB).
  - **The always-visible core rides on every Codex call.** It is about 16.8 KB, including four remote-worker tools whether or not a worker is connected: about 100M tokens per five days (2.3% of input).
  - **Checkers and triage carry tools and guidance they never use.** Plan-queue checkers and triage get every tool server plus both the browser and desktop guidance blocks (about 5.7K characters), although they only read and run gates.
  - **Tool search returns full schemas.** `orchestrator_tool_search` sends full schemas in every result (median 7.7K characters), and `plan_queue_status` was polled 350 times, 21% returning byte-identical results.
  - **No tool says it only reads.** AIO's tools carry no `readOnlyHint` or `destructiveHint` annotations (`src/main/mcp/mcp-server.ts:108-115`), so Claude treats every one as a possible write, never runs them in parallel, and ranks them without search hints.
- **Fix.**
  1. Cap the browser snapshot and click echoes and the orchestrator list and read tools at about 8K characters, with "more available, call X with offset".
  2. Role-aware tool sets in `spawn-config-builder.ts`: plan-queue checkers and triage get no browser, desktop, `imap` or codemem tools, and skip the guidance blocks when those bridges are not attached.
  3. Hide the four remote-worker tools when no worker is connected; they stay findable through search.
  4. A CI ratchet on full and visible schema bytes, using the existing `measureToolSchemaBytes`.
  5. Search returns names and one-line descriptions only. Status tools accept `sinceVersion` and return `{unchanged: true}`.
  6. Add tool annotations (`readOnlyHint` on reads, `destructiveHint` on terminate and close), with a spec that every tool declares one.
- **Sources:** TR2-6; TS-5, TS-8; HE2R-6; `ref2-memory-codepilot` MC2-9.

### T11. A size budget for every prompt AIO builds, written authoring rules, and the guide diet before the guide is sent everywhere · P1 · S
- **What's wrong.**
  - **Nothing guards prompt size or wording.** AIO's prompt contract guards block order only. There are only three upper-bound size checks in the tests (the loop handoff, prior context, the instruction stack). The orchestration guide (14,157 characters), the reminders, the loop round prompts and all five plan-queue prompts have none.
  - **Three projects show why this matters.**
    - Hermes regrew about 3.4K tokens in five weeks after a diet, then added a committed, token-counted snapshot of every prompt (`ae3598c7cd`).
    - Oh-my-opencode-slim cut its orchestrator prompt from 22.8 KB to 5.2 KB in five days and kept it there with snapshot tests and block-size guards.
    - Storybloq pins every startup step's byte ceiling and requires a reason for every increase.
  - **The 10 October guide fix (A12) carries a trap.** It would deliver the guide on every path, but sending today's 14K guide to the 120 of 122 sessions that currently skip it adds about 3.5K tokens each, re-read on every turn.
  - **AIO's house style has no authoring rules** (`docs/prompt-engineering-house-style.md`, 2,986 bytes). It has no delete test, no budget and no "this line exists because of X" note. A fresh example: `plan-queue-prompts.ts` states the same autonomy rule twice.
- **Fix.**
  1. One spec renders each prompt surface with fixed inputs (clock, paths and settings pinned) and asserts `chars ≤ BUDGET[surface]`, with every budget in one table. The surfaces: orchestration guide, reminders, child prompt, loop first round, continuation and full re-anchor, the five plan-queue prompts, review prompts, the RTK note, helper and title prompts. Seed at today's sizes, lower each budget in the same change that cuts it, and require a reason comment on every raise.
  2. One debug line per injection (surface, characters, session), which also answers "how often do the reminders fire?".
  3. Seven authoring rules in the house style:
     - the delete test;
     - rules over reasons;
     - structure beats prose;
     - one source of truth;
     - no sediment;
     - measure before and after;
     - each added line names the failure it prevents and goes when that failure becomes impossible.
  4. Before A12 delivers the guide everywhere, cut it to an always-on core of about 4,500 characters. Gate Automations (500) and Consensus (600). Turn Cross-LLM into one line. Drop Code Navigation, since the tool list already shows those tools. Show the worker section only when a worker is connected.
- **Sources:** OMO2-2, OMO2-3; HE2R-2; SB2-6.

### T12. Messages AIO writes itself should not trigger memory and code search; late search results are dropped, not carried to the next message · P1 · XS · **[checked by Claude]**
- **What's wrong.**
  - **Machine-written messages still trigger the searches.** Every `sendInput`, including plan-queue fix prompts sent with `automatedInput: true`, runs the memory and code-index search: `instance-manager.ts:1672` calls `buildInputContexts` without the options, and `instance-input-contexts.ts:109` never sees the flag.
  - **The "memory" block is really code snippets.** In 398 sends between 16 and 19 October, 96% of injections were code-index blocks of about 950 tokens; memory blocks fired on 0.5% of sends.
  - **Late results are carried to the wrong message.** 65 sends (16%) missed the 500 ms deadline. Up to 34 late blocks were then parked and attached to the next message, whatever it was (`instance-input-contexts.ts:166-183`).
- **Fix.**
  1. Skip retrieval and keyword reminders when `automatedInput` or `internalSource` is set: one condition.
  2. Drop a late block instead of parking it, or keep it only if the next message is James's and still overlaps.
  3. Skip the code block for messages under about four content words ("continue", "yes"). This is already built on the Phase 3 branch, with an 8K cap per turn and de-duplication (A20's `turn-injection-policy.ts`), so it arrives with L2; fixes 1 and 2 are not built anywhere.
- **Expected benefit.** Small in tokens (about 24K a day); the gain is a cleaner transcript and no stale snippets. The carrier is the code index, not memory notes, so check A20's rules against code blocks when Phase 3 lands.
- **Sources:** TS-6; MC2-2.

### T13. Claude idle and compaction levers: compact before a known sleep, hint after 75 idle minutes, tell Claude what to keep · P1-P2 · S-M
- **What's wrong.**
  - **Claude's own idle rules never fire inside AIO.** Claude Code 2.1.299+ compacts a 200K-plus conversation after about 54 idle minutes (terminal-only and server-gated, so not in AIO's sessions). It shows "new task? /clear to save N tokens" after 75 minutes at 100K or more. AIO hibernates idle sessions at 30 minutes (`process/hibernation-manager.ts:24`), so neither runs. The loop's stale-cache tier is still a logged no-op.
  - **Every return after more than an hour rewrites the whole cache.** Main-session returns after an hour or more rewrote the cache every time: 91 returns, about $28 a day at list price.
  - **AIO assumes a one-hour cache.** It hard-codes the cache lifetime as one hour (`orchestration/loop-context-survival.ts:29`), but each Claude reply says which it wrote. Main sessions write almost all on the 1-hour clock; helper agents write all on the 5-minute clock.
  - **Claude's summaries get no instructions from AIO.** AIO passes no `PreCompact` hook (the `--settings` overlay carries only a `PreToolUse` hook, `claude-cli-argv-builder.ts:66-110`). Claude Code turns a `PreCompact` hook's output into custom summary instructions (`Actual Claude/utils/hooks.ts:3961-4045`).
  - **Claude's own /compact has a working recipe elsewhere.** openclaw runs `claude -p ... --resume <id> "/compact"` as a separate call after retiring the warm process, and checks for `compact_boundary` (`openclaw/extensions/anthropic/cli-backend.ts:191-216`). AIO has only tested sending `/compact` into the resident stream, which does not work.
- **Fix.**
  1. **Before a known sleep.** When a loop, scheduled job or set-aside queue job will not run again for longer than the cache lifetime and holds at least 200K, compact (or recycle with the handoff note) before sleeping. Break-even: compacting wins whenever there is more than about a 15% chance the session is used again.
  2. **The idle hint, with Anthropic's own numbers.** After 75 idle minutes at 100K or more: "Starting something new? A fresh session would skip re-reading about N tokens." Stay quiet while a loop wake-up, background agents or a dialog is pending.
  3. **Read the cache lifetime per reply** from `usage.cache_creation` (`ephemeral_1h_input_tokens` or `ephemeral_5m_input_tokens`), and use it for the hint, the loop's stale-cache rule and the cache-break explanations.
  4. **A `PreCompact` hook for machine sessions only.** It prints a short, role-specific block: a queue worker gets its job, plan path, changed files, last check and next step; a loop round gets its open task ids and state folder.
  5. **Probe openclaw's `/compact` recipe once.** If it works, use it for Claude's "Compact now", which keeps Claude's own summary and session instead of restarting from AIO's.
  6. **Set `precomputeCompactionEnabled: false`** (an undocumented Claude setting that makes background summaries) in the machine-session overlay until a transcript count shows whether it costs anything.
- **Sources:** CC2-6; `ref2-t3code` T32-1; `ref2-jean-nanoclaw` JN2-2; `ref2-openclaw-runtime` OC2R-3; TR2-7.

### T14. Gemini and Antigravity send AIO's whole system prompt on every turn · P2 · S
- **What's wrong.** Each turn is a fresh process, so Gemini prepends `[SYSTEM INSTRUCTIONS]` and the full system prompt plus the RTK note to every prompt (`gemini-cli-adapter.ts:518-537`); Antigravity does the same with every `--print` (`antigravity-cli-adapter.ts:358-367`). For a root session that includes James's 25 KB global `CLAUDE.md` (they own only `GEMINI.md`). How much interactive Gemini or Antigravity use there is was not measured; one-shot reviewers are unaffected.
- **Fix.** For these two providers, drop the global `CLAUDE.md` (or send a short safety digest) and send memory blocks on the first turn only.
- **Sources:** TS-7.

### T15. OpenCode correctness and visibility (OpenCode is about 0.2% of token volume) · P2, except the bug · XS-S each
1. **Bug (XS):** a cancelled OpenCode compaction (`status: "cancelled"`) is not handled, so the "Compacting the session…" row never finishes (`opencode-acp-updates.ts:52`, the same in the Phase 1 branch).
2. Deliver Harness's stable rules through OpenCode's `instructions` file list (a hash-named file under the data folder) instead of only inside the first message, because OpenCode 2's summary prompt tells the summariser to leave injected instructions out (`opencode/packages/core/src/session/compaction.ts:153`). Add a startup check: an unreadable instructions file is skipped silently.
3. Show the compaction summary OpenCode already sends, in the divider tooltip with a "Show summary" expander.
4. Count OpenCode helper sessions (`task`, `explore`): their tokens and cost never reach AIO. Until they do, deny helpers for unattended OpenCode spawns.
5. A6.2's pruning does nothing on OpenCode 2 (it is 1.x only). For unattended spawns use `tool_output` caps and `compaction.buffer` instead.
6. A6.6 is resolved upstream: OpenCode 2.0.28+ no longer cuts silent streams at five minutes. Close it.
7. Note for planners: the first list's `opencode/packages/opencode/…` citations no longer resolve (v1 was deleted from `dev` on 10 October). Read them with `git show origin/v1:<path>`.
- **Sources:** `ref2-opencode` OP2-1 to OP2-7.

### T16. RTK: stop widening it, and fix two quiet errors · P2 · XS
- **What's wrong.**
  - **The ceiling is small.** Measured on 10-19 October transcripts, RTK's ceiling is about 2.7% of Claude's bill (realistically under 1.5%). 47% of Bash result tokens are `sed` and `cat` file reads, which RTK deliberately never shortens.
  - **The trial cannot see small gains.** The queued 50/50 trial would need 10,000-22,000 sessions per arm to see a 5% gain; AIO makes about 115 a day.
  - **A rename will corrupt the counts.** RTK 1.0 renamed `rtk proxy` to `rtk bypass`, and AIO's "ran in full" counts match only `proxy` and `fallback`, so the first 1.x binary (for example after `brew upgrade rtk`) silently inflates "filtered".
- **Fix.**
  1. Land the queued A13 steps as designed and add no more RTK surface.
  2. Call the trial a harm check ("catches harm of about 25% or more"), judged on Bash calls per session (on-arm at most 1.05 times off-arm).
  3. Add `rtk bypass` to the queries.
  4. Licence and the Savings tab: see K6.
- **Sources:** `ref2-pi-rtk` PR2-1, PR2-4, PR2-5.

### T17. Say the cost before a change that restarts the session · P2 · S-M
- **What's wrong.**
  - **Seven kinds of change tear a session down.** `computeRuntimeDiff` covers provider, model, effort, local model, auto-approve, Copilot account and account profile (`runtime-reconciler-plan.ts:24-70`); Claude model changes always replay. Nothing on screen says the next message re-sends the conversation at full price.
  - **The model-switch notice is false.** It still says "Conversation context has been preserved" (A8.3; the truthful notice is on the Phase 1 branch).
- **Fix.**
  1. One `describeRuntimeChangeCost(diff, contextTokens, idle)` that returns zero or one plain sentence per change kind. Show it in the picker or toggle that triggers the change.
  2. Confirm only when the re-send is large ("The next message will re-send about 230K tokens at full price").
  3. When the switch replays text, say before the click what carries over (t3code's pending-handoff row, `t3code/packages/client-runtime/src/handoff.ts:16-39`), and size the carry-over from the target model's window.
- **Sources:** `ref2-hermes-ux` HE2U-5; T32-2.

---
## U. A calmer screen and plainer words

Most of the 10 October screen work (C2, C3c-g, C4, C8, C9, C12, C13) is already written on the Phase 3 and Phase 5 branches; L2 lands it. The items below are new, or are the parts those branches do not cover. The clutter has moved: five of the eight Harness screenshots James pasted between 11 and 18 October show raw provider text as the most prominent thing on screen.

### U1. One plain message per event, raw text behind "Details" · P0-P1 · S then M · **[examples checked by Claude]**
- **What's wrong.**
  - **Codex log lines in the conversation.** Codex warning and error lines become System messages word for word, `[codex] 2026-10-18T00:51:03.042357Z ERROR codex_core::tools::router: …` (`src/main/cli/adapters/codex/exec-process-runner.ts:408-433`). The duplicate filter keys on `category:line`, and each line starts with its own timestamp, so repeats never match. An MCP start-up failure falls into the generic bucket.
  - **Two notes for one usage limit, and no date.** The Claude adapter writes `Provider rate limit "${status}" (${rateLimitType}). Resets at ${time}.` (`claude-cli-adapter.ts:1778`). The limit handler separately writes "Provider limit reached. This session is parked…" (`instance-provider-limit-handler.ts:653-657`). James's 16 October screenshot shows both, the first ending `"rejected" (seven_day). Resets at 11:00:00 PM`. A weekly reset can be days away, and only the time of day is shown.
  - **Raw start failures and HTTP codes.** "This session could not start. Reason: Timed out waiting 60000ms for 'opencode' provider concurrency slot" (`provider-concurrency-limiter.ts:196`). "⚠ Reauth needed — MiMo usage login expired (401/403)". A toast about a removed Codex account that does not say which session it means.
  - **About 190 places in the renderer show raw `error.message` text**, for example "Fresh-eyes review failed for ${signal}: ${error}" and "Could not save: ${error}".
  - **Jargon on held messages.** "Held - session respawning (native-resume)", "Held - waiting for interrupt acknowledgement", "Held - backing off (attempt 3)" (`input-panel-formatters.ts:56-70`). The wait-reason type already carries start times and deadlines, yet no elapsed time is shown.
  - **Turn-end notices with gaps.** The table of turn-end notices exists (`turn-ending-continuation-policy.ts:36-58`) but:
    - it has no case for "the model wrote nothing at all";
    - six notices do not say whether the work was kept;
    - next steps are words, not buttons;
    - a dying process still prints the raw "Process exited unexpectedly with code N" (`instance-communication.ts:2202`, `:2215`).
  - **Every nonzero Codex command exit is marked an error** (`codex-notification-item-events.ts:218-229`). Codex itself switched to a neutral "Exited (status N)" on 15 October, because a `grep` with no match is not a failure.
- **Fix.**
  1. **A small shared module first:** `presentError(code | Error, context) → {headline, whatToDo, action?, rawDetail}`, built from a closed list of categories. Only whitelisted reasons go inside a sentence, so private text from a provider cannot leak into one (t3code's `packages/provider-core/src/server/failure.ts`). Every message gets the CodePilot shape: what happened, then "What to do: …", or "No action needed" when Harness is already fixing it.
  2. **Route the sources seen in James's own screenshots first:**
     - **Codex log lines:** strip the timestamp before keying and showing; add an MCP start-up rule ("A tool server didn't start for this Codex session: <name>"); one line per category per turn, with the raw line under Details.
     - **The usage limit:** one message, "Your work Claude account has used its weekly allowance. It resets on Thursday at 23:00. [Switch account]", with the day and date when the reset is more than 12 hours away. Never print `rejected`.
     - **The concurrency timeout:** "OpenCode is already running its maximum of N sessions; this one waited a minute. [Try again]".
     - **MiMo:** "Signed out of <account>. [Sign in]".
     - **The removed-account toast:** name the session.
  3. **Held messages:** one plain sentence per wait kind, with a ticking "waiting 12 s" ("Restarting this session and picking up where you left off. Your message will send in a moment."). After two minutes, offer "Keep waiting / Stop waiting and keep my message" (nanoclaw's first-reply stages, `setup/lib/first-chat-progress.ts`).
  4. **Turn-end notices:**
     - add an `empty_result` reason;
     - every notice says whether James's message and the work were kept, enforced by a spec;
     - optional `action` buttons (continue, retry, switch model, sign in);
     - the `crash` notice replaces the raw exit string;
     - split the dual-purpose runtime notices into a model text and a user text.
  5. **Nonzero Codex exits:** `is_error` only when the command could not run; otherwise "Exited with status N" in neutral colour.
  6. **A ratchet** (like the tooltip ratchet) that bans `${error}` or `.message` straight into visible text in new code.
- **Sources:** `aio2-ux-clarity` UX2-10, UX2-11, UX2-12; `ref2-t3code` T32-3; `ref2-memory-codepilot` MC2-8; `ref2-hermes-ux` HE2U-1; `ref2-jean-nanoclaw` JN2-1; CX2-6. Extends C6.

### U2. Healthy means hidden: the startup chip, the local-model chip and the title bar · P1 · S · **[startup rule checked by Claude]**
- **What's wrong.**
  - **"Startup degraded" is the normal state.** `summarizeStatus` returns `degraded` if any check is degraded (`src/main/bootstrap/capability-probe.ts:16-26`), and an optional CLI that is simply not installed is "degraded" (`:176-187`). One unused CLI therefore makes the whole app "degraded".
  - **The chip and banner are always there and mostly can't help.** The title-bar chip shows "Startup {status}" even when ready. The banner's only button, "Open accounts", fixes one of five kinds of check. Its summaries are developer text ("Hardened run mode is macOS-only (Phase A)").
  - **The local-model chip always shows.** "Local AI: Not configured · 0 targets", under three different names (Local AI, Local AI Guard, Local AI health centre).
  - **The title bar now has up to 10 items** (keep-awake was added), and 13 banner slots remain.
  - **The keep-awake chip is the model to copy:** shown only while it matters, in plain words, and it opens its setting.
- **Fix.**
  1. A missing optional CLI is "disabled" unless the user has an account or default for it. Only critical or in-use checks can make startup "degraded".
  2. Hide the chip when ready. Give each check its own fix button (Accounts, Remote computers, Browser, Setup) and a plain summary ("Cursor isn't installed. You only need it to use Cursor.").
  3. Show the local-model chip only when it is paused or degraded, in plain words ("Local helpers paused until 14:20"), under one name: "Local models".
  4. Two lines for anything with both a switch and a live state: "On, but not running yet: <why>" (a warning) and "Running: <what you can now do>". Never say "unavailable" for something not yet checked: say "Checking…" or "Couldn't check: <reason>" (CodePilot's design rules).
- **Done when:** a normal launch shows the quota strip and notifications and nothing else.
- **Sources:** UX2-2, UX2-7; MC2-5, MC2-6. Extends C5.

### U3. One name for each thing: a shared display-names module · P1 · S
- **What's wrong.**
  - **A MiMo account has five names:** "OpenCode" (popover and model menu), "OC" (strip), "MiMo" (Settings), "MiMo Token Plan" (account chip) and "xiaomi-token-plan" (a plan-queue error).
  - **Codex is named in 17 maps with four spellings**, and Grok in two.
  - **The quota strip still uses CC/CX/GM/AG/CP/CU/GX/OC,** where CU is Cursor while every session header uses CU for Computer Use.
  - **"Reauth" and shell commands sit in the title bar** ("Run `gh auth login` …").
  - **Other computers have five names:** "Remote Nodes", "Worker Nodes", "computers", "browser computer" and "worker node".
- **Fix.** `src/shared/display-names.ts` with `providerName(id, {long?})`, `accountFamilyName`, `computerName(node)` and `PRODUCT_NAME = 'Harness'`.
  - Replace the 17 maps, with a guard spec that fails on any new local display map.
  - MiMo reads "MiMo" everywhere, with "via OpenCode" only under Details.
  - The strip shows short names plus the worst percentage, with account names in the popover.
  - A signed-out account becomes "Signed out of <name>. [Sign in]".
  - Word list: "your other computers" and "this Mac"; "node" and "worker" only under Details.
- **Sources:** UX2-3, UX2-9. Extends C7.

### U4. One status presenter, and a phone fix today · P1 · S + XS
- **What's wrong.**
  - **Five label maps describe one session state** (`status-colors.ts`, `status-indicator.component.ts`, `instance-row.component.ts`, `child-instances-panel.component.ts`, `mobile-gateway-push.ts`). They have drifted: "respawning" is purple in one and teal in another, and the session row has no "terminated" label.
  - **The phone mislabels waiting.** Its lock-screen Live Activity calls "waiting for input" "needs approval" (`src/main/mobile-gateway/mobile-gateway-push.ts:88-104`).
- **Fix.**
  1. Fix the phone mapping now (one line).
  2. Then one shared `presentInstanceStatus(status, waitReason) → {label, tone, detail}` with about eight plain labels: Working, Thinking, Needs your answer, Needs your OK, Restarting, Asleep, Stopped, Problem. Use it at all five sites and in notifications, with a spec that fails on a new local label map. This is Phase 3 step 8b, not started.
- **Sources:** UX2-8. Extends C6.

### U5. Closing a session says what happens to its helper sessions · P0 · XS-S · **[checked by Claude]**
- **What's wrong.**
  - **New sessions close their children with them.** They default to `terminationPolicy: 'terminate-children'` (`src/main/instance/lifecycle/instance-create-builder.ts:76`), so closing a parent ends every child (`instance-termination.ts:341-383`).
  - **The confirm dialog doesn't say so.** Closing one session says nothing about its helpers (`terminate-confirm-dialog.component.ts:57-63`). Only the Close-all dialog mentions child sessions, and only to say they are not kept in history (`:52-56`). Neither gives a count of running children or a choice.
- **Fix.**
  1. When a session has running children, say so: "This session has N running helper sessions."
  2. Offer two buttons: "Close this session and its N helpers" and "Close only this session (helpers keep running)". The second needs a per-call policy on the close command; the policies already exist.
  3. The × tooltip carries the same count.
  4. Separately, skip the dialog altogether for a session with no messages and no unsent draft (jean's rule).
- **Sources:** `ref2-openclaw-ux` OC2U-1; JN2-7. Extends C1.

### U6. "Allow once" means once; the browser request card says what it allows · P0-P1 · XS-S · **[checked by Claude]**
- **What's wrong.**
  - **"Allow once" lasts an hour.** The card offers "Allow once", and its own hint admits "Also allows the same command for the next hour." In the main process, scope `once` caches the decision for the permission manager's one-hour lifetime (`src/main/security/permission-manager.ts:221`, `:655-667`). The same applies to a "once" deny.
  - **The ordinary browser request card is raw:**
    - its title is the raw tool name (`browser.click`);
    - its meta line is `actionClass · origin | url | profileId`;
    - the scope shows as "per_action - input, navigation";
    - the selector shows by default;
    - an unlabelled `Once / Session / Autonomous` select sits before a bare "Approve" (`browser-approval-request.component.html:10-57`, `:106-131`).
  - **Two cards, two vocabularies.** The CLI card now says "Allow once / Allow for this session / Always allow…" (C3a). The saved-login variant of the browser card is excellent and is the pattern to copy.
- **Fix.**
  1. **"Allow once" (recommended):** make `once` uncached, or cached only until the current turn ends, so the label is true. The alternative, relabelling it "Allow for the next hour", is Decision 8.
  2. **The browser card:** reuse the saved-login layout for every request ("Click 'Submit order' on shop.example.com (Windows PC)", then reason, website and computer), with the tool name, selector and element fields under Details.
  3. **Three buttons in the C3a style:** "Allow this once", "Allow for this task", "Allow without asking (this task)". Keep the typed phrase for publish and delete.
  4. **One scope word list** shared by the CLI, browser and permission-registry cards.
  5. **Optionally, t3code's card shape:** only Deny and Allow once as buttons, with the lasting choices in a "More" menu carrying their warning, plus a kind label ("Command approval"), "1 of 3", and a "can't be answered any more" state when the provider has gone.
- **Sources:** UX2-6, UX2-4; T32-4 (corrected: C3a's labels did land). Extends C3.

### U7. A one-line note under each turn: what it did, what failed · P1 · S-M · **[tool-group label checked by Claude]**
- **What's wrong.**
  - **There is no per-turn summary.** A collapsed tool group says "44 calls · 900,532 characters · 25 results externalized", with no notion of failure (`shared/components/tool-group/tool-group.component.ts:240-253`).
  - **There is no warning when a failed edit is glossed over.** Hermes found models summarising "done" after half of their parallel edits failed.
- **Fix.**
  1. A pure `summariseTurn(toolEvents, elapsed)` in `src/shared`. It renders one quiet row at the end of a turn, only when tools ran or the turn took over about 10 seconds: "12 s · edited 2 files +18 −3 · read 4 · ran 3 commands · 1 failed". Use verbs with real plurals, count failures separately, and stop at four segments (hermes `display.turn_summary`).
  2. A row "Changed 4 files while this reply ran", from a per-turn file comparison in git folders, that opens the review panel (opencode `81d57087a4`).
  3. When an Edit or Write failed and no later write to the same path succeeded, add one warning under the reply: "2 edits failed and were not retried: <path> (<error>). Check before trusting the summary." Show it only when a text reply exists and the turn was not interrupted (hermes `display.file_mutation_verifier`).
  4. Optionally, a "Worked for 2m 14s · … · 1 failed" fold for the whole turn, with the final reply, approvals and questions kept outside the fold and the fold opening itself when something failed (agent-orchestrator). Keep the "show tool calls" switch.
  5. Put the failure count on the collapsed tool-group label now (C6.3's small fix).
- **Sources:** HE2U-2; `ref2-agent-orchestrator` AO2-6; `ref2-opencode` OP2-12. Extends C6.3.

### U8. A calm failure card with "Try again" that continues · P1 · S-M
- **What's wrong.** For a failed turn there is no transcript card with a retry action: the renderer never reads `turnErrored`. After Stop, the composer is empty and James types.
- **Fix.**
  1. A `RunFailureNotice` for the latest failed turn: a plain title, one sentence from U1's module, Copy error, Details (raw text), and "Try again".
  2. "Try again" sends a short continuation ("Continue from where you stopped. Check which actions already completed before retrying anything."), never a replay of the original prompt, which could repeat side-effecting tool calls (openclaw `chat-run-failure-notice.tsx`).
  3. While automatic retries run, show "Retrying in 12 s" in the working row, not in the transcript, with the countdown taken only from a deadline the runtime reports.
  4. After an interrupt, the empty composer becomes a "Continue" button. For providers that drop a cancelled turn, attach the original request and the last 8 KB of partial output as hidden context (agent-orchestrator `continuation.go`).
- **Sources:** OC2U-2; AO2-8. Extends C6 and B4.

### U9. Question cards: typing in the composer answers them; a closed card leaves a receipt · P1 · M
- **What's wrong.**
  - **The composer ignores pending question cards.** Nothing in `input-panel.component.ts` checks for a pending card, and hermes fixed exactly this bug on 13 October: typed words went in as a separate steer, and the card was cancelled.
  - **Closed cards vanish.** A card closed by the app is deleted with no trace (`user-action-request.component.ts:256-268`).
- **Fix.**
  1. A small registry that the composer's send path asks first, for agent question cards only (never permission cards). Text equal to a choice picks it; anything else is the typed answer.
  2. Every closed card becomes one transcript line: "You allowed once: <tool>" / "You answered: <first 60 characters>" / "No answer in 5 minutes; nothing ran" / "Answered elsewhere" / "Cancelled when the session closed".
  3. Check first what the main process does today with a message sent while a card waits (unverified, per provider).
- **Sources:** HE2U-3 (hermes `apps/desktop/src/store/parked-card-answers.ts`). Extends C3.

### U10. Fold routine system notices instead of hiding exact strings · P1 · S-M
- **What's wrong.**
  - **Routine notices are hidden by exact match.** They are hidden by kind and by two literal strings (`display-item-processor.service.ts:294-308`, `display-item-system-events.ts:18-21`), and a hidden notice cannot be inspected afterwards.
  - **The planned C6 rewording will break the match.** It will change those strings, so the hidden notices will quietly reappear.
- **Fix.**
  1. Before C6's rewrite, move the literal checks to a metadata flag at the emit sites.
  2. Give every system message `audience: routine | attention`, and fold consecutive routine ones into one "N system events" row with the worst severity on it (openclaw `d5c7055a700`). Failed tool calls and approvals always stay outside the fold.
- **Sources:** OC2U-4. A hazard for C6.

### U11. "Where your usage went": one card with Anthropic's nine named causes · P1 · M
- **What's wrong.** Claude Code 2.1.299+ explains spend as nine causes. Each is shown only when it is at least 10% of cost, with one sentence of advice:
  - cache misses over 100K;
  - context over 150K;
  - helper-heavy sessions;
  - 4 or more sessions in parallel;
  - sessions active for 8 hours or more;
  - max effort;
  - workflows;
  - always-on context over 40K;
  - tool results over 10K.

  AIO's Costs page groups by purpose or provider and gives no advice.
- **Fix.**
  1. A "Where your usage went" card on the Costs page and in the session status card. Compute the nine shares for the last 7 days from the transcripts AIO already reads, or call the experimental `get_usage` control request as a first version.
  2. Show only causes at or above 10%, each with one sentence and one button that does AIO's version of the advice:
     - cache misses → "Compact first";
     - long context → the long-chat cap (T7);
     - helper-heavy → helper settings (T6);
     - sessions running 8 hours or more → the scheduled jobs list;
     - always-on context → the context details;
     - large tool results → the caps (T10).
  3. Lead with percentages and plan windows, not dollars, because James is on subscriptions (A10). Reuse the sentences as tooltip copy on the context ring, the effort picker and the helper controls.
- **Sources:** CC2-1. Extends A7 and A10.

### U12. Small copy fixes, in one change · P1 · XS
1. "Ask Claude to Address" appears on the second-opinion panel for every provider's session (`cross-model-review-panel.component.ts:63`).
2. "Codex is compacting… your message will send afterwards" shows for every provider (`input-panel.component.html:458-459`).
3. A "Restart AIO" button appears twice; the product is Harness.
4. A developer measurement in a clean-up dialog: "The scratch trial took about 2 seconds for 249 MB of live data…".
5. A settings heading "Session process fence" sits over a well-worded row.
6. The abbreviation "iter" appears in past loop runs, and "AIO stops retrying it" in their tooltip.
7. A code comment says `window.confirm()` does nothing in the renderer. It is wrong, and it would mislead C12.
8. The effort picker says "Max: Deepest session-only reasoning" and "Workflow: Claude Code ultracode mode". Neither says it costs more. Use Anthropic's own words: "Thinks as long as it can on every step and uses much more of your allowance. Keep it for the hardest problems." and "Splits every task across many helper agents; each one uses its own allowance."
9. The three Codex cost settings say "Trial keeps related sessions on one comparison arm" and "compacts earlier". Rewrite them in plain words, saying that Trial is the default and splits sessions half and half. Add a thin "requests above this cost double" tick at 272K on a Codex session's context bar.
- **Sources:** UX2-13; CC2-14; `ref2-codex` CX2-8.

### U13. Smaller ideas for later · P2 · XS-S each
1. Session menu: put everyday actions first and fold the rest (15 flat entries become about 9, with "Copy ▸" holding the transcript, the three ids and the folder). The shared `ContextMenuItem` gains `disabledReason` and `children` (OC2U-5).
2. Navigation by hubs: about 12 sidebar destinations instead of 52, with sub-pages as tabs and the hub staying highlighted. Pair it with C10's palette-everywhere (OC2U-9).
3. Countdowns that tick: "in 14 min" or "due now, waiting for the session to be idle" on scheduled jobs and wake-ups, instead of a fixed time (HE2U-7).
4. A shortcut to jump to the next session that needs James (AO2-3), and a "Waiting for you to sign in" status word instead of "Initializing" during sign-in waits (AO2-1).
5. A delivery line on each message, with an honest "delivery uncertain, not retried" state. Today most send errors retry five times, two seconds apart, even when the message may already have arrived. Log failed sends first, to size it (AO2-5).
6. A "Session facts" popover: slowest tools, failed tools, calls that never returned, and compactions (OMX2-3).
7. The context panel says "Available on demand, not loaded" for deferred tools, and "Unverified" instead of 0 (OC2U-11).
8. A narration rule if an "Everyday" view ever hides tool rows: one short sentence before each group of tool calls (JN2-5).
9. Pause animations that cannot be seen: 54 infinite animations in 38 files, and no visibility check (T32-11).

---

## H. Help and tooltips everywhere

Nothing a user would notice has changed on `main` since 10 October (TT2-2). The work exists on three branches (L2). Land it first, then these items finish the job and keep it finished.

### H1. Land the tooltip work as one stack · P0 · M-L · see L2
Part 1 (the tools, the CI ratchet, lint rules, glossary, help drawer, wording guide and review prompt) goes first, rebased on `main`, without its copy of the D1 fix. Parts 2 and 3 then go on top as template and copy changes only, deleting their own copies of the building blocks. Do not queue the three parts in parallel again. Running Part 1's own checker on today's `main` already finds new debt in screens added since 10 October.

### H2. Fix the dead tooltip · P0 · XS · **[checked by Claude]**
`features/instance-list/instance-list.component.html:472` uses `appTooltip="Completed — click to view"`, but `InstanceListComponent` never imports the tooltip directive (`instance-list.component.ts:85`), so the hover never shows. A static attribute on an unknown directive is accepted silently. Add the import, and keep Part 1's "inert tooltip" rule, which catches this class.

### H3. The cheap sweep nobody has done · P1 · S
22 icon buttons with no name and no hover, all at the same places as on 10 October:
- the archive page;
- the codebase panel;
- the hooks configuration;
- the knowledge, memory and context-query panels;
- the skill browser;
- the training dashboard;
- the agent configuration;
- the verification preferences;
- the remote-browse dialog.

Also:
- the message box has no accessible name (`input-panel.component.html:318`);
- two composer buttons have only a native title (`:362`, `:481`);
- 28 icon buttons have a name but no hover, including a destructive "Delete session ×" (`verification-dashboard.component.html:309`).

One sweep with `appIconButton` (or `aria-label` plus `appTooltip` until Part 1 lands) takes icon-only controls that meet the contract from 48 of 169 to more than 150 of 169. Give "Delete session" a visible consequence or a confirm.

### H4. One way to show shortcuts · P1 · S
- **Two clashing designs are queued.** Parts 1 and 2 take a key-binding action id, which is live: it follows rebinding and sets `aria-keyshortcuts`. Part 3 passes a literal string built from `modKeyLabel()`, which is still wrong after a rebind.
- **`main` is behind.** It has 19 hard-coded shortcut strings and no `aria-keyshortcuts`.
- **Fix.** Standardise on the action id, drop `mod-key-label.ts` and Part 3's strings, register actions for the source-control hints, and switch the "no hard-coded shortcut" lint on at zero.
- **Sources:** TT2-6.

### H5. Disabled controls say why, and keyboards can reach the reason · P1 · M
- **The gap.** 264 lasting disabled states give no reason. A disabled button cannot take focus, so a keyboard user can never reach the reason even where one exists.
- **The new screens are the worst.** The plan-queue routing panel (8 of 8 without a reason), provider accounts, the worktree panel's "Merge All", the browser page (34), local models (22), MCP (22) and plugins (15).
- **Fix.**
  1. After Part 1 lands, use `appTooltipDisabledReason`, which keeps the control focusable with `aria-disabled`, on lasting states first. Keep plain `disabled` with a "Saving…" label for short busy states.
  2. Adopt CodePilot's rule: disable a control only when it truly cannot work. If James could fix the cause, let the click happen and show the real error.
  3. A batch button shows the count of eligible targets, "(3)".
- **Sources:** TT2-7; MC2-7.

### H6. A ratchet that survives parallel work, and claims that are pasted, not written · P1 · XS-S
- **What's wrong with Part 1's ratchet.** It is strong, with one gap and one risk:
  - the comparison with the previous baseline runs only for pull requests, while `main` takes direct commits;
  - "stale is an error" plus one shared `baseline.json` will conflict between parallel queue worktrees.
- **Fix.**
  1. Run the base comparison on push too.
  2. Make "stale" a CI warning with an auto-tighten helper, and split the baseline by top-level folder.
  3. Require a written reason for any raised marker (t3code lints that every suppression carries a reason).
  4. Store the words, not only counts, so each new tooltip string shows up in review (openclaw's raw-copy baseline).
  5. Status lines for this work quote the checker's output (L2).
- **Sources:** TT2-8, TT2-3; OC2U-8.

### H7. One vocabulary file with three uses · P1 · S-M
- **What's there today.** The glossary exists only on Part 1's branch (30 entries, used 3 times).
- **Unexplained on screen today:**
  - compaction: 14 of 16 uses;
  - MCP: 13 of 13;
  - worktree: 13 of 13;
  - RTK: 7 of 7;
  - debate: 18;
  - council: 4;
  - parked: 4.

  "RLM" is "Learning database" in help but "RLM" on screen.
- **Fix.** One source, `src/shared/glossary/glossary.ts`, with `{term, plain, group, avoid?, flag?}`, written as "what it means, not how it works" so each entry doubles as a tooltip body (oh-my-opencode-slim's `GLOSSARY.md`, with rejected synonyms and a "Flagged" section for real double meanings, such as "worker" for a machine and for a queue agent). It has three uses:
  1. the `<app-term>` popover and "Learn more";
  2. a check that fails when visible text uses an "avoid" word ("AIO", "instance", "Orchestrator");
  3. a short generated file for agents, plus a 10-line "Words on screen" block and a 4-line "new control" checklist in `AGENTS.md`: tooltip and name, disabled reason, the way back, shared status label (t3code's `AGENTS.md`).
- **Sources:** OMO2-6; TT2-9; T32-7. Extends D6, D8 and C7.

### H8. The screen-and-wording guide, loaded only for screen work, with rules that would have caught this round's problems · P1 · S
- **What's there today.** D8's guide exists only on Part 1's branch.
- **Fix.** Ship it as a project skill that loads when a change touches `src/renderer` or visible text, plus the one pointer line in `AGENTS.md`. It costs nothing in other sessions (agent-orchestrator's `DESIGN.md` front matter). Add these rules, each with an AIO example:
  1. **No fake zero.** Every number on screen has a declared source (measured, estimated, derived or not available), or it is hidden or labelled. Five review questions (CodePilot `CLAUDE.md:62-82`). It would have caught "used: Nx" counting shows, an "effectiveness" score that always adds success, and the inflated Claude dollars.
  2. **Actionability.** "Could James do anything differently because of this? If not, it goes behind Details." Healthy is invisible. Composer controls stay quiet until they hold a non-default value. CodePilot removed its own badge system after learning this.
  3. **Enabled and running are two lines**, and "not checked" is not "unavailable" (U2).
  4. **Every automatic action's notice names its off switch**, and a hint may fade but a count must not (Claude Code 2.1.302).
  5. **openclaw's ten rules** (`ui/AGENTS.md`):
     - omit rather than estimate;
     - show progress once;
     - never open a panel because something happened in the background;
     - no second line repeating what an icon shows;
     - hide empty things;
     - an explicit close sticks;
     - the pointer cursor only for links;
     - completion buttons last;
     - colours only from tokens;
     - a blocked action says what happens to the user's work.
  6. **Agent-orchestrator's six-moment lifecycle table** (arrive, leave untouched, begin, active, finish, interrupt), **three review classes** (Blocker, Must fix, Follow-up) and **a dated decision log** of James's rulings (Harness as the name; no rotating tips; healthy is invisible).

  D9's review angle checks changed lines against these rules.
- **Sources:** MC2-4, MC2-5, MC2-6; OC2U-7; AO2-2; CC2-13. Extends D8 and D9.

### H9. Tooltip copy for the places James uses most · P1 · XS-S
- **The queue dock** still has native titles with vague words: "Will send before passive queued messages", "Steer this queued message now". The hint says only "Enter to queue". Replace them with timing-aware copy, after checking each provider's real steer behaviour: "Steer: send this into the running turn now. The agent reads it after its next tool call." The hint becomes "Enter queues this to run after the current turn. Use Steer to redirect it now." (hermes' queue wording).
- **The plan queue** has 32 buttons and 4 tooltips. Pause, Resume and Cancel have none: say when each takes effect. Land Part 2's `tooltip-copy-plan-queue.ts`.
- **The effort picker and the Codex settings:** see U12.
- **Sources:** HE2U-6; TT2-11.

### H10. Smaller tooltip items · P2
1. `title` used as an input on six shared components (`app-empty-state` and five others) also paints a native grey hover over the whole card. Rename the input to `heading` (Part 3's step 1e) and ban `title` on component tags (TT2-12).
2. `appTooltipTpl` has no users. If it stays unused after the migration, delete it (OC2U-8).
3. A build and version tooltip on the Harness name in the title bar: version, build, branch, commit and data folder, with copy. James runs a dev checkout, an installed app and queue-worktree builds side by side (AO2-9). It pairs with K2's "Settings > About" migration level.

---

## K. Keeping house: numbers, storage, versions, documents

### K1. Fix the cost-history clean-up before the next restart · P0 · XS-S · **[checked by Claude]**
- **What's wrong.**
  - **The fix arrived in two halves.** Per-turn Claude cost booking reached `main` in the Phase 2 merge (`06201b4b0`, 15 October) and has run in James's app since his 17 October 08:31 restart. The one-off history repair and migration 077 arrived only with the Phase 0 merge (`199d74d7f`, 18 October 15:34), after his last start, so they have never run.
  - **The cutoff is wrong.** Migration 077 stamps the cutoff as the moment the migration runs (`src/main/persistence/rlm/rlm-migrations-076-080.ts:18-35`). The repair then treats every Claude row older than that as a running total and subtracts the previous value (`src/main/core/system/cost-entries-a0-repair.ts:21-47`). It runs on every start until its marker exists (`src/main/ipc/handlers/cost-handlers.ts:64-68`).
  - **The effect.** The 574 rows booked per turn between the 17 October restart and 21:13 on 19 October would be cut from $1,780.97 to $1,454.82 (−18%); by 22:05 it was 613 rows, $2,203 to $1,751 (−20.5%), and it grows with every turn. The originals go to `cost_entries_a0_backup` first.
- **Fix.** Before the next restart on current `main`:
  1. Set the cutoff to the first per-turn booking: a one-off migration 078 writes the install's first per-turn time, here 17 October 08:31:19 BST, before 077's repair runs. Better, add a `cost_basis` column (`running-total` or `per-turn`) written by `CostTracker.persistEntry` from now on.
  2. Add a guard test: rows booked per turn before the migration survive the repair unchanged.
- **Done when:** the test passes, and after the restart the repaired total matches the session-chained backup within 0.5%.
- **Sources:** `aio2-tokens-db` TD-1.

- **Correction from the fact-check (replaces fix 1 and "Done when" above).** Do not add migration 078 (the Phase 1 branch already uses 078-080 and the follow-ups branch 081) and do not edit 077 (an applied migration that changes text stops the app starting). Instead give the Claude branch of `repairCostEntriesA0` its own cutoff (this install's first per-turn time, 17 Oct 08:31:19, or "stop at the first falling pair per session"), and keep the migration-time cutoff for Copilot and Cursor rows, which are still cumulative. A `cost_basis` column would break the repair's `SELECT *` backup insert unless the backup table gains the column too. **Done when:** no row dated on or after the Claude cutoff appears in `cost_entries_a0_backup`, those rows' summed cost is unchanged by the restart, and Copilot and Cursor rows in that window are repaired. Rebuild the app after the fix, then restart (`_verify-3` M1).

### K2. Restart on current `main`, then prove the October fixes are running · P0 · S
- **Why.** James's running app predates the Phase 0 merge, so these are on `main` but not live:
  - A0's purpose recorder, Copilot correction, helper fallback records and back-off, the Costs page panel and the helper-size records;
  - A10's header cost;
  - A14's guards;
  - A1, A2, A3, C3a and D1.

  The proof is in the data: since 10 October there are no `cross-model-review` or `fresh-eyes-review` purposes in the cost log, and 2,297 helper fallbacks still have no provider.
- **Fix.**
  1. After K1, restart, then re-run the audit's queries for one full day:
     - review purposes appear;
     - helper fallbacks name a provider;
     - Copilot rows are per turn;
     - `SELECT COUNT(*) FROM local_ai_routing_events WHERE created_at > <restart> AND actual_route='frontier' AND provider IS NULL` is 0.
  2. Turn `showCost` on, if James wants the header cost (his stored setting is off).
  3. Show the build commit and the RLM and loop migration levels in Settings > About, so "is the fix running?" has a one-glance answer.
- **Sources:** TD-7, TD-9.

### K3. Honest spend numbers everywhere · P1 · S each · **[queue spend formula checked by Claude]**
1. **Unknown is not zero.** The plan queue turns an unpriced call into `0` (`src/main/plan-queue/plan-queue-spend.ts:24`, `costUsd ?? 0`) and prints `$0.00`: 24 of 72 priced-era jobs, carrying 17.2M tokens. Keep three states: known dollars, known free, not priced. Show "$379.93 known · 17.2M tokens not priced", and average only over known costs (oh-my-codex `session usage`; openclaw's "≥" and "Unpriced"; CodePilot's "no fake zero").
2. **Queue spend counts what was processed.** It records `inputTokens + outputTokens` only (`plan-queue-spend.ts:21`), about 20 times low. Every Codex estimate is labelled "exact", and no role is stored, so 86% of queue turns cannot be attributed afterwards. Store processed tokens (input, cache read and cache write) and output separately, set "exact" only for provider-reported cost, and add a `plan_queue_spend(item, run, role, round, provider, model, processed, output, cost, cost_basis)` table like the loop's.
3. **Claude cache writes are under-priced.** AIO prices them at 1.0 times input (`src/shared/data/model-pricing.ts:208-218`); Anthropic bills 1.25 times for the 5-minute cache and 2 times for the 1-hour cache, and 53% of sampled writes were on the 1-hour cache. Read the split from `usage.cache_creation` and fall back to about 1.6 times. This moves every token-priced Claude figure: helper estimates, the $2-a-day helper cap and audits.
4. **Codex's 272K premium** goes into the price table (T2).
5. **Ask Codex what a thread cost.** `account/usage/read {threadId}` returns Codex's own credit estimate per thread, with a model and effort split; AIO never calls it. First a one-off check on about 10 finished threads, which settles whether the 272K premium reaches plan credits. Then record credits per root thread and use them as the trial's unit.
6. **Codex queue threads leave no record.** They are ephemeral (`adapter-factory.ts:291`; only top-level chats persist, `provider-session-durability.ts:6-12`): 163 queue thread starts in three days, and none has a transcript. Write one usage line per ephemeral thread when it ends: thread, job, kind, arm, requests, tokens, helpers, compactions, duration.
7. **Reconcile Claude with Claude's own figure.** The Claude CLI now writes its own running cost into every transcript (`cost-state`). Check AIO's Claude store against it daily and flag drift.
8. **Helper agents' model.** Record each helper's own model (from frames with `parent_tool_use_id`) next to its size, so helper cost is priced right (jean `31abea1c`).
- **Sources:** OMX2-1; TD-5; LQ-14; CC2-12; CX2-1, CX2-7; TR2-2, TR2-10; JN2-4; OC2U-3; T32-8; MC2-4.

### K4. Storage: 130 GB in the data folder, growing about 4 GB a day · P1 · S-M
- **What is there (19 October, against 10 October):**

  | Store | Now | Change | State of the clean-up |
  |---|---|---|---|
  | Conversation ledger | 48.3 GB (file 51.8 GB) | +19.4 GB | Capture stopped on 17 October as designed; the file only shrinks with a manual rebuild, possible from about mid-November |
  | RLM | 33.8 GB, including the two July backups (24.1 GB) | +0.9 GB | Storage page can remove them; ask first |
  | Codex backups (`~/.ai-orchestrator/codex/backups`) | 40.7 GB, 443 copies | +155 MB per app start | Keep-3 is built but only on the follow-ups branch |
  | Codex sessions | 23.4 GB | | none |
  | Code index (`codemem.sqlite`) | 12.7 GB | +5.5 GB | 22 plan-queue worktrees are indexed as separate projects (41-48% of rows); the 10-root eviction can push out James's real projects |
  | Conversation evidence | 8.0 GB | +4.8 GB | not examined |
  | Session states | 7.2 GB | +3.0 GB | Storage page removes items over 30 days old (manual; 1.9 GB eligible) |
  | Observation memory (inside RLM) | 404 MB, 48.5K rows, 88% past their own expiry | grows | The only clean-up function is never called |
  | RTK history (James's) | 862 MB, 1.1M rows | +322 MB in 9 days | K6 |
  | Temporary Codex homes | 4,430 `codex-nomcp-*` folders in three days | | Start-up sweep removes only folders older than a day; likely spec runs; unconfirmed |
  | Task worktrees (`.worktrees/task-*`) | 7.8 GiB in nine clean September worktrees | | Listing card exists; nothing sweeps |

  Total app folder: **129.8 GB (binary GB; about 139 GB in Finder), up about 40 GB in 9.9 days** by the per-store changes above (the 10 October total was a rounded figure). Also outside AIO: OpenCode's own database is 28 GB (shared with OpenCode desktop; do not touch it from Harness), and Claude's transcripts are about 37% bigger per session since CLI 2.1.300.
- **Fix.**
  1. Land Codex keep-3 from the follow-ups branch: 40 GB back now, 155 MB saved per start.
  2. Stop indexing sessions whose folder is under `.worktrees/`: map them to the parent repository's index. Delete a worktree's index when the queue removes the worktree, and exempt roots James opened himself from eviction.
  3. Call `applyDecay()` for observation memory at start-up and daily (about 42.7K rows), and stop capturing machine sessions (decision 9 covers keeping the feature at all).
  4. Show a one-time "Shrink now (frees about 40 GB)" on the Storage page once the ledger passes half free pages.
  5. Cap session-state file size, and keep states only for sessions in history.
  6. Sweep leaked temporary Codex homes more often.
  7. A safe clean-up for old work folders: list each with its age, size, clean or dirty state, unpushed commits and a live-process check. Archive dirty ones to a git ref before removing, offer Restore, and always ask (hermes `worktree_archive.py`).
  8. Show total size and weekly growth on the Storage page.
- **Expected benefit.** About 105 GB back: Codex backups 40 GB, July RLM backups 24 GB (with James's yes), the ledger about 40 GB from mid-November, old states 1.9 GB.
- **Sources:** TD-10, TD-11; MC2-1; HE2R-7; CX2 leads; OP2-11; CC2-5.

### K5. Versions: CLI updates never apply, and floors for remote computers · P1 · S · **[auto-update checked by Claude]**
1. **CLI auto-update skips while any session exists**, idle and hibernated ones included (`src/main/cli/cli-auto-update-service.ts:155-161`; the count is the instance map size, `late-runtime-initialization-steps.ts:346`). The logs show 7 skips with 28-95 open sessions and **no update applied** in the window, although James opted in. Count only sessions that cannot be interrupted, keep the "safe installer" filter, and add a pill note: "Update waiting: 2 sessions are mid-turn" (agent-orchestrator `49bc06bb7a`).
2. **A Claude CLI floor table** in `claude-cli-feature-probes.ts`:
   - 2.1.300 for resumed sessions (earlier versions can lose their summary, and tool search can switch itself off);
   - 2.1.299 for side questions;
   - 2.1.302 for tool-search cache stability.

   Show it in plain words for remote computers.
3. **A Copilot floor:** below 1.0.100 Copilot "may stall for minutes on a hung tool server".
4. **Codex upgrade watch:**
   - incremental tools became default-on upstream on 19 October;
   - background compaction and rollout compression are coming;
   - a compressed rollout (`.jsonl.zst`) would vanish from AIO's session lookups, which only read `.jsonl` (`session-scanner.ts:114`).

   Pin compression off or accept `.zst`. Regenerate the protocol snapshot on every CLI bump (installed 0.163.0, snapshot 0.162.1).
- **Sources:** AO2-4; CC2-9, CC2-11; CX2-5.

### K6. RTK: the Savings tab freezes the app, and the next upgrade is a licence choice · P1 · S · **[checked by Claude]**
1. **The Savings tab freezes the main process.** Opening it runs full-table queries on James's RTK history (862 MB, 1.1 million rows, +322 MB in nine days) synchronously in Harness's main process (`src/main/cli/rtk/rtk-tracking-reader.ts:345-360`, `src/main/ipc/handlers/rtk-handlers.ts:58-75`). The same queries took 5-6.5 seconds each from the command line. Default the tab to 7 days, read in a worker, keep a small incremental daily roll-up, and show the last result at once with "refreshing".
2. **The next RTK bump is a licence choice.** From RTK 1.0 the default download includes BUSL-1.1 code; an Apache-only `rtk-oss` download exists. AIO also ships no RTK licence text today. Choose 0.52.0 (the last all-Apache release, which brings the pipeline and exit-code fixes) or 1.x `rtk-oss` (Decision 10), and ship the licence file beside each binary.
3. **The `git cat-file` burst is back.** About 3,000 calls an hour on 16 and 19 October in work-finding and one of its queue worktrees: about one a second, which looks like a script loop. Add a notice when one project calls RTK more than about 2,000 times an hour. The queued awareness wording ("don't add `rtk` inside scripts or pipelines") is aimed at it.
- **Sources:** PR2-2, PR2-6, PR2-7.

### K7. Untrack the 72 planning documents the queue committed by mistake · P0 decision · XS
`3be08c73a` put `claude_oct-todo.md` and 71 active plan and live-check documents into git on `main` (69 of the 71 are still tracked). The lifecycle says they must stay untracked until `_completed`. `git rm --cached` on those paths keeps the files on disk and stops tracking them; nothing in history is rewritten. Together with L1's identity guard, it stops queue worktrees from carrying stale copies of their own plans. James decides (Decision 2).

### K8. Observation memory and the Wake page · P1 · S
1. **Observation memory** records everything and almost never helps:
   - 48.5K observations (404 MB) and 8.7K reflections, 88% and 58% past their own expiry, because `applyDecay()` has no caller except an unused IPC;
   - only 20 different reflections injected in eight months (773 injections between them);
   - promotion can never fire (it is checked only when a reflection is created, at a usage count of 0; `reflector-agent.ts:126-133`);
   - every machine session is captured.

   Schedule the clean-up, stop capturing machine sessions, and decide whether to keep the feature (Decision 9).
2. **The Wake page** shows 877 notes, but only 368 are distinct. 553 are legacy rows not shown since 3 May, "used: Nx" counts shows, and a removed mined note can be re-added by the miner (the code path was read; it has not been seen to happen). Hide the legacy rows and duplicates behind a "Hidden" tab, relabel "used" as "shown", add a one-line health summary ("877 notes, 368 different, 206 shown this week"), and add a tombstone so a removed note stays removed.
- **Sources:** MC2-1, MC2-3. Corrects the first list's MEM-2 (promotion cannot fire as it described).

### K9. Two habits that save the next round's research · P2 · XS-S
1. **A lasting register of rejected ideas.** Add `docs/decisions/rejected/<topic>.md`, each with a stance, the reason and a reopen condition, and one `AGENTS.md` line: "before proposing a feature or starting a research sweep, read docs/decisions/rejected/". Seed it from both lists' "considered and rejected" sections (oh-my-opencode-slim's `.out-of-scope/`).
2. **A measurement kit.** Add read-only scripts under `scripts/audit/` (the context-ceiling replay, the composition scan, the polling scan) whose headers carry hermes's rules:
   - label figures observed or modelled;
   - print coverage first;
   - three repeats at least;
   - ±3% is noise;
   - exclude research-sweep sessions;
   - de-duplicate by message id;
   - report the read, write and output mix beside any ratio.

   This round needed all of them: two agents' first passes were distorted by this sweep's own sessions and by duplicated transcript lines.
- **Sources:** OMO2-7; HE2R-8.

### K10. Copilot loads this repository's AGENTS.md twice · P2 decision · XS
Copilot's own system message contains `AGENTS.md` twice on CLI 1.0.97 and 1.0.99. Making this repository's `CLAUDE.md` a symlink to `AGENTS.md`, and moving the `@docs/angular-conventions.md` import into `AGENTS.md`, lets Copilot de-duplicate identical files: about 2.6K cached tokens per Copilot request here. It changes how Claude Code reads the repository, so James decides (Decision 11). Separately, check after the restart that the 18 October fix delivers Harness's instructions to Copilot: 0 of 1,238 Copilot first messages carried them before it.
- **Sources:** CC2-11.

---
## Decisions for James

Thirteen short questions. Answer by number; the recommended answer is (a) each time. Anything not listed follows your 10 October approvals. Note for the plans: a changed default does not reach your install by itself, because your settings file stores every value, so each default change (T2, T3, T7) needs a one-off settings update.

1. **Land first, then new work.** Merge the built October work (L2) before starting new plans?
   (a) Yes: land Phases 1, 3, 5, the three tooltip parts and the follow-ups first. (b) Run new plans in parallel.
2. **The 72 planning documents the queue committed by mistake** (71 unfinished plans and live-check documents, plus the first to-do list). (a) Stop tracking them (`git rm --cached`; the files stay on disk and history is not rewritten). (b) Leave them tracked. Either way, the rest of that commit (about 45 code files and 35 other documents) stays as it is.
3. **Codex's working memory.** (a) Keep the work Harness starts by itself (queue, loops, scheduled jobs, reviews) under 272K tokens of working memory, and let your own chats use 500K only if you switch it on. (b) Keep 500K everywhere.
4. **Long Claude chats.** (a) After a quick quality check, turn the long-chat cap on at about 300K for your own chats; leave queue jobs and helper agents alone. (b) Leave it off.
5. **Opus on Copilot.** 14 Copilot chats on Opus, at 15 premium requests a message, used two-thirds of Copilot's allowance; everything Harness starts by itself already uses the 1-request models. (a) Show the cost wherever Opus is picked for Copilot, and a running count of premium requests in the chat. (b) Leave as is.
6. **Queue notices in the chat that started a run.** The per-job "write a full report" messages stop either way, because they go against the queue's own design (T4 fix 1). (a) Show the queue's own notices as quiet notes that do not wake the model, and send queue questions to the queue page unless you pick that chat in a new setting. (b) Keep notices waking the chat.
7. **Big plans.** (a) The queue warns about plans over about 120 KB and turns big plans into one job per step; after a one-off trim of today's plans it also refuses plans over 200 KB (six current plans are above that). (b) No size rule.
8. **"Allow once".** (a) Make it truly once. (b) Keep the one-hour memory and rename it "Allow for the next hour".
9. **Observation memory** (only 20 of its 8,670 notes have ever been used, though those 20 were used 773 times between them; it holds 404 MB). (a) Switch it off by default, clean it up and hide its page until it earns its place. (b) Keep it, clean up and stop it recording machine sessions. (c) Leave as is.
10. **RTK's next version.** (a) 0.52.0, the last all-Apache release. (b) 1.x `rtk-oss` (Apache edition). (c) The default 1.x download (includes BUSL code).
11. **Copilot reads this repository's AGENTS.md twice.** (a) Make `CLAUDE.md` a link to `AGENTS.md` (and move its one import into `AGENTS.md`). (b) Leave it.
12. **One "pause new work" switch** for loops, the queue, scheduled jobs and wake-ups. Harness already has a Pause button that refuses all messages, hidden in your settings; this would extend it so loops, the queue and scheduled jobs wait quietly instead of failing. (a) Build it (later, P2). (b) Not needed; the queue's own Pause all is enough.
13. **Codex helper trial for queue and loop work.** On 10 October you approved helpers off there after a side-by-side trial, and the trial is running. The first three days show about 11% fewer tokens per queue job with helpers off, on a small sample, and nobody has compared pass rates yet. (a) Add each side's pass rate, run it about a week, then switch helpers off for Harness work if that side is no worse. (b) Switch them off now. (c) Leave the trial as it is.

---

## Suggested order

| Phase | What | Why this order |
|---|---|---|
| **A: safety and truth (days)** | K1, then restart; K2; L1; L3; T2; T3 step 1 (pass rates in the helper trial, Decision 13); T4 fix 1 (no per-job reports), then fixes 2-4; T12; T15.1 (the OpenCode bug); H2; U5; U6 step 1; U4's phone fix; K7 if (a) | Each is small. Together they stop work being lost, stop the biggest avoidable token flows and make the numbers trustworthy |
| **B: land what is built (1-2 weeks)** | L2 in order: Phase 1 (both ceiling defaults set to 0 at merge), Phase 3, Phase 5, Phase 4 as one stack (H1), follow-ups; alongside, T1's items 1 and 3, the one-off diet (item 7), then item 5 as a warning | Most of the approved screen, tooltip and token work arrives without new design. The plan diet keeps the landing runs cheap and the checkers able to read the plans; the size gate warns until the diet has run, so it cannot block the stranded plans |
| **C: a queue that finishes (1-2 weeks)** | L4, L5, L6, L7, L9, L10, L12; T8, T9; K3 items 1, 2 and 6 | L7's verdict history and K3's honest spend make the rest measurable |
| **D: tokens** | T5, T6, T7 (after the recall check), T10, T11, T13, T14, T16, T17; K3 items 3-5 and 7-8 | Each is checked against K2's live numbers |
| **E: screen** (after Phase 3 lands) | U1, U2, U3, U4, U7, U8, U9, U10, U11, U12 | Phase 3 steps 7 and 8 (notices and wording) are the natural home for U1-U4 |
| **F: tooltips** (after Phase 4 lands) | H3-H9 | The ratchet must be live before the sweep, or the gains leak again |
| **Alongside** | K4, K5, K6, K8, K9, K10 | Low risk; storage clean-ups always ask first |
| **Later (P2)** | L11, L13, U13, H10, T15.2-7 | Useful, not before the rest |

Each phase becomes its own dated plan with the normal gates and the fresh-eyes completion gate. Screen checks run on the Windows PC (or on the Mac only with James's OK); headless test runners are fine.

---

## Appendix A: status of every 10 October item (19 October)

"Running" means on `main` and in James's app. "On main" means merged but arriving with the next restart (after K1). "Waiting" means on the Phase 1 branch. "Stranded" means on a parked branch. Phase 1's 14a control-channel work and 18a's items 2-6 belong to Phase 1.

| Item | Status | Notes and evidence |
|---|---|---|
| A0 true spend numbers | Partly running, mostly on main | Per-turn Claude booking running since 17 October; history repair has the cutoff bug (K1); recorder, Copilot fix, helper records, Costs page and helper telemetry on main (TD-7) |
| A1 "Compact now" writes a summary | On main | Phase 0, including the anchor index, verbatim user messages and wait rule; a small tweak to the user-message filter is still uncommitted in the root checkout; the recovery pointer is partly built, only on the Phase 5 branch (A11 step 1b; its plan still lists an open requirement) |
| A2 instructions to OpenCode and Copilot | On main | 96,000-character budgeted delivery and ownership rules (`acp-system-prompt-delivery.ts`); before it, 0 of 1,238 Copilot first messages carried them |
| A3 loop instructions not re-sent | On main | Re-anchor on provider compaction, recycle, every 10th round (`loop-goal-reanchor.ts`, `claude-compaction-observer.ts`) |
| A4 context ceiling | Built, off | Defaults 0/0 (`settings-defaults.ts:158-159`); Phase 1 branch sets 250K/200K; T7 recommends own chats only |
| A5 machine-started sessions | Mostly running | Read-only reviewers, turn and $1 caps, security plugin off; `DISABLE_GIT_INSTRUCTIONS` dropped with evidence; one-shot `--no-session-persistence` not built |
| A6 OpenCode levers | Waiting | Phase 1; A6.2 has no effect on OpenCode 2; A6.6 resolved upstream (T15) |
| A7 context doctor | Not built | U11 is a simpler route |
| A8 side jobs on the live Claude session | Waiting | Phase 1 control channel; CC2-2 gives the 2.1.303 contract |
| A9 cheaper composer defaults | Waiting | Phase 1; A9.1 big pastes dropped |
| A10 cost where James works | On main | Header no longer forces `showCost` off; James's own setting is off |
| A11 read another session by pointer | Partly stranded | References on the Phase 5 branch; no MCP tool on main |
| A12 short, delivered guidance | Waiting | Phase 1 (guide source 28 KB → 15 KB); see T11's warning |
| A13 RTK | Partly running | Bundled 0.51.0 running; hook, trial and honest Savings waiting; Codex hook not built (T16, K6) |
| A14 second opinions | On main | Changed-file trigger, skips, 20 a day; about 37 a day on 16-19 October and rising (T9) |
| A15 scheduled-job pre-check | Waiting | Phase 1 step 8 (L10) |
| A16 Codex helpers, caps, compaction | Partly running | Thread policy running as a 50/50 trial; standing notes and trial report waiting; snapshot regenerated (T2, T3) |
| A17 fan-out leaks | Waiting | Phase 1 (child-result batcher, browser 12K cap and others) |
| A18 Claude helper agents | Waiting | Phase 1 trial (T6) |
| A19 tool-output caps | Waiting | Phase 1 (Bash cap); size it by command type (`ref2-pi-rtk` PR2-3) |
| A20 memory notes earn their place | Built, stranded on the Phase 3 branch (`turn-injection-policy.ts`: four-word minimum, 8K cap, de-duplication) | MEM-4 on main; T12 adds what A20 lacks |
| A21 approve a plan into a fresh session | Waiting | Phase 1 |
| B1 loop quick fixes | Mostly running | Notes trimmed by bytes, iteration log capped; five stale paused runs still open (L13) |
| B2-B6 finish phase, baselines, end states, live questions, spend | Running (unexercised) | Phase 2; no loop has run since 24 September |
| B7 cheaper reviewer rounds | Partly | Loop side present; the queue checker has none of it (L7) |
| B8 plan-queue reliability | Partly running | Document merge, restart survival and triage retry working in data; "land when only old failures" not built (L4) |
| B9 loop and queue screens | Partly | Plain set-aside labels; no next steps (L9) |
| B10 stall facts | Partly running | Process facts on stalls; Codex false-stuck unverified |
| B11-B13 OpenCode loop parity, provider goal row, handoff intent | Not built | |
| B14 keep the Mac awake | Running | Battery and heat guard not built (agent-orchestrator AO2-7, small) |
| B15 Copilot limit messages | Running | |
| C1 Close all asks first | Running | |
| C2, C3c-g, C4, C8, C9 | Stranded (Phase 3) | L2 |
| C3a approval buttons name their scope | On main | |
| C3b answer every tool's ask in-turn | Not built | |
| C5, C6, C7, C10, C11 | Not built | U1-U4 are their smallest slices |
| C12, C13 | Stranded (Phase 5) | L2 |
| D1 tooltip directive fixes | On main | |
| D1b-D10 | Stranded (Phase 4 parts 1-3) | H1 |
| D11 tips while waiting | Built, stranded on the Phase 5 branch (`shared/tips/*`, `<app-working-tip>` in the session view; plan Step 17 ticked) | Arrives with L2 |
| E1 storage | Partly | Ledger capture off and sweep working; Codex keep-3 stranded; K4 |
| E2 leftover worktrees | Listing card running | The worktrees themselves remain (K4 item 7) |
| E3 stale versions and comments | Running | |

---

## Appendix B: research coverage

| Report (`_scratch/oct2-audit/`) | Scope | Status |
|---|---|---|
| `aio2-tokens-static.md` | Every prompt and injection AIO builds; plan-document bloat; tool catalogues; status of A1-A21 and E3 | complete |
| `aio2-tokens-db.md` | AIO's databases and logs, 10-19 October against the month before; storage; status of A0, A4, A10, A14, A15, A18 | complete |
| `aio2-tokens-transcripts.md` | Claude, Codex and Copilot transcripts; helper shares; plan-queue sessions; research sweeps separated | complete (revised twice) |
| `aio2-loops-planqueue.md` | Plan queue, loops and automations in practice; set-aside causes; status of B1-B15 and A15 | complete |
| `aio2-ux-clarity.md` | Status of C1-C13 and E2; fresh clarity audit of the renderer and of James's screenshots | complete |
| `aio2-tooltips.md` | Status of D1-D11; like-for-like re-measurement against the 10 October tree; enforcement | complete |
| `ref2-openclaw-runtime.md`, `ref2-openclaw-ux.md` | openclaw engine and interfaces (about 7,400 commits) | complete |
| `ref2-hermes-runtime.md`, `ref2-hermes-ux.md` | hermes-agent engine and interfaces (about 3,900 commits); context-ceiling replay | complete |
| `ref2-t3code.md` | t3code (1,305 commits) | complete |
| `ref2-opencode.md` | opencode (329 commits; v2 promoted to `dev`) | complete |
| `ref2-omo-slim.md` | oh-my-opencode-slim (331 commits) | complete |
| `ref2-omx-claw.md` | oh-my-codex and claw-code | complete |
| `ref2-codex.md` | codex, codex-plugin-cc, CodexDesktop-Rebuild; Codex window change | complete |
| `ref2-claude.md` | claude-code CHANGELOG 2.1.299-2.1.303, plugins and mods, "Actual Claude", copilot-sdk | complete |
| `ref2-storybloq-tura.md` | storybloq (251 commits) and tura | complete |
| `ref2-agent-orchestrator.md` | agent-orchestrator (164 commits) | complete |
| `ref2-pi-rtk.md` | pi and rtk (RTK 1.0) | complete |
| `ref2-jean-nanoclaw.md` | jean and nanoclaw | complete |
| `ref2-memory-codepilot.md` | mempalace-reference, OB1, CodePilot, online-orchestrator | complete |

Lead's working notes: `_synthesis-notes.md`, `_PROGRESS.md`. Agent brief: `_BRIEF.md`, `_SCOPES.md`.

---

## Appendix C: considered and rejected this round (so nobody re-researches them)

- **Rate-limit pacing and a shared admission gate** (openclaw): only 6 provider-limit events in 30 days, with no measured herd.
- **openclaw's goals engine**: AIO's loop engine is richer. Event-triggered automations need a public HTTPS endpoint.
- **Composer predictions and next-message autocomplete** (openclaw, agent-orchestrator): one extra model call per reply.
- **RTK's proxy daemon, pipelines and cheaper-model read delegation**: lossy or BUSL-licensed, and worth about 0.04% of cache reads. "Elide repeated identical outputs" is dead: the duplicates were a transcript double-logging artefact.
- **File re-reads as a lever**: only 7.3% of file reads repeat a range already in context, about 0.8% of spend.
- **A one-hour cache for helper agents**: still cost-neutral, and long-gap rewrites fell 11 times anyway.
- **Max effort as a saving lever**: max-effort helper requests are no longer or dearer than high-effort ones.
- **Claude's `mcp_toggle` as a "this session only" switch**: it persists per folder. Claude's own idle compaction inside AIO: terminal-only and server-gated.
- **Machine-started Codex runs with James's plugins and servers stripped**: declined by Decision 2 (10 October).
- **Hourly wake budgets per agent** (jean): AIO has no event storms. Quota holds for cadence jobs: 1 of 94 failures. Identical-finding suppression for automations: 3 of 399 runs.
- **Delegation completion as notes instead of turns** (hermes): it would stall overnight orchestrators. A17.1's batching is the right shape.
- **One-shot cache markers** (hermes): AIO's helper calls set none.
- **Seven claw-code runtime fixes** visible in the since-10-October log: they were reverted upstream the same day. Do not cite them.
- **oh-my-codex sparkshell** (summarise long output with a cheap model): lossy, and adds a call.
- **t3code's "zero native titles" lint shape**: leaky (its own truncation component sets `title`). AIO's template-parser ratchet is stricter.
- **First-run welcome wizards**, remote tool-usage telemetry, React Compiler work, and multi-user or hosted features (team mode, avatars, cloud environments).
- **Thread/sample side questions on Codex**: not in the installed CLI, and AIO has no tool-less check-ins that need it.
- **A global ESTOP** was judged polish by one hermes scout. It is kept as L11 at P2, because the other argued it matters for a runaway or a quota emergency.

---

## Appendix D: verification log and corrections

**Re-traced by Claude, independently of the agent that found each one (19 October):**
1. Commit `3be08c73a` is on `main` with 152 files: 71 active lifecycle documents plus `claude_oct-todo.md`. `checkpoint()` has no identity check (`plan-queue-worktree.ts:160-179`); `parkUnlocked` calls it on `existsSync` (`plan-queue-item-flow.ts:591-593`); `assertQueueCheckout` is used only by `reattach` and the reconciler's read-only alert. The only checkpoint commit on `main`. No identity check has been added to `checkpoint()` or `revertToSnapshot` since (other queue files changed on 18 October). (L1)
2. The October branch table: ahead and behind counts for every `queue/2026-10-1*` branch, and the job states in the queue's own records: exactly three October plans have a job in the "landed" state. (The queue lands by squash, so an ancestry test cannot separate landed from stranded branches, and land-blocked jobs also carry a `landed_commit`; an earlier draft used each of those tests.) (L2)
3. The Phase 4c root claim "round 9, 0 titles": the last checkpoint on any ref is round 3 (`65a144b19`), and the September task worktrees hold no tooltip work. (L2)
4. The queue settles a checker's turn at the first idle or complete event (`plan-queue-instance-tracker.ts:141-143`, `:195-197`), and nothing under `src/main/plan-queue` reads the async-work registry (`hasInhibitor`, `instance-async-work-registry.ts:94-97`). (L3)
5. A `PASS` goes to landing on the verdict alone (`plan-queue-item-flow.ts:509-513`); the reported gates are stored as given (`plan-queue-coordinator.ts:480-492`); 8 landed jobs' own verdicts list a non-zero gate. (L4; see correction 3)
6. The cost-history repair's cutoff is the migration's own time (`rlm-migrations-076-080.ts:18-35`), it differences every older Claude row (`cost-entries-a0-repair.ts:21-47`) and it runs at start-up (`cost-handlers.ts:64-68`). (K1)
7. Which merge brought which fix: `requestAll()` (C1) in `06201b4b0`; `compact_boundary`, `tooltip-visible-text`, the "Always allow" label, `CONTINUITY_WAIT_RULE` and `acp-system-prompt-delivery` in `199d74d7f`. (Status tables)
8. Context ceilings default to 0 (`settings-defaults.ts:158-159`, `context-ceiling.ts`), and Codex helper policy defaults to `trial` (`:160-161`). (T3, T7)
9. Restart handling for automations (`automation-runner.ts:128-136`, `automation-store.ts:686-724`), and no run time limit in `src/main/automations` (the only timers are the scheduler's and the provider-limit reconciler's ticks; a 900-second Codex turn timeout exists only on an old provider path). (L10)
10. `update_automation` accepts effort up to `max`, `ultra` and `workflow` and auto-approve, applied without comparison with the caller (`orchestrator-automation-tools.ts:203-208`, `automation-tool-impl.ts:327-346`). (L10)
11. The queue reaches the chat that started a run in two ways: its own notices through `sendInput` (`plan-queue-parent-messenger.ts:79-96`), and, because its jobs are created as that chat's children (`plan-queue-item-flow.ts:212`, `:407`; `plan-queue-triage.ts:133`), the general child-completion handler's `child_completed` and "all completed" injections (`instance-child-completion-handler.ts:85-145`, `orchestration-handler.ts:1077-1156`). Re-measured; see the fact-check below. (T4)
12. Children close with their parent by default, and neither close dialog gives a count or a choice; the single-session dialog does not mention helpers at all (`instance-create-builder.ts:76`, `instance-termination.ts:341-383`, `terminate-confirm-dialog.component.ts:52-63`). (U5)
13. "Allow once" is cached for an hour (`permission-manager.ts:221`, `:655-667`). (U6)
14. Approval labels did land on main (`user-action-request.rules.ts:69-82`); the default for a Claude denial is still "always", and the label now says so. (U6)
15. The startup "degraded" rule (`capability-probe.ts:16-26`, `:176-187`). (U2)
16. The Codex stderr duplicate key includes the timestamped line (`exec-process-runner.ts`, around line 417), and the usage-limit text (`claude-cli-adapter.ts:1778`). (U1)
17. The tool-group label has no failure count (`tool-group.component.ts:240-253`). (U7)
18. A dead tooltip (`instance-list.component.html:472`; the component's imports at `:85`). Native `title="` attributes on main: 128 in HTML templates and 97 in inline templates. (H2, H3)
19. Machine-written inputs still get retrieval (`instance-manager.ts:1672` → `instance-input-contexts.ts:109`, no option passed). (T12)
20. CLI auto-update skips while any instance exists (`cli-auto-update-service.ts:155-161`; the count at `late-runtime-initialization-steps.ts:346`); 7 skip lines and no other updater lines in the logs. (K5)
21. The RTK Savings tab queries James's 862 MB RTK history synchronously in the main process (`rtk-tracking-reader.ts:200-215`, `:345-360`; `rtk-handlers.ts:58-75`). (K6)
22. Plan-document sizes, 73 pending live-check documents (68 completed) and the register's size (1,058,876 bytes). (T1, L12)
23. Plan-queue counts and set-aside reasons from `loop-mode.db` (read-only). (L section)
24. The 50 "You are one of two independent judges" Claude sessions in one queue worktree are the local-model A/B plan's own judging runs, not a Harness prompt. Median about 145K tokens; 37 of the 50 were one turn with no tool calls.

**Corrections made to agents' reports while writing this list:**
1. `ref2-claude` CC2-4 put Claude helper agents at 43% of spend for 17-19 October. That window included this research sweep's own agents. The sweep-free figure from `aio2-tokens-transcripts` (30% of AIO's Claude spend, against 61% before) is used instead.
2. `ref2-t3code` T32-4 said the approval buttons still lacked scope labels. They landed in the Phase 0 merge; only the visual demotion of lasting choices is new.
3. `ref2-storybloq-tura` SB2-1's "8 landed jobs passed with a failing gate" is weaker than stated. `ref2-omx-claw` found the labels read like earlier failing runs that were re-run. L4 says "nothing checks", not "8 bad landings".
4. `ref2-openclaw-ux` OC2U-1 said closing one session never mentions child sessions. That is right: the "except child sessions" sentence appears only in the Close-all dialog and is about history (an earlier draft of this list wrongly overruled OC2U-1; `_verify-1` M7).
5. The A4 status, "landed" in one scout's report: the plumbing landed, and both defaults are 0.
6. `ref2-omo-slim` first estimated an 80-95% saving from moving history out of plans. Measured history is 12-25% of the bytes of the big plans (60% in Phase 0), so T1 leans on status blocks, lists and step-sized jobs instead.
7. `ref2-agent-orchestrator` AO2-1 (show start-up stages): 40 of 45 Claude starts take under 10 seconds, so the value is an honest status word for sign-in waits (U13), not a progress checklist.
8. `ref2-hermes-runtime` HE2R-1's replay overrides the first list's plan to cap helper agents and machine sessions (A4, A18): helpers and queue jobs save little, while James's own long chats save a quarter.

**Corrections to the first list (10 October), for whoever plans from it:**
- "No Copilot use since 25 September" was a logging gap: `session-store.db` stopped on 25 September, and the per-session `events.jsonl` files show heavy use (TR2-4).
- MEM-2's claim that a reflection reaches promotion after about 12 injections cannot happen: promotion is checked only at creation (MC2-1). The project brief is about 135 tokens, not 400.
- Every `opencode/packages/opencode/…` citation now resolves only on `origin/v1` (OP2).
- The ceiling recommendation for helper agents and loop workers (A4, A18) is superseded by T7.

**Fresh fact-check of this document (19 October).** Three reviewers who did not write the list checked it against the code, the databases, the transcripts and the agents' reports. Their reports are `_scratch/oct2-audit/_verify-1.md`, `_verify-2.md` and `_verify-3.md`.
- **Sections L and T** (`_verify-2`: 3 must-fix, 15 should-fix). All applied, and one went further after the lead re-checked it:
  - **T4's figure.** The reviewer showed that the 3.84B count came from child-result messages, not the queue's own notices, and put the notices alone at under 0.6B. The lead then traced why those child results exist: the queue creates its jobs as children of the chat that started the run, so every job that ends runs the general child-completion handler. Every child result since 10 October came from a queue job. Re-measured with the sources split (`/tmp/oct2-lead-recheck/attr2.py`, aggregates only): about 5.3B tokens on Codex in 9.9 days (3.67B after "all completed" prompts, 1.38B after the queue's own notices, 0.23B after single child results), plus 0.2B on Claude. TD-4 had counted the queue's own notices as James's prompts. T4 now describes all three paths and starts its fixes with the cheapest one.
  - **Also applied:** T1 (median plan size about 170 KB, not 254 KB; the AGENTS.md rule for ordinary sessions; guards for the history file; a hash check before the coordinator moves text; the size gate warns until the diet has run); T3 and the new Decision 13 (the trial James approved is what is running, so ending it early is a question for him); L1 (where the guard goes around the squash's crash recovery; the squash already refuses active documents); L2 (landed jobs from the queue's own records; Phase 1 now 29 commits and still live; its ceilings set to 0 at merge); L3 (what the background-work registry covers; Claude's setting for switching off background commands; the nudge before the stop); T2's risk; the overlap between T2 and T3; one progress check shared by L5 and L7; and several counts and line numbers.
- **Top matter, Appendix A and Appendix D** (`_verify-1`: 8 must-fix and 17 should-fix, then 6 still open after its second pass over the edited text). All applied, the second-pass items included (Copilot's Opus use in T8 and Decision 5; the sweep's Opus share, 84% of requests and 89% of cost; the review discards, 36 of 118 reviews; the landing test, which is the job state, not a `landed_commit`). The first pass covered: the scheduled-job "26 times" figure (one run of 794M tokens; most failed runs cost nothing); D11 and A20, which are built on stranded branches rather than "not built anywhere"; A1, which is committed on main; Copilot's Opus use, which is 14 interactive chats rather than the queue's checkers; the research sweep's cost, explained by model choice rather than effort; correction 4, reversed; storage growth of about 40 GB rather than 50 GB; the restart warning's numbers; "3 of 10" October plans; the long-chat cap ranges at one threshold; and plain-English rewrites of the opening sections.
- **Sections U, H, K, the decisions and the suggested order** (`_verify-3`: 2 must-fix, 14 should-fix). Applied: the K1 fix recipe (migration numbers, one cutoff per provider, the backup insert, a "Done when" that can fail); observation memory's use (20 notes used 773 times, not "20 times"); the built-files warning; the settings-default note; Decision 2's scope; Decision 12's existing Pause button. **Not yet applied (James asked to finish quickly); carry them into the plans:** run T1's diet before T2 or exempt big plans; give T3 steps 2-6, T1 steps 2, 4, 6 and U6 steps 2-5 a phase; U10 before U1; H3's target is about 101 of 169 until Parts 2 and 3 land; U4's phone fix is three places, not one line; U1 step 5 is a data fix that U7's failure count depends on; add decisions for the 24 GB backup deletion, `showCost`, the 300M turn stop and the scheduled-job limits; plainer decision wording; K3.4 and T2.4 are one task; and the nits in `_verify-3.md`.
- **The lead's own fresh-eyes pass** also corrected two of its first fixes: a claim that ordinary helper agents sent child results before 10 October (none ever has in the records), and a suggestion to add summaries to completed plans, which would break the rule that completed files are closed.
