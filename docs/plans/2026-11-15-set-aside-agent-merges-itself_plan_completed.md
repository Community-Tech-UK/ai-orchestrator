# Set aside agent merges what it can, without bouncing it to James

## Status

Written 15 November 2026 at James's request after a Sort out session kept handing him merges it should have done
itself ("We're meant to be autonomous and you're meant to be doing this busy work yourself"). James said "Build
it", which chose option A in change 5. Completed 15 November 2026: all five changes are built, with unit tests,
and passed independent review; each section below says what was built. Checks that need the rebuilt app are in
[2026-11-15-set-aside-agent-merges-itself_plan_livetest.md](2026-11-15-set-aside-agent-merges-itself_plan_livetest.md).
Not covered: a session reopened from History does not keep the Sort out tools (deliberate).

## What went wrong on 13 to 15 November

One Sort out pass over about 85 jobs ended with roughly 40 listed for James. Some genuinely need him (a person at
the Windows PC, a sign-in, an approval to touch real data). These did not:

1. **Checks passed, but too many checks were live-only.** The queue parks these as "needs James" ("left 6 of 10
   acceptance criteria to be checked live ... Merge without checks or Resume"). The Sort out prompt only lets the
   agent merge without checks when a final check fails for an unrelated reason, so it listed them. James then
   said "go with your recommendations" and the agent merged them, which shows the step was a formality.
2. **An older attempt holds work a newer, merged attempt lacks.** The OpenCode 2 fix for typed answers being
   refused (LT-1046, P1) existed only on an older attempt. `checkRestart` in `plan-queue-set-aside.ts` refuses
   both Resume and Merge without checks for the Set aside agent once a newer attempt has merged, so only the
   page button could land a P1 fix.
3. **A clash during Merge without checks.** Landing merged main, hit a clash in two Markdown files, stopped, and
   the job could not be resumed (same newer-attempt refusal). The agent resolved the clash by hand in the job's
   folder, ran the focused tests and the type check, and the next Merge without checks landed it. That path
   works, but nothing tells the agent it may take it.
4. **Authority is lost on an app restart.** After a restart every Set aside tool answered "Only the agent
   started from the Set aside tab ... may use this tool", and James had to press Sort out again.
5. **Any session's "message from James" window closes on the first Harness notice.**
   `authorizeLandAnyway` in `plan-queue-land-anyway-authority.ts` requires James's message to be the session's
   latest input. The queue's run-end summary is sent to the owning session as an input (each job's own notice is
   only a quiet note), and taking over a finished run re-sends it, so it arrived during the reply and James had to
   send "go" twice for one merge.

## Changes

1. **Merge passed jobs that only wait on live checks.** In the Sort out prompt (`plan-queue-set-aside.ts`,
   step 4), add: checker PASS with reason needs-james because live checks remain: use land-anyway. The live
   checks stay in the document, which stays open, so nothing is lost. List the job for James only if a remaining
   check needs his approval before the code may run at all (for example a change to real data on first start).
   Built as a step 4 bullet; the "leave for James" list now says live checks that can follow a merge do not stop it.
2. **Let the Set aside agent merge an older attempt over a newer merged one.** In `checkRestart`, allow
   `land-anyway` for the Set aside agent when a newer attempt merged. The prompt requires the agent to compare
   the two with git first and merge only work the newer attempt lacks; otherwise discard.
   Built: the refusal is removed from `checkRestart`. Resume and Try merging again stay refused for everyone once a
   newer attempt merged (`plan-queue-coordinator.ts`). The brief says merging an older attempt's extra work on top is
   not a "choose between attempts" decision, and names a temporary clone in `_scratch` for checking a job with no
   folder.
3. **Say how to handle a clash during a merge.** Prompt: when Merge without checks stops on a clash, resolve it
   in the job's own folder (keep the base branch's copy of shared registers and add only this job's facts), run
   the job's focused tests and the type check there, then use land-anyway again. Confirm in a test that landing
   commits a resolved, uncommitted merge in the job's folder rather than refusing it; today's run suggests it
   does. It did not: git refuses to merge the base again while a merge is open, so the first Merge without checks
   failed and a background folder retry hid this in the incident. Built: Land anyway commits a merge finished by hand
   (no clashes left) before merging the base (`plan-queue-item-landing.ts`); a checked landing does not, so it never
   lands content its checker missed. The check after a merge still runs on the hand-finished result. A landing test
   (`plan-queue-coordinator-landing.spec.ts`, "lands a merge someone finished by hand") fails without either part.
   Known limit: a resolution identical to the job's last commit leaves nothing to commit, so that rare case still
   fails to land. The brief's "Finish a merge that clashed" item covers only jobs step 4 would merge without checks; any other job with
   an unfinished merge goes back to a worker.
4. **Keep the agent's authority across a restart.** Find why `folderOf` stops recognising the Sort out session
   after a restart (the folder is kept in instance metadata; check whether that survives restoration) and make it
   survive, or restart the Sort out session automatically after boot.
   Cause: a revived session gets fresh metadata, and continuity copied only named fields. Built: the folder is saved
   as `planQueueSetAsideFolder` in session state and put back on crash-recovery revival (the restart route); the
   marker name moved to `src/shared/utils/plan-queue-set-aside-agent.ts`. The screen summary of a revived session
   keeps it, the Plan Queue page reads it through the same shared helper, and Sort out reuses a revived agent that is still working instead of starting a second one; one that sits idle after
   the restart is not reused, and the page shows the newest agent per folder.
5. **A wider window for "James asked for this" (James chooses one).**
   - Option A: Harness notices about runs the session owns do not close the window; only a new message from
     James or another agent does. Small change in `checkPersonTurn` or its caller.
   - Option B: a setting, "Agents may merge without checks: only from the page / the Sort out agent / any session
     I've asked", recorded in the landing note like today.
   Recommendation: A. It keeps the current rule's meaning (James asked in this turn) and removes the accidental
   cut-off. Chosen: A. Built: the queue announces every report it sends the owning session about the run (run summary, questions,
   capability-repair notices) with `expectNotice`; handover messages are not reports and still close the window and a chosen
   message id, and `InputTurnRegistry` leaves James's message as the latest input, but only once his message has
   started its turn. A report that starts its own turn is still refused. Accepted trade-off: the report's text,
   written by queue workers and checkers, is now inside the reply James's message started.

Every merge without checks keeps today's record of who did it and why, in the landing note and the queue's event
record, so James can see what each was based on (as asked in the "stop building safeguards" note: let agents do
what can be undone, and record who).

## Not in this plan

- Merges blocked because another session has uncommitted edits to the same file in the main folder (the shared
  defect list, the generated architecture inventory). That needs its own plan.
- Defect numbers clashing between parallel jobs. `next-lt-id.mjs --reserve` now exists for this; check it is in
  the worker prompts before writing anything new.

## Checks

- Unit: land-anyway authority for the Set aside agent with a newer merged attempt (allowed; queue workers stay
  refused by the general authority check); the Sort out prompt text for changes 1 and 3; restart keeps `folderOf` (change 4); the
  chosen option in change 5 (a Harness notice no longer closes the window; another person message or agent
  message still does).
- Gates: `npm run checks` and `npm run test:quiet`.
- Live checks: moved to the live-test document linked in the Status block.
