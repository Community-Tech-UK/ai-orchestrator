# Pause everything for a restart, and a workload slider — spec

**Status:** DRAFT for James's review, 2026-10-24, revised after an independent review the same day. Nothing is built. The recommended answer to each decision in
section 8 is what the plan assumes; change any of them and the plan follows.
**Plan:** [2026-10-24-pause-everything-and-workload_plan.md](2026-10-24-pause-everything-and-workload_plan.md).
**Replaces:** step 1 (L11, "one Pause new work switch") of
[2026-10-20-oct2-later_plan.md](2026-10-20-oct2-later_plan.md). James chose to build L11 on 20 October (decision 12a).
This spec is a superset of it: L11 becomes the "Hold new work" half of the pause below.

## 1. What James asked for

1. A single "pause" button that interrupts every session and helper agent, gets each one to write a short note on
   where it had got to, and then stops, so James can restart Harness or the computer. After the restart, one
   "Resume" button carries everything on from those notes.
2. No pile of stale notes left behind.
3. A "less ↔ more" slider so Harness does not slow the computer down, by changing how many helper agents, Plan
   Queue jobs and other jobs run at the same time.

## 2. What exists today (checked in the code on 24 October)

Details and file references are in the plan's "Evidence" section. In short:

- **There is already a Pause button, but James cannot see it.** It belongs to the "Pause on VPN" feature, which is
  switched off for James. When it is on, pressing Pause interrupts every busy session at once, with no note, and then
  refuses every message until it is switched off. It is remembered across a restart, for up to 24 hours.
- **Nothing pauses "new work" quietly.** While that Pause is on, the Plan Queue, loops and scheduled jobs still try
  to start. Their first message is then refused, and (per the 20 October investigation; the plan re-tests it first)
  the Plan Queue counts that as a failure and sets the job aside.
  Timed wake-ups (for example "resume when the usage limit resets") fail and are logged, not deferred.
- **Each engine has its own pause, and they don't line up.**
  - The Plan Queue has a good "Pause all": it stops each job, saves its work as a checkpoint on the job's branch,
    and carries on from there on Resume. But "Resume all" also restarts runs James paused on purpose earlier,
    because nothing records which runs "Pause all" paused.
  - A paused loop lets its current round finish, which can take a long time. After a restart a loop never resumes on
    its own, and paused loops are never tidied away (five have been open since May to July).
  - A scheduled job that is running when Harness quits is marked "failed" at the next launch.
- **After a restart, sessions don't come back by themselves.** Their conversations are kept, and James reopens them
  from History or the recovery banner. A reopened session picks its conversation up, but nobody tells it that it was
  cut off mid-task.
- **Helper agents** (sessions a main session started) are not brought back after a restart at all. Helpers that live
  inside one provider's program, such as Claude's own sub-agents, are invisible to Harness; they stop when their main
  session is interrupted.
- **There is no "continuation note" feature yet.** The nearest things leave litter: loop hand-over files in project
  folders are never deleted, and the "last stop" record is never cleared after a successful restore.
- **Limits on how much runs at once are scattered, and some don't exist.**
  - Plan Queue: 3 jobs and 2 checks per run by default (a run can be set up to 8 jobs), fixed when the run starts.
    Checks are shared across runs; jobs have no limit across runs. It waits when the computer's load is over 30, which
    on this 18-core Mac means "already very busy".
  - Helper agents: at most 20 sessions in total, and that count includes James's own chats. A helper over the limit
    is refused, not queued.
  - Loops and scheduled jobs: no limit at all.
  - Background indexing has its own small limits, buried in Advanced settings.
  - Almost all of these take effect on the next thing that starts, without a restart. None of them stops running
    work when lowered.

## 3. What James will see

### 3.1 One "Work" control in the title bar

A small button in the title bar opens a panel with:

- **Pause for restart** (main action). It is explained beside the button: "Stops every session after it writes a note
  on where it got to. Nothing new starts until you press Resume."
- **Hold new work** (secondary). This is the L11 switch. Running work finishes; nothing new starts.
- **Workload** slider, "Less ↔ More", with the current level named and a line saying what it means, for example
  "Light: 2 queue jobs and 4 helper agents at once; waits when the computer is busy."
- A one-line count of what is running now, for example "3 sessions working, 2 queue jobs, 1 loop".

Healthy is invisible: when nothing is paused and the slider is at its default, the button is plain. When paused, it
becomes a chip that says so: "Paused for restart · Resume".

