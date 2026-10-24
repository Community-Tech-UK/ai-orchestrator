## Verifier findings to fix next (23 Oct, coordinator handoff; both high)

1. `src/main/storage/storage-runtime.ts:46` - attachment cleanup protects Harness instance IDs while attachment folders
   use PROVIDER session IDs (generated independently), so it can delete a LIVE session's attachments. Protect both
   identities with a real-identity-split regression.
2. `src/main/orchestration/loop-review-driven-terminal.ts:43` - the final-audit merge hold is gated on
   `status === 'completed'`, so `completed-needs-review` outcomes (missing plan rename, known failures, follow-ups) merge
   without operator review. Hold on that outcome too when `finalAuditMode='gate'`.


## Status

On main: no (`queue/2026-10-11-oct-followups-bad1a7`).
49 parts: 42 built, 7i deliberately not built, 5f skipped on its own terms, five Step 8 parts parked
(non-blocking triggers). Both queue-verification round-2 findings repaired and re-tested; ready for
re-verification. Awaiting coordinator full suite, queue-verifier acceptance and completion rename.
Do not close or rename this document.
Live checks in [livetest](2026-10-11-oct-followups_livetest.md).
Dated status and as-built sections: [history](2026-10-11-oct-followups_history.md).

> Earlier dated status and as-built sections moved to [history](2026-10-11-oct-followups_history.md).

**Source:** James, 11 Oct 2026. He was offered "every left-out piece in one short follow-up list" and replied:
- "definitely need to retire old docs.  We have FAR too many docs."
- "Yeah add one more doc for that list of other things"

