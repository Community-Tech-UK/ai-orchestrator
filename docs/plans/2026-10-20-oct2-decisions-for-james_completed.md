# Decisions for James: October list part 2

**Date:** 20 October 2026 · **Status:** answered by James on 20 October 2026: "Go with your recommendations". Every decision below is (a), the recommended answer.

**How to answer.** The recommended answer is the first one each time. Reply "all as recommended", or name only the ones
you want different in your own words, for example "9: keep it as it is; 16: no ceiling".

**What happens before you answer.** Work that only fixes something broken goes ahead. Anything that would delete your
data, change one of your settings, or change how Harness behaves for you waits until you reply.

A word used throughout: **tokens** are the units AI companies count usage in, roughly three-quarters of a word each. Your
plan allowances are measured in them.

Numbers 1-13 match the second October to-do list. Numbers 14-19 are new: the independent checks found decisions
the list was missing. Changing a default in the code does not reach your copy of Harness by itself, because your settings
file stores every value, so where an answer changes one of your settings the plan does it with a one-off update.

The plans: [Phase A, urgent fixes](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[Phase B, get the built work in](2026-10-20-oct2-phaseB-land-built-work_plan.md) ·
[Phase C, the plan queue](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) ·
[Phase D, tokens](2026-10-20-oct2-phaseD-tokens_plan.md) · [Phase E, the screen](2026-10-20-oct2-phaseE-calm-screen_plan.md) ·
[Phase F, tooltips](2026-10-20-oct2-phaseF-tooltips_plan.md) · [housekeeping](2026-10-20-oct2-housekeeping_plan.md) ·
[later](2026-10-20-oct2-later_plan.md).

## Before anything: two things not to do yet

- **Don't restart Harness yet, or reopen it from the project folder.** The next start on the newest code would wrongly
  shrink about a fifth of your correctly recorded Claude cost figures. The app files in the project folder were last
  rebuilt early on 20 October and already contain that clean-up, so even a normal reopen from there would run it. The fix is
  the first job in the plans. I'll tell you when it is built, checked and ready; then restart when no live work would be
  lost. (Nothing is lost for good either way: the original figures are saved first.)
- **Don't retry a plan-queue job that was set aside because its work folder couldn't be set up,** until the plan queue's
  safety fix is in the copy of Harness you are running (I'll tell you when). The same job can repeat the mistake that saved files into your project on 15 October.

## The decisions

1. **Finish putting the October work that is already built into the app before starting anything new?**
   (a) Yes, first. (b) Start new work alongside it.
   *This is within what you approved on 10 October, so the plans go ahead with (a) unless you say otherwise.*
   **Answer (20 Oct):** (a).

2. **Unfinished plans saved into your project by mistake.** On 15 October the plan queue saved 71 unfinished plans and
   test checklists (69 are still there), plus your first October to-do list, into the project's permanent record, where
   your rule says unfinished plans must never go. (a) Take them back out of the permanent record: the files stay exactly
   where they are on disk and nothing already recorded is rewritten. (b) Leave them in.
   *The same mistake also saved about 45 code files from another session and 35 other documents; this choice does not
   touch those.*
   **Answer (20 Oct):** (a).

3. **Codex's working memory.** Around 11 October Codex's working memory nearly doubled, and Harness's own background work
   now sends much bigger requests. Above a certain size (272,000 tokens), OpenAI's published price doubles for that whole
   request; whether your subscription counts it the same way is not known yet, and the plans check it.
   (a) Keep Harness's own background work (plan queue, loops, scheduled jobs, second opinions) at the old size, so it
   summarises its working memory sooner and its requests stay smaller. Your own chats keep the bigger size. (b) Keep the bigger size everywhere. (c) The old size
   everywhere, including your own chats.
   **Answer (20 Oct):** (a).

4. **Long Claude chats.** Today Claude summarises a chat only when it is nearly full (about 970,000 tokens).
   (a) After a quick check that nothing important is lost, summarise your own long chats at about 270,000 instead: up to
   a quarter cheaper for very long chats, with some risk of losing detail. Plan-queue jobs and helpers are left alone.
   (b) Leave it as it is.
   **Answer (20 Oct):** (a).

5. **Opus on Copilot.** Each message to Opus on Copilot counts as 15 of your monthly premium requests (1 for the cheaper
   models). 14 Copilot chats on Opus used two-thirds of Copilot's allowance; everything Harness starts by itself already
   uses the cheaper models. (a) Show "15 premium requests each" wherever Opus can be picked for Copilot, and a running
   count in the chat. (b) Leave it.
   **Answer (20 Oct):** (a).

6. **Plan-queue messages in the chat that started a run.** The "write a full report" messages after every job stop either
   way. (a) You get one summary in that chat when the run ends; the queue's other notices appear as quiet notes that don't
   wake the AI; and the queue's questions appear only on the Plan Queue page, unless you choose that chat in a new setting.
   (b) Keep the notices waking the chat, and keep questions going to it.
   **Answer (20 Oct):** (a).

7. **Big plans.** Six of today's unfinished plans are 250-600 KB (very roughly 40,000-100,000 words each), and the AI
   that does each queue job, and the AI that checks it, re-read them again and again. (a) Trim them once, moving old progress notes into a side file (nothing deleted);
   then the queue warns about plans over about 120 KB, splits big ones into one job per step, and refuses plans over
   200 KB. (b) No size rule.
   **Answer (20 Oct):** (a).

8. **"Allow once".** Today it also allows the same request again for the next hour. (a) Make it truly once. (b) Keep the
   hour and rename the button "Allow for the next hour".
   **Answer (20 Oct):** (a).

9. **Observation memory**: notes Harness writes about what worked in earlier sessions, which it sometimes adds to new ones.
   Only 20 of its 8,670 notes have ever been used, though those 20 were used 773 times between them, and it takes up
   404 MB. Whatever you choose, its out-of-date notes are cleaned up and it stops recording Harness's own background
   sessions. (a) Also switch it off and hide its page until it earns its place (those notes stop appearing in the AI's
   instructions). (b) Keep it on, and fix the part that should promote the most useful notes, which never runs today.
   (c) Keep it on with nothing more.
   **Answer (20 Oct):** (a).

10. **RTK's next version** (the tool that shortens command output before the AI reads it). From version 1.0, part of it is
    under a licence that limits offering it to other people as a product, which matters only if you ever hand Harness to
    others. (a) Version 0.52.0, the last one under the fully open licence. (b) The newer version in its fully open
    edition (it lacks a few of the newest shortening features). (c) The newer version including the restricted part.
   **Answer (20 Oct):** (a).

11. **Copilot loads this project's instructions twice** (about 2,600 extra tokens on every Copilot request), because
    they live in two files with slightly different contents. (a) Make the two files one, after checking that the Windows
    PC's copy of the project can handle it. (b) Leave it.
   **Answer (20 Oct):** (a).

12. **One "pause new work" switch.** Harness already has a Pause button that refuses all messages; you don't see it because
    it belongs to the "Enable network pausing" setting, which is off for you. (a) Extend it so loops, the plan queue and scheduled jobs wait quietly
    instead of failing, and show it to you. (b) Not needed.
   **Answer (20 Oct):** (a).

13. **Codex helpers for plan-queue and loop work.** On 10 October you approved switching them off there after a
    side-by-side trial. The trial is running: the first three days show about 11% fewer tokens per queue job with helpers
    off, on a small sample, and nobody has yet compared how often each side's work passes its checks.
    (a) Add the pass rates, run it about a week more, then switch helpers off for Harness's own work if that side is no
    worse. (b) Switch them off now. (c) Leave the trial running as it is (the report still shows the pass rates).
   **Answer (20 Oct):** (a).

14. **The two July copies of the learning database** (24 GB; the biggest single clean-up on the list).
    (a) Delete them through the Storage page, which asks again at the time. (b) Keep them.
   **Answer (20 Oct):** (a).

15. **The cost in the session header.** The header can show what a session has cost (an estimate at published prices);
    your setting for it is off. (a) Turn it on. (b) Leave it off.
   **Answer (20 Oct):** (a).

16. **A ceiling on runaway Codex rounds** (a round is everything the AI does in answer to one message). 51 single rounds
    each used over 100 million tokens and together made up
    almost two-thirds of all usage since 10 October. (a) At about 150 million tokens Harness tells the AI to wrap up; at
    about 300 million it stops the round, for Harness's own background work only. Your own chats get the "wrap up" nudge
    but are never stopped. (b) The same, and also stop your own chats at 300 million (with a Continue button).
    (c) No ceiling.
   **Answer (20 Oct):** (a).

17. **Time and usage limits for scheduled jobs.** Three jobs ran 15-18 hours until a restart killed them; one failed run
    used 794 million tokens. (a) New jobs stop after 90 minutes; each existing job gets 1.5 times its longest successful
    run; and a run stops past about 30 million tokens (100 million for one-off jobs). Each limit can be changed per job.
    (b) No limits.
   **Answer (20 Oct):** (a).

18. **Your "don't save unfinished plans" safety check.** It lives in your own computer-wide settings, so it covers every
    project, not just Harness. The plans add a new kind of side file for old progress notes. (a) Teach the check that
    these side files, and this decisions page, belong to unfinished work too, so they can't be saved by mistake.
    (b) Leave it alone; Harness's plan queue still refuses the side files, but nothing guards this decisions page.
   **Answer (20 Oct):** (a).

19. **Old Codex backup copies** (about 40 GB in 443 copies, growing every time Harness starts). The October storage work
    you approved includes keeping only the newest three. (a) Turn that on; the first run frees about 40 GB. (b) Keep them
    all for now.
   **Answer (20 Oct):** (a).

---

*For agents:* answers recorded 20 Oct 2026; this file is closed. Do not add to it: a new question needs a new dated decisions page.