### 3.2 Pressing "Pause for restart"

1. Nothing new starts from that moment: no new queue jobs, loop rounds, scheduled jobs or timed wake-ups. They wait
   quietly instead of failing. A session that tries to start a helper agent is told plainly that Harness is paused.
2. Every session that was in the middle of something is interrupted and asked for a short note (section 4).
3. Plan Queue runs use their existing pause: work is saved as a checkpoint on its branch. Loops stop their current
   round. Scheduled jobs that are mid-run are paused, not failed.
4. Helper agents are stopped. Their main session's note covers them, and Harness attaches each helper's last
   message to it automatically. Sessions that belong to the Plan Queue, loops, reviews and scheduled jobs are not
   asked for notes: those engines already save and resume their own work.
5. The panel shows progress: "Writing notes: 4 of 6 done", with a "Skip the rest" button.
6. When everything is in, the chip reads **"Safe to restart"** with a **Quit Harness** button. Sessions are left
   idle, not closed, so changing your mind is just pressing Resume.

### 3.3 After the restart

The chip is still there: **"Paused for restart, 6 sessions waiting · Resume"**. Pressing Resume:

1. Reopens each recorded session from History, a few at a time, at the pace the Workload slider allows.
2. Sends each one a short message: "Harness paused you for a restart. Your last reply is your note on where you got
   to. Carry on from there." If a session cannot pick its conversation back up exactly, the note is included in the
   message instead.
3. Resumes exactly the queue runs, loops and scheduled jobs this pause stopped, and nothing James had paused himself
   earlier.
4. Shows a one-line result: "Resumed 6 sessions, 2 queue runs and 1 loop", with a list for anything that failed.

Pressing Resume without restarting works the same way, minus the reopening. If Harness quits or crashes part-way
through a pause or a resume, the chip picks up where it stopped ("Resume was interrupted · Resume the rest").

### 3.4 What James can still do while paused

Everything by hand. He can open any session, read it, answer it and start new chats. Only work Harness would start on
its own waits. Typing into a session that is waiting to be resumed simply takes that one out of the pause: its note is
dropped (he has picked it up himself) and it is not resumed again later. The session shows one quiet line saying so.

"Hold new work" has no time limit either; after 3 days its chip reminds James it is still on.

## 4. Continuation notes

- **Who writes one:** a session that was busy, or was waiting on something (a question, an approval, a helper), when
  Pause was pressed. An idle session that was waiting for James needs no note. It is simply listed to reopen.
- **What a note says:** fixed headings, kept short (about 200 words): the task, what's done, what's in progress
  (files touched, commands mid-run), the next step, and anything waiting on James.
- **Where it lives:** the note is the session's own reply, so it is in the conversation itself. Harness keeps one
  copy in its own database for the Resume list and as a fallback. It never writes note files into project folders.
- **If a session doesn't answer within 3 minutes**, or cannot be asked (out of usage, or the provider cannot be
  interrupted cleanly), Harness writes a basic note itself, with no model call: the last request, the last reply
  excerpt and the helpers that were running. The Resume list marks it "basic note".
- **Cost:** one short extra turn per busy session. "Skip the rest" and a no-notes option keep it cheap when James
  is in a hurry.

## 5. Keeping notes from going stale

1. **Only one pause at a time.** Pressing Pause again while one is waiting updates it; it never starts a second
   pile. Each session has at most one note, and a newer one replaces an older one.
2. **A note is used once.** After a successful resume the note copy is deleted; a small record stays (when, which
   session, whether it worked) for 30 days.
3. **A note becomes void by itself when its reason goes away:** James closes or deletes the session, James sends the
   session a message himself (he has picked it up by hand), or the queue job or loop it belonged to finishes or is
   cancelled.
4. **An old pause asks once, then tidies up.** After 3 days the chip says "Paused 3 days ago · Resume or discard".
   After 14 days the note copies are discarded automatically. The sessions themselves stay in History, and the
   notes are still in their conversations. Queue runs and loops the pause stopped stay paused, and a notice says so.
   This follows the "tidies up after itself" rules: tell first, delete only
   what is safely recoverable.
5. **Discard** in the panel drops the pause and all its notes in one step, and clears the pause chip. Queue runs and
   loops it stopped stay paused in their own screens, and the confirmation says so.

## 6. The workload slider