So this plan does two things. Step 1 retires old docs. Steps 2 to 8 and [The rest of the list](#the-rest-of-the-list-one-line-each)
collect the work that no other plan builds. That work comes from the "Not in this plan (and where it goes)" and "Found
on the way (not fixed here)" lists of the nine plans written on 10 Oct, plus the few lines elsewhere in them that leave
work to nobody. The nine plans are all in `docs/plans/`:
- Phase 0: `2026-10-10-oct-phase0-confirmed-fixes_plan.md`
- Phase 1: `2026-10-10-oct-phase1-token-levers_plan.md`
- Phase 2: `2026-10-10-oct-phase2-loops-converge_plan.md`
- Phase 3: `2026-10-10-oct-phase3-calm-screen_plan.md`
- Phase 4 part 1: `2026-10-10-oct-phase4-tooltips_plan.md`; part 2: `2026-10-10-oct-phase4b-tooltips-migration_plan.md`;
  part 3: `2026-10-10-oct-phase4c-tooltips-finish_plan.md`
- Phase 5: `2026-10-10-oct-phase5-later_plan.md`
- Housekeeping: `2026-10-10-oct-housekeeping_plan.md`

The approved backlog behind them is [`claude_oct-todo.md`](../../claude_oct-todo.md). It has no row for this plan; the
backlog has no doc-retirement item at all.

**How it was checked:** on 11 Oct 2026 four read-only checks went through the nine plans against the working tree (HEAD
`4d175e55b`, "provider hardening", committed at 00:34 on 11 Oct). Their reports are in `_scratch/oct-phases/`, which is
gitignored and disposable; this plan carries what an implementer needs.
- `fu-docs.md`: retiring old docs (the inventory of 789 docs, who reads them, the options, the design).
- `fu-inventory-a.md`: 203 pieces from the Phase 0, Phase 1, Phase 2 and Housekeeping plans, with items FU-A1 to FU-A11.
- `fu-inventory-b.md`: 128 distinct pieces (145 table rows, 17 of them duplicates) from the Phase 3, Phase 4 (three
  parts) and Phase 5 plans, with items FU-B1 to FU-B20.
- `fu-wave2.md`: items FU-C1 to FU-C10, built from rows that the two inventories left in their "Not yet checked" lists.
- `_review-followups.md`: a fresh review of this plan (3 must-fix, 12 should-fix, 8 nit findings). Each finding was checked against the code and applied the same day, except where the code showed the review was wrong; its resolution log says which.

Totals: 331 pieces were classified. 171 had no home in any plan. Class counts:

| | Has a home in another plan | Rejected | Information only | Waits on a numbered choice | No home | Total |
|---|---:|---:|---:|---:|---:|---:|
| Inventory A | 64 | 13 | 16 | 6 | 104 | 203 |
| Inventory B | 26 (25 plus 1 already done) | 18 | 17 | 0 | 67 | 128 |

The 171 "no home" rows (104 in table A, 67 in table B) were checked by a script over both tables and this file, and none is
dropped: 77 are built or decided in Steps 1 to 8 (31 from table A and 46 from table B), and 95 sit on 76 one-line entries in
[The rest of the list](#the-rest-of-the-list-one-line-each). One row (A#156) is on both, because only half of it is
built (the automation half is part 4a; the campaign half stays on the list), so 171 = 77 + 95 minus 1. Step 1 and the Codex
part (5a) are new work and use no row. Rows are cited as `A#n` and `B#n` after the row numbers in the two inventory tables;
every line in this plan carries enough text to stand alone, because the tables are disposable.

The plan writer also re-checked, read-only, on 11 Oct: the Codex backups folder (counts, sizes, dates, the code that makes
and never removes them); the line anchors for AGENTS.md, the plan queue, the ignore lists, the packaging filter and the
commit hook; the anchors of the safety parts (`instance-handlers.ts`, the thin-client executor, `orchestrator-tools-step.ts`,
the worktree files, `instance-lifecycle.ts`); and the line count and room of every file in the headroom table below.
Where this plan differs from a report, the part says so. **Line numbers are as of 11 Oct and will move. Re-read the code
before editing.** Commit `4d175e55b` (146 files) touched `scripts/check-ts-max-loc.ts`,
`docs/generated/architecture-inventory.json`, `acp-cli-adapter.ts`, `settings-migrations.ts`, `instance-manager.ts` and
`loop-coordinator.ts`; the line counts below were measured after it.

**Size:** L in total: 8 steps and 49 parts, and every part stands alone. Most parts are XS to S. The larger ones are
Step 1 (M, six parts), the Codex backups part (S, but the biggest pile of disk), the notice for
paused loops (S-M), deleting two empty screens (M), and the parked parts in Step 8 (M to L, each behind a trigger or a
design pass). What goes first: Step 1, because it is the work James asked for and depends on no other plan; then Step 2,
which makes room in files that the other plans are about to add to.

**Depends on:** the nine plans above. Each part names the step it waits for, and the full table is under
[Order of work](#order-of-work). In short:
- **Nothing:** Step 1 (1d waits for James's approval of the list), Step 2, parts 3b, 3e, 5e, 5i, 6b and 6c, and the code halves of 5d and 5g (the card halves wait for Housekeeping step 4).
- **James's answer first**, because the part deletes something or changes what is merged or kept (its choice is in brackets): 1f (2), 3g (4), 5a, 5b and 5c (7), 5e (8), items 1 to 3 of 5i (10) and 5h (11). Parts 5d and 5g delete nothing until James presses a button on the disk space card.
- **Phase 0:** step 1 (3g), step 2.6a (3c), step 3 (3d), step 4 (3a), step 7b (6a), step 7g (5f), step 7h (7g) and
  step 7c (8e).
- **Phase 1:** step 5a (6f lands after it), step 12d (7a, if built) and step 18a (5e lands before it; 5b is best after it).
- **Phase 2:** step 8 (4b), step 8b (3f, 3g), steps 8d and 17 (4a), step 13 (8a) and step 14 (4c).
- **Phase 3:** step 3 (7d), step 5 (7c, 8c), step 6 (6d, 8a), step 6c (7j), step 9 (5h lands before it; 8c after it),
  step 10 (7h), step 12b (7c), step 14 (6b, same event), step 15 (7b, same file area) and step 16 (6e, 8b).
- **Phase 4:** step 4 (7f), step 4b (7e), and part 3 step 1f (7f).
- **Phase 5:** step 3 (5h), step 7 (7i), step 11 (7g), step 14 (7b) and step 16 (7c).
- **Housekeeping:** steps 4a and 4b (the disk space card: parts 5a to 5d and 5g), step 5 (6g) and step 6 (3c, ideally built with it).

## In plain English (what James will notice)

1. **Old documents get tidied away, and nothing is deleted.**
   - About 360 of your 790 plan, spec and test documents are finished and more than a month old. They move into one
     archive folder, and a list says where each one went.
   - You read the list of what would move and approve it before anything changes.
   - Harness's code search (including its fallback search and its quick "where is" lookup), the plan queue and agents' own text searches skip that folder, so old plans stop turning up inside new messages. Anyone can still open an archived document by its path.
   - At the end of each job the agent tells you how many old documents are waiting, so the pile does not grow back.
   - A pointer in the agent instructions that names a file that no longer exists is fixed first, and the line that tells agents to add notes to a finished plan is reworded.
   - If you want it, a second tool can clear old working files from the 32 GB scratch folder. That is off unless you say yes.
2. **Room is made before the new switches arrive.** Nothing you will see. Two lists of settings are nearly full, and one
   large file that several plans touch has 3 lines of room. The build refuses a file that grows past its limit, so later
   plans would stall. This makes room first.
3. **Places that act when they should refuse or ask are fixed.**
   - A held shell command that is answered with no decision is refused, not run.
   - An agent with Harness's remote-computer tools can read only the sessions it started.
   - The start-up tidy-up leaves a loop's work folder alone if it holds unsaved changes.
   - Automatic clean-up of quiet chats skips a chat that is running a loop.
   - Stop and Cancel on the phone ask first.
   - A campaign pauses when a step's work was held back.
   - Only if you say yes: loops that stall, or whose last check needs you, stop merging their work.
4. **Loops and the plan queue fail more honestly.**
   - A loop that pauses inside a scheduled automation frees the automation, and you get one desktop notice per pause.
   - A loop given a plan file checks that the plan was marked complete before it finishes.
   - The plan queue's checker sends back only the serious findings and shows you the rest.
5. **The biggest unmanaged pile on your disk stops growing, and nothing already there is deleted without your yes.**
   - Codex: Harness has saved 425 safety copies of Codex's private session list (39 GB in all; the whole Codex folder is 57 GB)
     and never deletes one. After this, new copies get a new name and Harness keeps only the newest 3 of those by itself, so the
     pile stops growing from the first start. It never touches the 425 existing copies or the 6 smaller clean-up copies; the disk
     space card offers them (about 38 GB; the newest 3 old copies stay) after a preview and your yes. The card also shows the 18 GB of
     Codex session files but never offers to delete them, because resuming a Codex chat needs them.
   - Other rows on the card: the log of commands RTK (the tool that shortens long command output) handles (600 MB), the old
     technical record (711 MB), pasted attachments, and an old Harness data folder (11 MB). Each asks first.
   - The technical record files stop growing without limit: each is capped, and Harness drops only the oldest piece of files it
     writes after the update. The five copies of the RTK tool (43 MB) stop being kept in the project's version history; the build
     downloads them instead.
   - If you say yes, two empty screens (Training Data and Instance Messaging) and three unused building blocks are deleted.
6. **Numbers and signals tell the truth.**
   - A helper agent's "tokens used" shows what it spent.
   - The context ring ignores helper agents.
   - The overnight "sessions are blocked" reminder counts Claude and Codex questions.
   - A connector that asks Claude for input gets an answer.
   - Ordinary error text stops looking like a permission refusal.
   - The "Compact after token spend" switch, which does nothing, is hidden.
   - A slow lookup of saved sessions is timed first and then fixed.
7. **Smaller screen, wording and access fixes.**
   - The attach button says why it is off for providers that refuse files.
   - "Shown N times" counts real session starts.
   - A chip counts helper agents running.
   - Switching Build, Plan or Review leaves a grey line.
   - Invisible "close menu" buttons stop being Tab stops.
   - Every input box gets a name for screen readers.
   - The Costs page shows cents.
   - Two more switches get a Settings row.
   - Memory reviews and repository jobs reach "Needs you" at once.
8. **Parked ideas are written down with the condition that wakes each one.** Examples: a "Needs you" number on the phone, an
   Everyday / Full view switch, and a real Copilot context figure.
9. **The rest of the list.** 76 more entries (small or conditional pieces), one line each, with when each would matter and a
   reminder to re-check the code before building. They do not block closing this plan.
10. **What you need to do.** Nothing, to start. There are 14 choices below, each with a recommended default; 11 of them are
    real decisions. The first thing that needs your eyes is the list of old documents in Step 1d. Nothing is deleted without
    your yes: eight parts that delete something, or change what is merged or kept, wait for your answer to their choice before
    anything is built (the "Needs first" column in Order of work names each).

## Decisions this plan follows

From James (11 Oct 2026 unless stated):
- **"definitely need to retire old docs.  We have FAR too many docs."** So Step 1 is built, and the Harness help pages
  (backlog A12, Phase 1 choice 14) are **not a choice**: the "FAR too many docs" message drops them. They are not built
  anywhere and are not offered again.
- **"Yeah add one more doc for that list of other things".** This plan is that doc.
- The product name on screen is **Harness** (Decision 1, 10 Oct). All new wording says Harness.
- **Keep James's personal setup in machine-started sessions** (Decision 2, 10 Oct). Nothing here trims it.
- **No default loop spend cap.** James removed the $30 default on 2 Sep. Nothing here brings one back; the "Add more at
  a loop cost cap" line in the rest of the list matters only if he chooses a cap.
- **Every deletion is shown first and asks first** (the Housekeeping plan's rule, from James's standing rule about
  deleting). Only these parts delete or change real data, and each says so:
  - the ask-first rows on the disk space card (parts 5a to 5d and 5g), where James presses a button after a preview;
  - Step 1's `git mv`, after James approves the list; it deletes nothing;
  - Step 1f, off by default and held for his yes (choice 2);
  - two automatic bounds on Harness's own files, both held for his yes (choice 7): the newest-3 rule for the new-named Codex
    safety copies (5a) and the size cap on the technical record files (5c). **They are exceptions to the Housekeeping plan's
    "no new automatic deletion"** (its choice 7). Neither can touch anything that exists today: 5a matches only copies made after
    the update (the 425 old copies and the clean-up and archive copies are matched by the card alone), and 5c drops only
    rotation pieces it creates itself;
  - code deletions, each held for its choice: the two empty screens and three building blocks (5h, choice 11), and a shortcut,
    a setting and two dead helpers (5i items 1 to 3, choice 10).
- **No branches or worktrees** (James's standing rule). Parts 3g and 3c talk about loop branches and work folders; the
  implementer works in the current checkout.
- **Untracked docs are never deleted or moved by this plan.** The one exception is 1f's scratch sweep (choice 2), which deletes only git-ignored working files in the scratch folders that James has seen listed and said yes to. Moves use `git mv` and only tracked, unchanged, finished docs. No `_completed` file's content is edited.
- Decision 7 (agents act on their own recommendation for non-blocking questions) never covers deletion.

Choices made while planning. Each is the recommended default, and James can change any of them. Most need no answer: the work
starts with the default. Eight parts wait for his answer first, because they delete something or change what is merged or kept.
The "Needs first" column in Order of work names each: choice 2 holds the scratch clean-up (1f), choice 4 holds the stalled-loop merge hold (3g),
choice 7 holds the Codex, trace-file and RTK-history parts (5a to 5c), choice 8 holds taking the RTK programs out of version history (5e), choice 10
holds three of the small clean-ups (items 1 to 3 of 5i), and choice 11 holds the two deleted screens (5h). The 11 marked "real decision" would change the design,
delete something, or change what is merged or kept if answered the other way. The titles say plainly which choices delete and
which change the design.
1. **Old documents are moved to an archive folder, not deleted (Step 1). This moves files; it deletes nothing. Parts (b) and (c) are real decisions.**
   - (a) What happens: finished documents that nothing live cites are moved into one archive folder, keeping their names and
     sub-folders. An index inside the archive lists every move and says how to put each one back, and a one-line search-ignore
     file keeps default searches out of it. The tool never commits: it stages the moves and prints the exact commit command. The
     old completed-plans folder is folded in. Alternative: delete them and keep only an index with each document's last change.
     Reason for the default: nothing is lost, one step undoes it, and they stay readable.
   - (b) The cutoff is 30 days since a document's last change. 30 days moves 356 documents (9.1 MB). 14 days would move 473
     (11.6 MB), 60 days 313 and 90 days 207. You see the real list before anything moves, so you can pick again at the review.
     Recommended: 30.
   - (c) Finished documents that live ones cite stay where they are. 119 finished documents (3 MB) are cited by link or full
     path from a document still in use, or from code; the register of live-test failures cites 42 of them. They are not moved,
     so about 80 stay in the plans folder for good. Alternative: edit the register's links so the evidence can move too. That
     edits a 1 MB file that another session is working on, and edits finished documents, which the plan-lifecycle rule says not
     to touch. Recommended: leave them.
   - (d) The agent instructions stop telling agents to add a status section to a finished plan (today they name the finished
     remediation plan for that, which the closed-file rule forbids). Default: a new live-test failure's status goes in that
     failure's own row in the register. Alternative: a new dated document each time.
2. **Clearing old working files from the scratch folder is optional and off (Step 1, last part). Real decision, and it deletes.**
   - The scratch folder is 32 GB in 146,591 files and your version history does not hold it, so a deletion cannot be undone.
   - If you say yes: a dry run first, only entries whose newest file is over 30 days old (and rendered review pages over 14
     days old); the October research folders, and any folder an open plan names, stay. Default: not done, and not built until you answer.
   - Alternative: leave it alone.
3. **Where a safety fix has to choose, it refuses or leaves things alone (Step 3). This changes what Harness does today; no answer needed unless you disagree.**
   - A held shell command answered with no decision is refused and logged. Alternative: return an error, which could leave the
     waiting tool waiting.
   - The start-up tidy-up leaves a work folder that has unsaved changes alone and tells you, instead of committing them.
     Alternative: commit first, as a normal close does. Reason: your ask-first rule for work folders.
   - Idle clean-up and the automatic memory clean-up skip a chat that hosts a running loop. They do not stop the loop.
   - An agent's read of another session's output is refused unless that session was started on a remote computer by the same
     tools, the rule that already protects closing. Alternative: also require the caller to be the parent.
   - Stop and Cancel on the phone get an inline "Are you sure?" row, not a pop-up.
4. **Loops that stall, or whose last check needs a person, stop merging their work, but only if you say yes (Step 3, last part). Real decision, and it changes what Harness merges for you.**
   - Today those loops end as "ended, see notes" and Harness merges their work as if they had succeeded. After this their work
     stays on its own branch and the end card says nothing was merged. Accepting a loop by hand still merges.
   - Recommended: yes. Until you answer, the part is not built. Alternative: leave it as it is.
5. **A campaign step whose work was held back pauses the campaign, even on "carry on" (Step 3). Real decision, and it changes the design.**
   - Only a campaign you set to "carry on" is affected; the default already pauses. Recommended: yes.
   - Alternative: carry on, so later steps start without the held work.
6. **Paused loops, plan-file loops and the plan queue's checker (Step 4). Part (c) is a real decision, and it changes the design.**
   - (a) A loop that pauses inside a scheduled automation ends the automation's run as "needs attention" while the loop stays
     paused, so Resume still works. You get one quiet desktop notice per pause, at most one per loop per hour.
   - (b) A loop given a plan file that was never marked complete ends as "needs review", not as a pause and not as a refusal.
     This keeps the earlier decision that ordinary loops may finish with skipped checks.
   - (c) The plan queue's checker sends back only critical and high findings, and the rest go to you. If a failed check has no
     critical or high finding, everything goes back as it does today, so a failed check cannot turn into a pass. There is no
     new setting. Recommended: critical and high go back. Alternative: a per-run setting, which needs a change to the shared data
     definitions.
7. **What Harness may delete or trim on its own, and what it only offers after a preview (Step 5, parts 5a to 5c). Real decision, and it deletes. Answer a, b and c separately; none of the three parts is built before you do.**
   - (a) Codex's safety copies. Before its start-up fix of Codex's private session list, Harness saves a full copy: 425 so far,
     39 GB, and it never deletes one.
     - From the update on, new copies get a new name. Harness keeps the newest 3 of those and removes older ones of that kind by
       itself, one per start. This is the one place in these parts where Harness deletes by itself, and it can only ever touch
       copies it makes after the update, so the pile stops growing from the first start (at most 3 new copies).
     - The 425 existing copies and the 6 smaller clean-up copies are never removed by Harness by itself. The disk space card
       offers them (about 38 GB; the newest 3 old copies stay) after a preview and your yes.
     - Alternatives: ask-first only, with no automatic rule; keep more than 3; or back up less often.
   - (b) The technical record files get a size cap. Each file stops at 50 MB and keeps three older pieces; Harness drops the
     oldest piece by itself, the way its main log already rotates. The 711 MB file is set aside, not deleted; deleting it is an
     ask-first row on the card. The stray copy in the Mac's temporary folder moves into the Harness folder under its own name.
     Alternatives: 100 MB with two older pieces; or one shared file (unsafe: two record shapes in one file).
   - (c) RTK's command history gets an ask-first trim to 30 days (a real decision). RTK keeps 90 days by itself. The file is
     600 MB and has grown about 50 MB a day since 7 Oct, because one script runs thousands of commands per run. The trim removes
     rows only when you press the button after a preview, and the file does not shrink on disk. It is low urgency: 449 GB are
     free. Recommended: build it. Alternative: do nothing and re-measure after the RTK wording fix in the token plan.
8. **The five RTK program files stop being kept in the project's version history (Step 5, part 5e). Real decision, and it changes what is kept there.**
   - The build downloads them and checks them against a fixed fingerprint (one retry; a failed download fails the build), as the
     release build already does, and the build check on every change gets its own download step. Day-to-day start-up only warns
     if a download fails. History is not rewritten. It needs your yes to commit.
   - Alternative: keep them tracked, which adds about 20 MB for every copy of the project, for good, at each update.
9. **Three smaller disk items (Step 5, parts 5d, 5f and 5g). Defaults; no answer needed unless you disagree.**
   - The old pre-rename data folder (11 MB) goes to the Bin from the disk space card, after a preview and your yes; it is not
     deleted. Its dead start-up code is removed.
   - Pasted attachments get a one-line ignore in the local settings of any project Harness saves them in (this writes into that
     project's own private ignore list, never into files it commits), plus a card row.
   - Single-question Claude calls skip the saved transcript.
10. **Small clean-ups delete a shortcut, a setting and two unused helpers (Step 5, part 5i). Real decision, and it deletes; these three items wait for your answer.**
    - Delete the bare `i` "Focus Input" shortcut, which does nothing. Alternative: wire it. Reason: a global one-letter shortcut
      collides with typing.
    - Delete the "resident session" setting, which does nothing, and two unused helper functions.
    - Not held: correct a stale size limit, and make the size check see files that are not saved to version history yet (a
      warning, not an error).
11. **Delete the empty Training Data and Instance Messaging screens and three unused building blocks (Step 5, part 5h). Real decision, and it deletes about 5,100 lines of code.**
    - Training Data records nothing. Instance Messaging is unused but not proven empty. Reversible through git. Not built until you answer.
    - Recommended: yes to Training Data and the three building blocks; yes to Instance Messaging unless you plan to use it.
    - Alternative: keep Phase 5 step 3's change, which only hides the two screens.
12. **The Settings page (Steps 6 and 7). Two real decisions.**
    - (a) The "Compact after token spend" switch is hidden now, not wired. It does nothing today. Hiding keeps any stored value.
      Wiring it (size M) needs Claude's per-turn spend record and the compaction rework first. Recommended: hide. Alternative:
      wire it later.
    - (b) Which switches get a Settings row. Recommended: a row for the repository-map switch and a row for the transcript-speed
      switch (labelled "Experimental"). The other three stay as they are.
13. **Numbers and screen fixes take the smallest honest version (Steps 6 and 7). Defaults; no answer needed unless you disagree.**
    - A helper's "tokens used" shows its recorded spend, or "not measured".
    - The context ring (the circle showing how full the conversation is) skips helper-agent frames.
    - The fix for ordinary error text raising permission cards starts with a count only.
    - The overnight reminder folds waiting sessions into the existing reminder (no new alert type).
    - The slow lookup of saved sessions gets a timing line first, then a small lookup list that is built once in the background.
    - The attach control stays visible but disabled, with a visible reason. Alternative: hide it.
    - "Shown N times" counts only real session starts, and notes suggested for removal are never removed automatically.
      Alternative: a soft "hidden" state, which an earlier plan rejected.
    - The Costs page shows cents with the exact figure on hover. Alternative: keep four decimals on that page.
    - The rule that every input box has a name starts by only reporting, and becomes strict once the count reaches zero.
14. **Four things recommended not to build yet (Steps 7 and 8). Real decision on each; the default is to wait.**
    - (a) A question before a running session is switched to Auto-approve. Recommended: not built. You run Auto-approve by
      default and the header shows it.
    - (b) A "Needs you" number on the phone and the small remote screen. Recommended: wait until the desktop version has been in
      use; the phone already pushes each prompt.
    - (c) Letting Harness write Claude's own suggested allow rules into your global Claude settings. Recommended: no.
    - (d) The Everyday / Full view switch and tabbed pages. This changes the design. Recommended: decide after weeks of
      page-visit data and some time with the shorter menu.

## Ground rules for every step

1. **Read first.** Re-read the file, its callers and its specs before editing. Line numbers here are from 11 Oct. Commit
   `4d175e55b` touched `scripts/check-ts-max-loc.ts`, `docs/generated/architecture-inventory.json`, `acp-cli-adapter.ts`,
   `settings-migrations.ts`, `instance-manager.ts` and `loop-coordinator.ts`, and other sessions keep committing: re-read a
   file and its `git status` entry just before you edit it.
2. **Prove the bug first.** Where a part names a failing test, write it before the fix and confirm it fails on today's code.
3. **Work in the current checkout.**
   - Do not create a feature branch or worktree; that is James's rule.
   - On 11 Oct nothing was staged (the other session committed its 146 staged files at 00:34). Seven tracked docs are
     modified and not closed: `docs/AIO_MCP_CLI.md`, `docs/DEVELOPMENT.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`,
     `docs/mobile-app/live-activities-setup.md`, `docs/plans/livetest-remediation-register.md`,
     `docs/provider-parity-checklist.md` and `docs/superpowers/plans/2026-09-19-agent-reachable-loop-resume_livetest.md`.
     About 60 untracked entries are other sessions' or James's plans, live tests and reports. At 01:20 on 11 Oct another
     session was also building a release and had modified `package.json` (one line) and `package-lock.json`; Step 1 (1b) and
     part 5e both edit `package.json`, so check its `git status` first. Treat anything already modified or untracked before
     you start as theirs.
   - Never stage, revert or reformat their work. Stage only your own hunks. **Never stage this plan or any other plan, spec
     or live test that does not end in `_completed`.**
4. **Docs rules for this plan's own work.**
   - Untracked docs are never moved, deleted or edited by Step 1's tool. The one exception is 1f's scratch sweep, which deletes only git-ignored working files that James has seen listed and said yes to (choice 2); no tracked doc and no doc outside `_scratch/` and `.aio-review/` is ever in it.
   - Moves use `git mv`. A document with any `git status` entry is never moved.
   - Nothing is added to a file whose name ends in `_completed`; follow-up work goes into a new dated doc.
5. **File-size limits** (`npm run check:ts-max-loc`; it skips `*.spec.ts` and `__tests__/`, and reads only git-tracked `.ts`
   files). Allowlisted files may grow to their ceiling plus 50 lines; other files are capped at 700. Counts measured on 11
   Oct, after `4d175e55b`, with the room left to the cap:

   | File | Lines now | Room left | Plan |
   |---|---|---|---|
   | `src/main/instance/instance-lifecycle.ts` | 3,638 | 3 | 2b moves about 200 lines out; 5i nets -1; shared with Phase 0 step 12 (about 1 line), Phase 1 step 17a and Phase 5 step 9. Land 2b first |
   | `src/main/plan-queue/plan-queue-coordinator.ts` | 700 | 0 | not edited here (4c edits `plan-queue-item-flow.ts`); Phase 2 step 4a makes room there |
   | `scripts/check-ts-max-loc.ts` | 700 | 0 | 5i: line-neutral edits only; new logic in `scripts/lib/` |
   | `src/main/instance/instance-orchestration.ts` | 1,151 | 4 | 6a: the two call sites (`:761`, `:1075`) stay line-neutral; logic in a new module |
   | `src/main/ipc/handlers/instance-handlers.ts` | 1,296 | 5 | Phase 0 step 3 uses about 3, so 2 remain; 3a: same line count, a one-line warning at most |
   | `src/renderer/app/features/instance-detail/instance-header.component.ts` | 694 | 6 | 7i: put new code elsewhere |
   | `src/main/cli/adapters/claude-cli-adapter.ts` | 2,114 | 7 | 6c and 6e: no edits there; new modules |
   | `src/main/app/orchestrator-tools-step.ts` | 691 | 9 | 3b: net +3 |
   | `src/main/orchestration/campaign-coordinator.ts` | 690 | 10 | 3f: about +6; if it passes 700, move the whole needs-review policy block into a new module |
   | `src/main/orchestration/loop-coordinator.ts` | 3,993 | 11 | 3g about 4 lines; 4b one line; 4a none (wrap the emit in the existing override). Shared with Phase 0 steps 1 and 11 and Phase 2 steps 8 and 13 |
   | `src/main/instance/instance-manager.ts` | 2,456 | 11 | not edited here |
   | `src/main/orchestration/loop-completion-detector.ts` | 844 | 12 | read only (4b) |
   | `src/main/session/session-continuity.ts` | 1,742 | 21 | 6g about +12; Housekeeping step 5 uses about 10: together 22 against 21, so put the index calls behind one `lookupIndex` property |
   | `src/main/cli/adapters/acp-cli-adapter.ts` | 2,559 | 21 | not edited here |
   | `src/main/orchestration/loop-coordinator-completion-gates.ts` | 673 | 27 | read only (4b) |
   | `src/shared/types/keybinding.types.ts` | 669 | 31 | 5i: net negative |
   | `src/shared/types/settings.types.ts` | 857 | 32 | 2a first; shared by every plan that adds a setting |
   | `src/main/event-bus/thin-client-command-executor.ts` | 659 | 41 | 3a: line-neutral |
   | `src/renderer/app/features/verification/execution/verification-monitor.component.ts` | 657 | 43 | 7g |
   | `src/main/core/config/settings-control-policy.ts` | 844 | 46 | 2a first; shared |
   | `src/main/core/config/settings-migrations.ts` | 643 | 57 | 5d deletes about 57 lines; 5i removes a block |
   | `src/main/mcp/orchestrator-tools.ts` | 773 | 77 | 3b: a description line |
   | `src/main/plan-queue/plan-queue-item-flow.ts` | 609 | 91 | 4c needs about 12; Phase 2 steps 4c and 4e add 30 to 55, leaving 36 to 61 after them |
   | `src/renderer/app/core/services/markdown.service.ts` | 586 | 114 | 5i: net about -60 |
   | `src/main/app/late-runtime-initialization-steps.ts` | 564 | 136 | 5a: read only |

   More than 200 lines of room each (lines now): `rtk-tracking-reader.ts` 501 (5b), `codex-state-cleanup.ts` 494,
   `codex-private-rollout-reconcile.ts` 307 (5a), `idle-monitor.ts` 480 and `resource-governor.ts` 424 (3d),
   `loop-worktree-lifecycle.ts` 208, `loop-worktree-lifecycle-reconcile.ts` 431, `loop-final-audit-blocked-completion.ts` 132
   and `loop-worktree-reconcile.ts` 140 (3c, 3g), `file-handler.ts` 87 (5g), `automation-loop-run.ts` 271 (4a),
   `child-announcer.ts` 299 (6a), `claude-assistant-message.ts` 147 (6b), `claude-cli-permission-details.ts` 214 (6c),
   `cross-project-initialization-step.ts` 198 and `security-handlers.ts` 481 (6d), `wake-context-builder.ts` 365 and
   `compaction-recovery.ts` 173 (7b), `mobile-gateway-push.ts` 364 (8a), `interrupt-utils.ts` 55 (5i),
   `verification-results.component.ts` 317 (7g), `plan-queue-prompts.ts` 273 (4c), `campaign-worktree-landing.ts` 339
   (3f), `claude-cli-argv-builder.ts` 352 (5f), `settings-manager.ts` 390 (5d), `settings-surfacing.ts` 276 and
   `settings-metadata-runtime.ts` 474 (6f), the trace files (`local-trace-exporter.ts` 91,
   `provider-runtime-trace-sink.ts` 233, `provider-runtime-trace-worker.ts` 155,
   `provider-runtime-trace-protocol.ts` 49; 5c), `session-continuity-state.ts` 172 (6g),
   `scripts/fetch-rtk-binaries.js` 299 (5e), `scripts/generate-architecture-inventory.js` 293 (1c), `AGENTS.md` 142 lines (no cap, but Copilot loads it twice; Step 1 adds 3 short lines, about 400 bytes), `docs/plans/README.md` 19 (rewritten), `package.json` 218.
   New modules proposed (count untracked new files by hand; the size check does not see them until they are staged):
   `scripts/retire-docs.ts` (about 400), `codex-state-backup-retention.ts`, `loop-merge-hold.ts`,
   `loop-worktree-clean-check.ts`, `attachments-ignore.ts`, `session-hosts-active-loop.ts`, `child-result-usage.ts`,
   `loop-plan-rename-check.ts`, `live-waiting-approvals.ts`, `claude-denial-patterns.ts`, `lifecycle/agent-mode-change.ts`,
   `helper-agents-chip.ts`, `memory-removal-suggestions.ts`, `needs-you-summary.ts`, `rtk-history-trim.ts`,
   `ndjson-rotation.ts`, `legacy-app-data.ts`, `plan-queue-finding-triage.ts` and `session-continuity-lookup-index.ts`.

   Put new logic in new modules and keep call-site edits to a line or two. Do not raise a ceiling.
6. **Prompt text** (only part 4c adds any) follows `docs/prompt-engineering-house-style.md`: role first; payload in named
   delimiters, stated to be data; the task and output contract after the payload; one concrete example; provider-neutral
   and positive wording.
7. **Wording on screen:**
   - Plain English, "Harness", and no internal codes.
   - Tooltips use `appTooltip` with `TOOLTIP_COPY`. Do not add new `title=` attributes to controls.
   - A tooltip may not be the only place that shows a state or a consequence (house rules at the top of `tooltip-copy.ts`).
     Every clean-up window states in visible text what it removes.
8. **IPC:** add the channel in `packages/contracts/src/channels/*.channels.ts`, then run `npm run generate:ipc`. Add the Zod
   payload schema, the handler and the preload domain, then run `npm run verify:ipc` and `npm run verify:ipc-usage`. New
   push events also need an entry in `src/main/event-bus/renderer-event-validation.ts`. Part 7j adds two channels and part
   5h removes about 30; the disk-card parts add target names to an existing schema and no channel.
9. **No browser on the Mac.**
   - Test renderer behaviour headless in Vitest, with seeded stores.
   - Anything that needs eyes on the rebuilt app goes to the live checks. Those run on the Windows PC, or on the Mac only
     with James's OK. Real data lives on the Mac, so the real-data checks happen there with James present and his yes.
10. **Never write to James's app databases, settings or folders from a script, and never delete real data.**
    - Use read-only queries (`?mode=ro`). Tests and rehearsals run on scratch copies in temporary folders.
    - Real data changes only in the places listed under "Decisions this plan follows": each starts with James pressing a
      button after a preview, or is one of the two automatic bounds (5a, 5c; each touches only files Harness starts writing after the update, and each waits for James's answer to choice 7), or is part 5g's one local exclude line.
    - `git worktree list` and `git branch --list` for the real repository must be identical before and after any rehearsal.
11. **Testing:** while working, run `npm run test:quiet -- <spec>`. When a part is finished, run the
    [gates](#final-verification) that apply.
12. **Re-check before building anything from "The rest of the list".** Those lines were not traced to code. Each one says
    so.
13. **Commit only when James asks.** Stage only a part's own code, specs and the docs it names; check the staged paths
    before every commit.

## Order of work

Parts run one at a time unless two of them share no files. "Needs first" lists hard dependencies and, where James must answer first, the choice that holds the part. Parts are listed by
value inside each step, not by when they can start; the "Needs first" column says what each waits for.

**Why this order.** Step 1 comes first because James asked for it and nothing blocks it. Step 2 comes second, and it
should land before the other plans' first new settings and before the plans that edit `instance-lifecycle.ts`: that is
what "make room first" means. Safety fixes (Step 3) come before loops (Step 4) because they can lose work or run
commands. Inside Step 5 the Codex backups part comes first, ahead of the order the reports used, because it is the biggest pile (39 GB) and, once James has answered choice 7, its code half needs nothing from other plans. Parked parts (Step 8) wait for a trigger or a
design pass and never block closing the plan.

| Part | Item | Size | Needs first | Main files (new modules in *italics*) |
|---|---|---|---|---|
| 1a | Fix a wrong pointer and a stale instruction, add a pointer check, rewrite the plans README | XS | none | `AGENTS.md`, `docs/plans/README.md`, *`scripts/__tests__/agents-doc-pointers.spec.ts`* |
| 1b | The retire tool, dry run only | S-M | 1a | *`scripts/retire-docs.ts`*, `package.json`, *`scripts/__tests__/retire-docs.spec.ts`* |
| 1c | Apply, the index, and hiding the archive from search | S | 1b | `scripts/retire-docs.ts`, *`.ignore`*, *`docs/_archive/INDEX.md`*, `AGENTS.md`, two existing specs, optionally `generate-architecture-inventory.js` |
| 1d | The first batch (James approves the list) | XS code | 1c and James | none new |
| 1e | Keep the count from growing back | XS | 1c | `AGENTS.md` |
| 1f | Optional: clear old scratch files (off by default) | S | 1b and James's yes (choice 2) | `scripts/retire-docs.ts` |
| 2a | Room in the two settings files | S-M | none; design pass first | `settings.types.ts`, `settings-control-policy.ts`, *new settings group files* |
| 2b | Room in `instance-lifecycle.ts` (first half of the mode-switch fix) | S | none | `instance-lifecycle.ts`, *`lifecycle/agent-mode-change.ts`* |
| 3a | A held shell command with no decision is refused | XS | Phase 0 step 4 | `instance-handlers.ts`, `thin-client-command-executor.ts` |
| 3b | Agents read only sessions they started on a remote computer | XS-S | none; before or with Phase 5 step 1a | `orchestrator-tools-step.ts`, `orchestrator-tools.ts` |
| 3c | The start-up tidy-up leaves a work folder with unsaved changes | S | Phase 0 step 2.6a (see the part) | `loop-worktree-lifecycle-reconcile.ts`, *`loop-worktree-clean-check.ts`* |
| 3d | Automatic closes skip a chat that hosts a loop | S | Phase 0 step 3 | `idle-monitor.ts`, `resource-governor.ts`, `initialization-steps.ts`, *`session-hosts-active-loop.ts`* |
| 3e | Stop and Cancel on the phone ask first | XS-S | none | phone `loop-detail.component.ts`, `plan-queue.component.ts` |
| 3f | A held campaign step pauses the campaign | S | Phase 2 step 8b | `campaign-coordinator.ts`, `campaign-worktree-landing.ts`, `campaign-page.component.html` |
| 3g | Stalled and final-audit-blocked loops stop merging | S | Phase 0 step 1, Phase 2 step 8b, and James's yes (choice 4) | *`loop-merge-hold.ts`*, `loop-coordinator.ts`, `loop-final-audit-blocked-completion.ts`, the two worktree files |
| 4a | A paused loop frees its automation; a notice per pause | S-M | Phase 2 steps 8d and 17 | `automation-loop-run.ts`, `loop-coordinator.ts` emit wrapper, `attention-notices.ts` |
| 4b | Plan-file loops check the plan was marked complete | S | Phase 2 step 8 | *`loop-plan-rename-check.ts`*, `loop-coordinator.ts` (one line) |
| 4c | The plan queue's checker sends back only serious findings | S | none; best after Phase 2 step 14 | `plan-queue-item-flow.ts`, `plan-queue-prompts.ts`, *`plan-queue-finding-triage.ts`*, `plan-queue-item-list.component.html` |
| 5a | Codex safety copies: new ones named apart and kept to 3; offer the old ones on the card | S | James's yes (choice 7); card half also Housekeeping step 4a | `codex-private-rollout-reconcile.ts`, *`codex-state-backup-retention.ts`*, the storage files |
| 5b | RTK's command history: ask-first trim to 30 days | S | James's yes (choice 7); Housekeeping step 4a; best after Phase 1 step 18a | *`rtk-history-trim.ts`*, `rtk-tracking-reader.ts`, the storage files |
| 5c | Trace files get a size cap | S-M | James's yes (choice 7); card half also Housekeeping step 4a | *`ndjson-rotation.ts`*, the four trace files, the storage files |
| 5d | The old `claude-orchestrator` data folder, ask-first | XS-S | card half Housekeeping step 4a, then James's yes on the card (choice 9); the dead code any time | *`legacy-app-data.ts`*, `settings-migrations.ts`, `settings-manager.ts` |
| 5e | Stop keeping the RTK programs in git, and fetch them in CI | S | before Phase 1 step 18a; James's yes (choice 8) to commit | `scripts/fetch-rtk-binaries.js`, `package.json`, `.gitignore`, `.github/workflows/ci.yml` |
| 5f | Single-question Claude calls skip the saved transcript | XS | with or after Phase 0 step 7g | `claude-cli-argv-builder.ts`, `adapter-factory.types.ts` |
| 5g | Pasted attachments: a local ignore line, and a card row | S | exclude half none; card half Housekeeping step 4a, then James's yes on the card (choice 9) | `file-handler.ts`, *`attachments-ignore.ts`*, the storage files |
| 5h | Delete the empty Training Data and Instance Messaging screens | M | James's yes (choice 11); after Phase 5 step 3 (or instead of it); before Phase 3 step 9 | deletions, `app.routes.ts`, `control-surface.registry.ts`, the channel and preload files |
| 5i | Small clean-ups: dead shortcut, helpers, setting; the size gate | XS each | items 1 to 3: James's yes (choice 10); items 4 and 5: none | `keybinding.types.ts`, `markdown.service.ts`, `settings-migrations.ts`, `scripts/check-ts-max-loc.ts` |
| 6a | A helper's "tokens used" shows what it spent | S | Phase 0 step 7b | *`child-result-usage.ts`*, `instance-orchestration.ts`, `child-announcer.ts` |
| 6b | The context ring ignores helper agents | XS-S | none; before or with Phase 3 step 14 | `claude-assistant-message.ts` |
| 6c | Ordinary error text stops raising permission cards | S | none; design pass first | *`claude-denial-patterns.ts`*, `claude-cli-permission-details.ts` |
| 6d | The overnight reminder counts Claude and Codex questions | S-M | Phase 3 step 6; design pass first | *`live-waiting-approvals.ts`*, `cross-project-initialization-step.ts`, `security-handlers.ts` |
| 6e | A connector's request for input gets an answer | S | probe any time; code after Phase 3 step 16 | the Phase 3 step 16 dispatcher |
| 6f | Hide the "Compact after token spend" switch | XS | none; after Phase 1 step 5a, which copies this switch's entry | `settings-surfacing.ts`, `settings-metadata-runtime.ts` |
| 6g | A missed lookup of a saved session stops reading 4.7 GB | S-M | timing line none; index after Housekeeping step 5 | `session-continuity.ts`, *`session-continuity-lookup-index.ts`* |
| 7a | The attach control says why it is off | S | Phase 1 step 12d, if built | the composer, one shared function |
| 7b | "Shown N times" counts real starts; suggest unused notes | S-M | step 1 with Phase 3 step 15; steps 2-3 after Phase 5 step 14 | `wake-context-builder.ts`, `compaction-recovery.ts`, *`memory-removal-suggestions.ts`* |
| 7c | A "helper agents running" chip | S | Phase 3 steps 5 and 12b, Phase 5 step 16 | *`helper-agents-chip.ts`* |
| 7d | A grey line when Build, Plan or Review changes (second half) | XS | 2b and Phase 3 step 3 | *`lifecycle/agent-mode-change.ts`* |
| 7e | Invisible "close" buttons stop being Tab stops | XS-S | Phase 4 step 4b | the templates |
| 7f | Every input box has a name; a rule keeps it so | S-M | Phase 4 step 4; with part 3 step 1f | the Phase 4 counter and guard |
| 7g | Money shown in cents on the Costs page and other cost screens | S | Phase 5 step 11 and Phase 0 step 7h | `cost-page.component.html`, the verification components |
| 7h | Two switches get a Settings row | S | Phase 3 step 10; James's pick | the five settings places |
| 7i | Optional: a question before Auto-approve is switched on | XS-S | Phase 5 step 7; James's yes | `instance-detail.component.ts` |
| 7j | Memory reviews and repository jobs reach "Needs you" at once | S | Phase 3 step 6c; design pass first | two channels, `renderer-event-validation.ts`, `diagnostics.preload.ts` |
| 8a | A "Needs you" number on the phone and thin client (parked) | M | 6d, Phase 3 step 6, Phase 2 step 13; James | *`needs-you-summary.ts`*, `mobile-gateway-push.ts` |
| 8b | Follow-ups to "Allow once for every tool" (parked) | M | Phase 3 step 16 and its default flip | the Phase 3 step 16 files |
| 8c | Everyday / Full view switch, tabbed pages (parked) | L | Phase 3 steps 5 and 9, plus weeks of data | design pass |
| 8d | Nine small tidy-ups that wait for a trigger (parked) | XS-S each | their triggers | various |
| 8e | Copilot's context counter and native context tools (parked) | M | Phase 0 step 7c; Copilot loops in use | design pass |

Files shared across parts: `AGENTS.md` (Step 1; Phase 4 steps 3 and 4 add a pointer and a checklist line; Housekeeping step 13 option 2 would also edit it) and `package.json` (Step 1 and 5e; Phase 0 step 7b adds `audit:claude-cost`, Phase 1 step 3 `audit:context-ceiling`, Phase 2 step 7e `audit:loop-scorecard`, Phase 4 `audit:ui-hints`); `settings.types.ts` and `settings-control-policy.ts` (2a, 5i, 7h and every plan that
adds a setting); `instance-lifecycle.ts` (2b, 5i); `settings-migrations.ts` (5d, 5i); the disk space card files that
Housekeeping step 4 creates (`storage.schemas.ts`, `storage-cleanup-service.ts`, `storage-usage-service.ts` and the card
component: 5a, 5b, 5c, 5d, 5g); `loop-coordinator.ts` (3g, 4a, 4b); `loop-worktree-lifecycle-reconcile.ts` (3c, 3g);
`campaign-coordinator.ts` (3f); `plan-queue-item-flow.ts` and `plan-queue-prompts.ts` (4c; Phase 2 steps 4c and 4e add 30 to 55 lines to the first and edit the second, and Phase 1 step 6 tags spawns in the first); `orchestrator-tools.ts` (3b and Phase 5 step 1a); `scripts/check-ts-max-loc.ts` (5i);
`rtk-tracking-reader.ts` (5b and Phase 1 step 18); `session-continuity.ts` (6g and Housekeeping step 5);
`cost-page.component.html` (7g and Phase 0 step 7h, Phase 3 steps 12b and 13d). Do those parts in the order above.

---

## Step 1. FU-D1: Retire old docs (M, six parts)

**For James:** About 360 of your 790 plan, spec and test documents are finished and more than a month old. They move into
one archive folder. Nothing is deleted, and an index says where each one went. You read the list of what would move and
approve it before anything changes. This is the work you asked for on 11 Oct.

**Origin:** James's message of 11 Oct. The backlog has no item for it. No dependency on Phase 0 or any other plan.

**Verified (11 Oct)** (the facts all six parts rely on):
- **Size of the problem.**
  - 789 markdown docs (729 tracked, 60 untracked), about 20.5 MB.
  - 623 are closed: 506 named `completed` in any spelling, 110 `_livetest_completed`, 7 superseded. That is 79 percent of
    all docs and about 15 MB. Only 14 are active plans or specs and 32 are open live tests.
  - New docs reach git at about 33 a week (293 in the last 9 weeks), in bursts: 186 landed in the week of the 23 Sep bulk
    commit.
  - At a 30-day cutoff **356 docs (9.1 MB) can move**. The other closed docs are held back: 119 pinned (cited by a live doc
    or by code), 142 too recent, 4 untracked, 2 out of scope or already archived (356 + 119 + 142 + 4 + 2 = 623).
  - Cutoff table (docs that can move after the safety rules, of all closed docs older than the cutoff): 14 days 473 (522);
    30 days **356 (365)**; 45 days 330 (339); 60 days 313 (321); 90 days 207 (213); 120 days 142 (148).
- **The plan queue ignores `_archive` and never opens closed docs.** `src/main/plan-queue/plan-queue-discovery.ts:32-33`
  has `'_archive'` and `'archive'` in `SKIPPED_DIRS`; `:90` is `if (!SKIPPED_DIRS.has(entry.name)) await walkMarkdown(full, out)`;
  `:71` classifies any name containing `_completed` as `other`; `readHeader` runs only after the `wanted` filter
  (`:149-155`). Items are added only by the scan at run start (`plan-queue-coordinator.ts:283`). The plan writer re-read the
  `SKIPPED_DIRS` set and the walk on 11 Oct.
- **Loop completion cannot be triggered or undone by moving old docs.** `loop-completion-detector.ts:175-182` watches with
  `depth: 0, ignoreInitial: true`; `loop-completed-plan-helpers.ts:42-51` accepts only "this loop's configured plan file
  renamed"; `loop-completion-watcher-runtime.ts:14-22` logs and ignores every other `*_completed.md`.
- **The commit hook.** `.githooks/pre-commit:5-8` runs `~/.config/git/hooks/plan-spec-guard.sh`. Line 16 of that script
  blocks added, copied, modified or renamed files matching `(_spec|_spec_planned|_plan|_livetest)\.md`. Closed-name moves
  pass and deletions are not blocked (`--diff-filter=ACMR`). Two tracked docs could not be moved without tripping it
  (inferred from the pattern; the hook was not run): `docs/_archive/bigchange_intent_routing_plan.md` and the tracked open
  live test.
- **Codemem indexes markdown, and `docs/` is not excluded.** `src/main/indexing/config.ts:53` has `'**/*.md'`;
  `src/main/codemem/code-index-ignores.ts:19` has `'_archive/'`; `code-index-manager.ts:426-433` also applies the repo's own
  `.gitignore`; `code-index-reconciler.ts:78-84` drops manifest rows whose file leaves the filtered walk. Real data
  (`codemem.sqlite`, counts only): `docs/_archive` 0 rows, `docs/superpowers/plans/_archive` 0, `_archive` 0,
  `docs/plans/completed` 33 rows (all 33 files). This repo's markdown chunks are 1,112 of 108,104; doc chunks are about 1
  percent of chunks but 10.3 percent of the text (median 15,949 characters against 1,021 for `.ts`).
- **Per-message retrieval is an unfiltered keyword match, and old docs win slots.** `instance-manager.ts:1657` →
  `context-engine.ts:124-128` → `instance-input-contexts.ts:282-304` (`maxTokens: 900`, `topK: 5`, child sessions skipped)
  → `indexed-codebase-context.ts:288` → `cas-store.ts:548-549` (`WHERE code_fts MATCH ? AND wc.workspace_hash = ?`, no file-type
  or folder filter; the query is the first 12 tokens, `cas-store.ts:755`). In a synthetic probe (10 of the checker's own
  queries, not James's messages; the injection metadata keeps no file names, so the real share cannot be read back) closed
  docs took 25 of 47 top slots; with them excluded, 24 slots were code and 19 were other markdown.
- **Nothing ships from `docs/` except two things.** `electron-builder.json` filters `docs` to `BROWSER_AUTOMATION_SETUP.md`
  and `runbooks/**/*`. **Trap:** `resources/browser-extension/KNOWN_ISSUES_completed.md` has a closed-style name and ships
  in the app, so the tool's scope must be `docs/` plus top-level repo docs, never `resources/`, `src/`, `apps/`, `packages/`.
- **Docs that must stay put.** The AGENTS.md pointers (`:30`, `:69`, `:101`, `:111`, `:133`, `:135`), the `CLAUDE.md:1-2`
  imports, `plan-queue-prompts.ts:18` (`RUNBOOK_RELATIVE = 'docs/plans/livetest-campaign-runbook.md'`),
  `scripts/check-provider-parity.js:19`, the standing register (`livetest-remediation-register.md`, the only doc with the
  "Type: standing register" marker, 1,018,484 bytes) and the 11 packaged runbooks.
- **Broken today (re-read by the plan writer on 11 Oct).** `AGENTS.md:101` names
  `docs/plans/2026-07-19-livetest-failure-remediation-followup_plan.md`; only the `_plan_completed.md` file exists. `AGENTS.md:142`
  (the report said `:141`) names `code-index-watcher.ts` for `DEFAULT_CODE_INDEX_IGNORES`, which is defined in
  `code-index-ignores.ts` and only re-exported at `code-index-watcher.ts:10`. `docs/plans/README.md` still describes the
  `completed/` folder, last used on 12 Jul (`9c8800c1b`).
- **Links.** 1,699 doc-to-doc references resolve; 210 run from surviving docs into closed docs. **119 closed docs are cited by
  link or path** from a surviving doc (76 closed live tests and 43 others, 2,986 KB). The register cites 42 of them. Of 61
  non-test `docs/...md` citations in code, only 26 resolve and 22 were already broken by `_completed` renames.
- **A generated file lists docs.** `docs/generated/architecture-inventory.json` lists 105 docs of 800 or more lines by path,
  read from the git index (`scripts/generate-architecture-inventory.js:154-171`); 69 of them are in the movable set. The
  pre-commit hook regenerates and stages it (`scripts/run-git-hook.js:11-24`) and CI checks it (`verify:architecture`,
  `.github/workflows/ci.yml:79`). A move changes path strings in it: expected churn, not a failure.
- **Safety facts.** `origin` exists and `main` was level with it. None of the 623 closed docs has a local change. On 11 Oct
  the other session's 146 staged files were committed (`4d175e55b`), so nothing is staged now; the overlap-based rule in 1c
  stays right either way, because another session will usually have something staged again. `rg` 15.1.0 reads `.ignore` by default. The Claude Code source snapshot builds its Grep arguments as `['--hidden', ...]`
  with no `--no-ignore` (`Actual Claude/tools/GrepTool/GrepTool.ts:330`), so its Grep honours `.ignore`; its Glob passes
  `--no-ignore` (`utils/glob.ts:105`) and still lists archived files. 1c confirms this with a live search.
- **Three Harness features also run `rg` in this repo without `--no-ignore`, so a root `.ignore` hides the archive from them too (read on 11 Oct; decided in 1c change 6).**
  - The Codemem fallback search, used when the index has no answer: `src/main/codemem/code-retrieval-service.ts:148-210` (`spawn('rg', ...)` at
    `:154`). It backs the per-message code context (`indexed-codebase-context.ts:288`), the codebase IPC handlers and the loop's context lookup
    (`loop-coordinator.ts:1095`).
  - The quick "where is X" lookup that answers some helper-agent tasks without starting a model: `src/main/instance/orchestration/fast-path-retriever.ts:97-131`
    (`rg` at `:98` and `:122`).
  - The local reviewers' `search` tool: `src/main/review/local-review-tool-runner.ts:230-233`. It lists files with `git ls-files --cached --others
    --exclude-standard` (`:305`), copies them into a temporary folder (the tracked `.ignore` goes with them) and runs `rg --no-config` there, so `.ignore`
    applies. Its `read` tool opens files by path, and the file mentions no ignore file.
  - Not affected: Codemem's index (it reads the repo's `.gitignore` and `DEFAULT_CODE_INDEX_IGNORES`, never `.ignore`: `code-index-manager.ts:426-433`) and
    the plan queue (`plan-queue-discovery.ts:32-33,90`). No `.ignore` or `.rgignore` exists today in this repo or in any parent folder up to the home folder
    (checked on 11 Oct), and `RIPGREP_CONFIG_PATH` is unset.

### 1a. Fix what is already wrong (XS)

**For James:** A pointer in the agent instructions names a plan file that no longer exists under that name. This fixes it,
rewrites the out-of-date how-to in the plans folder, and adds a small check so a broken pointer cannot creep back.

**Change:**
1. `AGENTS.md:101`: that sentence tells agents to add "a matching implementation-status section" to
   `docs/plans/2026-07-19-livetest-failure-remediation-followup_plan.md`. Only `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md` exists now,
   and it is closed (the register calls it "(closed)"; it already holds 6 implementation-status sections). Swapping the name alone would send agents to edit
   a closed file, which the closed-file rule and this plan's Ground rule 4 forbid. So fix the name and reword the clause: the completed plan is history only,
   and a new item's status goes in its own row in the register's Remediation Index ("Per-item status lives in the Remediation Index", register header).
   Without the name fix the tool's "every doc AGENTS.md names stays" rule would pin a file that does not exist and miss the real one. This changes the
   live-test flow, so it is part (d) of choice 1; if James prefers a new dated document for each item's status, word the clause that way.
2. `AGENTS.md:142`: say the ignore list is in `src/main/codemem/code-index-ignores.ts` (the watcher file only re-exports it).
3. New `scripts/__tests__/agents-doc-pointers.spec.ts` (about 30 lines): every concrete `docs/...md` path named in `AGENTS.md`
   or `CLAUDE.md` (ignore globs with `*`), and every `@path` import in `CLAUDE.md`, must exist on disk. It fails on
   today's code (the `AGENTS.md:101` pointer) and keeps this class of rot from returning.
4. Rewrite `docs/plans/README.md` (19 lines now) to the real flow in about 10 lines: active docs stay untracked in
   `docs/plans/`; rename to `_completed` and commit; closed docs older than 30 days are retired to `docs/_archive/` by
   `npm run docs:retire`; see AGENTS.md "Plan and Spec Filename States". Remove the `completed/` folder instructions.

**Tests:**
- `agents-doc-pointers.spec.ts`: fails today, passes after change 1.

**Done when:**
- `grep -c "livetest-failure-remediation_plan_completed.md" AGENTS.md` is 1 and the old name is absent, and the sentence no longer tells agents to add to a closed plan.
- `docs/plans/README.md` no longer mentions `completed/` as a place to move files; the new pointer spec passes.

### 1b. The retire tool, dry run only (S-M)

**For James:** A tool that, without changing anything, lists which finished documents are old enough to move and which must
stay (and why). It writes the list as a page you can answer by number.

**Change:**
1. New `scripts/retire-docs.ts` (about 400 lines; cap 700), run with `tsx` like `check-ts-max-loc.ts`. Standalone: it
   imports nothing from `src/`. Add to `package.json` (218 lines): `"docs:retire": "tsx scripts/retire-docs.ts"` and
   `"check:docs-retire": "tsx scripts/retire-docs.ts --check"`. Keep the pure rules in exported functions so the spec can
   test them without a repo.
2. **Inputs:** `git ls-files -z '*.md'`; `git ls-files -z --others --exclude-standard '*.md'`; one
   `git log --cc --format=@@C@@%cI --name-only --no-renames` pass for last-commit dates (0.16 s here); `git status
   --porcelain -z`. **`--cc` matters:** without it a file whose only touching commit is a merge is missed
   (`.githooks/README-stay-on-main.md`, merge commit `5f6ea83c1`, one of 25 merges in the history). Keep
   `git log -1 -- <path>` as a fallback for any path still missing.
3. **A doc is a candidate only if all of these are true:**
   - it is tracked;
   - it has no `git status` entry (not modified, staged, renamed or deleted);
   - it is closed by name: `/[._-]completed\.md$/i` or `/superseded/i` (covers `_completed`, `_Completed`, `.COMPLETED.md`,
     `_livetest_completed`, `_superseded`);
   - it is in scope: a top-level repo `*.md`, or under `docs/` but **not** under `docs/runbooks/`, `docs/generated/`,
     `docs/llm/`, or any folder named `_archive` (never `resources/`, `src/`, `apps/`, `packages/`);
   - its last commit is strictly more than `--cutoff-days` ago (default 30);
   - it is not pinned.
4. **Pinned** means cited by a markdown link `](x.md)` or a path `a/b.md` (resolved against the citing file's folder, then the
   repo root) from (1) any surviving doc, meaning any markdown file that is not itself closed-named, tracked or untracked,
   including AGENTS.md and CLAUDE.md, or (2) any tracked non-markdown text file except `docs/generated/` and lock files.
   Bare file names do **not** pin. A doc cited only by other closed docs is not pinned. Report each pinned doc with the
   first citing file, so the pin releases when the citing doc is retired or closed.
5. **Never touched, listed for information only:** untracked closed docs (4 today; they wait for their code to land). Untracked
   docs older than 14 days by modification time go under "yours to decide, never touched".
6. **Groups with stable numbers (so James answers by number):** 1 superpowers plans; 2 superpowers specs and verifications;
   3 `docs/plans` closed plans, specs and designs; 4 `docs/plans` closed live tests; 5 `docs/plans/completed/` (the whole old
   folder, its `README.md` goes with it); 6 `docs/` top level and `docs/mobile-app` old todo and plan docs; 7 top-level repo
   closed docs. At 30 days on 11 Oct: 136 / 84 / 80 / 8 / 32 / 10 / 6 docs (4,572 / 1,677 / 1,254 / 58 / 701 / 579 / 71 KB).
7. **Review list (never moved by the tool):** tracked, not closed-named, not an active, live-test, report or prompt name, in
   scope, not a README, older than 90 days, cited by no surviving doc or code. 11 docs, 85 KB today (for example
   `docs/QUICK_TEST_REFERENCE.md`, `docs/DISCORD_CHANNELS.md`, `docs/pause-on-vpn.md`, `docs/phase-0.5-api-verification.md`,
   `docs/2026-06-03-manual-verification-checklist.md`, the two `docs/articles/*`, `docs/plans/PROMPT_claude-cost-routing.md`).
   Some are conventions or runbooks (`docs/renderer-state-and-performance-conventions.md`,
   `docs/android-automation-runbook.md`), so each needs James's yes or no.
8. **`--as-of YYYY-MM-DD`** fixes "today" (default: the real date and time). It means the start of that date (00:00) in the machine's time zone, and
   "more than N days old" means a last-commit time strictly before that instant minus N times 24 hours. The spec uses it for exact age boundaries, and it
   lets the first real run get close to the report's numbers (`--as-of 2026-10-11`). The 30-day count is stable under this choice (the fresh review found no
   closed doc last committed on 10 to 12 Sep); the 14-day count moves by about 60 documents between a start-of-day and an end-of-day reading, because 61
   closed docs share one commit on 27 Sep, and the 90 and 120-day counts move by a few because of the commits of 12 and 13 Jul.
9. **Output:** Markdown to `_scratch/retire-docs/<YYYY-MM-DD>.md` (disposable) plus a short summary on screen. The dry run
   writes nothing else. Sections: summary line, numbered groups with per-doc lines (path, close date, first heading), held
   back (with reasons and the citing doc), review list, untracked list.
10. **`--check`:** one line, always exit 0, for example `Docs: 356 closed docs are past the 30-day cutoff and can move (9.1 MB).
    Last batch: never. Run npm run docs:retire.` It reads the newest `## Batch YYYY-MM-DD` header in
    `docs/_archive/INDEX.md` for "last batch", and says "due" when 25 or more are eligible or the last batch is over 35 days old.

**Tests** (new `scripts/__tests__/retire-docs.spec.ts`; all fail on today's code because the script does not exist). Build a
temp git repo (as `plan-queue-doc-close.spec.ts` does), commit docs with controlled commit dates (`GIT_COMMITTER_DATE`),
then assert:
- old, clean, tracked, closed docs are candidates; the destination is `docs/_archive/<rest>`; a top-level doc goes to
  `docs/_archive/_root/`;
- with `--as-of` fixed, a doc 30 days old is held back and one 31 days old is a candidate (strictly more than);
- untracked closed docs are listed as "not committed" and never moved, even with `--apply --all`; their bytes are unchanged;
- a tracked doc with a working-tree edit, or a staged change, is held back with the reason;
- pin rule: cited by a relative link or a full path from a surviving doc is held, with the citing file named; cited by bare
  name only is still movable; cited only by another closed doc is movable; cited from a tracked `.ts` file is held; named in
  AGENTS.md is held;
- scope: `docs/runbooks/x_completed.md`, `docs/llm/x_completed.md`, `docs/generated/...`,
  `resources/browser-extension/KNOWN_ISSUES_completed.md`, `src/x_completed.md` and anything under an existing `_archive/` are
  never candidates;
- spelling: `_completed`, `_Completed`, `.COMPLETED.md`, `_livetest_completed`, `-superseded`, `_superseded` are closed; `_plan.md`,
  `_spec.md`, `_spec_planned.md`, `_livetest.md`, `_report.md` are not;
- the dry run changes nothing: `git status --porcelain` and the tree hash are identical before and after, and the only file
  written is the one named in the output path;
- `--check` prints one line, exits 0, and parses "last batch" from the newest `## Batch` header;
- review list: old, unreferenced, non-state docs are listed; READMEs and `src/` docs are not; nothing in it is moved by `--apply`.

**Risks:**
- The tool reads about 20 MB of docs and six thousand code files once per run (a few seconds). No model calls, no network.

**Done when:**
- `npm run docs:retire` prints the summary in under 15 seconds, writes only `_scratch/retire-docs/<date>.md`, and
  `git status --short` is byte-identical before and after.
- With `--as-of 2026-10-11` its counts match the 11 Oct report within a few documents (356 movable, 119 pinned, 142 too
  recent, 4 untracked, at 30 days). Without the flag they move on with the calendar and the tree.

### 1c. Apply, the index, and hiding the archive from search (S)

**For James:** The same tool can do the move once you approve, and writes the index. Agents' searches skip the archive on
purpose, and the agent instructions say where it is.

**Change:**
1. In the same script: `--apply --groups 1,2,3` (or `--all`; refuse with neither). Recompute eligibility from scratch and never
   trust the dry-run file. Skip, and print the reason for, any doc whose status changed since.
2. **The safety rule is overlap-based, not "the index must be empty".** Other sessions will often have something staged.
   Refuse to start if (a) any candidate, `docs/_archive/INDEX.md` or `docs/generated/architecture-inventory.json` has a staged
   or unstaged change, or (b) a destination exists. If other unrelated paths are staged, print how many, proceed, and leave
   them staged and uncommitted (the printed commit command uses `--only`). Offer `--require-clean-index` for the cautious.
3. Move with `git mv` only. Destination: `docs/<rest>` → `docs/_archive/<rest>`; a top-level `<name>.md` →
   `docs/_archive/_root/<name>.md`. Same file name, same sub-path, no content edits (the spec asserts byte equality). No
   `git add -A`, stash or reset.
4. Append a batch section to `docs/_archive/INDEX.md` and stage it. First-creation header: what this folder is; "same file name
   and sub-path as before"; restore with `git mv docs/_archive/<path> docs/<path>`; history with
   `git log --follow -- docs/_archive/<path>`; search with `rg --no-ignore <word> docs/_archive`. This recipe lives here, not in `AGENTS.md`, so the always-loaded file stays small (change 7). Row format:
   `| docs/plans/2026-07-19-x_plan_completed.md | 2026-07-19 | <first heading, 80 characters> |` (about 120 bytes a row; roughly
   43 KB for the first batch).
5. **Do not commit.** Write the exact old and new paths to `_scratch/retire-docs/<date>-paths.txt` and print
   `git commit --only --pathspec-from-file=<that file> -m "docs: retire <N> closed docs"` (git 2.54.0 here; the option needs
   2.25 or newer). The hook regenerates and stages `docs/generated/architecture-inventory.json`; check that it is in the commit.
6. New top-level `.ignore` (tracked, 3 lines): a comment and `docs/_archive/`. It keeps ripgrep-based search, and editors that honour it, out of the archive
   by default. **Decided from the code (11 Oct):** the three Harness features named under "Verified" run `rg` without `--no-ignore`, so they stop seeing the
   archive too, and that is wanted. The Codemem fallback and the quick lookup feed model context, the very place retired plans were crowding out code (25 of 47
   slots), and Codemem's own index already skips `_archive/` (`code-index-ignores.ts:19`), so the fallback now matches the index. The local reviewers work on
   diffs and code; their `read` tool opens a path and does not use `.ignore`, and the index lists every move, so nothing there needs text search over retired
   docs. **No caller needs the archive, so no code changes.** If one is found later, the smallest fix is to add `--no-ignore-dot` to that one caller's `rg`
   arguments: ripgrep 15.1.0 has it, it turns off only `.ignore` and `.rgignore` files and keeps the `.gitignore` rules, whereas `--no-ignore` turns off both.
7. `AGENTS.md` "Scratch and Archive Directories" (`:137-142`): add two short lines (a third, from 1e, goes in "Plan and Spec Filename States"): (i) where
   retired docs go, that `docs/_archive/INDEX.md` lists them, and that default search skips the folder; (ii) "do not cite `docs/...` paths from code comments
   (a `_completed` rename or a retirement breaks them); name the plan by date and topic instead". The commands and the restore, history and search recipe live
   in the INDEX header, not here. `AGENTS.md` is 10,505 bytes and Copilot loads it twice (`CLAUDE.md` imports it), so each byte costs double there (Phase 4
   sized its own pointer for that: `phase4-tooltips_plan.md:2561`); Step 1 adds about 400 bytes in all.
8. Optional: `scripts/generate-architecture-inventory.js:154-160`: skip `/_archive/` paths in `readLargeFiles`, so the 69 moved
   entries drop out of the committed JSON (293 lines; add one case to `scripts/__tests__/generate-architecture-inventory.spec.ts`,
   170 lines: a doc under `docs/_archive/` with 800 or more lines is not listed).

**Tests:**
- `retire-docs.spec.ts` (apply cases): `git mv` makes rename entries (status `R`); blob ids of every moved file are unchanged;
  `INDEX.md` has the batch header and one row per doc; it refuses when a candidate or `INDEX.md` has a staged or unstaged
  change; with unrelated staged work elsewhere it proceeds, warns, and leaves that work staged and uncommitted (check blob ids
  in the index before and after); it refuses to overwrite an existing destination; a second run moves nothing; `--groups 1`
  moves only group 1; no commit is created (HEAD unchanged). `docs/plans/completed/README.md` moves only when all closed docs
  beside it move.
- `src/main/plan-queue/plan-queue-discovery.spec.ts` (98 lines): add fixtures `docs/_archive/plans/2026-01-01-retired_plan.md`,
  `..._livetest.md`, `..._spec.md`; assert none is discovered for `plans` or `livetests`. It passes on today's code; it guards
  the dependency (the existing fixture at `:31` covers `archive/`, not `_archive/`).
- `src/main/codemem/__tests__/default-code-index-ignores.spec.ts` (20 lines): add a case using the `ignore` package with
  `DEFAULT_CODE_INDEX_IGNORES`: `docs/_archive/plans/x_plan_completed.md` and `docs/_archive/INDEX.md` are ignored;
  `docs/plans/completed/x_completed.md` is not. It passes on today's code.

**Done when:**
- The set of paths the apply staged equals the printed old and new paths plus `INDEX.md`; any other session's staged files are
  unchanged; a second `npm run docs:retire` straight afterwards reports 0 movable docs at the same cutoff.
- `docs/_archive/INDEX.md` has one row per moved doc; `AGENTS.md` points at it; `.ignore` exists.
- `.ignore` works for agents: in the implementing session, a Grep search for a word that appears only in a moved doc finds
  nothing, and `rg --no-ignore <word> docs/_archive` finds it. This settles the "inferred" item; no live check is needed.
- The three Harness callers named under "Verified" were read and need no change (change 6); `--no-ignore-dot` is the recorded fallback if one is later found to need the archive.

### 1d. The first batch (XS of code; James decides)

**For James:** You read the list and answer by number: the cutoff, which groups to move, and yes or no for each old reference
doc on the review list. Then the first batch moves and is committed when you say so.

**Change:**
1. Run the dry run and present the Markdown as a review artifact (AGENTS.md:83-85, the `doc-review-artifact` skill) with the
   numbered groups, so James answers by number. James picks the cutoff (choice 1b), holds or approves groups, and answers yes
   or no on the review list.
2. Two commits, each only when James says so (AGENTS.md: never commit unless asked).
   - **Commit 1** is the tooling from 1a, 1b and 1c: the script, specs, `.ignore`, the AGENTS.md and README edits and
     `package.json`, made by the normal hook.
   - Then, after the dry run is approved, run `npm run docs:retire -- --apply --groups <approved>`. Check `git status`: the
     paths this tool staged are exactly the printed old and new paths plus `docs/_archive/INDEX.md`; the untracked docs and the
     modified docs are byte-identical to before. Run the gates in Final verification.
   - **Commit 2** is the batch, made with the printed `--only` command so unrelated staged work cannot ride along. Confirm
     the regenerated `docs/generated/architecture-inventory.json` is inside it (the checker did not run the hook under
     `--only`, so this is a live check). If another session still has that JSON staged, wait for it to commit first; the apply
     refuses until then. Do not push.
3. Record the landing date in the as-built notes, so cost comparisons across it (Phase 0 day-checks) are not misread. The effect
   on a message is at most 900 tokens.

**Done when:**
- After James approves and the batch is applied and committed: the repo holds about 433 markdown docs (was 789);
  `docs/superpowers/` about 103 (was 323); `docs/plans/` about 218 (was 338); the untracked and modified docs are unchanged;
  every moved file has the same blob id at its new path; `git log --follow` shows its old history.
- A fresh agent reaching the task cold can answer "what happened to plan X?" from AGENTS.md alone in two reads (AGENTS.md, then
  INDEX.md).

### 1e. Keep the count from growing back (XS)

**For James:** At the end of each job the agent says how many old documents are waiting, so you can approve the next batch
before the pile grows back.

**Change:**
1. `AGENTS.md` "Plan and Spec Filename States": one bullet. After renaming a plan or live test `_completed`, run
   `npm run check:docs-retire`; when it says "due", say so in the completion summary so James can approve a batch. It is not in
   the pre-commit hook (the hook is kept fast on purpose, and this check reads git history) and not a CI gate (docs clutter must
   not block a merge).
2. Nothing else is automatic. At about 33 docs a week, a monthly batch moves about 140. The standing pile after each batch is the
   last 30 days plus the pinned evidence (about 265 closed docs today, about 120 of them pinned).

**Done when:**
- The bullet exists and `npm run check:docs-retire` prints its one line.

### 1f. Optional: clear old working files from the disposable folders (S; off by default; held for James's yes, choice 2)

**For James:** A dry run that lists the old working files in the 32 GB scratch folder. Nothing is deleted unless you say yes.
Deleting here cannot be undone, because git does not hold these folders.

**Change:**
1. `npm run docs:retire -- --scratch` (dry run): list `_scratch/` top-level entries whose newest file (recursive) is more than 30
   days old, and `.aio-review/` files older than 14 days, with counts and sizes. Write the list to the OS temp folder, not inside
   `_scratch/`. The dry run also writes a unique repository-bound, digest-named manifest. Only
   `--scratch --apply --manifest '<exact path printed by that approved dry run>'` may delete that reviewed list; bare apply
   is refused. It never adds newly eligible entries and rechecks physical containment, unchanged generation, current
   protection and age, including fresh empty directories. Anything touched in the last 14 days is refused.
2. Today: `_scratch/` is 32 GiB, 146,591 files and 12,204 top-level entries (3,457 untouched at top level for 30 or more days,
   by directory time, so recompute with newest-file age); `.aio-review/` is 83 files, 6.7 MiB, 47 older than 30 days.
3. **Protect `_scratch/oct-phases/` and `_scratch/oct-audit/`.** They hold the research and the reports behind the October
   plans and this plan, and they must survive until those plans are written, landed and closed. The tool's skip list names them, and it also skips any other `_scratch/` entry whose path is named in a plan, spec or live test that is not yet `_completed`.

**Tests:**
- `retire-docs.spec.ts`: `--scratch` lists by newest-file age; refuses anything touched in the last 14 days; `--scratch --apply`
  deletes only the listed entries; the two protected folders are never listed.

**Done when:**
- The dry run lists entries with sizes and deletes nothing; `--apply` is run only after James's yes.

**Risks (the whole step):**
- *Pinned docs stay.* 119 closed docs (3 MB) are not moved. After batch one `docs/plans/` still holds about 218 files: 80 pinned
  closed docs, 79 closed docs 30 days old or younger, 31 open live tests, 13 active plans or specs and 15 others (including the
  4 uncommitted finished plans). `docs/superpowers/` holds about 103. That is the price of not editing the 1 MB register another
  session is changing. Pins held by an open live test release when it closes; pins held by the register never do.
- *Links into moved docs break* where the citing doc is itself retired or closed (cosmetic; listed in the index) or is a
  bare-name mention. Code comments that cite moved docs go stale; 57 percent of them already are. The new AGENTS.md rule stops
  adding more.
- *Other sessions' staged work.* The apply must not disturb it: overlap-based refusal, `git mv` only, `--only` commit. If the
  inventory JSON is staged by someone else when the batch is ready, the apply waits.
- *A wrong batch.* Mitigated by the dry run, numbered groups, re-checking at apply time and no auto-commit; one `git revert` or a
  per-file `git mv` undoes it. Nothing is deleted.
- *Other branches and worktrees* (39 local branches, 19 of them `queue/*`, and 13 worktrees) keep their own copies. A later merge
  conflicts only if one of them edited a closed doc, and closed docs are not edited. Low.
- *Hook and CI.* Committing with `--no-verify` leaves `architecture-inventory.json` stale and `verify:architecture` fails in CI.
  Use the normal hook.
- *Search behaviour changes (what James will notice).* The per-message code search returns fewer old-plan snippets, and some
  messages that used to get an old plan pasted into them get nothing. That is intended (it removes the biggest source of
  off-topic hits that backlog A20 describes; A20 itself is Phase 3 step 15 and is not done here). The same holds for Harness's fallback search, its quick "where is" lookup and the local reviewers' search tool (see "Verified"); anyone who needs a retired plan opens it by path or searches with `rg --no-ignore`.
- *`.ignore` also hides the archive from James's editor search* if his editor honours it; he can turn that off or use
  `rg --no-ignore`.
- *Concurrency.* A loop or plan-queue run active at apply time works on an active doc by definition, and only closed docs move.
  The one edge: a not-started queue item whose source doc was closed and then moved would be parked, not skipped
  (`plan-queue-readiness.ts:97-103`); not plausible at a 30-day age.

**Live checks** (only what needs a person or the running app; none needs a rebuild or the Windows PC):
1. James reads the review artifact of the dry run and answers by number (cutoff, groups, hold list, review-list docs). This is the
   approval gate.
2. After the commit, with the Harness app open on this repo for a few minutes (or after its periodic reconcile), re-run the same
   read-only counts on `codemem.sqlite` (workspace `ai-orchestrator`): rows under `docs/_archive/%` are 0; markdown rows under
   `docs/` fall from 708 toward the new doc count; markdown chunks fall from 1,112. Then re-run the 10-query probe: the closed-doc
   share should fall from 25 of 47 slots to about 0. This needs the running app because the index worker lives there.
3. Where the regenerated `docs/generated/architecture-inventory.json` lands when the batch commit uses `--only` (1d).
4. Optional (1f): James reads the disposable-folder dry run and says yes or no.

**Size and order:** M overall (1a XS, 1b S-M, 1c S, 1d XS plus James's time, 1e XS, 1f S optional). Order 1a → 1b → 1c → James
approves → 1d → 1e; 1f any time after 1b. No dependency on Phase 0. Soft ordering: land the first batch before Phase 3 step 15
(A20's measure-first step), so A20's before and after numbers are not mixed with this change. Shared files: `AGENTS.md` (Phase 4 steps 3 and 4 add a pointer and a checklist line; Housekeeping step 13 option 2 would also edit it, only if James picks it), `package.json` (Phase 0 step 7b adds
`audit:claude-cost`; a trivial merge) and `docs/generated/architecture-inventory.json` (regenerated at every commit).

## Step 2. Make room first (S-M, two parts)

Two shared files are nearly full, and several plans are about to add to them. The build refuses a file past its limit, so a
later plan would stall. This step moves existing code out, without changing behaviour, before those plans start. It should
land ahead of Phase 0's first new setting and ahead of the plans that edit `instance-lifecycle.ts`.

### 2a. FU-A11: Make room in the two settings files before the October plans add their switches (S-M; design pass first)

**For James:** Nothing you will see. Roughly a dozen switches are planned across the October work, and the two files that hold
the list of settings are nearly full. The build refuses a file that grows past its limit, so the first few plans would work
and a later one would stall. This makes room first.

**Origin:** Housekeeping "Found on the way" 9; A#202.

**Verified (11 Oct):**
- `src/shared/types/settings.types.ts` is 857 lines against a ceiling of 839 plus 50 (`scripts/check-ts-max-loc.ts:595`): room
  32. `src/main/core/config/settings-control-policy.ts` is 844 against 840 plus 50 (`:208`): room 46. Counted again by the plan
  writer on 11 Oct.
- The Housekeeping plan says "about 11 plans add settings there"; that was not re-counted. Each new setting needs lines in
  both files (five places in all: types, defaults, surfacing, metadata, control policy).
- Part 5i removes one setting (`residentClaudeSession`) from all five places, and part 6f hides one without deleting it. Count
  both in the design pass.

**Change:**
1. **Design pass first (about 30 minutes):** list the settings every October plan adds (search each plan for "five usual
   places") and total the lines. Do not invent the split before that.
2. Move one self-contained group of existing settings (for example the loop group, or the helper-model group) into new
   `settings-<group>.types.ts` and `settings-<group>-policy.ts` files, re-exported from the old ones so no import changes. A
   pure move, no behaviour change.
3. Do not raise a ceiling (every plan's rule).

**Tests:**
- `npm run check:ts-max-loc`, `npx tsc --noEmit` and the existing settings specs: all unchanged and green.

**Risks:**
- Merge conflicts with other sessions that edit the settings files.

**Done when:**
- Both files have at least the lines the design pass totals, with a margin.

**Live checks:**
- None.

**Size and order:** S-M. Do before Phase 0 step 9 (the first new setting) and before Phase 1 step 1c.

### 2b. FU-B8 (first half): Make room in `instance-lifecycle.ts` (S)

**For James:** Nothing you will see. The biggest file in the session code has 3 lines of room, and four plans need to add to
it. This moves the code that switches a session between Build, Plan and Review out first, with no change in behaviour, so the
later changes fit. The grey line that says what changed comes later (part 7d).

**Origin:** Phase 3 "Not in this plan" (session screen); B#2, first half.

**Verified (11 Oct):**
- `src/main/instance/instance-lifecycle.ts` is 3,638 lines with a ceiling of 3,591 (`scripts/check-ts-max-loc.ts:252`): room 3.
  It was clean in `git status`.
- `changeAgentMode` starts at `:2961` and runs to just before `setComputerUseMode` (about 203 lines). Its end builds the
  model-facing `[SYSTEM MODE CHANGE - IMPORTANT]` text (`:3125`) and does `await adapter.sendInput(modeChangeMessage)`
  (`:3134`). No display receipt is emitted there.
- `src/main/instance/lifecycle/` already holds 61 non-spec modules, so a move there follows the existing pattern.

**Change:**
1. Pure move, as its own change: move the `changeAgentMode` body to `src/main/instance/lifecycle/agent-mode-change.ts` as
   `changeAgentModeImpl(deps, instanceId, newAgentId)`, and leave a thin delegate with the same public signature. About 200
   lines are freed. No wording change in this part, and the model-facing text stays byte for byte, so prompts and caches do
   not change.
2. Other plans also touch this file (Phase 0 step 12 about 1 line, Phase 1 step 17a "land as its own small commit", Phase 5
   step 9 two lines). Do the pure move first and have them rebase onto it.

**Tests:**
- New `agent-mode-change.spec.ts`: the moved cases (state transitions, the error path) still pass, and the delegate keeps
  `changeAgentMode`'s signature.

**Risks:**
- Conflicts with the other plans' edits to the same file (change 2).

**Done when:**
- `instance-lifecycle.ts` is about 200 lines shorter and the existing specs for mode switching pass unchanged.

**Live checks:**
- None here. The receipt's live check is in 7d.

**Size and order:** S. Before Phase 0 step 12, Phase 1 step 17a and Phase 5 step 9. Part 7d builds on it.

## Step 3. Safety fixes: places that act when they should refuse or ask (seven parts)

Listed by risk, not by when each can start; the Order table says what each part waits for. Parts 3b and 3e wait for nothing.

### 3a. FU-A2: A held shell command answered with no decision is refused (XS)

**For James:** If anything ever answers a held shell command without saying Allow or Don't allow, Harness currently lets the
command run. After this it refuses and asks again. The normal buttons are unaffected.

**Origin:** Phase 0 "Found on the way" 12; A#38.

**Verified (11 Oct):**
- `src/main/ipc/handlers/instance-handlers.ts:1063` is `const action = validatedPayload.decisionAction;` and `:1091` is
  `const approved = action !== 'deny';`. The schema makes it optional
  (`packages/contracts/src/schemas/instance.schemas.ts:378`, `decisionAction: z.enum(['allow', 'deny', 'modify']).optional()`),
  so an answer with no action approves. Re-read by the plan writer.
- The thin-client path has the same defect: `src/main/event-bus/thin-client-command-executor.ts:225` reads the action and `:238`
  passes `action !== 'deny'`.
- The phone route already insists on an action (`mobile-gateway-instance-routes.ts:426`). The desktop card always sends one;
  Phase 0 step 4 keeps it that way and says "Do not send an empty decision here, because a held call with no `decisionAction`
  is approved".

**Change:**
1. `instance-handlers.ts:1091`: `const approved = action === 'allow' || action === 'modify';` (same line count; the file has 1,296 lines, ceiling 1,251 plus 50, room 5, of which Phase 0 step 3 uses about 3, so 2 remain).
2. `thin-client-command-executor.ts:238`: pass `action === 'allow' || action === 'modify'` (659 lines, cap 700).
3. In both, when `action` is undefined, log a warning and answer the held call as refused, not as an error, so the waiting tool is not left waiting. In
   `instance-handlers.ts` the warning must be one line (`if (!action) logger.warn('Held command answered without a decision; refused');`) or live in
   `instance-handlers-utils.ts` (it exists), because only 2 lines of room remain after Phase 0 step 3.

**Tests:**
- `src/main/ipc/handlers/__tests__/instance-handlers.spec.ts`: a `deferred_permission` response with no `decisionAction` calls
  `resumeAfterDeferredPermission(..., false)` (fails today: it passes true).
- The thin-client executor spec: the same. Existing allow, deny and modify cases are unchanged.

**Risks:**
- Any sender that relied on the old default (an answer with no action meaning "yes") now refuses. Senders found: the desktop
  card (always sends), the phone route (requires it), the thin client (check its sender when starting).

**Done when:**
- No path in `src/main` approves a held call without an explicit `allow` or `modify`.

**Live checks:**
- None.

**Size and order:** XS. After Phase 0 step 4 (same handler lines). Shares files with Phase 0 steps 3 and 4. Part of choice 3.

### 3b. FU-B1: Agents may read only the sessions they started on a remote computer (XS-S)

**For James:** An agent that has Harness's remote-computer tools can today read the output of any session on your Mac if it
knows that session's number. After this it can read only sessions it started itself on a remote computer, the same rule that
already applies to closing them.

**Origin:** Phase 5 "Found on the way" 17; B#145. The backlog's A11 sits next to it.

**Verified (11 Oct):**
- `src/main/app/orchestrator-tools-step.ts:553-578` `readInstanceOutput` does `let instance = instanceManager.getInstance(args.instanceId);
  if (!instance) { return null; }` and returns the visible messages of `instance.outputBuffer`. Nothing checks who started the
  instance. Re-read by the plan writer.
- The RPC dispatch only checks that the caller is a known local session (`src/main/mcp/orchestrator-tools-rpc-server.ts:348`) and
  calls `tool.handler(validated)` (`:414-423`); the caller id is not handed to `readInstanceOutput`. The tool is one of the six
  always-listed ones (`src/main/mcp/orchestrator-mcp-deferral.ts:19`).
- The precedent is in the same file: `const isRemoteSpawn = (instance) => typeof instance.metadata?.['spawnDepth'] === 'number'`
  and "Refusing to terminate ... only run_on_node-spawned instances can be terminated via MCP" (`:482-496`). `run_on_node` sets
  `spawnDepth` and `spawnParentInstanceId` (`:452-459`).
- Phase 5 step 1 builds `read_session` behind the Cross-session messaging switch and says it does not change this tool, so
  today that switch has a back door.
- Not verified: how an agent would learn another session's id (a listing tool). The fix does not depend on it.

**Change:**
1. In `readInstanceOutput`, after the first `getInstance` and inside the poll loop, return `null` when
   `typeof instance.metadata?.['spawnDepth'] !== 'number'`. Hoist the existing `isRemoteSpawn` arrow to one constant above both
   tools (net +3 lines; `orchestrator-tools-step.ts` is 691 of 700 with no allowlist entry, room 9).
2. The tool already turns `null` into `Error('Instance not found: <id>')` (`src/main/mcp/orchestrator-tools.ts:709-711`), which
   hints nothing about whether the id exists.
3. Reword the tool description (`orchestrator-tools.ts:668`) to "an instance previously started with run_on_node" plus "other
   sessions are not readable here" (773 of 800 allowlisted plus 50, room 77).
4. A stricter option, not the default: also require `spawnParentInstanceId === caller`. It needs the caller id plumbed into the
   handler; skip it unless James wants it.

**Tests:**
- `orchestrator-tools-step` spec (or the tool spec): "read_node_output returns not found for a session without spawnDepth"
  (fails today); "still returns the buffer for a run_on_node-spawned session"; "the polling loop refuses too".

**Risks:**
- An agent that used this tool on a non-remote session loses that. The description never promised it. No settings change.

**Done when:**
- Reading a session you started yourself, by its id, answers "Instance not found"; reading a run_on_node session works as before.

**Live checks:**
- None.

**Size and order:** XS-S. No dependency. Shares `orchestrator-tools.ts` with Phase 5 step 1 (its `read_session` tool): land this first
or in the same pass. Part of choice 3.

### 3c. FU-A3: The start-up tidy-up never force-removes a closed loop's work folder that has unsaved changes (S)

**For James:** When you press the new "Close" button on an old stranded loop run, the next time Harness starts it tidies that
run's work folder away without asking. If the folder still held changes that were never saved to the branch, they would be
lost. After this the tidy-up checks first, and leaves a folder with unsaved changes alone and tells you.

**Origin:** Housekeeping "Found on the way" 10 (from Phase 0 step 2.6a); A#203.

**Verified (11 Oct):**
- `src/main/orchestration/loop-worktree-lifecycle-reconcile.ts:230-243`: for a run whose status is not a success (or without
  auto-integrate) it sets `preserved`, then calls `removeOrphanWorktree(...)` with no dirty check and no prompt, then
  `clearWorktreeInfo` and `cleaned`. `:230` is `if (!isSuccessfulStatus(row.status) || !row.autoIntegrateWorktree)` (re-read).
- `src/main/orchestration/loop-worktree-reconcile.ts:79-111`: `removeOrphanWorktree` runs `git worktree remove --force` three
  times, then falls back to `rm(worktreePath, { recursive: true, force: true })`. It never removes the branch.
- The Housekeeping plan records that Phase 0's Close gives the parked `provider-limit` run an `ended_at`, so the next start
  reconciles it. For that one folder the branch is merged and the folder is clean (the Housekeeping plan checked; not
  re-checked here), so nothing is lost today.
- A normal terminate harvests (commits) first (`loop-worktree-lifecycle.ts:121-124` blocks on uncommitted work); the start-up
  path has no such step.

**Change:**
1. In `loop-worktree-lifecycle-reconcile.ts`, before `removeOrphanWorktree`, call a new `isWorktreeClean(path)` (`git status
   --porcelain`, new module `loop-worktree-clean-check.ts`; any error counts as dirty). If dirty: `transition('blocked', {
   lastError: 'Work folder has unsaved changes; left in place' })` and `continue`, as the existing blocked rows do (`:216-228`).
2. Surface the blocked row on Housekeeping step 6's "Leftover work folders" card (it already lists these folders with a
   preview and ask-first removal). No new screen.
3. Do not change `removeOrphanWorktree` for its other callers.

**Tests:**
- `loop-worktree-lifecycle-reconcile.spec.ts`: a closed run with a dirty folder is blocked and the folder still exists (fails
  today); a clean folder is removed as before; a git error counts as dirty.

**Risks:**
- A few more rows stay `blocked` until you decide. That is the point. 431 lines in the reconcile file (cap 700). No settings.
- If James uses Close on a run whose folder may hold unsaved work before this lands, that folder is removed at the next
  start without asking. Land this before he does, or have him wait.

**Done when:**
- With a dirty scratch folder owned by a closed run, a restart leaves the folder and branch in place and logs the reason.

**Live checks:**
- With James present, on a scratch repo only: close a stranded run whose folder has an untracked file, restart, and confirm the
  file survives.

**Size and order:** S. After Phase 0 step 2.6a (the Close button) in build order, ideally with Housekeeping step 6; see Risks for
the safety order. Shares `loop-worktree-lifecycle-reconcile.ts` with 3g and Phase 2 step 8b. Part of choice 3.

### 3d. FU-A5: Automatic closes skip a chat that is hosting a running loop (S)

**For James:** Harness sometimes closes a quiet chat on its own (idle clean-up, or when memory is tight). If a loop is running
inside that chat, the loop is left stranded. After this, those automatic closes pass over any chat that has an active loop.

**Origin:** Phase 0 "Found on the way" 11; A#37.

**Verified (11 Oct):**
- `src/main/instance/lifecycle/idle-monitor.ts:347` `void this.deps.terminateInstance(instance.id, true)` (idle) and `:396` (memory
  pressure); `src/main/process/resource-governor.ts:396` `await instanceManager.terminateInstance(inst.id, true)` (or
  `hibernateInstance`). None checks for a loop.
- The active-loop test exists but is wired in one place only: `src/main/app/initialization-steps.ts:105-107`,
  `getActiveLoops().some((loop) => loop.chatId === instanceId && isActiveLoopRuntimeState(loop))`, for the "Announce-then-halt
  continuation".
- Phase 0 choice 4 keeps automatic closes from cancelling loops on purpose, so this part is about skipping, not stopping.

**Change:**
1. Move that predicate into a small shared module `src/main/orchestration/session-hosts-active-loop.ts`
   (`sessionHostsActiveLoop(instanceId)`), called from `initialization-steps.ts`, `idle-monitor.ts` and `resource-governor.ts`.
   Inject it through the existing deps, not an import cycle (`idle-monitor.ts` is 480 lines, `resource-governor.ts` 424, cap 700).
2. In the idle and governor candidate selection, drop sessions where it returns true. Log one debug line per skip.

**Tests:**
- `idle-monitor.spec.ts` and `resource-governor.spec.ts`: an idle session hosting an active loop is not terminated or hibernated
  (fail today); others are.

**Risks:**
- A loop that is itself stuck keeps its chat alive, and the memory governor may find fewer candidates. The governor still
  reports memory pressure; only the skip is added.

**Done when:**
- Neither automatic path closes a session whose loop is running; the debug line shows the skip.

**Live checks:**
- None (unit level is enough).

**Size and order:** S. After Phase 0 step 3 (the loop-stop helper). No settings. Part of choice 3.

### 3e. FU-A6: Stop and Cancel on the phone ask first (XS-S)

**For James:** On the phone app, tapping Stop on a loop, or Cancel on a Plan Queue run, takes effect at once with no "are you
sure?". Cancel ends a whole queue run, and skipped items are final. After this both ask first.

**Origin:** Phase 2 "Found on the way" 21 and "Not in this plan" (B8/B9); A#148 and A#175.

**Verified (11 Oct):**
- `apps/mobile/src/app/features/loops/loop-detail.component.ts:25` is `<button type="button" class="danger" ...
  (click)="control('stop')">Stop</button>`; `apps/mobile/src/app/features/plan-queue/plan-queue.component.ts:29` is
  `(click)="queue.control(run.id, 'cancel')"`. Neither file mentions a confirm step, and the phone app uses no confirm or alert
  helper anywhere (searched `apps/mobile/src/app`).
- The desktop side is covered: Phase 2 step 15 makes Stop ask first on desktop; Phase 2 says "no phase owns the phone app";
  Phase 3 step 17 changes phone words only.

**Change:**
1. Add a small inline "Are you sure? Stop this loop / Cancel this whole run" two-button row in both components (a `confirming`
   signal), matching Phase 2 step 15's inline-row pattern, not a pop-up. Both files are tiny (61 and 64 lines).
2. Wording: "Stop this loop? Its work so far is kept." and "Cancel the whole run? Items not started are skipped for good."
   Buttons "Stop it" / "Keep going" and "Cancel the run" / "Keep going".

**Tests:**
- Phone component specs: the first tap shows the row and sends nothing; confirming sends once; "Keep going" clears it (all fail
  today). Run the phone app's own `typecheck`, `lint` and `test:quiet`.

**Risks:**
- A phone rebuild and reinstall is needed to see it. No desktop change.

**Done when:**
- Neither button sends a command on the first tap.

**Live checks:**
- On the rebuilt phone app (James's call).

**Size and order:** XS-S. Independent. Same app files as Phase 3 step 17 (words): land after it or merge the edits. Part of choice 3.

### 3f. FU-C7: A campaign step whose merge was held pauses its campaign (S; a decision for James, recommended: pause)

**For James:** A campaign runs steps in order. If you chose "carry on" for steps that end with skipped checks, then after Phase 2's
change the held step's work stays on its own branch, yet the next steps start without it. After this, a step whose work was
held always pauses the campaign and says why, even on "carry on". The default setting already pauses, so only a campaign you
set to "carry on" is affected.

**Origin:** Phase 2 "Found on the way" 25; A#179.

**Verified (11 Oct):**
- **Where the policy is applied:** `src/main/orchestration/campaign-coordinator.ts:553-560`: for `completed-needs-review`,
  `pause-campaign` pauses, `halt` halts, and `'continue' // fall through to advance`; then `await this.advanceCampaign(campaignId)`
  at `:573`.
- **A held step is not a landing block:** `campaignLandingBlockReason` returns a reason only when `lifecycle.phase === 'blocked'`
  (`campaign-worktree-landing.ts:335`). Phase 2 step 8b sends a held run down the existing `preserved` path and records
  `endEvidence.mergeHold = true`, so the lifecycle is not `blocked` and the campaign sees nothing. Step 8b is not built, so
  the exposure starts when it lands (inferred from the plan text; the hold function does not exist yet).
- **Who is exposed:** the campaign page defaults to `pause-campaign` (`campaign-page.component.ts:129`) and plan import sets
  `pause-campaign` (`campaign-plan-import.ts:170`). The schema has no default (`campaign.schemas.ts:50`), so only a campaign
  created with "continue" in the dropdown (`campaign-page.component.html:70`) carries on.
- Both entry points call the same function with the loop's status: the live subscription (`campaign-coordinator.ts:157`) and the
  restart path (`:206`); the loop snapshot there is the place to read `endEvidence.mergeHold`.
- `campaign-coordinator.ts` is 690 lines and not on the ratchet list (cap 700, room 10); `campaign-worktree-landing.ts` is 339.

**Change:**
1. `campaign-worktree-landing.ts`: add `campaignHeldBlockReason(nodeId, branch?)` returning "Step {label} finished with skipped checks and its work was not merged (it is kept on branch {branch}). Later steps would start without it. Land or discard that work, then resume the campaign." (`{label}` is the step's label, `CampaignNode.label` at `src/shared/types/campaign.types.ts:49`, or its position in the campaign when it has none.)
2. `campaign-coordinator.ts`: give `onLoopTerminal` a fourth parameter `mergeHold = false`; both callers pass
   `snapshot.endEvidence?.mergeHold === true`. After the existing `halt` check and before the `continue` fall-through add
   `if (mergeHold && nodeStatus === 'completed-needs-review') { this.pauseCampaign(campaign, campaignHeldBlockReason(nodeId,
   landing?.sessionBranch)); return; }` (about +6 lines; if that passes 700, move the whole needs-review policy block into a new
   `campaign-node-terminal-policy.ts`).
3. Campaign page: the "carry on" option gets a sentence: "A step whose checks were skipped still pauses the campaign."
   (`campaign-page.component.html:70` area; 288 lines).
4. Resuming uses the existing campaign resume; nothing else changes.
5. If James says yes to 3g, stalled and final-audit-blocked loops set the same flag, so this rule covers them too.

**Tests:**
- `src/main/orchestration/__tests__/campaign-coordinator.spec.ts`: a node ends `completed-needs-review` with `mergeHold` and policy `continue` → the campaign is
  `paused` with the held reason and no `advanceCampaign` (stubbed snapshot; fails until Phase 2 step 8b adds the field); without
  `mergeHold` it advances as today; policy `halt` → halted; the restart path (`:206`) behaves the same.
- `campaign-worktree-landing.spec.ts`: the new reason text includes the node id and branch.

**Risks:**
- None for default campaigns. For "carry on" campaigns, held steps now stop the run; that is the point.
- Depends on Phase 2 step 8b naming the flag the same way; if 8b names it differently, only the one read in change 2 moves.

**Done when:**
- A scripted campaign with "carry on" and a held middle step pauses at that step and does not start the next.

**Live checks:**
- None beyond the spec; optionally one scratch campaign after Phase 2 lands.

**Size and order:** S. After Phase 2 step 8b. Files: `campaign-coordinator.ts` (690, room 10), `campaign-worktree-landing.ts` (339),
`campaign-page.component.html`. Choice 5.

### 3g. FU-A1: Loops that stall, or whose last check needs a person, stop merging their work (S; only if James says yes to Phase 0 choice 14 and to choice 4 here)

**For James:** Today a loop that gives up because it stopped making progress, or that ends because its final check wants a
person, still has its work merged into your main branch as if it had succeeded. After this, those loops keep their work on
their own branch and say "Nothing was merged because the loop stalled" (or "...the final check needs your sign-off"). You merge
it yourself when you have looked. Only built if you say yes (choice 4).

**Origin:** Phase 0 choice 14 and "Found on the way" 10; Phase 0 "Not in this plan" (B4); A#19 and A#36.

**Verified (11 Oct):**
- The merge decision counts a needs-review end as success: `src/main/orchestration/loop-worktree-lifecycle.ts:128`
  `const isSuccess = status === 'completed' || status === 'completed-needs-review';`, and the start-up twin
  `loop-worktree-lifecycle-reconcile.ts:53-54` `isSuccessfulStatus` returns the same test (used at `:230`). Both re-read.
- Five call sites reach that status without a person's sign-off: `loop-coordinator.ts:3224` and `:3294` (stalled; the Phase 0
  plan cites 3223 and 3293, one line early: `this.terminate(state, 'completed-needs-review', reason)`), `:3066` and `:3132`
  ("Final audit requires operator review..."), and `loop-final-audit-blocked-completion.ts:116`
  (`params.terminate(state, 'completed-needs-review', reason)` with `acceptedByOperator: false`).
- Phase 2 step 8b already designs the hook: `holdsMergeForReview(status, endEvidence)` in `loop-worktree-lifecycle.ts`, true only
  when `endEvidence.mergeHold === true`, used in both places above (Phase 2 plan lines 2040-2056: "If James says yes there, route
  it through this one function"). Not yet built.
- The Phase 0 counts (12 of 22 stored rows are such stops; no past merge found) were not re-run.

**Change:**
1. Wait for Phase 2 step 8b (the `mergeHold` flag and `holdsMergeForReview`). New module
   `src/main/orchestration/loop-merge-hold.ts`: `stageMergeHold(state, kind: 'stalled' | 'final-audit-blocked')` sets
   `state.endEvidence = { ...state.endEvidence, mergeHold: true, mergeHoldKind: kind }`.
2. Call it where each ending is decided, so the flag is set before `terminate` runs. The two stalled endings call `terminate` directly (`loop-coordinator.ts:3224`
   and `:3294`): add the call on the line before. The two final-audit endings build their status as an object literal first (`pingPongTerminal` at `:3066`,
   `reviewDrivenTerminal` at `:3132`) and call `terminate` later (`:3083` and `:3149`), where the status can be many other things, so set the flag inside the
   `if` that builds the literal (`:3060-3068` and `:3128-3136`), not at `terminate`. Do the same in `loop-final-audit-blocked-completion.ts`.
   `loop-coordinator.ts` is 3,993 lines against a ceiling of 3,954 plus 50, so 11 lines of room, shared with Phase 0 steps 1 and 11 and Phase 2 steps 8 and 13:
   one call line per ending (about 4); recheck the room when starting, and put the logic in the new module.
3. End card sentence (Phase 2 step 15's `mergeHeld` branch): add the two variants above. Harness wording only.
4. An Accept by the operator still merges (the flag is not set when `acceptedByOperator` is true).
5. If Phase 2 step 8b is not built, the fallback is to replace both `isSuccess` tests with a shared
   `isMergeableEnd(status, state)` that refuses these two kinds.

**Tests:**
- `loop-worktree-lifecycle.spec.ts`: a stalled `completed-needs-review` run with `mergeHoldKind: 'stalled'` keeps its branch and
  never calls integrate (fails on today's code); a sign-off Accept still integrates.
- `loop-worktree-lifecycle-reconcile.spec.ts`: restart recovery of the same row also keeps the branch.
- `loop-coordinator` specs: each of the four endings stages the flag.

**Risks:**
- It changes what Harness merges for you: loops that stall no longer merge. Loops have been unused since 24 Sep, so few runs
  are affected. Gated, automation and lifecycle loops are untouched.
- The flag must survive a restart: it rides in `end_evidence_json` (Phase 2 step 8b item 8).

**Done when:**
- A forced stall and a forced final-audit-blocked end each leave the branch in place with the card sentence, and nothing reaches
  `integration/*`.

**Live checks:**
- None beyond one scratch loop forced to stall; loops are rarely run, so batch it with Phase 2's live checks.

**Size and order:** S. After Phase 0 step 1, Phase 2 step 8b and James's yes (choice 4). Shares `loop-coordinator.ts` and
`loop-worktree-lifecycle.ts` with Phase 2 step 8b.

## Step 4. Loops and the plan queue (three parts)

### 4a. FU-A7: A paused loop no longer leaves its automation open, and every reasoned pause raises a desktop notice (S-M)

**For James:** If a loop started by a scheduled automation pauses (no progress, a blocked file, or you pause it), the
automation's run stays "running" for ever and every later run of that automation is skipped. And a loop paused overnight tells
nobody. After this, the automation run ends with a clear note, and you get one desktop notice saying which loop paused and why.

**Origin:** Phase 2 "Found on the way" 2 and 20, and "Not in this plan" (hand-off 5); A#117, A#156 (automation half) and A#174.

**Verified (11 Oct):**
- `src/main/automations/automation-loop-run.ts:218` is `if (!tracked || !TERMINAL_STATUSES.has(payload.state.status)) { return; }`,
  so a `paused` loop leaves the run tracked and `running`. Phase 2 step 8d fixes only the sign-off pause
  (`lastCompletionOutcome === 'unverifiable'`).
- `automation-store.ts:691` `failRunningRuns` skips loop-linked rows (`WHERE status = 'running' AND loop_run_id IS NULL`), and the
  'skip' policy at `:314-322` skips a new fire while a run is `running`.
- Seven non-test emit sites for `loop:paused-no-progress`: `loop-coordinator.ts:1816, 1905, 3712`,
  `loop-blocked-file-handler.ts:91`, `loop-nonconvergence.ts:262, 414` and `loop-terminal-intent-actions.ts:144`. Listeners are only in
  `loop-handlers.ts:239` and `loop-stream.ts:133`. The only desktop notifier, `notifyLoopTerminal`, runs on ends
  (`loop-coordinator.ts:3893` per Phase 2; not re-read).

**Change:**
1. Extend Phase 2 step 8d's rule: in `automation-loop-run.ts` (271 lines) treat `paused`, for any reason, as "end this run as
   `needs-attention`" with the pause reason, keeping the loop paused so Resume still works.
2. New `notifyLoopPaused(state, reason)` beside `notifyLoopTerminal`. Avoid editing seven call sites in `loop-coordinator.ts` (11
   lines of room): wrap the emit in the coordinator's existing `emit` override and call the notifier from there.
3. One notice per pause, quiet, naming the loop and the reason; skip it when the window is focused on that loop. Follow Phase 3
   step 7d's notice pattern (`attention-notices.ts`).
4. A campaign step whose loop pauses also stays "running" (Phase 2 "Found on the way" 2). Whether it should be treated the same way
   is not decided here; part 3f covers held steps only.

**Tests:**
- `automation-loop-run.spec.ts`: a loop that pauses for no progress ends the automation run, and the next fire is not skipped
  (fails today).
- Coordinator spec: each pause site produces exactly one `notifyLoopPaused`.

**Risks:**
- Resume after an automation run has ended: confirm the loop's later terminal state is ignored cleanly (`trackedByLoopRunId` is
  deleted at the pause).
- Notification noise if a loop pauses repeatedly: throttle to one per loop per hour.

**Done when:**
- A scratch automation loop that pauses frees its automation, and a desktop notice appears once.

**Live checks:**
- Rebuilt app, a scratch automation with a forced blocked file; the desktop notice appears.

**Size and order:** S-M. After Phase 2 steps 8d and 17 (step 17 adds one notice for its own pause: reuse its helper).
`loop-coordinator.ts` is shared with 3g and 4b. Part of choice 6.

### 4b. FU-A8: Loops given a plan file check that the plan was marked complete (S)

**For James:** A loop given a plan file is meant to finish only when the plan file has been renamed to show it is done. That check
is applied to only one kind of loop. The other kind (review-driven, the usual one for ordinary loops) can declare itself finished
without it. After this both check.

**Origin:** Phase 2 "Found on the way" 7 and "Not in this plan" (B2/B3); A#134 and A#161.

**Verified (11 Oct):**
- `src/main/orchestration/loop-coordinator-state-helpers.ts:46-47` sets `requireCompletedFileRename = true` when a plan file is
  given. The only gate that reads it is `loop-completion-detector.ts:804` (`if (!config.completion.requireCompletedFileRename)
  return true;`; 844 lines, ceiling 806 plus 50, room 12). Every non-spec reference was searched:
  `loop-coordinator-completion-gates.ts` (the review-driven gate, 673 lines) never mentions it. Phase 2 states the same; the
  review-driven helper chain was not traced call by call (consistent with Phase 2, not fully traced).

**Change:**
1. A short design pass first: decide whether the review-driven gate should refuse completion, or end as `completed-needs-review` with
   the sentence "The plan file was not marked complete". Recommended: the second, using Phase 2 step 8's finish-phase ending so a
   loop does not spin.
2. Put the check in a new `loop-plan-rename-check.ts`, called from `evaluateReviewDrivenCompletion` (`loop-coordinator.ts:3543`)
   with one line (the coordinator has 11 lines of room).

**Tests:**
- `loop-coordinator-completion-gates.spec.ts`: a review-driven loop with a plan file that is not renamed does not complete cleanly
  (fails today).

**Risks:**
- Loops that used to finish "clean" now end with a note. Decision 6 (ordinary loops may finish with skipped checks) must still hold,
  so this must be a needs-review end, not a pause.

**Done when:**
- A review-driven loop with a plan file and no rename never ends as `completed`.

**Live checks:**
- None.

**Size and order:** S. After Phase 2 step 8 (the finish phase). Shares `loop-coordinator.ts`. Part of choice 6.

### 4c. FU-C6: The plan queue's checker sends back only the serious findings; the rest go to you (S; a choice for James)

**For James:** When the plan queue's independent checker fails a piece of work, the worker gets every complaint back, from "this
breaks a requirement" down to "consider renaming this", and is told to fix all of them. After this, only the serious ones
(critical and high) go back to the worker. The smaller suggestions are kept and shown to you on that item, and they never hold
the work up. Fewer rounds, less cost, less drift; the price is that a medium-rated real problem no longer forces a fix unless
the checker rates it high.

**Origin:** Phase 2 "Not in this plan" (hand-off 2); A#114.

**Verified (11 Oct):**
- **All findings go back, whatever the severity.** `src/main/plan-queue/plan-queue-item-flow.ts:459-462` in `finishVerification`
  (`:412`): `await this.toFixing(this.host.save({ ...item, round, verdict }), buildFixPrompt(round, run.config.maxRounds,
  verdict.findings));`. `buildFixPrompt` (`plan-queue-prompts.ts:107-120`) numbers every finding as `[severity, confidence] summary
  (file) Evidence:` and ends "Task: fix every finding in your worktree". The round-limit park text uses the first five findings of
  any severity (`plan-queue-item-flow.ts:455`).
- **On a PASS the findings go nowhere:** `:448-451` moves the item to `landing` with `{ round, verdict }`; the verdict is stored but no
  code or screen reads the findings of a passing verdict (the only reader of `verdict` in the plan-queue screens is
  `plan-queue-item-list.component.html`, 37 lines). The other plan-queue screens were not opened.
- **The vocabulary:** severities are `critical | high | medium | low` (`packages/contracts/src/schemas/plan-queue.schemas.ts:47`);
  the verifier is told to give each finding a severity and a confidence, and to use PASS "only when every criterion holds and every
  gate exited 0" (`plan-queue-prompts.ts:199`). So a FAIL can rest on a gate or an unmet criterion that the verifier rated only
  medium; the new rule must not turn that into a pass.
- **The rule to copy:** Phase 2 step 14 for ping-pong reviews ("Only blocking findings reach the builder"; the verdict comes from
  blocking findings; optional suggestions go to James); loop reviewers carry `blockingSeverities` (`agentic-pingpong-reviewer.ts:119`).

**Change:**
1. New `src/main/plan-queue/plan-queue-finding-triage.ts` (about 45 lines): `PLAN_QUEUE_BLOCKING_SEVERITIES = ['critical', 'high']`
   and `splitFindings(findings)` returning `{ blocking, optional }`.
2. `plan-queue-item-flow.ts` (609 lines; room 91 now, about 36 to 61 after Phase 2's steps 4c and 4e), FAIL branch: send `blocking` to the worker; if `blocking` is empty (a FAIL for a gate
   or criterion rated lower), send all findings exactly as today and `logger.warn('Verifier failed without a critical or high
   finding')`. The round-limit park text lists blocking findings first. Nothing is added to the stored item: the saved verdict
   already holds all findings, and the screen derives the optional ones with the same function.
3. `buildFixPrompt(round, maxRounds, findings, optionalCount = 0)` in `plan-queue-prompts.ts` (273 lines): the data block lists only
   what it is given; add one sentence after the task when `optionalCount > 0`: "The verifier also left {n} lower-severity
   suggestions. They have gone to James. Work only on the findings above; touch a suggestion only when a fix above needs the same change." The existing text keeps
   "findings follow as data".
4. Verifier prompt (`plan-queue-prompts.ts:199`): add the definition that makes the split reliable, in positive wording: "Rate a
   finding critical or high when it breaks an acceptance criterion, fails a gate or shows behaviour the task did not ask for. Rate it medium or low when
   the work meets every criterion without the change." Follow `docs/prompt-engineering-house-style.md`.
5. Screen: in `plan-queue-item-list.component.html`, under an item whose latest verdict has optional findings, show a muted line "The
   checker left N optional suggestions" that opens the list in the existing detail area (`appTooltip` for any hover text; no
   `title=`). Phone and thin client: not in this part.
6. No setting: a constant. (If James wants to choose, the run's config already carries `maxRounds`; a `blockingSeverities` field there
   is the natural home, at the price of a contracts schema change.)

**Tests:**
- `plan-queue-prompts.spec.ts` (126 lines): `buildFixPrompt` with one high and two low findings lists only the high one and mentions 2
  suggestions (fails today: it lists all three).
- `plan-queue-coordinator.spec.ts`: a verifier FAIL with one high and two low findings starts the worker turn with one finding; a
  FAIL with only low findings still sends all three and logs the warning; a PASS with low findings lands and keeps them on the item;
  the round-limit park text names the blocking finding first.
- New `plan-queue-finding-triage.spec.ts`.

**Risks:**
- A real medium problem the checker rated medium is no longer forced back. The prompt sentence in change 4 and the fall-back for an
  all-low FAIL are the guards.
- Fewer worker rounds per item (lower cost). The panel shows a new line; the stored data is unchanged, so old items need no migration.

**Done when:**
- A scripted FAIL with mixed findings sends only critical and high to the worker; the item shows the optional count; the all-low FAIL
  still goes back whole.

**Live checks:**
- Any machine, the plan queue on a scratch repo: run a tiny plan whose verifier is given a seeded mix of findings, and read the worker's
  fix prompt in the item log.

**Size and order:** S. No Phase 0 dependency; best after Phase 2 step 14 (reuse its wording). Files: `plan-queue-item-flow.ts`,
`plan-queue-prompts.ts`, `plan-queue-item-list.component.html`; no uncommitted work in them on 11 Oct, but Phase 2 steps 4c and 4e also edit the first two (30 to 55 lines in `plan-queue-item-flow.ts`, leaving 36 to 61 of its 91; this part needs about 12), so land after them or re-measure first. Choice 6(c).

## Step 5. Disk and clutter (nine parts)

Parts 5a, 5b, 5c, 5d and 5g add a row to the "Disk space used by Harness" card that Housekeeping step 4 builds. Each adds one
target name to the target list in `packages/contracts/src/schemas/storage.schemas.ts`, one preview-and-run pair in
`storage-cleanup-service.ts`, and one usage row in `storage-usage-service.ts`, all through the single-use preview id of
`cleanup-ticket.ts`. None adds an IPC channel. The code halves that do not need the card can be built first, and each part
says which. If `storage-cleanup-service.ts` passes about 500 lines, give each target its own small module. The card work waits for
Housekeeping step 4a (services) and 4b (the card). Every window states in visible text what it removes, and Cancel is the default. Parts 5a, 5b and 5c wait for James's answer to choice 7 before any of their code is built; 5h waits for choice 11 and items 1 to 3 of 5i for choice 10.

### 5a. Codex's safety copies: new ones named apart and kept to 3; the old ones offered on the disk space card (S)

**For James:** Each time Harness starts and finds that Codex's private session list needs a fix, it first saves a full copy of that
list (10 to 141 MB each). It has done this 425 times since 11 July and never deletes one, so they now take 39 GB; the whole Codex
folder is 57 GB. After this, new copies get a new name and Harness keeps only the newest 3 of those itself, so the pile stops growing
from the first start. It never touches the 425 existing copies or the 6 smaller copies from other clean-ups; the disk space card
offers those after a preview and your yes (about 38 GB; the newest 3 old copies stay). The card also shows the size of the Codex
session files (18 GB) but never offers to delete them, because resuming a Codex chat needs them. Not built until you answer choice 7(a).

**Origin:** the wave-2 check's "Found on the way" (the Codex folder is not on Housekeeping's card at all), plus a re-check on 11 Oct by the
session that asked for this plan. No inventory row.

**Verified (11 Oct)** (sizes in binary GB, as `du` shows them; the plan writer re-measured read-only):
- **Where:** `~/.ai-orchestrator/codex` is `getAioCodexStateDir()` (`src/main/cli/adapters/codex/codex-home-manager.ts:38-41`, built from
  `HOME`, so it is outside the Harness data folder, and the module also runs in worker processes). `du -sk`: the folder 57 GB
  (60,257,196 KiB), `backups` 39 GB (40,818,400 KiB), `sessions` 18 GB (19,205,008 KiB).
- **What is in `backups`:** 431 files.
  - 425 are `state_5-before-rollout-reconcile-<UTC stamp>.sqlite`: 10 to 141 MB each, median 100 MB, the newest about 140 MB, 41.65 GB
    in decimal. Dated 11 Jul to 8 Oct. By the UTC date in the file name: 51 on 27 Sep, 22 on each of 20 and 21 Sep, and 14 and 15 on 3
    and 4 Oct, so one comes with most app starts.
  - 5 are `state_5-before-aio-cleanup-*` (23 to 27 MB) and 1 is `state_5-before-aio-archive-*` (23 MB). No code in `src` or `scripts`
    writes the `aio-archive` name.
  - Keeping the newest 3 reconcile copies leaves 422 older ones: 41.2 GB decimal, about 38 GB binary.
- **Who makes them:** `reconcilePrivateCodexRolloutPaths`, imported at `src/main/app/late-runtime-initialization-steps.ts:22` and run as
  the start-up step "Private Codex rollout-path reconcile" (`:262`). It backs up with `VACUUM INTO`
  (`codex-private-rollout-reconcile.ts:271-273`) at `:99-106` (folder `backups`, `uniqueBackupPath` at `:286-296`) before it rewrites stale
  rows, and only when there is at least one row to rewrite (`:95-97`). The worker agent does not call it (searched `src`).
- **Nothing prunes them:** a search of that file for `unlink`, `rmSync`, `rm(`, `retain`, `prune` and `readdir` finds no match (the command
  was confirmed to run: a positive control on `mkdirSync` matched).
- **The per-resume repair makes no backup:** `repairPrivateCodexRolloutPath` (called at `app-server-initializer.ts:97`) runs one `UPDATE`
  (`:233-235`), and its comment says it deliberately skips the whole-database backup (`:179-181`).
- **Same folder, other writer:** `codex-state-cleanup.ts:90` and `:470` write `state_5-before-aio-cleanup-<stamp>.sqlite` (the start-up
  step "Leaked AIO Codex thread cleanup", `late-runtime-initialization-steps.ts:261`).
- Housekeeping step 4's card lists the Harness data folder only (96.8 GB). `~/.ai-orchestrator/codex` is not on it.

**Change:**
1. **Write new copies under a new name.** In `uniqueBackupPath` (`codex-private-rollout-reconcile.ts:286-296`) change the file-name prefix from
   `state_5-before-rollout-reconcile-` to a new one that does not begin with it, for example `state_5-auto-reconcile-<UTC stamp>.sqlite` (same stamp and
   `-<n>` suffix scheme; about four changed lines, the file stays near 307 lines). Nothing else reads the old name (searched `src`, `scripts` and `docs`: only
   that line and a closed doc quoting one file name), and the existing spec checks only that the backup path exists.
2. **A pure helper, new `src/main/cli/adapters/codex/codex-state-backup-retention.ts`.**
   - Constants `CODEX_AUTO_BACKUPS_KEEP = 3` and `CODEX_AUTO_PRUNE_MAX = 5`, and two exact patterns (whole-name regular expressions, never prefix matches): the
     new name `^state_5-auto-reconcile-\d{8}T\d{9}Z(-\d+)?\.sqlite$` and the old name `^state_5-before-rollout-reconcile-\d{8}T\d{9}Z(-\d+)?\.sqlite$`.
   - `selectAutoBackupsToPrune(names, keep = 3)` matches **only the new pattern**, orders by the stamp and then the suffix, and returns the older ones beyond the
     newest `keep`, oldest first. It can never return an old-name copy, a clean-up copy, an archive copy or any other file.
   - `pruneAutoBackups(backupDir, { keep, maxRemove, list, remove })` lists the folder, applies the selector and removes files one by one. **Tripwire:** if more than
     `maxRemove` (5) would go, it removes none and logs one line ("N automatic Codex safety copies are waiting to be removed; leaving them"). In normal use exactly one
     goes per new copy. It logs counts only and never throws.
   - Two more selectors for the card only, never called by the automatic rule: `selectOldCopiesForCard(names, keepNewest = 3)` (the old pattern, all but the newest 3) and
     `selectOtherCopiesForCard(names)` (the `state_5-before-aio-cleanup-*` and `state_5-before-aio-archive-*` names).
3. **Call the prune once** in `reconcilePrivateCodexRolloutPaths`, right after the backup succeeds (after `:104`), through a new option `pruneBackups` (default: the helper) so
   the spec can inject it. A failed backup prunes nothing. The repair function is untouched.
4. **Why this shape.** The 425 old copies are 39 GB that cannot be removed without a preview. A rule that matched them would either delete them with no preview or, if it
   refused to run while they exist, never run and let the pile keep growing. Matching only the new name means the automatic rule can never reach anything that exists today:
   the pile is bounded from the first start (the old files, frozen, plus at most 3 new copies of about 100 to 140 MB), and every old file goes only through the card, after a
   preview and a yes. The 5-per-run cap stays only as a tripwire against a selector mistake.
5. **The card half (after Housekeeping step 4a and 4b):** add target `'codex-state-backups'` to `storage.schemas.ts`.
   - `storage-usage-service.ts` gets two rows. "Codex safety copies": the `backups` folder, the number of copies and size, and "can be given back" = the old reconcile copies
     except the newest 3, plus the clean-up and archive copies. "Codex session files": the `sessions` folder, size only, with the line "Harness needs these to resume Codex
     chats", and no button. The path comes from `getAioCodexStateDir()`.
   - `storage-cleanup-service.ts`: the preview lists the files in two groups (name, size, date, and totals): the old reconcile copies (422 today, about 38 GB) and the clean-up
     and archive copies (6, about 150 MB). The run removes exactly the previewed files through the single-use preview id. It refuses any path outside
     `<codex state dir>/backups` and any name the two card selectors would not pick, and **it never lists a new-name copy** (Harness manages those).
   - Window wording (dates and sizes are examples; the window shows the preview's): heading "Delete older Codex safety copies?" Body: "Before it fixes Codex's private session
     list at start-up, Harness saves a full copy of it. These are 422 older copies from 11 July to 6 October, about 38 GB, and 6 smaller copies from other clean-ups, about
     150 MB. Harness no longer adds to them and keeps the 3 newest of the older ones. Newer copies are managed by Harness itself and are not listed here. Deleted copies cannot be
     brought back. Your Codex session files, which Harness needs to resume Codex chats, are not touched." Buttons "Keep them" (default) and "Delete the older copies".

**Tests:**
- New `codex-state-backup-retention.spec.ts` (pure): the automatic selector keeps the newest 3 of 10 new-name files; orders `-1` suffixes after the plain name of the same stamp;
  **given a fixture shaped like today's folder (425 old-name files, 5 clean-up files, 1 archive file, no new-name file) it selects nothing, whatever `keep` is (this fails on a
  prefix match)**; ignores unrelated names; with fewer than 4 new-name files it picks nothing; the prune removes the one displaced copy in the steady state; with more than 5 selected
  it removes none and logs once; a failing remove is logged and skipped. The card selectors: the old-name one never matches a new-name file and returns all but the newest 3; the
  other one matches only clean-up and archive names.
- `codex-private-rollout-reconcile.spec.ts` (exists): a successful reconcile writes the backup under the new name; in a temp folder holding 4 new-name copies, old-name copies and a
  clean-up and an archive copy, only the oldest new-name copy is gone afterwards; a folder with only old-name copies loses nothing; a failed backup (`backup-failed`) prunes nothing;
  a prune error does not change the result.
- `storage-cleanup-service.spec.ts` (Housekeeping step 4a's): a `codex-state-backups` run without a preview is rejected; a changed list is refused; a path outside the backups folder
  is refused; a new-name copy is never listed or removed; the newest 3 old-name copies are never listed.
- `storage-usage-service.spec.ts`: the two Codex rows are within 5 percent of `du` on a fixture.

**Risks:**
- This is one of two automatic deletions in this plan (choice 7). It removes only Harness's own safety copies made after the update, of a private database that Harness itself
  rewrites; the newest 3 always stay; nothing is removed if the new backup failed; and the tripwire stops it if the selector ever picks more than 5. A bad rewrite could afterwards be
  undone only back to the last 3 new states plus whatever old copies remain. Each copy is taken before an `UPDATE` of rollout paths, and older ones would only restore older stale
  paths (inferred, not tested).
- The pile of old copies stays until James clears it on the card (39 GB, frozen, not growing). The card removes up to 38 GB at once, only after a preview and a yes. Cost: none (no model calls).

**Done when:**
- After a start-up that makes a new copy in a folder with 3 older new-name copies, exactly 3 new-name copies remain, and every old-name, clean-up and archive copy is untouched.
- With today's folder (no new-name copy yet), the first start that needs a copy adds one and removes nothing; across any number of later starts the folder holds at most 3 new-name copies,
  so it grows by no more than about 0.4 GB in total, and the automatic rule has deleted nothing that exists today.
- The card lists the old copies (422 plus 6 today) with the preview's numbers, and after a yes exactly those files are gone while the newest 3 old copies and all new-name copies remain.
- The card shows the Codex session files' size (18 GB) with no button.

**Live checks** (Mac, real data, James present and his yes first):
1. Open the card, read the Codex rows and the window, and press Cancel. A listing of the `backups` folder is unchanged.
2. Only with James's yes, press "Delete the older copies". Check the folder (the newest 3 old reconcile copies plus any new-name copies), that a Codex chat still resumes, and that the
   next start that needs a backup makes one new-name copy.

**Size and order:** S. Held for James's answer to choice 7(a); after that the code half (the new name and the keep-3 rule) needs nothing from other plans and should go first. The card
half also waits for Housekeeping step 4a and 4b. Deleting Codex sessions is not in this plan.

### 5b. FU-C1: RTK's command history gets an ask-first trim to the last 30 days (S)

**For James:** RTK (the tool that shortens long command output) keeps a log of every command it handles. That log is now 600 MB and grew
by about 50 MB in the last day, because one script runs thousands of commands per run. RTK only forgets entries after 90 days and has no
setting to change that. After this, the disk space card shows the log and, after you say yes, removes entries older than 30 days. The file does not get smaller on disk, but RTK reuses the freed space, so it grows more slowly for a while. This is a one-off tidy: RTK's own 90-day limit applies again afterwards, and you can press the button again.

**Origin:** Phase 1 "Found on the way" 11 and 12; Housekeeping NIP; A#109.

**Verified (11 Oct):**
- **The premise "no retention" is refuted; the real problem is that the window is long and the rate just jumped.** RTK prunes by itself: in
  the 0.42.4 release (the copy on this Mac) `src/core/tracking.rs:439-446` `cleanup_old` runs `DELETE FROM commands WHERE timestamp < ?1`
  with `DEFAULT_HISTORY_DAYS` (90; `constants.rs:7` in the 0.51.0 clone), after every write (`tracking.rs:643` in 0.51.0). The data agrees:
  the oldest row is 12 Jul 23:24 UTC and the newest 10 Oct 23:24 UTC, exactly 90 days (row dates from the disk check's read-only query; the
  0.42.4 source is not on this Mac, so the pruning rule was read in the 0.51.0 clone, where it is the same).
- **Where and how big:** `~/Library/Application Support/rtk/history.db`, 599,248,896 bytes at 00:23 on 11 Oct (551 MB a day earlier per Phase 1,
  so about +48 MB a day). Harness resolves the same file at `src/main/cli/rtk/rtk-tracking-reader.ts:156-163` (`getRtkTrackingDbPath`).
  Read-only queries: WAL mode, 146,301 pages of 4,096 bytes, 0 free pages. `commands`: 825,488 rows; `parse_failures`: 208,792 rows. No
  `hook_decisions` table, which fits the older 0.42.4 writer.
- **Who writes:** the `rtk` command line, run by every agent that calls `rtk <cmd>` or `rtk proxy <cmd>`; here that is Homebrew
  `/opt/homebrew/bin/rtk` (0.42.4). Harness prefers the system copy when it is at least as new as the bundled one (`rtk-runtime.ts:256-262`,
  bundled `RTK_BUNDLED_VERSION = '0.39.0'` at `:29`). Harness only reads: `rtk-tracking-reader.ts:209` opens it `{ readonly: true }`.
- **No working setting anywhere.** RTK declares `tracking.history_days` but no code reads it; the delete uses the constant. The only built-in
  way to shrink is `rtk gain --reset --yes`, which deletes every row. Harness has no setting for it.
- **The jump:** rows per day were 2,757 to 24,577 from 27 Sep to 6 Oct, then 30,941 (7 Oct), 61,313 (8 Oct), 103,564 (9 Oct), 97,853 (10 Oct).
  60 percent of the command rows are `rtk proxy` rows, which record no saving. Since 9 Oct, 147,348 of 201,428 rows came from the folder
  `/Users/suas/work/communitytech/work-finding`; Phase 1 "Found on the way" 12 names a ComTech gate script that runs `rtk proxy git` about
  2,877 times a run. At about 580 bytes a row, 100,000 rows a day is about 58 MB a day, and held for 90 days the file would settle near 5 GB.
- **What a 30-day trim removes:** 287,070 command rows plus 122,191 parse-failure rows, about 409,000 rows or 39.6 percent of the file
  (roughly 240 MB of pages, which RTK reuses; the file itself stays at its size).
- **Writes are safe to share:** RTK's own connection sets WAL and `busy_timeout=5000` (`tracking.rs:1717-1718`) and swallows tracking failures
  (`let _ = tracker.record(` at `:1882, :1903, :1937`), so a held lock loses one tracking row and never breaks an `rtk` command.
- **What reads the data:** the Savings tab asks for the whole database with no window (`rtk-savings-tab.component.ts:189`). Phase 1 step 18
  adds a 7/30/90-day/all selector.
- Disk is not tight: 449 GB are free. This is a growth-rate item, not an emergency.

**Change:**
1. New `src/main/cli/rtk/rtk-history-trim.ts` (about 140 lines). `RTK_HISTORY_KEEP_DAYS = 30` (a constant, no setting; the settings files have
   no room, see 2a).
   - `previewRtkHistoryTrim(keepDays, { dbPath?, now? })` returns `{ available, dbPath, fileBytes, commandsToRemove, failuresToRemove, oldestAt,
     newestAt, cutoffAt, estimatedBytes }`. Read-only; `available: false` when the file, either table or the `timestamp` column is missing (no
     guessing about future RTK schemas).
   - `trimRtkHistory(keepDays, { onProgress, shouldAbort })` opens read-write through the existing driver factory, sets `PRAGMA busy_timeout = 250`,
     then loops `DELETE FROM commands WHERE id IN (SELECT id FROM commands WHERE timestamp < ? LIMIT 2000)` (one transaction per batch, a 25 ms
     pause between batches) and the same for `parse_failures`. It stops after 3 busy results in a row and reports the partial count, and ends with
     `PRAGMA wal_checkpoint(PASSIVE)`. **It never runs `VACUUM`** (an exclusive lock; RTK writers would time out and lose rows).
   - In `rtk-tracking-reader.ts` (501 lines, room 199) make `getRtkTrackingDbPath()` honour RTK's own `RTK_DB_PATH` first (`tracking.rs:1635-1637`),
     about +6 lines. Today the reader would read the wrong file if that variable is set.
2. Wire it to the disk space card as target `'rtk-history'` (`storage.schemas.ts`, `storage-cleanup-service.ts`, `storage-usage-service.ts`). Usage row:
   "RTK command history", file size, date range, and "RTK removes entries after 90 days by itself".
3. Window (the numbers come from the preview): heading "Trim RTK's command history?" Body: "RTK keeps a log of every command it shortens or passes
   through: about 825,000 entries from 12 July to 10 October, 600 MB. Harness will remove the entries older than 30 days: about 409,000 entries, roughly
   240 MB. RTK's totals, and the Savings tab, will then count the last 30 days only. This cannot be undone. The file on disk keeps its size, but RTK reuses
   the space, so it grows more slowly afterwards." Buttons "Keep it" (default) and "Trim the history".
4. Note for Phase 1 step 18: label the selector's last option "All that RTK has kept", so a trim does not look like lost data. The cause of the surge
   (the gate script and the awareness wording) is for Phase 1 step 18a to reduce (it changes the awareness wording; the gate script itself lives in another repository); this part does not wait for it.

**Tests:**
- New `rtk-history-trim.spec.ts` on a temp WAL database with RTK's real schema (`commands` with `project_path` and `exec_time_ms`, the three indexes,
  `parse_failures`): preview counts equal a hand count; a trim removes only older rows; 5,000 old rows take 3 batches and call `onProgress` 3 times; a second
  connection holding a write lock makes the trim stop after 3 busy results and report the partial count without throwing; a missing table or file gives
  `available: false` and writes nothing; `page_count` is unchanged (no `VACUUM`); a database without `project_path` still works.
- `rtk-tracking-reader.spec.ts`: `getRtkTrackingDbPath()` returns `RTK_DB_PATH` when set (fails today); the reader sees the lower counts on its next query.
- `storage-cleanup-service.spec.ts` (Housekeeping step 4a's): an `rtk-history` run without a preview is rejected; a changed list is refused.

**Risks:**
- It deletes rows from a database that RTK and your other tools (`rtk gain` in a terminal) also use. It asks first, and a lock can only cost RTK one row.
  After a trim the Savings numbers, and Phase 1 step 18's "ran in full" share, cover 30 days only.
- The file does not shrink. Giving the space back needs `VACUUM`, which is left out on purpose. The freed space (about 240 MB) lasts a few days at the 9 and 10 Oct rate (about 58 MB a day); after that the file grows again toward RTK's own 90-day limit (about 5 GB at that rate), so the trim is a one-off unless the cause is reduced. No model cost.

**Done when:**
- Preview numbers equal a read-only count of the same file; Cancel leaves the file byte for byte the same (`ls -l`).
- After a yes, no row older than 30 days remains, newer rows are untouched, and `rtk gain` still runs.

**Live checks** (Mac only, the real file is there; with James's yes):
1. Open the card, read the preview, press Cancel; compare `ls -l` and a read-only row count before and after.
2. Press "Trim the history" while an agent is running commands; confirm no `rtk` command failed and `rtk gain` prints totals with 0.42.4.

**Size and order:** S. After Housekeeping step 4a (it needs `cleanup-ticket.ts` and the storage schema); best after Phase 1 step 18a, which is meant to reduce the surge. Low
urgency. Shares `rtk-savings-tab.component.ts` and `rtk-tracking-reader.ts` with Phase 1 step 18. Held for James's answer to choice 7(c).

### 5c. FU-C2: The trace files get a size cap, and the stray copy in the temp folder comes home (S-M)

**For James:** Harness writes a technical record of every message that comes back from the AI tools. It has never been trimmed: one copy has grown to 711 MB, and a
second copy is quietly written to the Mac's temporary folder (292 MB there, in 30 MB pieces that are never deleted). After this, each record file stops at 50 MB,
keeps three older pieces and drops the oldest. The huge existing file is set aside, not deleted; you can remove it from the disk space card after a preview.

**Origin:** Housekeeping NIP and "Found on the way" 1; A#183 and A#194.

**Verified (11 Oct):**
- **No rotation in the exporter:** `src/main/observability/local-trace-exporter.ts:36-37` `await fs.mkdir(path.dirname(this.traceFilePath), { recursive: true });` then
  `await fs.appendFile(...)` with no size check. Path `<userData>/logs/traces.ndjson` (`:18-22`). Wired by `initTracer()` at
  `src/main/bootstrap/infrastructure-bootstrap.ts:95`, `otel-setup.ts:48` and `:60`. Writes are serialised through one promise chain (`:25, :33-35`), so a
  size counter inside it is race-free.
- **Measured (read-only):** `~/Library/Application Support/harness/logs/traces.ndjson` = 710,943,505 bytes at 00:28 on 11 Oct (695 MB per Housekeeping, so
  still growing); 1,373,774 lines; every sampled line (1 in 50) is the span `provider.runtime_event`; first record 6 May, last 10 Oct. MB per month: May 49.5,
  Jun 65.2, Jul 129.4, Aug 87.2, Sep 220.0, Oct (10 days) 159.7. Last days: 8 Oct 16.7, 9 Oct 22.2, 10 Oct 46.2.
- **A second writer, in another folder, that rotates but never deletes:** `provider-runtime-trace-worker.ts` rotates at 30 MB (`:45`; `rotateSyncIfNeeded`
  `:62-74` renames to `traces.ndjson.<ms>.old`) and has no unlink. Its path code (`:29-43`) falls back to `os.tmpdir()` when `require('electron').app` is
  missing, which is inferred to be the case inside a worker thread (the mechanism is inferred; the effect is verified). On this Mac `$TMPDIR/ai-orchestrator/logs/`
  holds `traces.ndjson` 7.8 MB, nine `.old` files of 31.5 MB (8 Oct 22:25 to 10 Oct 23:25, one every 3 to 6 hours) and `lifecycle.ndjson` 6 MB: 291,604 KB in all.
  The two writers are separate: 0 of 1,373,774 lines in the Harness-folder file contain `"eventId"` (the worker's record shape,
  `provider-runtime-trace-protocol.ts:9`), while the temp files are worker-shaped.
- **CHANGED (Housekeeping "Found on the way" 1):** it says "no `.old` files exist. Two writers share one path". The `.old` files exist, in the temp folder, and the two
  writers use two different folders.
- Both run on every provider event: `src/main/app/instance-event-forwarding.ts:274-275` `recordProviderRuntimeEventSpan(enrichedEnvelope);
  traceSink.enqueue(enrichedEnvelope);`. Nothing in `src` reads `traces.ndjson`. Only `lifecycle.ndjson` has a reader
  (`src/main/diagnostics/operator-artifact-exporter.ts:205`).
- **The pattern to copy exists:** `src/main/logging/log-writer-worker.ts:28-50` (shift `.i` to `.i+1`, unlink the last one; 10 MB × 5 files).

**Change:**
1. New `src/main/observability/ndjson-rotation.ts` (about 90 lines, imports only `fs` and `path`, so it is safe inside a worker): `rotateFilesSync(filePath, keep)` (the
   logger's shift scheme; deletes the oldest first, which also works on Windows) and `createRotatingAppender({ filePath, maxBytes = 50 MB, keep = 3 })` returning
   `{ append(text): Promise<void> }` (async, one `stat` at first use, rotates when `size + text > maxBytes`, catches and counts errors, never throws into the
   caller). A file larger than 4 × `maxBytes` at first use is renamed once to `<file>.legacy`; rotation never touches or deletes `.legacy`.
2. `local-trace-exporter.ts` (91 lines): replace the `appendFile` call with the appender; the constructor takes an optional `maxBytes` for tests. The
   result-callback behaviour is unchanged.
3. Worker: `provider-runtime-trace-sink.ts` (233 lines) `createWorker()` passes `workerData: { traceFilePath }` where the path is
   `join(dirname(resolveDefaultTraceFilePath()), 'provider-events.ndjson')`. The worker (155 lines) reads `workerData.traceFilePath` instead of its own `electron`
   lookup and uses `rotateFilesSync` at 30 MB with 3 older pieces; the timestamped `.old` names go. A new file name keeps the two record shapes apart and gives each
   file one rotator. The old temp files are left to the system's temp clean-up (not touched).
4. Disk space card (ask-first, after Housekeeping step 4a): target `'trace-files'`, offered only for `traces.ndjson.legacy`. Window: "Delete the old trace record? This is
   a technical record of AI messages from 6 May to the day of this update: 711 MB. Harness does not read it. This cannot be undone." Buttons "Keep it" (default),
   "Delete the old record". The numbered pieces belong to rotation and are never offered.
5. No new setting (constants). `lifecycle.ndjson` is left alone here (see "Found on the way").

**Tests:**
- New `ndjson-rotation.spec.ts` (temp folder): appends under the cap do not rotate; crossing the cap makes `.1`; after five rotations with `keep = 3` only `.1` to `.3`
  exist and the oldest text is gone; a 5 × cap file at first use becomes `.legacy` once and later rotations leave it alone; 20 concurrent appends lose no line and
  rotate once; a failing rename is swallowed.
- `local-trace-exporter.spec.ts`: the two existing cases still pass; add "rotates at `maxBytes`" and "an oversized file is set aside once".
- `provider-runtime-trace-sink.spec.ts` (214 lines): "the worker is started with the Harness-folder path" (fails today); a worker case with a small `maxBytes` in
  `workerData` rotates to `.1`.

**Risks:**
- This is the second automatic deletion in this plan (choice 7(b)). It removes only rotation pieces that this code made (`.1` to `.3`); it never touches `.legacy` or the temp-folder `.old` files.
- The first start renames a 711 MB file (instant on the same volume). The data folder then holds at most about 200 MB (exporter: 4 × 50 MB) plus 120 MB (worker:
  4 × 30 MB) until the legacy file is cleared, instead of an unbounded file.
- Anything that follows `traces.ndjson` live would lose its tail at a rotation; nothing in the code does. Windows rename-onto-existing is avoided by deleting
  first. No model cost.

**Done when:**
- A synthetic write of 3 × the cap leaves each file at or under its cap plus the three older pieces; a first start with an oversized file leaves `.legacy` and a
  fresh file.
- After the change no new files appear in `$TMPDIR/ai-orchestrator/logs` (stat twice, a minute apart, during a session).

**Live checks** (rebuilt app, any machine with real use): list `~/Library/Application Support/harness/logs` after a working hour (a new `provider-events.ndjson`, a
small `traces.ndjson`, `.legacy` present), and stat the temp folder twice to confirm it has stopped growing. The card part needs James's yes and the Mac.

**Size and order:** S-M. Held for James's answer to choice 7(b). No Phase 0 dependency. The card part comes after Housekeeping step 4a.

### 5d. FU-C3: An ask-first tidy-up for the old "claude-orchestrator" data folder (XS-S)

**For James:** There is an old Harness data folder from before the renames, called `claude-orchestrator`, in your Mac's app data area. It is only 11 MB, nothing in
Harness reads it any more, and it holds out-of-date settings. After this, the disk space card shows it with its size and asks whether to move it to the Bin or keep it.
Nothing is removed unless you say yes, and the Bin lets you undo it.

**Origin:** Phase 1 "Found on the way" 13; A#111.

**Verified (11 Oct):**
- **Size:** `~/Library/Application Support/claude-orchestrator` = 11,300 KB (`du -sk`), 62 files; the largest is `rlm/rlm.db` at 8.65 MB; last changed 16 Jul (the `rlm`
  folder 10 Aug). Inside (names and counts only): browser caches, `settings.json` with 22 setting names, `commands.json`, 9 conversation-history files, 6
  learning-database files, an empty `snapshots` folder.
- **The live folder is `harness`** (packaged) or `harness-dev` (dev): `src/main/app/user-data-path.ts:32`, applied at `src/main/index.ts:67`.
- **Nothing reads the old folder.** The only code that names it as a data folder is `migrateFromLegacyApp()` (`src/main/core/config/settings-migrations.ts:585-643`,
  called at `settings-manager.ts:194`). It builds the old path with `currentUserData.replace(/ai-orchestrator$/i, LEGACY_APP_NAME)` (`:593`) and returns at `:596`
  (`if (currentUserData === legacyUserData) return;`). The live path ends in `harness`, so the replace changes nothing and the function exits before reading
  anything. No spec mentions it. Verified by reading, not by running. One edge: the dev-only override `AIO_DEV_USER_DATA_PATH` (`src/main/app/user-data-path.ts:24-29`) could name a folder ending `ai-orchestrator`, which would let the function run; that applies to unpackaged developer runs only.
- Other uses of the name are not this folder: `LEGACY_PROJECT_CONFIG_FILE = '.claude-orchestrator.json'`, URLs, `~/.claude-orchestrator` (does not exist here), a
  temp-folder name, an MCP server name and a User-Agent.
- Phase 1 "Found on the way" 13's "stale `defaultYoloMode: false`" is true (the key is there; values not printed).

**Change:**
1. New `src/main/storage/legacy-app-data.ts` (about 90 lines): `LEGACY_APP_DATA_NAMES = ['claude-orchestrator']`;
   `listLegacyAppData(appDataPath, currentUserData)` returns `{ path, bytes, files, newestModified, inside }` only when the folder is a direct child of
   `app.getPath('appData')`, its name is in the list, it is not the current user data folder, and `lstat` says it is a real directory (not a link). Size by an async
   walk with a 50,000-file cap.
2. Disk space card target `'legacy-app-data'`. The preview shows size, last change and contents. Run calls `shell.trashItem(path)` (reversible; precedent
   `src/main/ipc/handlers/vcs-handlers.ts:516`) and logs one info line. If moving to the Bin fails, it reports the error and removes nothing (no `rm` fallback).
3. Window: heading "Move the older Harness data folder to the Bin?" Body: "This folder, 'claude-orchestrator', is from before Harness was renamed: 11 MB, last
   changed 16 July. Harness no longer reads it. It holds old settings, nine saved conversation records and a small old learning database. Your current data is in
   the 'harness' folder and is not touched. You can put it back from the Bin." Buttons "Keep it" (default), "Move to the Bin". "Keep it" stores nothing; the row stays,
   quietly, and no pop-up appears.
4. In the same change delete the dead `migrateFromLegacyApp()` (`settings-migrations.ts:585-643`, 59 lines) and its call and import (`settings-manager.ts:193-194`
   and `:20`). Behaviour-neutral as shown above; `settings-migrations.ts` drops from 643 to about 584 lines.

**Tests:**
- New `legacy-app-data.spec.ts` (temp folder as app data): the folder is listed with a size; a link, a folder with another name, the current user data folder and a
  folder outside app data are all ignored; the run calls a mocked `trashItem` once and never `rm`; a failing `trashItem` leaves the folder.
- `settings-manager.spec.ts` still passes after the call is removed.

**Risks:**
- Low. 11 MB; reversible through the Bin. The Bin does not exist the same way on every platform, which is why a failed move removes nothing.
- `settings-migrations.ts` also gets part 5i's block removal and the MiMo profile migration that `4d175e55b` committed; the three edits are in different regions.

**Done when:**
- With the folder present, the row shows 11 MB; Cancel leaves it; "Move to the Bin" puts it in the Bin and the row disappears; Harness starts normally without the
  migration function.

**Live checks** (Mac, with James's yes; never move it as a test): open the card, read the window, press "Keep it", and confirm the folder is unchanged.

**Size and order:** XS-S. After Housekeeping step 4a for the card half. The dead-code deletion (change 4) can land on its own at any time. Part of choice 9.

### 5e. FU-C4: Stop keeping the RTK program files in git, and make the build fetch them (S)

**For James:** Five copies of the RTK program (one per computer type) are saved inside the project's git history: 43 MB as files, about 20 MB inside git, a quarter of
the whole project's storage. Phase 1 plans to update RTK, and each update would add another 20 MB for every copy of the project, for good. After this, git stops
keeping them; the build downloads the right ones and checks them against a fixed fingerprint, as it already does before a release.

**Origin:** Housekeeping NIP ("Not tracking the RTK binaries in git"); A#193.

**Verified (11 Oct):**
- **Size:** five tracked files: `resources/rtk/darwin-arm64/rtk` 7,597,696 bytes, `darwin-x64/rtk` 8,809,116, `linux-arm64/rtk` 8,346,624, `linux-x64/rtk` 9,869,600,
  `win32-x64/rtk.exe` 8,660,992 = 43,284,028 bytes. In git's storage (`git verify-pack -v`) they take 20,115,303 bytes, against a whole-repository pack of 82.73 MiB. So the
  Housekeeping note's "35-40 MB per bump" is the raw size; the permanent cost per bump is about 20 MB. They have been committed once (`10e826dec`, 2026-05-08, version
  0.39.0). No `.gitignore` or `.gitattributes` entry mentions them.
- **How the build gets them already:** `package.json` `electron:build` = `node scripts/fetch-rtk-binaries.js && electron-builder`; the release workflow runs it
  (`.github/workflows/release.yml:194`). The script downloads from GitHub releases, checks SHA256 against `scripts/rtk-binaries.sha256.json`, and does nothing when a
  file is present with a matching hash. Its header says it is "Wired into npm `prebuild` and `predev`"; it is not.
- **Packaging:** `electron-builder.json` copies from `resources/rtk/<os>-${arch}/` into the app. At run time `rtk-runtime.ts:112-138` looks in
  `process.resourcesPath/rtk/<platform>-<arch>/` (packaged) or `<repo>/resources/rtk/...` (dev), and uses it only if no newer system copy exists (`:254-266`); with
  neither present the feature is simply off.
- **Failure policy is the real risk:** the script exits 1 only when all five downloads fail; one failed target prints "CI for that platform will fail at package
  time" and carries on. Today a failed download cannot leave a platform without a binary, because the tracked file is there. Untracked, a flaky download could ship a
  build with no RTK (the app still starts).
- **CI packages without fetching.** `.github/workflows/ci.yml:234-235` runs `npx electron-builder --mac --dir --config electron-builder.json` after `npm run build` (`:225`), not
  `electron:build`, and nothing else in `.github` or `scripts` fetches RTK: only the release workflow does, through `npm run electron:build` (`release.yml:194`; `scripts/localbuild.js:51` does the same
  locally). Once the files are untracked, a fresh CI checkout has no `resources/rtk/<os>-<arch>/` folder for `electron-builder.json` to copy (whether electron-builder then fails or ships without
  RTK was not tested; either way the step is needed). No spec reads the real binaries. Phase 1 step 18a bumps RTK from 0.39.0 to 0.51.0; doing that while the binaries are tracked adds about 20 MB
  of git storage.
- **The Windows PC.** No script in `package.json` uses `||` (the one `||` in the file is the Node version range at `:10`) and there is no `.npmrc` with a `script-shell`, so npm runs scripts through
  `cmd.exe` on Windows (inferred from npm's default; not run here). In `cmd.exe` `node ... || true` still fails when the node command fails, because `true` is not a command there, so it would break
  `npm run dev` and `npm run start` on the Windows PC whenever a download fails. A flag inside the script needs no shell operator.

**Change:**
1. `git rm -r --cached resources/rtk` (the files stay on disk) and add `resources/rtk/` to `.gitignore` with a one-line comment pointing to `npm run fetch:rtk`. History is not rewritten (the
   existing 20 MB stays).
2. `scripts/fetch-rtk-binaries.js` (299 lines now, about 340 after):
   - add `--platform=<darwin|linux|win32|host>` to fetch only that platform's targets (`electron:build` and CI pass `host`; a Mac build fetches the two darwin files, not all five);
   - add `--strict`: exit 1 when any selected target fails, and retry each download once;
   - add `--soft`: print a one-line warning for any failure (including the all-failed case and a thrown error) and always exit 0, so it needs no shell operator and works under `cmd.exe`.
     `--strict` and `--soft` exclude each other (both given: exit 2 with a usage line);
   - export the pure helpers (`selectTargets(argv, platform)`, `decideExit(results, mode)`) and guard `main()` with `if (require.main === module)` so a spec can import it;
   - fix the stale header comment.
3. `package.json`: `electron:build` = `node scripts/fetch-rtk-binaries.js --platform=host --strict && electron-builder`. `dev` and `start` begin with
   `node scripts/fetch-rtk-binaries.js --platform=host --soft && ` (offline-safe: a warning, never a failure; a no-op when the file is present and the hash matches), then continue as today.
   `fetch:rtk` keeps fetching all five. `localbuild` goes through `electron:build`, so it is covered.
4. **CI:** in `.github/workflows/ci.yml`, add a step `Fetch bundled RTK` with `run: node scripts/fetch-rtk-binaries.js --platform=host --strict` before the `Electron packaging smoke` step (`:234`).
   Any other job that packages needs the same step; none exists today (searched `.github`).
5. Phase 1 step 18a then changes only the two version constants and the five hashes; no binaries are committed.

**Tests:**
- New `scripts/__tests__/fetch-rtk-binaries.spec.ts`: `selectTargets(['--platform=darwin'], 'linux')` returns the two darwin targets; `host` follows the platform; `decideExit` is 1 in strict
  mode when one target failed and 0 otherwise; non-strict keeps today's "only all-failed is fatal"; **soft mode returns 0 for one failure, for all failures and for a thrown error**; both
  flags together are a usage error.
- A workflow check (in the style of `scripts/__tests__/release-workflow.spec.ts`, or a small new spec): `ci.yml` runs the fetch step before `electron-builder`, and no `package.json` script
  contains `||`.
- `npm run electron:build` on the Mac with the files deleted from a scratch copy: the script re-fetches and the hashes match (live check below).

**Risks:**
- A release build now needs GitHub reachable at build time (the script already fetched on a hash mismatch), and so does CI's packaging step. `--strict` plus one retry turns a failed download
  into a failed build rather than a build without RTK.
- A fresh checkout used for dev without network has no bundled RTK until `npm run fetch:rtk`; `dev` and `start` print a warning and carry on (`--soft`), and the app falls back to a system RTK
  or runs without it. The Windows PC worker needs one `npm run fetch:rtk` after its next pull, or a networked `npm run dev`.
- Anyone with the old tracked files sees them become untracked-ignored after the pull; no data loss.

**Done when:**
- `git ls-files resources/rtk` prints nothing; `git status` is clean after `npm run fetch:rtk`; the packaged app's log still shows the bundled RTK resolved.
- `ci.yml` has the fetch step before packaging, and no `package.json` script contains `||`.

**Live checks:**
1. On the Mac, in a scratch clone: `npm run electron:build` produces the app with `Contents/Resources/rtk/darwin-arm64/rtk` present and executable.
2. On the Windows PC, with and without network: `npm run dev` starts (with no network it prints the warning and still starts). The download needs `tar` and PowerShell; this is the Windows PC,
   not the Mac.
3. The first normal CI run after the commit: the new fetch step runs and `node scripts/packaged-startup-smoke.js` passes. (No branch is created for this; the no-branch rule stands.)

**Size and order:** S. Land before Phase 1 step 18a. Held for James's answer to choice 8 and his yes to commit (it changes tracked files). Files: `scripts/fetch-rtk-binaries.js`, `package.json`,
`.gitignore`, `.github/workflows/ci.yml`.

### 5f. FU-C5: Add `--no-session-persistence` to Harness's true one-shot Claude calls (XS; low value today)

**For James:** When Harness asks Claude a single question (a title, a magic prompt, a second opinion), Claude saves a full transcript file of that question to disk, like a
normal chat, and these show up when you list sessions in Claude. Claude has a switch that skips the saving. After this, Harness uses it for single questions that will never
be resumed. Almost no such leftovers exist on your Mac today, so the saving is small; this is mostly to keep things tidy.

**Origin:** Phase 1 "Not in this plan" (A5b); A#56.

**Verified (11 Oct):**
- **The flag:** in the Claude Code source snapshot (`Actual Claude/main.tsx:991`) "Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works
  with --print)"; outside print mode it exits 1 (`main.tsx:1855-1858`). It makes the transcript writer skip every write (`utils/sessionStorage.ts:954-966`). Not used anywhere in
  Harness (searched `src`; Phase 1 says the same).
- **Harness always runs Claude in print mode** with `--print --output-format stream-json --input-format stream-json` (`claude-cli-argv-builder.ts:132-136`), so the flag is always accepted.
  It must never go on a session that is resumed later: `--resume` is added at `:202`, and a resumed session carries its earlier total (Phase 0 step 7g).
- **What a Claude spawn writes today** (inferred from the CLI's code, not measured per path): a transcript `~/.claude/projects/<encoded working folder>/<session id>.jsonl`, plus a
  `session-env/<id>/` folder.
- **Measured (read-only) in `~/.claude/projects` by the wave-2 check on 11 Oct (not re-run by the plan writer):** 217 project folders; 4,215 transcript files; 4.8 GB; 2,638 of the files are subagent transcripts (2.68 GB). Files of 4 lines or fewer: 0;
  20 lines or fewer: 53 (17.8 MB). Elsewhere under `~/.claude`: `session-env` 5.2 MB, `shell-snapshots` 31.3 MB. So no leftover of one-line single questions exists: today the saving would be
  about nil.
- **Why so few:** the cost log for 8 to 10 Oct (1,574 lines, incomplete until Phase 0 step 7a) shows titles going to an OpenAI-compatible endpoint (86) or the local fallback (5) and one
  Claude title escalation; the rest are chat turns.
- **Paths that are true one-shots** (fresh session, one prompt, result read, never resumed): title escalation (`aux:titleGeneration`), magic prompts
  (`src/main/magic-prompts/magic-prompt-service.ts`), Council and multi-verify synthesis (`src/main/compare/council-run-service.ts`, `council-synthesis.ts`), cross-model review and consensus, and
  the five one-shot reviewers named in Phase 1's A5 note. **Not eligible:** loop iterations (`default-invokers.ts` `invokeCliTextResponse` reuses and resumes the adapter, `:1353-1391`), chats,
  plan-queue workers, and ping-pong reviewers (whether they hold a session across rounds was not read).
- **Trade-off:** Phase 0 step 7b's day-check script (`audit:claude-cost -- --compare-transcripts`) compares recorded spend with transcripts; a one-shot with no transcript cannot be compared, so
  those calls must be costed from the result line (step 7a's `costSource`), which step 7g already relies on.

**Change:**
1. Add `noSessionPersistence?: boolean` to `UnifiedSpawnOptions` (`adapter-factory.types.ts`) and to the Claude options type, described "Claude only; fresh print-mode one-shots only". In
   `claude-cli-argv-builder.ts` (352 lines), next to Phase 0 step 7g's `--max-budget-usd` line, push `--no-session-persistence` when the option is true and the session is neither resuming
   (`input.shouldUseNativeResume`) nor forking.
2. Set it on exactly the callers in step 7g's table (titles, magic prompts, reviewers, consensus, Council and multi-verify synthesis) in the same edit, so the two flags always travel together.
3. Callers must not call `resume` on these adapters afterwards; the argv builder logs and drops the flag when `spawnOptions.resume` or `forkSession` is set.

**Tests:**
- `claude-cli-argv-builder.spec.ts`: the flag is added for a fresh option, left out on resume, left out on fork, left out when unset.
- One caller spec per path asserts the option is set (step 7g's per-call budget specs can carry the second assertion).

**Risks:**
- A session started this way cannot be opened or resumed from Claude later, and its tool results are not on disk for debugging. Only calls that never need either are listed.
- It saves almost nothing on disk today; the value is keeping future one-shots from adding files.

**Done when:**
- A scratch one-shot with the flag leaves no new file under `~/.claude/projects` and no new `session-env` folder; the same call without it leaves one.

**Live checks** (any machine with Claude): run one magic prompt after the build, then `find ~/.claude/projects -newer <marker> -name '*.jsonl'` before and after.

**Size and order:** XS. Land with or right after Phase 0 step 7g (same code lines, same eligibility rule). Optional; skip it if step 7g slips. Part of choice 9.

### 5g. FU-A4: Pasted attachments stop landing unignored in your projects, and get a tidy-up (S)

**For James:** When you attach a file or paste a big file into a Claude or Codex chat, Harness saves a copy inside the project folder. In three of your project repos that folder is not
ignored by git, so a careless `git add` could commit pasted logs or screenshots, which may contain secrets. After this, Harness tells git to ignore the folder in whichever project it
writes to, and the disk space card can list and clear old copies (always asking first).

**Origin:** Phase 1 "Found on the way" 7 and "Not in this plan" (A9); A#85 and A#105.

**Verified (11 Oct):**
- `src/main/cli/file-handler.ts:33-34`: `const attachmentsDir = join(workingDirectory, '.claude-attachments', sessionId); await mkdir(attachmentsDir, { recursive: true });` (an 87-line file).
- Nothing cleans it up (no other match in `src/main`; Phase 1 says the same).
- This repo ignores it (`.gitignore:32 .claude-attachments/`). Counts only, read-only: 23 folders named `.claude-attachments` under `~/work` (two levels); 10 sit inside git repos; 3 of those
  10 do not ignore it (`git check-ignore` fails).
- Phase 1 "Found on the way" 7 says "Goes to E1", but the Housekeeping plan (E1) never mentions it (searched all nine plans). Phase 1 step 12d (big pastes) adds more files here.

**Change:**
1. In `file-handler.ts`, after `mkdir`, call a new `ensureAttachmentsIgnored(workingDirectory)` (new module `attachments-ignore.ts`): if the directory is inside a git work tree and `git
   check-ignore -q .claude-attachments` fails, append `.claude-attachments/` to that repo's `.git/info/exclude` (a local file, never committed, no change to tracked files). Best effort; log
   and continue on any error. **This writes one line into other projects' local git settings.**
2. Add `.claude-attachments` folders to Housekeeping step 4a's targets as a fifth item (`'claude-attachments'`), preview first, never automatic (Housekeeping choice 7): list folder, session
   count, size and age; "Clear" needs the same preview id as the other targets.
3. Do not move the files out of the project: Claude and Codex read them by path from the working directory.

**Tests:**
- `attachments-ignore.spec.ts` (temp git repo): it creates the exclude line once (idempotent); a non-git folder is a no-op; an already-ignored folder is untouched; a read-only `.git/info`
  logs and continues.
- A new `file-handler.spec.ts` beside `src/main/cli/file-handler.ts` (it has none; the nearby `src/main/ipc/handlers/__tests__/file-handlers.spec.ts` is a different file): `processAttachments` still returns the same paths.

**Risks:**
- It writes one line into other repos' local exclude file (not tracked, invisible to teammates). If a project deliberately commits attachments, the exclude hides them from `git status`;
  unlikely.

**Done when:**
- A fresh attachment in a scratch repo leaves `git status` clean. The card lists the folders with sizes (208 MB, 679 session folders and 1,059 files were Phase 1's counts; not re-run).

**Live checks:**
- Rebuilt app: attach a file in a scratch repo, then run `git status`.

**Size and order:** S. The exclude half has no dependencies; the card half comes after Housekeeping step 4a. Replaces Phase 1 "Found on the way" 7 and the "Clean up `.claude-attachments`"
hand-off. Part of choice 9.

### 5h. FU-C10: Delete the empty Training Data and Instance Messaging features and three unused components (M; held for James's yes, choice 11)

**For James:** Two screens (Training Data and Instance Messaging) and three small building blocks are not used by anything real. Training Data records nothing: its "training step" always
returns an empty answer. Phase 5 only hides the two screens from the menus. This part deletes the code, so it can never confuse you or a future agent. It is your call because it removes about
5,100 lines and two screens that still open by link.

**Origin:** Phase 5 "Not in this plan" (C13.4) and "Found on the way" 14; B#112 and B#142 (the same finding).

**Verified (11 Oct):**
- **Training Data is empty:** `src/main/learning/grpo-trainer.ts:257-270` `trainStep` builds `const updates: StrategyUpdate[] = [];`, emits an event and `return { loss, updates };`; its
  comment says "In a full implementation, this would update model weights". The only caller of `recordOutcome` is the IPC handler (`src/main/ipc/training-ipc-handler.ts:187-190`); nothing in the
  orchestrator feeds it (Phase 5 step 3 checked the same).
- **Instance Messaging is unused rather than proven empty:** `CrossInstanceCommService` is imported only by `src/main/ipc/handlers/communication-handlers.ts` (grep of `src`, non-spec). Its page was not run.
- **Three components have no user:** `confidence-meter` (239 lines), `cost-estimator` (364) and `token-counter` (238), one `.ts` file each under `src/renderer/app/shared/components/`; no file under
  `src/renderer` mentions their names outside their own folders (grep of `.ts` and `.html`, 0 hits each).
- **What is wired and reachable today:**

  | Piece | Where | Lines |
  |---|---|---|
  | Training page and dashboard | `src/renderer/app/features/training/` (`training-page.component.ts` 804, `grpo-dashboard.component.ts` 238, `.html` 393, `.scss` 586) | 2,021 |
  | Training renderer service | `core/services/ipc/training-ipc.service.ts` | 82 |
  | Training main handler and spec | `src/main/ipc/training-ipc-handler.ts` 296, `.spec.ts` 162 | 458 |
  | Training trainer | `src/main/learning/grpo-trainer.ts` | 622 |
  | Training channels | 16 `TRAINING_*` keys in `packages/contracts/src/channels/learning.channels.ts`, used by `src/preload/domains/learning.preload.ts` | n/a |
  | Training route and menu | `app.routes.ts:98-101` (`/training`), registry entry `training` (`control-surface.registry.ts:80`), help entries (`shared/help/content/knowledge.help.ts`, `shared/help/control-surface-help.ts`) | n/a |
  | Messaging page | `src/renderer/app/features/communication/communication-page.component.ts` | 713 |
  | Messaging service, store, spec | `src/main/communication/cross-instance-comm.ts` 209, `cross-instance-comm-store.ts` 99, `.spec.ts` 69 | 377 |
  | Messaging handler, preload, channels | `ipc/handlers/communication-handlers.ts` 269, `preload/domains/communication.preload.ts` 516, `channels/communication.channels.ts` 108 (these also hold Cross-Session Messaging, which stays) | shared |
  | Messaging route and menu | `app.routes.ts:269` (`/communication`), registry entry `communication` (`:108`) | n/a |
  | Three components | as above | 841 |

  Barrels and registration that also name Training: `core/services/ipc/index.ts`, `src/main/learning/index.ts`, `src/main/memory/index.ts`, `src/main/testing/singleton-reset.ts`,
  `src/main/ipc/ipc-main-handler.ts`, `src/main/ipc/memory-ipc-handler.ts`. `src/main/memory/training-loop.ts` (573 lines) is a different feature and stays.
- Deletable outright: Training 3,183 lines, Messaging page and service 1,090, three components 841: 5,114 lines in all. The messaging handler, preload and channel files need surgery, not deletion.
- **Other clients:** a search of `apps/` and `packages/sdk` (node_modules excluded) found 0 mentions of a `'training:` channel and 0 of "cross-instance" or "instance messaging". The cross-instance
  channels are the `COMM_*` keys at the top of `packages/contracts/src/channels/communication.channels.ts` (`comm:request-token`, `comm:send-message`, `comm:subscribe`, `comm:control-instance`,
  `comm:create-bridge`, `comm:get-messages`, `comm:get-bridges`, and more) within a file of 85 keys.

**Change.** **Do not start until James answers choice 11.** A yes to Training Data and the three components may go ahead even if Instance Messaging gets a no. (Recommended: delete Training Data and the three components; delete Instance Messaging too unless James has a plan for it.)
1. **Pre-checks:** re-run the orphan scan named in `docs/aio-ux-clarity.md`; re-run the `apps/` and `packages/sdk` search for `training:` and the `comm:` channel names (0 hits on 11 Oct); confirm
   `/training` and `/communication` have no inbound `routerLink`.
2. **Training Data:** delete `features/training/`, `training-ipc.service.ts` (and its line in `core/services/ipc/index.ts`), `training-ipc-handler.ts` and its spec, `grpo-trainer.ts` (and its line in
   `learning/index.ts`, `singleton-reset.ts`, `ipc-main-handler.ts`); remove the 16 `TRAINING_*` channels and their payload schemas; remove the training methods from `learning.preload.ts`; remove the
   route, the registry entry and the help entries. Run `npm run generate:ipc`, `npm run verify:ipc` and `npm run verify:ipc-usage`.
3. **Instance Messaging:** delete the page, `cross-instance-comm*.ts`, the cross-instance handlers inside `communication-handlers.ts`, the matching channels and preload methods, the route and the
   registry entry. First list which of the 85 channel keys belong to cross-instance messaging (the `COMM_*` group at the top of the file) and which to Cross-Session Messaging.
4. **Three components:** delete the three folders; they have no importers.
5. Remove Phase 5 step 3's `hidden` entries for the two screens (the flag itself stays for `chat-search`); remove them from the Tools & Views panel tests that name them.
6. The file-size ratchet only gets easier; remove any allowlist entry for a deleted file.

**Tests:**
- `control-surface.registry.spec.ts`: neither surface exists (the 52-link count assumption is not asserted today, so it is not needed).
- `verify:ipc` and `verify:ipc-usage` pass; typecheck and `build:renderer` pass (templates that named the deleted components would fail the build).
- The remaining specs for Cross-Session Messaging and the memory training loop still pass.

**Risks:**
- A deleted route breaks old bookmarks or deep links ("page not found"); Phase 5 step 3 already hides them from menus.
- Some user might use Instance Messaging; the page could work even though no other feature depends on it. That is why it is the part of this item most worth a yes from you.
- Reversible through git; the removal is large but mechanical.

**Done when:**
- No file named in the table exists (except the shared handler files, which no longer mention the removed features); the full gate (`tsc`, `typecheck:spec`, lint, `check:ts-max-loc`, `build:main`,
  `build:renderer`, the quiet test run) passes.

**Live checks:** a quick look at the menu and the Tools & Views panel on the Windows PC; open `/training` and `/communication` by link and confirm the normal "not found" page.

**Size and order:** M (large, mechanical). After Phase 5 step 3 if that lands first, otherwise it replaces it. Do it before Phase 3 step 9 (the menu regrouping) so the regroup does not carry dead entries.
No uncommitted work in these files on 11 Oct. Held for James's answer to choice 11.

### 5i. FU-B12: Small clean-ups: a dead shortcut, dead helpers, a dead setting and the size gate (XS each)

**For James:** Nothing you will see, except Settings no longer listing a shortcut that does nothing. These remove things that look real and are not.

**Origin:** Phase 3 "Found on the way" 6, Phase 4 "Found on the way" 5, 7 and 10, Phase 5 "Found on the way" 5, and Phase 1 and Phase 2 "Found on the way" (the stale ceiling); B#80, B#70, B#51, B#133,
B#83, and A#99 and A#170 (the same stale-ceiling finding).

**Verified (11 Oct):**
- **Dead shortcut:** `'focus-input'` ("Focus Input", default bare key `i`, context global) appears only in `src/shared/types/keybinding.types.ts:57,165-171`; no handler anywhere in non-spec code.
- **Dead helpers:** `setupCopyHandlers` (`src/renderer/app/core/services/markdown.service.ts:510`) and `setupFilePathHandlers` (`:572`) have no callers in `src`. The file is 586 lines. Phase 4 calls this
  "housekeeping"; the Housekeeping plan does not list it.
- **Dead setting** (CHANGED from Phase 3's "never read"): `instance-lifecycle.ts:1626` reads `residentClaudeSession` into `instance.residentClaude`, but `residentClaudeForSpawn` forces `true`
  (`lifecycle/interrupt-utils.ts:50-55`, `instance-lifecycle.ts:795-799`), the migration forces `true` (`core/config/settings-migrations.ts:188-190`) and the policy is `readOnly()`
  (`settings-control-policy.ts:323`). So it has no effect. Phase 1 text treats it as real.
- **Stale ceiling:** `scripts/check-ts-max-loc.ts:181` allows `codex-cli-adapter.ts` 3,344 lines; the file is 108 (re-measured on 11 Oct). Phase 5 says "housekeeping, E3", but the Housekeeping plan has no step for it.
- **Gate gap:** the size check reads `git ls-files '*.ts'` (`check-ts-max-loc.ts:621-625`), so a new untracked module is unchecked until staged. The script is exactly 700 lines. It was committed clean in
  `4d175e55b`, so the "dirty from another session" notes in the earlier reports no longer apply.

**Change:** items 1 to 3 delete a shortcut entry, two helpers and a setting: do not start them until James answers choice 10. Items 4 and 5 (the size limit and the size check) are not held.
1. Delete the `focus-input` entry and union member (decision: a bare global `i` shortcut is a hazard; delete rather than wire). Design pass first: confirm how stored custom bindings with an unknown id are
   handled (no crash, ignored).
2. Delete the two markdown helpers.
3. Remove `residentClaudeSession` from the five settings places, the line at `instance-lifecycle.ts:1626` (net -1 line) and the migration; keep `residentClaudeForSpawn`. (The two Phase 1 sentences that treated it as real were corrected on 11 Oct.)
4. Change the ceiling at `check-ts-max-loc.ts:181` to about 160; line-neutral.
5. Make the gate see untracked files without failing other sessions: list with `git ls-files -co --exclude-standard '*.ts'` and report an untracked file over the cap as a warning and a tracked one as an error.
   The script has no room, so put the new logic in `scripts/lib/` and keep the main edit line-neutral. Design pass first.

**Tests:**
- Keybinding spec (the defaults list has no `focus-input`); settings guard specs (the key is gone from all five places); the `check-ts-max-loc` spec (if one exists) gains an untracked-file case.

**Risks:**
- A user who rebound "Focus Input" loses an inert entry. The gate change can warn on other sessions' new files, which is the point.

**Done when:**
- Each item's search finds nothing; the gate warns on an untracked 701-line file.

**Live checks:**
- None.

**Size and order:** XS each; no dependencies. Collisions: `check-ts-max-loc.ts` (700/700), `instance-lifecycle.ts` (room 3; a net-negative edit is safe; land 2b first), `settings-migrations.ts` (shared with 5d). Items 1 to 3 held for James's answer to choice 10.

## Step 6. True numbers and honest signals (seven parts)

### 6a. FU-A10: "Tokens used" in helper-agent results stops showing context size for Claude (S)

**For James:** When a helper agent finishes, the note the parent gets says how many tokens it used. For Claude helpers that number is really how full its conversation was, not what it spent, so
it can look wildly different from the Costs page. After this it shows what the helper actually used, or says "not measured".

**Origin:** Phase 2 "Found on the way" 1; A#154.

**Verified (11 Oct):**
- `src/main/instance/instance-orchestration.ts:761` is `tokensUsed: child.totalTokensUsed,` (and `:1075`), shown in announcements by `child-announcer.ts:229, :276` (per Phase 2; only the first was read).
- `src/main/instance/instance-communication.ts:1592-1594`: "Prefer the lifetime spend counter; fall back to occupancy for adapters that don't emit cumulativeTokens (e.g. Claude).
  `instance.totalTokensUsed = usage.cumulativeTokens ?? usage.used`". So for Claude it is occupancy.

**Change:**
1. After Phase 0 step 7b (the per-turn Claude cost ledger), read the child's recorded token total from the ledger (new helper `childSpendTokens(childId)` in a new module `child-result-usage.ts`)
   and use it for `tokensUsed`; where no record exists send `undefined` and have `child-announcer.ts` print "not measured".
2. Do not change `Instance.totalTokensUsed` itself (other readers use it as occupancy; see Phase 2 "Found on the way" 1).

**Tests:**
- `instance-orchestration.spec.ts`: a Claude child with occupancy 180K and recorded spend 40K reports 40K (fails today); a child with no record reports none.
- `child-announcer.spec.ts`: the "not measured" wording.

**Risks:**
- Parents that parse the number out of the announcement text: check `orchestration-protocol.prompts.ts` before changing the format. `src/main/instance/instance-orchestration.ts` is 1,151 lines against a
  ceiling of 1,105 plus 50: 4 lines of room, so the two call sites (`:761`, `:1075`) must stay line-neutral and the logic goes in the new module. `child-announcer.ts` holds the wording.

**Done when:**
- A Claude helper's announced tokens match the day-check script's per-session total within rounding.

**Live checks:**
- One scratch Claude parent with a helper; compare with `npm run audit:claude-cost` (Phase 0 step 7b).

**Size and order:** S. After Phase 0 step 7b. Part of choice 13.

### 6b. FU-B3: The context ring ignores helper agents' request size (XS-S)

**For James:** While a helper agent works, the "how full is this conversation" ring can jump to the helper's size instead of the conversation's. After this it always shows the conversation.

**Origin:** Phase 3 "Found on the way" 9 (and step 14 item 5); B#54.

**Verified (11 Oct)** (inferred from the code path; not reproduced in a live session):
- `src/main/cli/adapters/claude-cli-adapter.ts:1339-1343` hands every `assistant` frame to `processClaudeAssistantMessage`; `src/main/cli/adapters/claude-assistant-message.ts:126-145` then emits
  `host.emit('context', { used: totalUsedTokens, total: contextWindow, percentage })` and sets `host.lastObservedContextUsage` for any frame with `message.usage`. That file never reads
  `parent_tool_use_id` (only `claude-cli-adapter.ts:918` does, for structured answers; the comment at `:908-912` says the CLI streams subagent turns into the same stream).
- `parent_tool_use_id` is typed at `src/main/cli/adapters/claude-cli-adapter.types.ts:73`.
- Phase 3 step 14 item 5 adds a `mainThread` flag (`!parent_tool_use_id`) to the same `context` event and says the ring fix "belongs to step 2 or Phase 1's A4"; neither plan does it.

**Change:**
1. In `claude-assistant-message.ts` (147 lines, room 553): read `assistantMsg.parent_tool_use_id`; when it is a non-empty string, skip the `context` emit, the `lastObservedContextUsage` update and
   `hasPerCallUsageThisTurn = true`. Keep `host.emit('status', 'busy')`.
2. If Phase 3 step 14 has landed, do it the other way round: keep the emit, include `mainThread`, and make the renderer's ring handler ignore `mainThread === false`.

**Tests:**
- `claude-assistant-message.spec.ts`: "a frame with parent_tool_use_id and large usage emits no context event" (fails today); "a main-thread frame still does".

**Risks:**
- `hasPerCallUsageThisTurn` is read at turn end to avoid double counting; verify it is not left false on a turn that only had helper frames (read the result handler first).

**Done when:**
- With a real Claude session that starts a helper reading large files, the ring stays at the conversation's size.

**Live checks:**
- Rebuilt app; one session, one foreground helper; watch the ring.

**Size and order:** XS-S. Independent. Do it before or with Phase 3 step 14 (same event). Part of choice 13.

### 6c. FU-B5: Ordinary error text stops raising "permission" cards (S; design pass first)

**For James:** In sessions that ask before acting, an error message from a file or web page that happens to contain words like "not allowed to" can look like a permission refusal and raise a card.
After this, only the real refusals do.

**Origin:** Phase 3 "Found on the way" 8; B#53.

**Verified (11 Oct):**
- `isPermissionDenialContent` matches any `is_error` string result containing one of 17 phrases, among them "not allowed to", "not permitted", "isn't allowed", "not authorized", "permission denied"
  (`src/main/cli/adapters/claude-cli-permission-details.ts:21-61`). Guards: a leading "Exit code N", and masking of `<word>: Permission denied`.
- Called from `src/main/cli/adapters/claude-cli-adapter.ts:1404` (log only) and `:1418`, and only when `!this.spawnOptions.yoloMode` and `block.is_error === true` (`:1411-1419`). James's default is
  auto-approve (Phase 1: `defaultYoloMode: true`), so this affects his ask-first sessions only.
- Not verified: how often it misfires in practice. No count exists.

**Change (design pass first):**
1. Read-only count: in saved Claude transcripts, how many `is_error` results contain each phrase, split by tool name, and which of them came from the CLI itself. Also read the CLI's own refusal
   sentences from the source snapshot (`Actual Claude/`).
2. New `src/main/cli/adapters/claude-denial-patterns.ts` (pure): the exact CLI sentences, plus a short allowed lead-in test for the generic phrases (text under about 300 characters and starting with the
   CLI's lead-in). `isPermissionDenialContent` calls it. Also require that `toolUseContexts` knows the tool use.
3. No change in `claude-cli-adapter.ts` (7 lines of room).

**Tests:**
- Fixtures from the real strings: a Read result quoting "you are not allowed to do that" is not a denial (fails today); each real CLI sentence still is.

**Risks:**
- Missing a real refusal brings back the silent-refusal bug; mitigated by keeping the exact CLI sentences and a fixture per version.

**Done when:**
- The fixtures pass and the count in change 1 shows no real refusal lost.

**Live checks:**
- None beyond fixtures.

**Size and order:** S. Independent. Low urgency (ask-first sessions only). Part of choice 13.

### 6d. FU-B2: The overnight "sessions are blocked" reminder counts Claude and Codex questions (S-M; design pass first)

**For James:** Today the overnight reminder and the approvals banner count only some kinds of waiting. A Claude or Codex session stuck on a question can sit for hours with no reminder. After this, any
session that is waiting for you is counted.

**Origin:** Phase 3 "Not in this plan" (Needs you) and "Found on the way" 2; B#7 (and its duplicate B#46).

**Verified (11 Oct):**
- The banner reads `pendingApprovalDigest({ pending: store.listPending(), ... })` from the durable approvals store (`src/main/ipc/handlers/security-handlers.ts:288-295`); the reminder is
  `startPendingApprovalWatcher({ listPending: () => store.listPending() })` (`src/main/app/cross-project-initialization-step.ts:105`; `src/main/orchestration/pending-approval-watcher.ts:38-60`). Same table, nothing else.
- Phase 3's check found Claude and Codex prompts never reach that table (136 approved, 32 denied, no pending rows; Phase 3 Corrections C4; counts not re-run).
- The digest input is `{ approvalId, instanceId, createdAt, expiresAt }` (`src/main/orchestration/pending-approval-digest.ts:14-19`). Sessions carry `status`, `waitReason`
  (`src/shared/types/instance.types.ts:479`) and `lastActivity`. Whether `lastActivity` stays fixed while a card is up is not verified.
- Phase 3 step 6 builds the "Needs you" count in the renderer from session status; the main-process reminder gets nothing from it.

**Change (design pass first: which timestamp says "waiting since"):**
1. New pure `src/main/orchestration/live-waiting-approvals.ts`: `liveWaitingAsApprovals(instances, now)` maps sessions in `waiting_for_permission` or `waiting_for_input` (not machine sessions, not auto-approve)
   to `PendingApprovalLike` rows (`approvalId: 'live:' + id`, `createdAt` = when the wait began, `expiresAt` = now + 24 h). If no reliable "wait began" time exists, add `waitingSince` where the status changes.
2. `cross-project-initialization-step.ts` (198 lines): `listPending: () => [...store.listPending(), ...liveWaitingAsApprovals(...)]`; the same merge for the banner handler (`security-handlers.ts`, 481 lines).
   De-duplicate by session so one session counts once.
3. Keep the digest's wording and cooldown; the title and body already say "N sessions blocked".

**Tests:**
- New `live-waiting-approvals.spec.ts`: a waiting Claude session becomes one row; a YOLO session and a loop session do not; a session with a durable row too counts once.
- `pending-approval-watcher.spec.ts`: a live-only waiting session older than 5 minutes raises the digest (fails today).

**Risks:**
- More reminders for James (by design); a session left waiting on a card by Phase 3 step 16 counts too. Quiet hours and the fingerprint already limit repeats.

**Done when:**
- A Claude session waiting on a question for over 5 minutes is included in the overnight reminder and in the banner count.

**Live checks:**
- Rebuilt app; leave an ask-first Claude session on a question for 6 minutes; one reminder names it.

**Size and order:** S-M. After Phase 3 step 6 (it defines "waiting" on screen so the two agree). Part 8a builds on this. Part of choice 13.

### 6e. FU-B4: Claude's "an MCP tool wants your input" requests get an answer (S; probe first)

**For James:** If a connector asks Claude for input (a sign-in or a form), Harness may never show it, and Claude may sit waiting. After this, the request shows up as a card, or is declined at once so
Claude carries on.

**Origin:** Phase 3 "Found on the way" 7; B#52.

**Verified (11 Oct):**
- The real CLI sends `control_request{subtype:'elicitation', mcp_server_name, message, mode, url, elicitation_id, requested_schema}` and awaits a reply (`Actual Claude/cli/structuredIO.ts:694-720`; a thrown
  error becomes `{ action: 'cancel' }`).
- The adapter's `case 'elicitation'` reads a flat message with `server_name`, `schema`, `request_id` (`src/main/cli/adapters/claude-cli-adapter.ts:1828-1876`): different key names and a different frame
  type. Whether the installed CLI really sends this in `--input-format stream-json` mode is not verified (Phase 3 calls it "inferred, not run").
- Phase 3 step 16 builds the first `control_request` handler (`can_use_tool`) and "an unknown subtype is ignored", so elicitation would still be ignored.

**Change (probe first):**
1. Probe on the installed `claude` with an MCP server that elicits: log the raw frame once at debug and record whether the CLI waits for a reply. If it never sends one, stop here and delete the dead flat
   `case 'elicitation'` instead.
2. If it waits: in Phase 3 step 16's dispatcher (`claude-live-permission.ts` or the control channel), handle `subtype:'elicitation'`. First version: reply `{ action: 'cancel' }` at once and show a grey line "Claude's
   connector <name> asked for input and Harness declined it". Second version: raise the existing `mcp_elicitation` card (Codex has one) and reply `accept` with the typed content.
3. `claude-cli-adapter.ts` has 7 lines of room: all of this goes in the new module.

**Tests:**
- New cases in `claude-live-permission.spec.ts`: an elicitation request writes a `cancel` reply (fails today); the answer card (second version) writes `accept` with content.

**Risks:**
- A wrong reply shape could hang a session; the probe settles the shape before any code. Only sessions with connectors that elicit are affected (rare).

**Done when:**
- A connector that asks for input no longer leaves the turn waiting for ever (probe-verified).

**Live checks:**
- Needs the installed Claude, a rebuilt app and an eliciting MCP server.

**Size and order:** S. After Phase 3 step 16 (it needs its dispatcher); the probe can run any time. Part of choice 13.

### 6f. FU-C8: The "Compact after token spend" setting does nothing; hide it now, wire it later (XS to hide; M to wire)

**For James:** In Settings there is a switch called "Compact after token spend" that says Harness will automatically compact an agent once it has spent that many tokens. It is off by default, and changing it
has no effect at all. After this, it disappears from Settings (your stored value is kept). Making it work is a bigger job and only worth it once the other compaction work has landed.

**Origin:** Phase 1 "Found on the way" 5; A#103.

**Verified (11 Oct):**
- **The words you see:** `src/shared/types/settings-metadata-runtime.ts:47-54` label "Compact after token spend", description "Automatically compact an agent once it has spent this many tokens since its last
  compaction, regardless of how full its context window is — a cost cap for long sessions. 0 turns it off." Surfaced as a tab setting at `settings-surfacing.ts:69` (`cumulativeTokenCompactionTrigger: 'tab'`);
  default `0` (`settings-defaults.ts:155`).
- **It is inert (traced):** the value is read once and handed to the coordinator (`src/main/app/compaction-runtime.ts:204`), which stores it (`src/main/context/compaction-coordinator.ts:123, :245-253`) and exposes it
  through `getCumulativeTokenTrigger()` (`:258-260`). The only callers of that getter are the spec (`compaction-coordinator.spec.ts:322-326`). `cumulativeTokenTrigger` is referenced nowhere else in `src/main`, so no
  decision reads it.
- **Why wiring is not trivial:** the cumulative counter a rule would compare exists for Codex, Gemini, Copilot, ACP, Cursor and Antigravity but not Claude ("adapters that don't emit cumulativeTokens (e.g. Claude)",
  `src/main/instance/instance-communication.ts:1593`). On Claude, the per-turn cost ledger of Phase 0 step 7b is the natural source.
- It conflicts with the compaction rework in Phase 0 step 10 (A1) and Phase 1, which change when and how compaction runs.

**Change (recommended: hide):**
1. `settings-surfacing.ts:69`: change `'tab'` to `'hidden'` (the type allows `'tab' | 'bespoke' | 'hidden' | 'internal'`, `:36`). Check `settings-surfacing.spec.ts` and the metadata consistency specs for a rule that
   a hidden key has no metadata entry; if there is one, delete the metadata block (`settings-metadata-runtime.ts:47-54`) in the same edit. Do this after Phase 1 step 5a: its two new ceiling settings copy this entry's category (`memory`) and surfacing (`'tab'`) (`phase1-token-levers_plan.md:1438-1440`); if 6f has to go first, tell Phase 1 to use those two literal values. Keep the key in `settings.types.ts:134`, `settings-defaults.ts:155` and
   `settings-control-policy.ts:344`, so stored values and the `$AIO_MCP settings` path still validate. No new wording is shown.
2. Only if James wants it wired, later: in `CompactionCoordinator`'s decision step compare `cumulativeNow - baselineAtLastCompaction` with `cumulativeTokenTrigger` when it is above zero, with trigger name
   `cumulative-tokens` and the same guards as the occupancy trigger; feed Claude from the step 7b ledger. Not part of this item.

**Tests:**
- Settings surfacing spec: the key is `hidden` and absent from the Settings tab model.
- `compaction-coordinator.spec.ts:322-326` still passes (the setter stays).

**Risks:**
- None for behaviour. Anyone who set a value expecting an effect never had one.
- Check `docs/llm/AIO_MCP_CLI_REFERENCE.md` and the help text for mentions; the first file is modified by another session (its diff was not read).

**Done when:**
- Settings no longer lists the switch; the stored value, if any, survives a restart.

**Live checks:**
- None.

**Size and order:** XS to hide. Land after Phase 1 step 5a (see change 1); otherwise no dependency. Wiring (M) belongs after Phase 0 steps 7b and 10. Choice 12(a).

### 6g. FU-C9: A missed lookup of a saved session record stops reading all 4.7 GB (S-M; measure first)

**For James:** When Harness looks for a saved session record by its history or session id and does not find it by file name, it opens every saved record one by one until it finds a match, or reaches the
end. There are 7,699 records holding 4.7 GB. After this, Harness keeps a small index of those ids, so a miss costs a lookup, not a 4.7 GB read. First it adds a timing line so we can see how often this
happens in real use.

**Origin:** Housekeeping "Found on the way" 3; A#196.

**Verified (11 Oct):**
- **The scan:** `src/main/session/session-continuity.ts:356-392` `loadStateFromDiskByIdentifier`: tries `<id>.json` directly (`:361-366`); on a miss it runs `fs.promises.readdir(this.stateDir)` and then, file by
  file, `await this.readPayload(...)` (a full read and parse) and tests `getStateLookupKeys(state).includes(normalized)` (`:379-388`), returning the first match or `null` after the last file. The keys are only
  `instanceId`, `historyThreadId` and `sessionId` (`session-continuity-state.ts:76-91`).
- **Callers:** `hydrateTrackedState` (`:311`), `resumeSession` (`:885`, lookup at `:904`) and `markNativeResumeFailed` (`:972`). A miss is any id with no file named after it that is also not a stored
  `historyThreadId` or `sessionId`; how often that occurs was not measured (there is no log line on this path: the only log is the error at `:370`).
- **The data (read-only):** `~/Library/Application Support/harness/session-continuity/states` holds 7,699 files, 4,680.5 MB; median 32 KB, 95th percentile 3,004 KB, largest 122.6 MB. A full miss reads and parses
  4.7 GB on the main process's async reader, with one `JSON.parse` of up to 122 MB at a time. Only the 250 most recent files are loaded at start-up (`maxLoadedStateFiles: 250`, `:106`).
- `session-continuity.ts` is 1,742 lines; its ratchet ceiling is 1,713, so room is 21 lines with the allowance. Housekeeping step 5 also edits about 10 lines of it.

**Change:**
1. **Measure first (XS):** wrap the scan in a counter and log once per scan `logger.info('Identifier lookup scanned state files', { scanned, ms, found })` (about +6 lines).
2. New module `src/main/session/session-continuity-lookup-index.ts` (about 120 lines): an in-memory `Map<string, string>` from each lookup key to the file name, persisted as
   `session-continuity/lookup-index.json` (about 1 MB: 7,699 records × 3 keys), written atomically (temp file and rename) with a 2-second debounce. API: `get(id)`, `upsert(state)`, `remove(instanceId)`,
   `isComplete()`.
3. `session-continuity.ts`: call `upsert` where a state is written and `remove` where one is deleted (the write and delete sites are the ones Housekeeping step 5 touches; they were not traced yet), and at the top
   of the miss path: if the index is complete and has no entry, return `null` without scanning; if it has an entry, read that one file.
4. **Backfill, once:** the index starts incomplete. A background task reads the state files newest first, 20 at a time with a short pause, skips files over 20 MB for later, and marks the index complete when done;
   until then a miss falls back to today's scan, but with a negative cache (id to time, 10 minutes) so the same miss is not rescanned. The task does not run while a loop is active.
5. Extra room: the new module carries the logic; `session-continuity.ts` gets about +12 lines. If Housekeeping step 5 uses its 10 lines first, the index calls move behind one `lookupIndex` property.

**Tests:**
- New `session-continuity-lookup-index.spec.ts`: upsert, remove, atomic write, reload, incomplete versus complete, the 10-minute negative cache with a fake clock.
- `session-continuity.spec.ts`: a miss with a complete index reads no state file (spy on `readPayload`; fails today); a hit by `historyThreadId` reads exactly one; a miss with an incomplete index still finds a
  state by scan; a record saved after start-up is found without a scan.

**Risks:**
- A stale index entry (file removed outside Harness) is handled by falling back to a scan when the named file is missing. The index is derived data: deleting it only triggers a new backfill.
- The backfill reads up to 4.7 GB once; it is throttled, newest first, and skips big files. No model cost.

**Done when:**
- A miss on the real folder with a complete index logs `scanned: 0`; a deliberately missing id returns in milliseconds.

**Live checks** (Mac, real data): after the first run, `ls -l` the index file and look for the backfill's completion line; then resume an old session by its history id.

**Size and order:** S-M. After Housekeeping step 5 (same function area). Change 1 (the timing line) can ship alone first. Part of choice 13.

## Step 7. Screen, wording and access (ten parts)

### 7a. FU-A9: The message box stops offering attachments that the chosen provider will refuse (S)

**For James:** On Gemini, Antigravity and local-model chats you can attach a file, press Send, and only then get an error. After this the attach control tells you up front, or is disabled with a reason,
for those providers.

**Origin:** Phase 1 "Found on the way" 8; A#106.

**Verified (11 Oct):**
- Each of these adapters throws on any attachment: `src/main/cli/adapters/gemini-cli-adapter.ts:198-199` ("Gemini adapter does not currently support attachments in orchestrator mode."),
  `antigravity-cli-adapter.ts:176-177` and `local-model-chat-adapter.ts:172-173`.
- No composer-side capability flag exists (searched `src/renderer` and `src/shared` for `supportsAttachments`, `canAttach` and `attachmentSupport`: nothing). Phase 1 step 12d adds
  `providerTakesPathAttachments(...)` for big pastes only (Phase 1 plan line 2778); that helper can be reused.

**Change:**
1. Reuse or extend `providerTakesPathAttachments` (Phase 1 step 12d) into one exported `providerAcceptsAttachments(provider)` in `src/shared`; the three refusing providers return false.
2. In the composer, when false: disable the attach button (it stays visible) and ignore drops and pastes, with a tooltip through `appTooltip` and `TOOLTIP_COPY` ("Gemini chats in Harness cannot take attachments
   yet") and a visible disabled-state line (a tooltip may not be the only place that shows a state).
3. Keep the adapters' errors as the last line of defence.

**Tests:**
- Composer spec: attach is disabled for each refusing provider and enabled for Claude, Codex, Copilot, Cursor, OpenCode and Grok (fails today).

**Risks:**
- If an adapter later gains attachment support, the list must follow; the shared function is the single place.

**Done when:**
- No refused provider shows a working attach control.

**Live checks:**
- None.

**Size and order:** S. After Phase 1 step 12d if that is built; otherwise standalone. Phase 4's tooltip rules apply. Part of choice 13.

### 7b. FU-B6: "Shown N times" counts real session starts, and unused notes can be suggested for removal (S-M)

**For James:** The memory page's "Shown N times" can count a note again when you press Rebuild or a session recovers from a compaction. After this it counts only sessions that really started with the note.
The page can then suggest notes that were never shown or whose source file changed, and you remove them yourself with the five-second Undo.

**Origin:** Phase 3 "Not in this plan" (costs), Phase 5 "Not in this plan" (A20.3) and "Found on the way" 12 (the second half of MEM-2); B#35, B#120 and B#140.

**Verified (11 Oct):**
- `src/main/memory/wake-context-builder.ts:255-266` `recordHintUsage`: `UPDATE wake_hints SET last_used = ?, usage_count = usage_count + 1 WHERE id IN (...)`, called at the end of every L1 build (`:242`).
  Compaction recovery rebuilds with `getWakeUpText(wing, { bypassCache: true })` (`src/main/app/compaction-recovery.ts:103`), and the memory page's Rebuild does the same (inferred from its name; the call site was not read).
- Phase 3 step 15 item 4 changes the label to "Shown N times" with the tooltip "How many sessions were given this note at the start", which the counter does not match.
- Real "was it used" detection exists only for loop lessons and (after Phase 3 step 15) for observation reflections (`detectUsedLessons`); none for wake notes.
- Phase 5 step 14 builds the page and the five-second Undo; it says it does not carry the two source ids through `addHint`, so what a wake note records about its source is not verified.

**Change:**
1. Count only real starts: give `getWakeUpText` (the L1 build) an option `recordUsage` (default true for new-session builds; false for Rebuild and compaction recovery). `wake-context-builder.ts` is 365 lines (room 335).
2. After Phase 5 step 14: add a "Suggested for removal" fold on the memory page, built by a pure `memory-removal-suggestions.ts`: notes shown at least 10 times in 30 days where the source file's content no longer
   matches (needs the note's recorded source; design pass first), or never shown in 60 days. Each row has "Remove" (Phase 5 step 14's Remove with Undo). Never automatic.
3. Because "used" cannot be known for wake notes, the page says "never shown" and "source changed", not "never used".

**Tests:**
- `wake-context-builder.spec.ts`: Rebuild and compaction recovery do not bump `usage_count` (fail today); a new session does.
- New `memory-removal-suggestions.spec.ts`: thresholds, and a changed source is flagged.

**Risks:**
- Hiding notes James can see is why this waits for the page; suggestions only keep it safe. A missing source record would make "source changed" impossible for old notes.

**Done when:**
- Pressing Rebuild leaves "Shown N times" unchanged; the suggestion fold lists a stale note and its removal can be undone.

**Live checks:**
- Rebuilt app: press Rebuild twice and compare the count; remove and Undo a suggested note.

**Size and order:** change 1 is XS and can ship now with Phase 3 step 15; changes 2 and 3 are S-M after Phase 5 step 14. Part of choice 13.

### 7c. FU-B7: A "Helper agents: N running" chip above the message box (S)

**For James:** While helper agents work, a small chip above the message box says how many are running, for example "2 helper agents running".

**Origin:** Phase 3 "Not in this plan" (costs, "unowned") and Phase 5's strip; B#34.

**Verified (11 Oct)** (all of this is plan text; none of those pieces exist on disk yet):
- Phase 3 step 5 builds the strip as a typed chip list (Phase 3 plan, lines 1146-1150), and step 12b part 4 supplies `SubagentUsageStore.summary(instanceId)` returning `{ running, finished, toolUses }` (Phase 3 plan, lines 3365-3367). Phase 5 step 16 adds
  only the "+N more" overflow rule and a guard test on the typed list (Phase 5 plan, line 2052). Phase 3 says the chip "needs its own label" and must not use the word "Agents" (Phase 3 plan, lines 3337-3339). Neither plan builds the chip.

**Change:**
1. After Phase 3 steps 5 and 12b and Phase 5 step 16: register one chip in the strip's typed list from a new `features/instance-detail/helper-agents-chip.ts` (a pure descriptor) reading `SubagentUsageStore.summary`.
   Show it only when `running > 0`; label "N helper agent(s) running"; tooltip through `TOOLTIP_COPY` flat key `'strip.helperAgents'`: "Helper agents the AI started inside this session. They are not separate sessions."
2. No panel: the chip is informational; the per-helper rows already sit in the transcript (Phase 3 step 12b).

**Tests:**
- A descriptor spec (hidden at 0, singular and plural, never says "Agents"); a strip spec: the chip sits in the overflow after Phase 5 step 16's limit.

**Risks:**
- The numbers are the throttled samples from step 12b; "running" may lag by up to 2 seconds.

**Done when:**
- A session with one running helper shows "1 helper agent running", and the chip disappears when it ends.

**Live checks:**
- Rebuilt app; one real turn with two helpers.

**Size and order:** S. After Phase 3 steps 5 and 12b and Phase 5 step 16. No new IPC.

### 7d. FU-B8 (second half): Say in the transcript when Build, Plan or Review changes (XS, after 2b)

**For James:** When you switch a session between Build, Plan and Review, the conversation shows nothing plain about it. After this it shows a short grey line saying what changed and what the session may now do.

**Origin:** Phase 3 "Not in this plan" (session screen); B#2, second half. (B#36, "automation first prompts are not covered by MEM-1", turned out to need nothing; see "Found on the way".)

**Verified (11 Oct):**
- Phase 3 step 3 (C8) supplies `src/shared/session-posture.ts` (planned, not on disk) for the plain sentence.
- Whether the transcript echoes the model-facing `[SYSTEM MODE CHANGE ...]` text was not checked (see 2b for the anchors).

**Change:**
1. In the new `lifecycle/agent-mode-change.ts` from part 2b, after the model message is sent, emit one display-only `system` output message (not sent to the adapter): "Switched to Plan mode: edits are off, the session
   can read and plan." using `describeSessionPosture` from Phase 3 step 3. Harness wording; no "YOLO".
2. The model-facing text stays byte for byte (prompts and caches do not change).

**Tests:**
- `agent-mode-change.spec.ts`: the receipt is emitted and is not passed to `adapter.sendInput` (fails today: no receipt).

**Risks:**
- Other plans also touch this file (see 2b); the pure move goes first.

**Done when:**
- Switching modes leaves a plain grey line, and the model-facing text is unchanged.

**Live checks:**
- Rebuilt app: switch Plan to Build and back.

**Size and order:** XS. After 2b and Phase 3 step 3.

### 7e. FU-B9: Invisible "close" buttons stop being Tab stops (XS-S)

**For James:** Keyboard users tabbing through Settings and a few menus land on invisible buttons called "Close menu". After this Tab skips them and Escape still closes the menu.

**Origin:** Phase 4 "Found on the way" 2; B#76.

**Verified (11 Oct):**
- `src/renderer/app/features/settings/settings.component.html:9-14` is `<button type="button" class="settings-nav-scrim" aria-label="Close settings navigation" (click)="closeCompactNav()">` and `:364-369` the same for
  `settings-help-drawer-scrim`; neither has a `tabindex`.
- The same class pattern (by class name only; `tabindex` not read on each): `instance-header.component.html:85` (`open-menu-backdrop`), `session-progress-panel.component.ts:147` and `session-artifacts-strip.component.ts:183`
  (`ctx-menu-backdrop`, `aria-label="Close menu"`), `child-diagnostic-bundle.modal.component.html:5`, `recent-directories-dropdown.component.ts:186` and `node-picker.component.ts:83`. Phase 4 says eight in all.
- Phase 4 step 4b only exempts them from the counts; Phase 4 step 6b's new Help drawer scrim already uses `aria-hidden="true"` and `tabindex="-1"`. Not tested in a browser.

**Change:**
1. For each backdrop button add `tabindex="-1"` and `aria-hidden="true"`.
2. First check that each overlay closes on Escape; where it does not, add the Escape handler (otherwise a keyboard user has no way out).
3. A small guard test: every `<button` whose class matches `scrim|backdrop` has `tabindex="-1"` (a grep-style spec over templates and inline templates, with an allowlist).

**Tests:**
- One spec per template asserting the attributes; the guard spec (fails today for the eight).

**Risks:**
- Removing the only keyboard route to dismiss where Escape is not handled; change 2 covers it.

**Done when:**
- Tab never lands on a scrim; Escape closes each overlay.

**Live checks:**
- (Windows PC) Tab through Settings with the compact menu open and with the help drawer open.

**Size and order:** XS-S. After Phase 4 step 4b (markers), so the counter exemptions stay in step; templates are not counted by the size ratchet.

### 7f. FU-B10: Every form field has a name, and a rule keeps it so (S-M)

**For James:** Some input boxes (about 26 in the verification pages) have no name for a screen reader. After this they do, and a check stops new unnamed ones appearing.

**Origin:** Phase 4 "Not in this plan" and "Found on the way" 3 and 4; Phase 4 part 3 "Not in this plan" and "Found on the way"; B#62 and B#61.

**Verified (11 Oct):**
- Phase 4 part 3 step 1f counts 26 unnamed inputs in the verification folder from audit evidence (Phase 4 part 3 plan, line 292); its "Done when" lists the strict rules H1a to H10 and does not include form fields (Phase 4 part 3 plan, line 302). Phase 4
  step 2's counter "prints a number; nothing gates it" (Phase 4 part 1 plan, line 2530). The 26 was not re-counted.
- One "opaque" control (a button holding only a child component) is reported, not judged: `features/remote-nodes/remote-nodes-page.component.ts:45` (Phase 4 "Found on the way" 3, unverified).

**Change:**
1. Counter rule, report-only first: an `input`, `textarea` or `select` needs `aria-label`, `aria-labelledby`, a wrapping `<label>`, or an `id` matched by a `<label for>` in the same template (placeholder and `title`
   never count, as for buttons). Same reader and record logic as Phase 4 step 4a.
2. Name the 26 verification inputs as part of 1f (a visible label or `aria-label`); then the rest of the tree as the counter shows.
3. When the count is zero, move the rule to the guard (a one-line record change) and add it to the lint plug-in (Phase 4 step 9 / part 3 step 2).
4. Ratchet the opaque-control count if it grows.

**Tests:**
- Counter fixtures (named by label, by `for`, by `aria-label`; a placeholder-only field is unnamed); the verification templates' specs for the new names.

**Risks:**
- "Named by a wrapping label" needs the reader to handle nested content; a false "unnamed" would block unrelated work, which is why it starts report-only.

**Done when:**
- The counter shows zero unnamed fields and the guard holds it.

**Live checks:**
- Optional: a screen reader on the Windows PC reads a verification field's name.

**Size and order:** S-M. After Phase 4 step 4 (the guard) and with Phase 4 part 3 step 1f. Part of choice 13.

### 7g. FU-B11: Money is shown in cents on the Costs page and the other cost screens (S)

**For James:** The Costs page shows amounts like "$0.730207". After this it reads "$0.73" (or "under 1 cent"), with the exact value one hover or click away, the same as the other screens.

**Origin:** Phase 5 "Not in this plan" (C13.3); B#110 and B#111. Phase 5 hands the Costs page to Phase 0 step 7h; Phase 0 step 7h has no format work, so nobody does it.

**Verified (11 Oct):**
- Costs page: `src/renderer/app/features/cost/cost-page.component.html:34,52,82,87,92` use `toFixed(4)` and `:146,187,234` use `toFixed(6)`.
- Other ad-hoc formatters: `features/verification/results/verification-results.component.ts:84` (`toFixed(4)`), `features/verification/execution/verification-monitor.component.ts:643`,
  `features/local-ai-guard/local-ai-fallback-notification-groups.ts:74`, and the loop's `formatCostCents` (`features/loop/loop-formatters.util`, used by `loop-control.component.ts:740`).
  `src/renderer/app/shared/utils/format-money.ts` does not exist yet; Phase 5 step 11 creates it.
- Phase 0 step 7h has no precision or format wording (searched: nothing).

**Change:**
1. After Phase 5 step 11 creates `format-money.ts` (`formatMoneyPlain(usd)` and the exact form): replace the Costs page numbers with the helper. Headline cards use the plain form; the per-model and per-entry
   tables show the plain form with the exact amount in the cell's tooltip (`appTooltip`, flat key `'cost.exactAmount'`: "Exact amount: {value}"), because the Costs page is where James checks sums.
2. Move `verification-results.component.ts:84`, `verification-monitor.component.ts:643` (657 lines, room 43) and `local-ai-fallback-notification-groups.ts:74` onto the helper; make the loop's `formatCostCents` call it.
3. A grep-style spec: no `toFixed(4)` or `toFixed(6)` next to a `$` in renderer files, with an allowlist for exact-value tooltips.

**Tests:**
- Each file's spec; `format-money.spec.ts` already covers `$0.7302072 → "$0.73"` (Phase 5 step 11); the guard spec fails today.

**Risks:**
- Rounding can hide a real difference when reconciling; the exact value stays on hover. Phase 0 step 7h and Phase 3 steps 12b and 13d edit the same page: land this after them.

**Done when:**
- No screen prints more than cents without an "exact" hover.

**Live checks:**
- Rebuilt app: open the Costs page and compare a total with its exact hover.

**Size and order:** S. After Phase 5 step 11 and Phase 0 step 7h. Template edits are not counted by the size ratchet. Part of choice 13.

### 7h. FU-B13: Give the switches people may want a row in Settings (S; design pass first; a pick for James)

**For James:** A few switches that change how Harness behaves have no place in Settings, so the only way to change them is a config edit. After this the ones worth having show up there.

**Origin:** Phase 3 "Not in this plan" (wording and Settings, UX-9); B#13.

**Verified (11 Oct):**
- Changed: they are not all "missing". Four are marked `'internal'` (the registry records where a setting is surfaced, not whether a row is wanted) in `src/shared/types/settings-surfacing.ts` (`injectRepoMap` `:224`, `detectDegradedAdapterOutput` `:226`, `enableSpawnWorkerOffload` `:231`,
  `transcriptVirtualization` `:257`) and `toolLoopAutoInterrupt` is `'bespoke'` (`:229`) with controls in `loop-control.component.ts` and `notification-center.component.ts`.
- Defaults (`settings-defaults.ts`): `injectRepoMap: true` (`:385`), `detectDegradedAdapterOutput: false` (`:389`), `toolLoopAutoInterrupt: false` (`:392`), `enableSpawnWorkerOffload: false` (`:398`),
  `transcriptVirtualization: false` (`:446`).
- No plan gives any of them a row (searched all nine; only Phase 1 names `enableSpawnWorkerOffload` in passing).

**Change (design pass first):**
1. Decide per switch. Recommendation: a row for `injectRepoMap` (a token lever that is on) and `transcriptVirtualization` (a speed option that is off); leave `enableSpawnWorkerOffload` and
   `detectDegradedAdapterOutput` internal; `toolLoopAutoInterrupt` keeps its bespoke controls.
2. For each chosen switch, the five places: type (`settings.types.ts`), default, surfacing (`'tab'`), metadata (`category`, plain label and description, Harness wording) and `settings-control-policy.ts`
   (`open(z.boolean())`). Part 2a should land first.
3. Where the row sits follows Phase 3 step 10's sections (Advanced).

**Tests:**
- The settings guard specs pick the keys up in all five places; a component spec for the row text.

**Risks:**
- Exposing `transcriptVirtualization` invites a half-tested option; label it "Experimental".

**Done when:**
- The chosen switches appear in Settings and change behaviour without a restart (check whether `requiresRestart` is needed per switch).

**Live checks:**
- Rebuilt app: flip each chosen switch.

**Size and order:** S. After Phase 3 step 10 (sections) and part 2a. **Decision for James:** which switches (choice 12(b); recommendation above).

### 7i. FU-B14: Ask before Auto-approve is switched on for a running session (XS-S; James's call; recommended: do not build)

**For James:** Switching a running session to Auto-approve takes one click and asks nothing. If you want a safety question there, this adds one; if not, skip this part.

**Origin:** Phase 4 part 2 "Not in this plan" (which hands it to "Phase 3's C8"); B#88.

**Verified (11 Oct):**
- The header badge `class="yolo-badge"` is a toggle button (`src/renderer/app/features/instance-detail/instance-header.component.html:223-226`) that emits `toggleYolo` (`instance-header.component.ts:315`); that
  file contains no `confirm`. The store's `toggleYoloMode` (`src/renderer/app/core/state/instance/instance-list.store.ts:399-405`) asks nothing. The parent handler in `instance-detail.component.ts` was not read.
- Phase 3 step 3 (C8) never asks (searched its text: no confirm about enabling), and backlog C8 (`claude_oct-todo.md:755-763`) does not list one. So the hand-off in Phase 4 part 2 has no receiver.
- James's live default is auto-approve for new sessions (`defaultYoloMode: true`), so this affects only a switch-on of an existing session.

**Change:**
1. After Phase 5 step 7 (the one Harness confirm box): the header handler asks only on OFF to ON, not for new sessions that start in the default, and not when turning off: "Turn on Auto-approve for this
   session? Harness will run tools in this session without asking you. You can turn it off from the same badge." Buttons "Turn on Auto-approve" and "Cancel", focus on Cancel.
2. No new setting.

**Tests:**
- `instance-header` or `instance-detail` spec: turning on opens the box and does nothing until confirmed (fails today); turning off does not ask.

**Risks:**
- Friction for someone who flips it often. Recommendation: do not build unless James says yes; he already runs Auto-approve by default and the header shows it.

**Done when:**
- If built: switching on asks once, and Cancel leaves it off.

**Live checks:**
- Rebuilt app: toggle on a running session.

**Size and order:** XS-S. After Phase 5 step 7. `instance-header.component.ts` is 694 of 700 (room 6): put the call in `instance-detail.component.ts` or a new helper. **Decision for James:** build it or not (choice 14(a);
recommend: not).

### 7j. FU-B16: Memory reviews and repository jobs appear in "Needs you" at once (S; design pass first)

**For James:** Memory reviews and repository jobs can take up to 5 and 2 minutes to appear in "Needs you" (or when you switch back to the app). After this they appear at once.

**Origin:** Phase 3 "Not in this plan" (Needs you); B#10.

**Verified (11 Oct):**
- Phase 3 step 6c: `repoJobStore.refresh(false)` "every 2 minutes and on window focus"; `memoryReviewStore.refresh()` "every 5 minutes and on focus. No other new polling" (Phase 3 plan, lines 1385-1386). Phase 3 says neither has a push
  event (Phase 3 plan, line 4440). The emit points in main were not located.

**Change (design pass first: where reviews and jobs are created and resolved in main):**
1. Two channels (`MEMORY_REVIEW_CHANGED`, `REPO_JOB_CHANGED`) in `packages/contracts/src/channels/*.channels.ts`; `npm run generate:ipc`; entries in `src/main/event-bus/renderer-event-validation.ts`; a push domain in
   `diagnostics.preload.ts` (`instance.preload.ts` is full); `npm run verify:ipc` and `verify:ipc-usage`.
2. Emit from the places that create or resolve a review or job; the stores refresh on the event and keep the slow poll as a backstop.

**Tests:**
- A validation spec (a valid payload passes, a malformed one is dropped); a store spec (an event triggers one refresh).

**Risks:**
- Event storms from bulk jobs: throttle to one per second.

**Done when:**
- A new memory review shows in "Needs you" within a second.

**Live checks:**
- Rebuilt app: create a review and watch the count.

**Size and order:** S. After Phase 3 step 6c.

## Step 8. Parked: needs a design pass or a trigger first (five parts)

None of these is started until its trigger fires or James says yes, and none blocks closing this plan. Each part keeps the facts the checkers found so the next person does not start from zero. "Tests, risks, done when and
live checks" are written when the design pass is done.

### 8a. FU-B15: A "Needs you" number on the phone app and the thin client (M; design pass first; James's call)

**For James:** The desktop gets one "Needs you" number (Phase 3). Your phone and the thin client show nothing like it. After this they show the same number. The phone already pushes a notice for each prompt, so this is
optional; the recommendation is to wait until Phase 3 has been in use.

**Origin:** Phase 3 "Not in this plan" (Needs you, "later"); B#6. A related piece, the phone's other Needs-you screens, stays in the rest of the list.

**Verified (11 Oct):**
- Phase 3 builds the count in a renderer-side root store (Phase 3 step 6c); main has no equivalent. The phone gets a push per prompt (`src/main/mobile-gateway/mobile-gateway-push.ts:54-87`, title `"<tool> needs approval"`)
  and a lock-screen status word (`liveActivityStatusLabel`, `:90-103`), and no total.
- Phase 0 step 3 only covers closing sessions on phone and thin client. The phone app is in this repo (`apps/mobile`). The phone's session list and DTOs were not read.

**Change (design pass first):**
1. A pure main-side `needs-you-summary.ts` shared with 6d's `live-waiting-approvals.ts` (waiting sessions), plus loop questions (Phase 2 step 13 data) and failed runs, using the same rules module as Phase 3
   (`question-need.ts`, `attentionLevelForLoopQuestion`).
2. Add `needsYouCount` to the mobile gateway's session-list DTO (and the thin-client snapshot); IPC steps from the ground rules if a new channel is needed.
3. Phone app TypeScript (`apps/mobile/src`): a badge on the sessions tab; no nagging while the app is in front.
4. Needs a phone rebuild and reinstall.

**Tests / Risks / Done when / Live checks:** after the design pass. A summary spec should reuse the renderer's cases so the two counters cannot drift; the phone and the desktop must show the same number for the same
state; James's iPhone and a rebuilt app are needed.

**Size and order:** M. After 6d, Phase 3 step 6 and Phase 2 step 13. Choice 14(b).

### 8b. FU-B17: Follow-ups to Phase 3's "Allow once for every tool" (design pass first, after its live checks)

**For James:** Phase 3 step 16 ships switched off. Once it has been seen working, these finish the job: fewer process restarts on shell commands, asks that Auto-approve cannot skip, and answering Claude's questions
inside the turn.

**Origin:** Phase 3 "Not in this plan" (menus) and "Found on the way" 5; B#23 (and its duplicate B#50), B#24, B#25, B#26, B#28 and B#29.

**Verified (11 Oct)** (these rest on Phase 3's own findings, which were not re-read in code): the shell hook defers every Bash command and its safe-tool list is dead code (`defer-permission-hook.mjs:22-27,66-70`);
`AskUserQuestion` is denied at once with no card in step 16 (Phase 3 tests); only the ACP adapter emits `input_required_resolved` (`acp-cli-adapter.ts:1963`, checked by Phase 3). Nothing else in the nine plans builds
any of them.

**Change** (each a separate small change, only after step 16's live checks 1 to 4 pass and its default is on):
1. Retire the shell defer hook so shell asks use the live channel (M; changes what asks, because Claude's own allow rules then apply first; needs a side-by-side run).
2. Live asks for auto-approve sessions' "bypass-immune" asks, such as edits to Claude's own settings files (S-M).
3. Answer `AskUserQuestion` natively: allow with the answers in `updatedInput` (S).
4. Apply Claude's `permission_suggestions` to its settings files, only if James says yes to Phase 3 choice 13's alternative (S). **Recommended: no** (it writes into his global Claude settings; choice 14(c)).
5. Resolved-event receipts ("request ended") from Codex, Gemini, Copilot and Cursor, and on the phone view via `request-outcome.ts` (S each).

**Tests / Risks / Done when / Live checks:** per change, written when each is designed; all need a real Claude session and the rebuilt app.

**Size and order:** M in total. After Phase 3 step 16 and its default flip.

### 8c. FU-B18: An "Everyday / Full" view switch, and tabbed pages instead of 52 menu entries (L; design pass first)

**For James:** Phase 3 shortens the menu and keeps everything. This is the bigger idea: one switch that hides the instrumentation for a calmer screen, and related pages merged into tabbed pages.

**Origin:** Phase 3 "Not in this plan" (menus; session screen; Needs you); B#21, B#22, B#5 and B#33.

**Verified (11 Oct):**
- Backlog C10: "Better still, an 'Everyday / Full' view switch ... AIO must never hide the auto-approve indicator in the simple view" (`claude_oct-todo.md:770-771`). Phase 3 choice 6 defers it "because the switch hides parts
  of the session screen that steps 2 and 5 are still reshaping" and names a Phase 5 item or a follow-up plan; Phase 5 has no such step (searched `interfaceMode|Everyday / Full` over all nine: only Phase 3).
- Phase 3 step 9 item 7 is the optional page-visit recording (`NavigationEnd`); nothing counts visits today.

**Change (design pass first):**
1. Collect two to four weeks of page-visit data with Phase 3 step 9 item 7 switched on, to decide which pages are everyday.
2. A setting `interfaceMode: 'everyday' | 'full'` in the five places, default `full`; it never overwrites user settings (a shadow layer), and the palette is always the way back.
3. A guard spec: approvals, "Needs you", errors and the Auto-approve indicator are never hidden in any mode.
4. Tabbed pages: Compare & verify (Verification, Debate, Council, Split Compare), Memory, Search, Health, Remote computers; drop the four "Workspace layout" presets in Tools & Views (UX-7).

**Tests / Risks / Done when / Live checks:** after the design pass. Main risk: hiding something that matters (the guard); second: broken links (keep every route).

**Size and order:** L. After Phase 3 steps 5 and 9. **Decision for James:** whether he still wants it once the Phase 3 menu is in use (choice 14(d)).

### 8d. FU-B19: Small tidy-ups that wait for a trigger (XS-S each)

**For James:** Nothing to notice; these finish earlier work once their condition is met.

**Origin:** B#1, B#17 (and its duplicate B#68), B#18, B#19 (and B#69), B#59 (and B#90), B#60, B#64, B#65, B#85, B#89 and B#93 (also A#84, the same picker hover card).

**Verified (11 Oct):** each is stated in the plan that defers it; none has a step elsewhere (searched all nine). B#85 was checked against Phase 3 steps 10a to 10d: a page badge but no dot in the icon-only state.

**Change** (each with its trigger):
1. Delete Phase 4 step 1's hover bridge (B#59, B#90). Trigger: native-title counts are zero everywhere and the seven transcript HTML strings (`markdown.service.ts:145,276,460,464,470,473`,
   `codex-followup-markdown.ts:69`) read a data attribute the bridge also reads.
2. Promote the "disabled needs a reason" and "tooltip begins with the name" reports to the guard (B#60). Trigger: Phase 4 step 5's adoption has settled.
3. Switch `scripts/ui-text/extract-ui-text.ts` to Phase 4 step 2's template reader (B#17, B#68). Trigger: step 2 exists.
4. Take the phone's "instance"/"thread" count for `apps/mobile/src` and add Rule B there (B#18). Trigger: any time after Phase 3 step 8a.
5. Rewrite the remaining `*.help.ts` articles, merge Settings' own Help drawer into the shared panel, and add "Which one do I want?" boxes to five empty states (B#19, B#69, B#64, B#65). Trigger: after Phase 4 steps 6 and 7
   are in use. (The Harness help pages that backlog A12 proposed are not part of this; James dropped them.)
6. A visible status dot on the icon-only Settings menu (B#85). Trigger: Phase 3 step 10d and Phase 4 part 2 step 1a both landed.
7. A hover card in the model picker using `appTooltipTpl` (B#93, A#84). Trigger: after Phase 4 part 3 folder `models` (1f).
8. A recycle hint without the number "about 1,200 characters" (B#89). Trigger: James prefers it (one line; the cap is a main constant, `loop-recycle-handoff.ts:18-23`).
9. Fold the orchestration HUD into the status strip (B#1). Trigger: after Phase 3 step 5.

**Tests / Risks / Done when / Live checks:** each as it is built.

**Size and order:** XS-S each. See the triggers.

### 8e. FU-B20: Copilot's context-window counter and its native context tools (M; design pass first; parked)

**For James:** The Copilot context ring says only "Tokens used" because Copilot does not report how full its window is. This would show a real figure and use Copilot's own context tools in long runs. It only matters
once Copilot loops are used again.

**Origin:** Phase 2 "Not in this plan" (B2/B3, "unowned") and Phase 5 "Not in this plan" ("it needs an owner"); B#128 and A#131 (the same piece).

**Verified (11 Oct):**
- Today's Copilot ring text: "Tokens used this session: N (this provider does not report context-window occupancy)" (`composer-toolbar.component.ts:392-445`, from audit `ref-copilot-sdk-plans.md:51`; not re-read).
- The CLI setting is `contextManagementTools: true` after a trial (`ref-copilot-sdk-plans.md:139,343`).
- Loops have not run since 23 Sep (Phase 5 choice 1).

**Change (design pass first):** (a) a measured occupancy figure from Copilot's cumulative usage ledger (Phase 0 step 7c) for the ring and the warning; (b) trial `contextManagementTools: true` in the spawn settings for loop
sessions, with a live check that `session_memory_v2` appears in the system message.

**Tests / Risks / Done when / Live checks:** after the design pass; the trial needs the installed Copilot CLI.

**Size and order:** M. Trigger: Copilot loops are used. After Phase 0 step 7c.

---

## The rest of the list (one line each)

These pieces have no home in any plan and no step above. Each line gives the piece, the plan it came from, the trigger that would wake it (if the plan gives one), and the standing rule: **re-check the code before
building**, because none of them was traced to code (the checkers ran out of budget, or the piece waits on something). They do not block closing this plan. Before this plan is renamed `_completed`, any line that is still
wanted moves into a new dated follow-up doc (see [Finishing](#finishing)). `A#n` and `B#n` are row numbers in the two inventory tables; rows are merged on one line when they are the same piece. A script confirmed that every
"no home" row of both tables is either in a step above or on a line below.

**Helper agents, context ceilings and prompts (Phase 1 hand-offs)**
- **Codex `thread/revert` and `thread/fork` experiments to drop a failed loop attempt (CXC-06).** Phase 1, Not in this plan (A16). Trigger: none given ("their own later item"). Re-check the code before building. (A#46)
- **A per-chat switch for Codex helper agents** (a new control and a restart of that Codex session, size M). Phase 1 choice 3's alternative. Trigger: James says yes to that alternative. Re-check the code before building. (A#49)
- **A lower context ceiling just for subagents (`autoCompactWindow`).** Phase 1, Not in this plan (A16): it means redefining a built-in agent, and Phase 1 step 5 already makes helpers inherit the main ceiling. Trigger: none;
  low value. Re-check the code before building. (A#51)
- **"Prefer Explore for read-only research" guidance (TR-2(b)).** Phase 1, Not in this plan (A16). Trigger: none; wording only. Re-check the code before building. (A#53)
- **A5b leftovers: block the two unused built-in tools; move memory text from the system prompt into the first user message (AT-8); a per-session menu (OCX-3) and `/doctor prompt-audit`.** Phase 1, Not in this plan
  (A5b): "no step takes it". Trigger: none given. Re-check the code before building. (A#57, A#58, A#60)
- **OpenCode's context ceiling (`limit.context` defaults to 1,000,000).** Phase 1, Not in this plan (A4): "unplaced; a follow-up to step 11 after the MiMo commit". Trigger: the MiMo work is committed. Re-check the code
  before building. (A#61)
- **Copilot's own compaction lever and discarded context fill-up (CPS-1, CPS-2).** Phase 1, Not in this plan (A5): "unconfirmed over ACP; Phase 3's Copilot work or later"; Phase 3 has neither. Trigger: none given. Re-check
  the code before building. (A#62)
- **Switch the security plugin per turn inside a borrowed live chat.** Phase 1 step 4 risk: it needs `reload_plugins` (`apply_flag_settings` now exists through step 14d). A rare path. Trigger: none given. Re-check the code
  before building. (A#63)
- **Copilot's output cap (CPS-12).** Phase 1, Not in this plan (A19). Trigger: Phase 3 step 12a gives a Copilot measurement. Re-check the code before building. (A#69)
- **A per-spawn `notify` parameter and compact JSON (17.1).** Phase 1, Not in this plan (A17). Nice-to-have. Trigger: none given. Re-check the code before building. (A#71)
- **Tag turns a machine causes inside a person's session (helper results, automation wake-ups).** Phase 1, Not in this plan (A0-S, A0-H). Trigger: Phase 1 steps 8a and 13c have landed and the admission-service delivery
  point has been traced. Re-check the code before building. (A#76)
- **OpenCode: a stream-timeout setting (A6.6) and a cheaper `explore` model (A6.7).** Phase 1 step 11c. Triggers: a live check shows a timeout retry; "with the other cheaper-helper-model work" (Phase 1 step 2 is Claude
  only). Re-check the code before building. (A#79, A#80)
- **"Compact first" for Chats (A9.3).** Phase 1 step 12c covers the session composer only. Trigger: none given. Re-check the code before building. (A#82)
- **Copilot roster facts in the model picker (window, multiplier, token prices).** Phase 1, Not in this plan (A9), which names "Phase 3's Copilot AI credits item"; Phase 3 step 12a is the bill only. Trigger: none given.
  Re-check the code before building. (A#83)
- **Quick ask as the first turn of a side chat; save a quick-ask answer into the transcript; a `/btw` command.** Phase 1, Not in this plan (A8). Feature ideas. Trigger: none given. Re-check the code before building.
  (A#87, A#88)
- **A proper `end_session` request for a graceful Claude teardown.** Phase 1 (A8), where the dead method is deleted instead, and Housekeeping. Trigger: a transcript-flush problem is seen. Re-check the code before building.
  (A#89, A#186)
- **Phone and thin-client quick ask, and phone and thin-client "build in a new session".** Phase 1, Not in this plan (A8, A21); Phase 2 says "no phase owns the phone app". Trigger: none given. Re-check the code before
  building. (A#91)
- **A "Model for building" setting.** Phase 1 choice 20's alternative (step 15 is deferred). Trigger: James says yes to that alternative. Re-check the code before building. (A#92)
- **Per-stage models for loops (JN-2 item 3), and asking the plan agent to list the files it read.** Phase 1, Not in this plan (A21). Feature ideas. Trigger: none given. Re-check the code before building. (A#93)
- **Other pages that ask for a typed session id (Snapshots, Checkpoints, Communication).** Phase 1, Not in this plan (A21): "the same fix pattern, a separate item"; step 15a fixes only the Plan Mode page. (The Communication
  page goes if part 5h is done.) Trigger: none given. Re-check the code before building. (A#94)
- **Loop verify-failure text through `rtk pipe --filter` (RTK-8).** Phase 1, Not in this plan (A13), which names "Phase 2's verify-excerpt work"; Phase 2 never mentions RTK. It helps only James's other stacks. Trigger: none
  given. Re-check the code before building. (A#95)
- **An RTK status chip on the session header and loop summary (RTK-12).** Phase 1, Not in this plan (A13). Trigger: the RTK hook decision log exists. Re-check the code before building. (A#96)
- **An Antigravity plugin hook for RTK (RTK-5) and a per-loop RTK recall store (RTK-9).** Phase 1, Not in this plan (A13). Feature ideas. Trigger: none given. Re-check the code before building. (A#98)

**Remote worker machines (one design pass first)**
- **Carry `sessionKind` across the remote worker spawn call; give worker-node Claude sessions the new options; gate the output cap on the worker's CLI version; switch model live on a worker (needs an RPC); RTK on workers
  (RTK-6); keep a worker PC awake; Windows and remote-session sampling for stuck warnings.** Phase 1, Not in this plan (A16, A5, A19, A8, A13) and Phase 2, Not in this plan (B14, B10). Trigger: `remote-node/rpc-schemas.ts`
  is committed; a design pass comes first. Re-check the code before building. (A#50, A#64, A#70, A#90, A#97, A#119, A#142)

**Loops (Phase 0 and Phase 2 hand-offs)**
- **A setting to review child sessions automatically.** Phase 0, Not in this plan (A14). Trigger: none given. Re-check the code before building. (A#17)
- **A loop that borrows a chat's Claude adapter may start a second Claude process on that chat's session.** Phase 0 "Found on the way" 2; Phase 0 step 11 item 7 only adds a test. Trigger: that test fails (the fix then needs
  its own part). Re-check the code before building. (A#28)
- **"Add more" at a loop cost cap, with amounts from past runs (CPS-9).** Phase 2, Not in this plan. Trigger: James sets a loop cost cap. Re-check the code before building. (A#113)
- **An end card with a "Run it now" button for each skipped check, and finish-budget controls.** Phase 2, Not in this plan (step 15 shows the list under Details and offers no button). Trigger: none given. Re-check the
  code before building. (A#115)
- **An `origin` field on review findings, and earlier-rounds memory for the fresh-eyes reviewer (SBT-1, SBT-4).** Phase 2, Not in this plan (step 14 covers the ping-pong reviewer only). Trigger: none given. Re-check the
  code before building. (A#116)
- **Battery-aware behaviour (do not hold the Mac awake on battery).** Phase 2, Not in this plan (B14). Nice-to-have. Trigger: none given. Re-check the code before building. (A#118)
- **Copilot `continueOnAutoMode` (CPS-4), and fixtures from real logs for Copilot's new usage-limit wording.** Phase 2, Not in this plan (B15). Triggers: none given ("not in the backlog"); the new wording shows up in a log.
  Re-check the code before building. (A#121, A#123)
- **A hook that counts calls and warns at 80 to 90 percent of the step limit (HR-4 step 2).** Phase 2, Not in this plan (B6). Trigger: the scorecard (Phase 2 step 7e) shows the note is not enough. Re-check the code before
  building. (A#124)
- **Act on other stop reasons (`prompt_too_long`, `budget_exhausted`, `hook_stopped`); store `num_turns`; a Codex stop-reason view.** Phase 2, Not in this plan (B6); `num_turns` needs room in `default-invokers.ts`.
  Trigger: none given. Re-check the code before building. (A#125)
- **Attribute helper model calls to a loop run.** Phase 2, Not in this plan (B6): they carry no run id. Low value. Trigger: none given. Re-check the code before building. (A#127)
- **An app-wide default check time limit (a five-places setting).** Phase 2, Not in this plan (B2/B3). Trigger: James wants `/goal` and automations to differ from 20 minutes. Re-check the code before building. (A#132)
- **More failure formats for the checks (oxlint, pytest, Maven, Go).** Phase 2, Not in this plan (B2/B3). Trigger: a loop meets one ("added with fixtures as needed"). Re-check the code before building. (A#133)
- **Mobile screens beyond widening the item kind (B5).** Phase 2, Not in this plan: "no phase owns the phone app" (see also part 8a). Trigger: none given. Re-check the code before building. (A#136)
- **A per-loop switch to turn "Decisions applied" off.** Phase 2, Not in this plan (B5). Trigger: none given. Re-check the code before building. (A#138)
- **A persistent reviewer session, and a user-pinned review depth.** Phase 2, Not in this plan (B7). Feature ideas. Trigger: none given. Re-check the code before building. (A#140)
- **Remove the unused review fields `lowOnlyChurnRounds` and `freshReviewerEachRound`.** Phase 2, Not in this plan (B7) and "Found on the way" 17: dead code; `freshReviewerEachRound` is read nowhere in `src/main`. Trigger:
  none given. Re-check the code before building. (A#141)
- **A "Stop just the child" button.** Phase 2, Not in this plan (B10): it needs IPC and a safety call. Trigger: none given. Re-check the code before building. (A#143)
- **More process facts on Codex's 15-minute stall error and on iteration-timeout failures; a calm interim notice during long Codex silences; soften the hard stop for other providers; Claude partial-message liveness.**
  Phase 2, Not in this plan (B10). Trigger: none given (data says Claude warnings are rare: 3 in 3 days). Re-check the code before building. (A#144)
- **Loop start-panel presets with an "Advanced" fold (LP-16), the seven status renderings merged (U4), and the duplicate end message in the transcript collapsed.** Phase 2, Not in this plan (B8/B9), which says Phase 3's C6
  absorbs them through `describeLoopEnd`; Phase 3 never mentions `describeLoopEnd`, LP-16 or those parts. Trigger: none given. Re-check the code before building. (A#146, A#147)
- **A "pick a side" control for `needs-human-arbitration`.** Phase 2, Not in this plan (B8/B9). Trigger: that state ever occurs (none of 141 runs has reached it). Re-check the code before building. (A#149)
- **A paused loop leaves its campaign step "running" (the campaign half of part 4a's problem).** Phase 2 "Found on the way" 2: "extend 8d's rule to them if James wants". Trigger: James wants 4a's rule extended to
  campaigns. Re-check the code before building. (A#156, campaign half)
- **`recordCompletionCost` returns early for a turn with no billable usage.** Phase 2 "Found on the way" 4 ("Phase 0 7b may cure it"). Trigger: Phase 0 step 7b has landed and a zero-cost turn still books nothing. Re-check
  the code before building. (A#158)
- **Dead code in the loop area: `loop-resource-view.ts` types never migrated; ten private copies of a closing-tag escaper plus three more; `process:interactive-prompt` emitted and nobody listens
  (`stuck-process-detector.ts:485-507`).** Phase 2 "Found on the way" 5, 10 and 13. Trigger: none given. Re-check the code before building. (A#159, A#164, A#167)
- **Small wording and blocking-call fixes in the loop area: `NotebookEdit`'s `notebook_path` missing from the capture's read-lock keys; a stale doc for `maxLedgerStallIterations` (`loop.types.ts:206-213`,
  `loop.schemas.ts:236-238`); `execFileSync('pgrep')` blocks the main process up to 1 s on the verify-timeout path (`loop-wait-on-pid.ts:179`, "minor").** Phase 2 "Found on the way" 9, 12 and 15. Trigger: none given.
  Re-check the code before building. (A#163, A#166, A#169)
- **The renderer `loop.store.ts` is at its limit and needs a refactor.** Phase 2 "Found on the way" 6 (second half; the plan-queue half is Phase 2 step 4a). Trigger: before more work lands in that file. Re-check the code
  before building. (A#160, second half)
- **Lost parent messages leave no trace; "a lost run summary is still invisible to James".** Phase 2 "Found on the way" 22; step 4c narrows the cases and adds a debug line. Trigger: none given. Re-check the code before
  building. (A#176)

**The phone app's words**
- **The phone's three loop screens print raw loop status words ("attempt-failed", "completed-needs-review"); `apps/mobile/.../loop-detail.component.ts` prints `item.kind · item.status` raw.** Phase 0 step 1 ("record as a
  follow-up for Phase 3's wording pass"); Phase 3 steps 8f and 17a cover instance statuses and push titles only. Trigger: Phase 0 step 1 has landed (it adds the new word). Re-check the code before building. (A#39)

**Housekeeping and the debug record**
- **An opt-in weekly tidy for activity logs, saved records and backups.** Housekeeping, Not in this plan. Trigger: a month of use of the disk space card. Re-check the code before building. (A#182)
- **Branches with no work folder (18 `queue/*`, `release/harness-auto-update-v0.1.0`, one unmerged `task-*`, six merged).** Housekeeping, Not in this plan: "a second list on the leftover card or the plan queue's own landing
  tidy-up". Needs James's ask-first rule for branches. Trigger: James asks. Re-check the code before building. (A#184)
- **A lasting counter for self wake-ups, and a turn-origin tag (an `origin` column in Phase 0 step 7b's per-turn record).** Housekeeping, Not in this plan and choice 14. Trigger: Phase 0 step 7b has landed. Re-check the
  code before building. (A#185)
- **Quota cooldowns for Codex, Copilot, Gemini and the rest.** Housekeeping, Not in this plan. Trigger: Housekeeping step 10's log line shows which endpoints refuse. Re-check the code before building. (A#191)
- **Claude tool results never carry a failure flag in the debug record** (all 227,226 rows say `success: true`). Housekeeping "Found on the way" 4; it matters little with the record off by default. Trigger: none given.
  Re-check the code before building. (A#197)
- **The context bar's "about $x" is the latest request's cost, and its legacy pricing branch is dead.** Housekeeping "Found on the way" 5: Phase 3's C2 decides, and deleting the dead branch belongs with that decision.
  Trigger: Phase 3 step 2's decision. Re-check the code before building. (A#198)
- **The memory-database warning banner appears only at 10 GB and says "RLM"** (`rlm-maintenance.types.ts:1`). Housekeeping "Found on the way" 7. Wording. Trigger: none given. Re-check the code before building. (A#200)

**Session screen, Needs you and menus (Phase 3 hand-offs)**
- **A read-only main-process lookup of the real permission policy for custom modes** (`side-chat-authority.ts:96-111`). Phase 3 step 3 risks. Trigger: custom modes turn out to be common. Re-check the code before building. (B#3)
- **Digits in the Windows taskbar icon.** Phase 3 choice 8's alternative. Trigger: James wants a number there. Re-check the code before building. (B#8)
- **An on/off switch for the new permission alerts.** Phase 3 choice 4. Trigger: the alerts prove noisy. Re-check the code before building. (B#9)
- **`requiresRestart` badges.** Phase 3 step 10b ships the plumbing with `dependsOn` only. Trigger: a setting is proven to need a restart. Re-check the code before building. (B#14)
- **Copilot AI credits for sessions on another machine** (the worker keeps its own `events.jsonl`). Phase 3, Not in this plan (costs): "later, on request". Trigger: James asks. Re-check the code before building. (B#37)
- **JN-1's optional "this subagent has used 400K tokens" notice.** Phase 3, Not in this plan (costs): "later"; off by default. Trigger: none given. Re-check the code before building. (B#41)

**Chat, search, confirm boxes and tips (Phase 5 hand-offs)**
- **B11b live steering of a loop (Codex `turn/steer` first).** Phase 5 choice 1: "goes in its own plan if loops come back". Trigger: loops come back into use. Re-check the code before building. (B#97)
- **B12 "provider goal mode" (`/goal` hands the goal to Codex).** Phase 5, Not in this plan (backlog T3-02(c)): "a separate decision"; it was not offered to James as a numbered choice. Trigger: needs a yes or no if loops
  come back. Re-check the code before building. (B#100)
- **Restore the Codex goal bar after a renderer reload.** Phase 5, Not in this plan. Trigger: `instance-list.store.ts` shrinks (868 of 868 lines) and parked Phase 5 step 18 is built. Re-check the code before building.
  (B#101)
- **`read_session` for Gemini and Antigravity** (they have no orchestrator tools bridge). Phase 5, Not in this plan: "a separate item". Trigger: none given. Re-check the code before building. (B#102)
- **C13.1 full-text search over every message (size L), retire Chat Search, merge the History sidebar.** Phase 5, Not in this plan: "a later 'search' item". Trigger: none given. Re-check the code before building. (B#104)
- **C12 follow-ups: re-queue a cancelled queued message at its old position (needs a position-aware queue API); Undo on the phone and thin client; move the other hand-built confirm boxes onto the new confirm service
  (`history-sidebar.component.ts:102-123`, `plan-queue-parked-list.component.html:18`, `snapshot-page.component.html:322-327`, `shared/terminate-confirm/*`).** Phase 5, Not in this plan ("not planned"). Trigger: none
  given. Re-check the code before building. (B#105, B#107, B#108)
- **Saved (history) child threads in the child-session strip.** Phase 5 step 12 item 3 ("not covered here"). Trigger: none given. Re-check the code before building. (B#114)
- **Read `TaskCreate` and `TaskUpdate` in `todo-tool-parser.ts`.** Phase 5, Not in this plan (C13.7). Trigger: Phase 5 step 9's live check shows Claude uses them instead of `TodoWrite`. Re-check the code before building.
  (B#115)
- **"Used in N of the last 20 sessions" for tool servers** (needs a per-session tool-use query). Phase 5, Not in this plan (C13.8). Trigger: none given. Re-check the code before building. (B#117)
- **A "Memory in this session" block** (which starting notes a session was given). Phase 5, Not in this plan (C13.10); Phase 3 step 15 adds only a count line. Trigger: none given. Re-check the code before building. (B#119)
- **Jean's third piece: a stable-prompt line asking agents to write findings as a `#`-column table.** Phase 5, Not in this plan (C13.11); it touches the cache-stable prefix (`prompt-injection-contract.ts`). Trigger: none
  given. Re-check the code before building. (B#121)
- **Idle-time tips (Hermes HU-8), and tips on the phone.** Phase 5, Not in this plan (D11): "later" and "not planned". Trigger: none given. Re-check the code before building. (B#122, B#123)

---

## Final verification

When each part is finished, run its targeted specs and `npx tsc --noEmit`. When a step is done, run the canonical gates and record their current output in the as-built notes:

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
npm run verify:ipc            # part 7j adds two channels; part 5h removes about 30
npm run verify:ipc-usage
npm run verify:architecture   # Step 1 moves docs that the generated inventory lists
npm run check:docs-retire     # Step 1: prints one line; run it after the batch
```

Also run, where a part touches them:
- the phone app's own `typecheck`, `lint` and `test:quiet` (parts 3e and 8a);
- each new or changed spec on its own with `npm run test:quiet -- <path>`, for example `scripts/__tests__/retire-docs.spec.ts`, `scripts/__tests__/agents-doc-pointers.spec.ts`,
  `scripts/__tests__/fetch-rtk-binaries.spec.ts`, `src/main/plan-queue/plan-queue-discovery.spec.ts` and `src/main/codemem/__tests__/default-code-index-ignores.spec.ts`.

**Fresh-eyes completion gate.** The steps are independent and several wait on other plans, so run the gate over each step when it is finished, and once more over the whole plan when it closes:
1. A fresh agent that did none of the work runs the `task-completion-gate` skill over that step's changes, this plan and the report evidence.
2. Fix every actionable finding, rerun the checks, and send the work to another fresh review.
3. Repeat until it returns `VERDICT: PASS`.

Brief each reviewer on James's rules:
- no branches or worktrees;
- no browser on the Mac;
- preserve other sessions' uncommitted work;
- never delete anything without asking, and untracked docs are never touched;
- Step 1 moves docs with `git mv` only, and nothing is committed until James asks;
- no secrets.

## Live checks

These need the rebuilt app, a real provider CLI, the Windows PC, the phone, or James's data. They are listed under each part. When the code is done, move them into
`docs/plans/2026-10-11-oct-followups_livetest.md` with the standard header:
- prerequisites (rebuild, restart, and which instance);
- a link back to this plan;
- the remediation-flow paragraph pointing at `livetest-campaign-runbook.md` and `livetest-remediation-register.md`.

Then leave a one-line pointer here. Screen checks run on the Windows PC, or on the Mac only with James's OK.

The checks that remove or move anything are done only with James present and after his yes:
- Step 1d's batch and Step 1f's scratch sweep;
- any real removal from the disk space card in parts 5a, 5b, 5c, 5d and 5g (5d only after James chooses; never move the old data folder as a test);
- part 3c's scratch-repo check removes nothing real.

Step 5a's, 5b's and 5d's first live check ends in Cancel and an unchanged listing. The checks for parts 3e, 8a (the phone) and 5e (the Windows PC build) need those devices.

## Not in this plan (and where it goes)

- **Step 1 (retire old docs):**
  - Deleting archive entries from the tree later (the checker's "option (a)", a second phase). Revisit after about 6 months, only with James's OK; the index and `origin` keep everything.
  - A "family" rule; re-pointing the register's links; merging the other three archive homes into one tree.
  - **Producing fewer docs.** About 33 docs a week land (293 in 9 weeks), mostly a plan, a spec and a live test per task, in two homes (`docs/plans/` and `docs/superpowers/`, which still receives new docs). Retirement
    only moves them. One doc per task, or one home, would cut the inflow; that changes James's lifecycle, so it needs its own decision later.
  - Codemem's handling of nested ignore files (see "Found on the way" 1): it belongs with A20 (Phase 3 step 15) or a Codemem item. A20 itself (skip machine messages, inject on topic change, repeat protection) is Phase 3.
  - Moving or reviewing James's own untracked docs; they are only listed.
  - A lint rule against doc-path citations in code comments (only an AGENTS.md sentence here).
  - The Harness help pages (backlog A12, Phase 1 choice 14): dropped by James on 11 Oct, not built anywhere.
- **Step 5 (disk and clutter):**
  - Deleting Codex session files (18 GB): resuming a Codex chat needs them. Only their size is shown.
  - Automatic removal of the 425 existing Codex copies, the clean-up copies and the archive copy (5a: they go only through the card, after a preview and a yes), and of anything else on the card (every card row asks first).
  - `VACUUM` of RTK's history file (5b).
  - Rotation of `lifecycle.ndjson` (38 MB), and clearing the temp-folder `.old` trace files (left to the system) (5c).
  - A browser-free dry run of `electron:build` (5e's live check).
- **Step 4:** the phone and thin-client display of plan-queue suggestions (4c).
- **Step 6:** wiring the token-spend compaction trigger (6f; after Phase 0 steps 7b and 10). The lock-screen question for 6d is answered (no), so nothing to build there.
- **Step 7:** real "was it used" detection for wake notes (7b offers only "never shown" and "source changed"); the phone app's own badge design (8a).
- **Everything under "The rest of the list":** each line says what wakes it. Three clusters need a design pass first: remote worker machines (A#50, A#64, A#70, A#90, A#97, A#119, A#142), the phone app (A#39, A#91, A#136) and
  Copilot's picker and compaction facts (A#62, A#83).

## Found on the way (not fixed here)

New in the four checks of 11 Oct:
1. **Codemem reads only the root `.gitignore`** (`code-index-manager.ts:426-433`), so nested ignore files are not honoured. `apps/mobile/ios/.gitignore` ignores `App/Pods` and `App/build`, yet 7,461 of this repo's 14,676
   manifest rows (51 percent) sit under `apps/mobile/ios` (15,131 files on disk, 18 tracked), and `apps/` as a whole holds 27,234 of its 108,104 chunks (25 percent; 97 percent of the `apps/` manifest rows are the iOS folder,
   so most of those chunks are inferred to be iOS files). Retrieval-quality impact not measured.
2. **Codemem's own bookkeeping disagrees with itself:** `code_index_status` says 2,677 files and 36,741 chunks (completed 27 May) while the manifest holds 14,676 files and `workspace_chunks` 108,104 rows. Not investigated.
3. **`docs/plans/livetest-remediation-register.md` is 1,018,484 bytes** and is indexed as 37 chunks. The indexing config caps files at 1 MiB (`indexing/config.ts:60`), so it has about 30 KB of room; whether Codemem applies
   the same cap, and what happens past it, was not read.
4. **Doc-path citations in code rot:** of 61 non-test `docs/...md` citations, 35 are dead (22 renamed `_completed`, 13 other, including 4 from the June `docs/_archive/` move). Examples:
   `packages/contracts/src/channels/copilot-account.channels.ts:10`, `src/main/app/late-runtime-initialization-steps.ts:127`, `src/main/cli/adapters/degraded-output-classifier.ts:16`,
   `src/main/orchestration/evidence-resolver.ts:5`, `src/main/instance/lifecycle/restart-policy-helpers.ts:36` (cites a `_livetest.md` that is now `_livetest_completed.md`). Part 1c adds a rule against new ones; the old
   ones are not fixed.
5. **The tracked open live test `docs/superpowers/plans/2026-09-19-agent-reachable-loop-resume_livetest.md` is committed yet also modified;** the plan-spec guard will block staging that modification (inferred from the
   pattern). `docs/_archive/bigchange_intent_routing_plan.md` is a tracked `_plan`-named doc in an archive folder; renaming it to the hook's `_archived` closed state would stop it looking active.
6. **`lifecycle.ndjson` (38 MB, `src/main/observability/lifecycle-trace.ts:61-80`) never rotates** and is read whole by `operator-artifact-exporter.ts:205`; a second 6 MB copy is written under
   `$TMPDIR/ai-orchestrator/logs` by a process that was not identified.
7. **The Savings tab counts `rtk proxy` rows** (60 percent of all rows) in "Shell commands compressed" and "Average output reduction" (`rtk-tracking-reader.ts:346-380`, `rtk-savings-tab.component.ts:110-118`); Phase 1 step 18
   already rebuilds those cards.
8. **`git count-objects -vH` reports 25 `tmp_obj_*` "garbage" files** under `.git/objects` (left by interrupted writes). Harmless; do not run `git gc` without James's yes.
9. **Other old leftovers, not touched:** `~/Library/Caches/ai-orchestrator` 89 MB, `~/Library/Caches/AI Orchestrator (Dev)` 13 MB, and three `com.*orchestrator*.plist` files.
10. **Phase 0 step 11's Codex test names `thread/compacted`,** but current Codex reports compaction as a `contextCompaction` item (`src/main/cli/adapters/codex/compaction-signals.ts:7-11`); the test should drive the item path
    (both paths reach the shared hook `handleObservedThreadCompaction`, per Phase 1 step 1e; checked 11 Oct). The Phase 0 plan's test was corrected on 11 Oct.
11. **Phase 1 cites `file-handler.ts` without a folder;** it is `src/main/cli/file-handler.ts`.
12. **A stale hand-off chain.** Seven hand-offs name a receiver that has no matching step: Phase 3 (five switches to "Phase 4 or a follow-up"; Everyday / Full to "a Phase 5 item or a follow-up"), Phase 4 (dead markdown helpers
    to "housekeeping"), Phase 4 part 2 (auto-approve confirm to "Phase 3's C8"), Phase 5 (Costs page precision to "Phase 0 step 7h"; the stale ceiling to "housekeeping, E3"; retirement of notes to "a follow-up"). All are now
    parts above (7h, 8c, 5i, 7i, 7g, 5i, 7b).
13. **The remote observer serves each prompt's full text,** including the Bash command: `src/main/app/instance-event-forwarding.ts:545-552` records `message: payload.prompt`; `src/main/remote/observer-server.ts:142-145`
    broadcasts it and `:270` serves `/api/prompts`. It is token-gated and binds `127.0.0.1` by default (`:63`), but it can bind `0.0.0.0` with the token in the URL (`:204-208`). Not a lock-screen leak for permission prompts (checked: their push
    title and body are `"<tool> needs approval"` and `"<agent> · <folder>"`, `mobile-gateway-push.ts:54-87`; other prompt kinds use the prompt's own title, not read), but worth a line in the observer's settings text if LAN access is switched on. Not verified: whether any UI
    switches it to `0.0.0.0`.
14. **Initial prompts never reach `buildInputContexts`** (`instance-lifecycle.ts:1405`, `:1028`, `:1053`; the only caller is `instance-manager.ts:1657`). So the first prompt of any session, not just an automation's, gets no
    retrieved-notes block; the project brief and starting notes reach it through the system prompt instead. If James expects retrieved notes on a first prompt, they are absent. (This refutes Phase 3's "automation first prompts
    are not covered by MEM-1" gap: there is nothing for MEM-1 to skip.)
15. **Phase 5's note that Phase 3 needs a correction is out of date:** Phase 3 plan lines 4478-4480 already say "unowned" for the notes retirement.
16. **`migrateFromLegacyApp()` is dead code** (part 5d), and **`scripts/fetch-rtk-binaries.js`'s header is stale** (part 5e).

Information only, from the inventories (nothing to build):
17. **Two September loops merged unfinished work into `main`** (communitytech `0cbedefd2`; this repo `8965eec0b`, merged 2026-09-24, still in main's history). James may want to look at both; Phase 0 step 1 stops a repeat (A#27).
18. **OpenAI embeddings and voice recording** are unused without an API key (A#3).
19. **A persisted seed for Copilot's usage counter** is a later option, only if Copilot ever starts carrying totals over (A#40).
20. **The spawn-worker proxy's hard-coded `acceptEdits`** is "off by default"; it follows Phase 0 step 7b item 5 (A#65).
21. **Phase 1 step 13e: IMAP is not duplicated,** so the duplicate-tools decision record removes nothing (A#75).
22. **Codex email automations also get IMAP from `~/.codex/config.toml`** (A#104): not a defect, and the reason Phase 1 step 13e removes nothing.
23. **`Instance.lastActivity` is not an idle clock** (A#107); Phase 1 step 12c uses the newest assistant message time.
24. **Two live OpenCode installs on this Mac** (A#108); Harness uses 2.x for every launch.
25. **Parked work does not count toward "busy"** (A#120): decided in Phase 2 choice 1.
26. **A model-specific rate limit holds other sessions on the same account for up to an hour** (A#122): accepted.
27. **Plan-queue workers do not write OUTSTANDING.md** (A#137): they have their own question flow.
28. **Two plan-queue items are parked `land-blocked`** (A#157); they should land with "Try merging again" once Phase 2 step 4f is in the running build.
29. **473 "Stream idle timeout exceeded" log lines in 3 days reach no screen** (A#173): informational.
30. **Stores that manage themselves:** `codemem.sqlite` 7.05 GB, `rlm.db` 6.2 GB, `conversation-evidence` 3.8 GB and `codex-command-output` 2.4 GB; shown on the disk space card, no clean-up action (A#192).
31. **Empty database stubs at the data-folder root** (`conversation-ledger.db`, `loop-mode.db`, `state-5.sqlite`): 0 bytes; the real files are in subfolders (A#201).
32. **Things that keep their names** (`aio-mcp`, `aiorch.*`, `~/.orchestrator`, ...) are a deliberate list of exceptions in Phase 3's wording pass (B#20).
33. **Loop questions have no deadline by design:** answers are read at the next round (B#31).
34. **Remote worker sessions and the spawn-worker offload keep today's behaviour:** they build their own arguments and have no live asks (B#32).
35. **Cache lifetime for Codex and other providers** is left out of the row, and exact per-call cache accounting for non-Claude providers stays per turn and says "about" (B#39, B#42).
36. **James's saved `showCost` is `false`,** so Phase 0 step 8's dollar line is invisible to him until he turns it on (B#55).
37. **`AGENTS.md` is loaded twice by Copilot** (B#81): recorded as James's choice in Phase 0, and Phase 4 step 3's pointer is sized for it.
38. **Hover styles for `aria-disabled` controls are done per adoption,** by design (B#87).
39. **Search across sessions, and reading another project without an `@session` chip,** were "not asked for" (B#103); **more than seven starter tips** will wait ("start small and pin the list in a test") (B#126).
40. **Gemini and Antigravity get no orchestrator tools,** so guidance must be provider-gated; Phase 1's guide is provider-neutral and its one tool line is conditional (B#131).
41. **`instance-list.store.ts` is at 868 of 868 lines** (the next instance field needs an extraction first), and **`browser-page.component.ts` is at 697 of 700** (B#132, B#144).
42. **The default loop path runs iterations inside the chat's own Claude process** (B#141): not a defect.
43. **Transcript virtualization exists behind a setting, default off** (B#143); relevant to Phase 5 step 15's tick state.

## Corrections to the backlog

These are wrong or changed claims in the backlog or in the other nine plans. The orchestrator fixes the other plans; this plan only records them.
- **Backlog:** it has no doc-retirement item, so nothing there is wrong about it; Step 1 is new.
- **Backlog A20 (`claude_oct-todo.md:500`),** "On every message AIO searches its memory and the code index and prepends the hits": verified, with refinements. The code-index half runs for every message of 3 or more characters in a
  non-child session (`indexed-codebase-context.ts:19`, `instance-input-contexts.ts:286`), is an unfiltered keyword (BM25) match on the first 12 words, and old closed plans are what mostly fills its slots in the synthetic probe
  (25 of 47). The "0.38M injected memory tokens in 30 days" figure in A20 is about memory notes, not this path.
- **Two assumptions corrected during the check.** The plan queue does not read or list `docs/plans`: it scans `docs/**/*.md` across the repo by file name only (`plan-queue-discovery.ts:23`), skips `_archive` and `archive` folders, and opens only
  active-named files. And `DEFAULT_CODE_INDEX_IGNORES` is defined in `code-index-ignores.ts`, not `code-index-watcher.ts` (`AGENTS.md:142` repeats the wrong file; fixed in 1a).
- **`AGENTS.md:101`** names a plan file that no longer exists under that name (fixed in 1a).
- **Phase 0:**
  - "Found on the way" 2 and step 11 only add a test for the borrowed-adapter question; the fix has no home (A#28; see the rest of the list).
  - Step 11's Codex test named `thread/compacted`, but current Codex reports compaction as a `contextCompaction` item (see "Found on the way" 10; corrected in the Phase 0 plan on 11 Oct).
- **Phase 1:**
  - "Not in this plan" (A9) says the Copilot picker facts belong to "Phase 3's Copilot AI credits item"; Phase 3 step 12a is the bill only (A#83).
  - "Not in this plan" (A9) and "Found on the way" 7 say the `.claude-attachments` clean-up "goes to E1"; the Housekeeping plan has no such step (A#85, A#105; now part 5g).
  - "Not in this plan" (A13) says RTK verify text belongs to "Phase 2's verify-excerpt work"; Phase 2 never mentions RTK (A#95).
  - Step 13f said 17.7 is built "with the loop work (Phase 2)"; Phase 2 has no such part (A#74). Corrected in the Phase 1 plan on 11 Oct:
    step 13f now builds 17.7 itself, gated on loops being in use again.
  - "Found on the way" 11 ("RTK history database is 551 MB, retention handled nowhere"): refuted. RTK prunes at 90 days after every write (`tracking.rs:439-446` in 0.42.4), and the file is exactly 90 days wide; the real issue is the
    recent rate and a `history_days` setting that is declared and never read (A#109, part 5b).
  - "Found on the way" 13 ("not traced"): traced. Nothing reads the `claude-orchestrator` folder, and the migration that names it cannot run (A#111, part 5d).
  - Phase 1 plan lines 3011 and 3368 treat `residentClaudeSession` as real; it is dead in effect (part 5i).
- **Phase 2:**
  - "Not in this plan" (B8/B9) says Phase 3's C6 absorbs the loop status merge, presets and the duplicate end message through `describeLoopEnd`; Phase 3 never mentions `describeLoopEnd`, LP-16 or those parts (A#146, A#147).
  - "Found on the way" 25 (a held campaign step) is confirmed but conditional: it needs Phase 2 step 8b and a campaign set to "carry on"; the default paths already pause (A#179, part 3f).
- **Phase 3:**
  - "Found on the way" 6 (`residentClaudeSession` never read): changed. It is read once (`instance-lifecycle.ts:1626`), then forced to `true` by `residentClaudeForSpawn`, the migration and a read-only policy (B#51).
  - "Not in this plan" (wording and Settings), five switches with no row: changed. Four are `'internal'` on purpose and one is `'bespoke'` (B#13, part 7h).
  - "Not in this plan" (costs), automation first prompts not covered by MEM-1: refuted as a gap (see "Found on the way" 14).
  - "Found on the way" 2, whether the Bash command reaches a lock screen or phone notification: answered, no, for permission prompts; other prompt kinds use the prompt's own title, which was not read.
- **Phase 4:**
  - Part 2 "Not in this plan" says a confirm when enabling auto-approve belongs to "Phase 3's C8"; Phase 3 C8 has none, and neither has the backlog's C8 (B#88, part 7i).
  - "Not in this plan" says to delete the two dead markdown helpers under "housekeeping"; the Housekeeping plan does not list them (B#70, part 5i).
- **Phase 5:**
  - "Not in this plan" (C13.3) hands the Costs page precision to "Phase 0 step 7h"; Phase 0 step 7h has no format work, and the page still prints `toFixed(4)` and `toFixed(6)` (B#110, part 7g).
  - "Found on the way" 5 ("Tighten it, housekeeping, E3"): the Housekeeping plan has no such step (B#133, A#99, part 5i).
- **Housekeeping:**
  - The disk space card (step 4a's table of 96.8 GB) leaves out `~/.ai-orchestrator/codex` (57 GB, outside the data folder; part 5a).
  - "Found on the way" 1 ("no `.old` files exist. Two writers share one path"): changed. The `.old` files exist in `$TMPDIR/ai-orchestrator/logs` (nine of 31.5 MB), the two writers use two folders, and the file is now
    711 MB, not 695 (A#183, A#194, part 5c).
  - "Not tracking the RTK binaries in git (35-40 MB per bump)": 35-40 MB is the raw size (43.3 MB); in git it is 20.1 MB per bump (A#193, part 5e).
  - "Found on the way" 3 (a missed lookup reads every saved record): confirmed with data (7,699 files, 4.68 GB, largest 122.6 MB); the miss frequency is unmeasured (A#196, part 6g).
- **Inert setting:** `cumulativeTokenCompactionTrigger` is confirmed inert, with the full path traced (A#103, part 6f). **One-shot transcripts:** `--no-session-persistence` is confirmed unused in `src`, and the measured effect today is
  about nil (A#56, part 5f). **Training Data** is confirmed empty; **Instance Messaging** is confirmed unused but not proven empty (B#112, part 5h).
- **The Codex units:** the wave-2 report gave the Codex `backups` and `sessions` sizes as 40.8 GB and 19.2 GB; those are the `du` figures in KiB read as millions. In binary GB they are 39 GB and 18 GB, as used in part 5a.

## Finishing

1. **When this plan closes.** It closes when its steps are built and verified, or when James explicitly drops them. Parts that are parked (Step 8) or held for James's answer (1f, 3g, 5a, 5b, 5c, 5e, 5h, items 1 to 3 of 5i, 7h, 7i) count as done when built or when James drops them. **"The rest of the list" does not block closing.**
2. **Before the rename to `_completed`,** carry every still-wanted line of "The rest of the list", and every Step 8 part James still wants, into a new dated follow-up doc, because nothing may be added to a `_completed` file.
3. Create `docs/plans/2026-10-11-oct-followups_livetest.md` and move the live checks into it.
4. Update this plan's status line and as-built notes, then rename it `2026-10-11-oct-followups_plan_completed.md`, **last**.
5. In `claude_oct-todo.md`, add one line under "Suggested order" that points at the completed plan (the backlog has no row for it), and mark done any backlog item whose left-out piece was built here.
6. Commit only when James asks.
   - Stage only this plan's code and the renamed `_completed` plan. The live-test doc stays untracked until its checks pass and it is renamed `_livetest_completed`: the commit hook blocks an open one (`plan-spec-guard.sh:16`) and AGENTS.md says not to commit unfinished plans.
   - Step 1 has its own two commits (1d), each only when James says so.
   - Never stage other sessions' work, and never stage a removal of James's data.


> Dated as-built notes moved to [history](2026-10-11-oct-followups_history.md).