Five levels. The middle one is exactly how Harness behaves today, so nothing changes until James moves it.

| | Lightest | Light | **Balanced (today)** | Busy | Most |
|---|---|---|---|---|---|
| Plan Queue jobs at once | 1, all runs together | 2, all runs together | each run's own setting (3 by default) | each run at least 4 | each run at least 5 |
| Plan Queue checks at once | 1 | 1 | each run's own setting (2 by default), shared | at least 2 | at least 3 |
| Helper agents at once | 2 | 4 | no new limit | no new limit | no new limit |
| Loops running a round at once | 1 | 2 | no limit | no limit | no limit |
| Scheduled jobs and repo jobs at once | 1 | 2 | no limit | no limit | no limit |
| Background indexing | paused | 1 at a time | today's | today's | twice today's |
| Waits before starting new work when the computer is busy | load above 0.75 per core | load above 1.0 per core | queue only, load above 30 | queue only, load above 45 | queue only, load above 54 |

The two right-hand levels never hold anything back more than Balanced does; they only allow more. Every level is
still capped by the 5 shared work folders Harness allows.

Rules:

- **It only affects what starts next.** Lowering it never stops running work; things over the new limit finish and
  are not replaced. The tooltip says so.
- **James's own messages are never held back.** The slider governs work Harness starts on its own: queue jobs,
  loops, scheduled jobs, helper agents and background indexing.
- **Work on another computer doesn't count.** Sessions running on the Windows PC don't slow the Mac, so they don't
  use up the Mac's allowance.
- **Over the limit means "wait", not "fail"**, for queue jobs, loop rounds and scheduled jobs. A helper agent over the
  limit is told plainly to try again later (as today, at the 20-session ceiling). Making helpers wait in line is
  decision 8.
- Helper agents started by the Plan Queue, loops or reviews don't use up the helper allowance; the queue and loop
  limits cover them.
- The level is one setting that agents can change through `aio-mcp`, for example to turn things down during a heavy
  build.

## 7. Out of scope

- Restarting Harness or the computer automatically. James presses Quit, and restarts the computer himself.
- An "automatic" slider that moves itself. The busy-computer wait in each level covers the main need. Revisit if
  James still finds Harness slowing the Mac at a fixed level.
- Pausing or limiting the Windows PC's own work. Its helper limit stays as it is.
- Changing how many sub-agents a provider's program runs inside one session (Codex's own setting is in the middle of
  a trial, decision 13 of 20 October).
- Clearing up the existing litter (old loop hand-over files, the never-cleared last-stop record). Both are noted for
  the tidy-up work, not fixed here.

## 8. Decisions for James

Each has a recommendation, marked **(rec)**, which the plan already assumes.

1. **Who writes a note.** (a) Only sessions that were in the middle of something; idle ones are just reopened.
   **(rec)** (b) Every open session.
2. **Helper agents.** (a) Stopped; the main session's note covers them, with each helper's last message attached
   automatically. **(rec)** (b) Each helper writes its own note too (more cost, and helpers are not reopened after a
   restart today anyway).
3. **How long to wait for notes.** (a) Up to 3 minutes, then Harness writes a basic note itself. **(rec)** (b) Wait
   as long as it takes.
4. **When the notes are in.** (a) Leave everything idle and show "Safe to restart" with a Quit button. **(rec)**
   (b) Quit Harness automatically.
5. **Resuming after the restart.** (a) James presses Resume once; sessions come back a few at a time. **(rec)**
   (b) Resume automatically when Harness starts.
6. **How long a pause lasts.** (a) Until Resume or Discard: a reminder at 3 days, notes discarded at 14 days, the
   sessions kept. **(rec)** (b) Expire after 24 hours, like today's pause.
7. **Slider levels.** (a) Five levels, with the middle one matching today. **(rec)** (b) Three levels.
8. **A helper agent over the limit.** (a) Told to try again later, as today. **(rec, first version)** (b) Waits in
   line until a slot frees up (more work; could follow later).
9. **Work on the Windows PC.** (a) Doesn't count against the Mac's allowance. **(rec)** (b) Counts.
10. **Where the controls live.** (a) One title-bar button with a small panel, mirrored in Settings, with an `aio-mcp`
    command for agents. **(rec)** (b) Settings only.
11. **The old L11 step.** (a) Replace it with this work and point the "Later" plan here. **(rec)** (b) Build L11 on its
    own first.
