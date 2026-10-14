# October housekeeping: disk, worktrees and stale details

**Status:** all code is implemented in the Plan Queue branch `queue/2026-10-10-oct-housekeeping-7e6641` and ready for independent verification; not ready for closure. The complete prior implementation was ported from the parked branch `queue/2026-10-10-oct-housekeeping-c2ff86` as the coordinator handover directed (see the round 3 notes). Steps 1-13 are built and pass their targeted checks and the fast gates, including all four Step 12 cross-plan confirmations, which the post-port round-1 remediation (14 Oct) implemented in this branch after the verifier's finding: Phase 1 Step 1a's Codex protocol refresh (snapshot 0.162.1 plus coverage spec), Phase 0 step 2.6b in full, Phase 1 Step 14a's dead-method deletion and Step 18a's RTK 0.51.0 pins and binaries. Still open: the full-suite plus fresh-eyes gate runs, which are the queue verifier's; Phase 1's remaining feature work on 14a (the control channel) and 18a (its items 2-6) stays with that plan and is not duplicated here (Finishing rule 3's renaming decision stays with the coordinator). Written 2026-10-10. Keep this file untracked until every step is implemented and
verified (see [Finishing](#finishing)). This is the housekeeping plan that runs alongside the phases: it has no phase
number, and its steps can be done in any gap between phases, in the order given here.

**Source:** the "alongside" row of the approved backlog [`claude_oct-todo.md`](../../claude_oct-todo.md) (James approved
it on 10 Oct 2026 and answered decisions 1-7). The row reads: "alongside | E1, E2, E3 | Low risk; E3.1 must come before
A16; E1's ledger counts come before any change to what the ledger captures". The plan also carries the question that
Phase 0 handed to James about this repo's `CLAUDE.md` file (Phase 0 plan, "Found on the way", item 8).

**How it was checked:** on 10 Oct 2026 one read-only checker re-traced every housekeeping claim against the working tree
(HEAD `04b6db59b` plus about 180 uncommitted entries from other sessions). Its report is `_scratch/oct-phases/e.md`,
which is gitignored and disposable; this plan carries what an implementer needs. The checker measured the data folder
with read-only `du` and read-only database queries, ran the three ledger counts that the backlog says must come first
(they are recorded in Step 2), and compared its Codex-protocol design with group p1-a's. The plan writer then re-read,
read-only: the backup code path, the line count of every file the plan edits, the list of files other sessions have
modified, `git worktree list` and the state of each leftover folder, the loop runs that own those folders, and the
Phase 0 and Phase 1 plans, because four E3 items are claimed by those plans too. Where this plan differs from the
report, the step says so. Some backlog claims were wrong or have changed; those corrections are folded in and listed in
[Corrections to the backlog](#corrections-to-the-backlog). **Line numbers are as of 10 Oct and will move. Re-read the
code before editing.** A fresh reviewer then re-checked this plan (`_scratch/oct-phases/_review2-housekeeping.md`, also
gitignored); its findings were applied on 10 Oct and the fixer's log is at the end of that file.

**Size:** M-L in total. Step 4 (the disk space card and its ask-first gate) is the biggest and is split in two. Steps 3,
5, 6 and 11 are S-M. Steps 1, 2, 8, 9 and 10 are S. Step 7 is two XS comment fixes. Step 12 builds two XS safeguards
(12a, 12b) after Phase 1 lands and points at two items that other plans finish (12c, 12d). Step 13 builds nothing: the
`CLAUDE.md` question waits for James. What goes first: Step 1 (it guards the two July backups) and Step 2 (it stops the
disk growth). Neither deletes anything.

**Depends on:** the Phase 0 plan (`docs/plans/2026-10-10-oct-phase0-confirmed-fixes_plan.md`) and, for a few small items,
the Phase 1 plan (`docs/plans/2026-10-10-oct-phase1-token-levers_plan.md`). Nothing in Phases 2 to 5 has to land first, but
Phase 3's wording pass and Phase 4's tooltip step also edit the learning-database window that Step 1 edits (see the
shared-files list under "Order of work").
- **Phase 0 step 2.6a** (a "Close" button for stranded loop runs) before Step 6. The parked loop run that owns one
  leftover folder has then ended. Step 6 does not strictly need it.
- **Phase 0 step 2.6b** deletes the stray backup file (E3.8). Step 12d only checks that it happened.
- **Phase 0 step 7c's final diff** before Step 8 touches the price lookup. Step 8 also has to make sure the new
  provider-aware pricing can price the three Claude 5.5 ids (Step 8, change 3). Phase 0 step 7b's day-check script prices
  subagent tokens by model, so land Step 8 before that script is trusted on Claude 5.5 sessions.
- **Phase 0 step 8** (the A10 quick fix) makes the cost figure beside the context bar the session's recorded spend. Nothing
  in Step 8 depends on it: Step 8 changes the price table only.
- **Phase 0 step 7b.0** (room in the Claude adapter: it moves about 75 lines out) should land before Steps 9 and 11,
  which together use all 7 of the adapter's free lines (Step 9 about 3, Step 11 about 4). **Phase 0 step 7b's** per-turn
  ledger is where a lasting self wake-up count would go later; it is not built here.
- **Phase 1:**
  - Step 1a (E3.1, the Codex protocol refresh) is done there, before A16. Step 12a here adds a warning on top of it and
    comes after it.
  - Step 18a bumps RTK (E3.2). Step 12b here adds a guard on top of it and comes after it.
  - Step 14a deletes the unused method (E3.7); Step 12c only points there.
  - Steps 2 (A18) and 9a there and Step 9 here share one helper, `resolveClaudeCliVersion`. Whichever lands first creates
    it; the others call it (the Phase 1 plan says so since its 10 Oct fixes; see Step 9).
- **Phase 3** receives two of the ledger counts recorded in Step 2 (A20, and C3b, which has a better source now).
- **Closing this plan** waits for Phase 1 Steps 1a, 14a and 18a and Phase 0 step 2.6b (see [Finishing](#finishing)).

---

## In plain English (what James will notice)

1. **Nothing here deletes anything on its own.** Every clean-up in this plan (old backups, old session records and logs,
   old work folders) first shows you what would go, how much space it frees and whether it can be undone, and then waits
   for you. The disk space card, the leftover work folders and the old-record clean-ups also refuse to run unless Harness
   showed you the list first, so a script or an agent cannot skip the question. The learning-database backup window is
   protected by its own tick box, which starts unticked.
2. **Your two July backups are protected first.**
   - Harness keeps two backups of its learning database (its screens call it RLM) from 12 July, about 25 GB together.
   - Today, the next time that database's clean-up runs, Harness makes a new backup and quietly deletes the older July one
     (about 14 GB). It tells you only afterwards.
   - That clean-up starts only when you press its button, and the warning that offers it appears at 10 GB. The database is
     6 GB now, so nothing is about to happen.
   - After Step 1 the clean-up window lists every backup it could delete, with date and size. Deleting one needs a tick box
     that starts unticked.
3. **Harness stops filling your disk with a record nobody reads.**
   - Harness keeps about 97 GB of its own files. The biggest piece is a 33 GB debug record of every message the AI tools
     send, inside a 35 GB conversation file.
   - Nothing in Harness reads it. It grows by about 2.3 GB every half day when Harness is busy, and the rate has been
     rising since September.
   - After Step 2 it is off unless you switch it on in Settings. This change deletes nothing; the records already there
     expire after 30 days, as they do now.
4. **A "Disk space used by Harness" card in Settings > Doctor** shows what takes the space and what could be given back.
   - About 52 GB could be given back while your newest backup is kept. The biggest part, the debug record, takes two steps:
     clear it, then shrink the file.
   - Each clean-up shows its size and its consequence first, with Cancel as the default.
   - The 35 GB conversation file only gets smaller after the old debug records are gone and you agree to a one-time
     "Shrink the file". While that runs, Harness pauses saving conversation records for a short time; a trial run in Step 3
     measures how long before the button is ever offered. Your sessions keep running.
5. **A "Leftover work folders" card** lists the 12 old work folders left by earlier loops and agents, about 8 GB.
   - Eleven of them hold saved work that your main copy does not have, so none can be thrown away safely without you looking.
   - Each row says in plain words what the folder holds. You can remove one folder at a time, only after you press a
     button on a screen that says exactly what goes and what stays.
   - The two that Claude Code made are shown, but Harness never removes them.
6. **Claude sessions that ask to be woken up later become visible.**
   - Claude Code has a tool that lets it say "wake me in 25 minutes". It asked for this 190 times in the last 30 days, in
     59 sessions, and Harness did not notice.
   - Nobody has shown yet that those wake-ups really happen inside a Harness session; Step 11's live check finds out.
   - After Step 11 the session says "Claude asked to be woken at 14:32", Harness counts the requests, and it warns you if a
     session ends while one is waiting.
   - It does not stop them. An off switch is only built if you ask for one.
7. **The Claude 5.5 prices are right.** Harness's built-in price list is missing the three Claude 5.5 models, so it prices
   them with older or default rates (too high for the short model names Harness uses), and it prices their cached words too
   high as well. After Step 8 both are right. It does not change what you are actually charged.
   - The backlog also said the little "about $x" beside the context bar reads far too high. On the Claude Code you run
     (2.1.296) that is not so: the figure comes from Claude Code's own total. Step 8 leaves it alone.
8. **Smaller checks and tidy-ups, none visible on your Mac.**
   - Harness checks which Claude Code version is installed before it uses two features that misbehave on old versions. Your
     Mac's 2.1.296 is fine. On a worker machine Harness asks that machine's Claude Code directly; if it still cannot tell,
     it takes the safe path.
   - Harness asks Claude's usage service for your plan figures less often when it already has fresh ones, and waits as long
     as the service asks after a "too many requests" reply.
   - Two wrong notes in the code are corrected. One says Claude Code cannot detect a stalled reply. One says Codex cannot
     run a command before it runs.
9. **Four tidy-ups are done in other plans, and two small safeguards for them are built here.** None needs anything from
   you.
   - Done in other plans: refreshing Harness's list of what Codex accepts, updating the built-in copy of RTK (the tool
     that shortens command output), removing one unused piece of code, and deleting the stray backup copy of a loop file.
   - Built here, after those land: a log line that says when the Codex list falls behind again, and a check that the three
     places that name the RTK version always agree. Updating the RTK copy adds about 20 MB (43 MB of program files before compression; corrected 11 Oct) to the
     repo's history when you commit it; that is how the repo already works.
10. **Your repo's `CLAUDE.md` is left alone.** Copilot reads the project instructions twice when it works inside this repo
    (about 10 KB of cached text per request). Claude Code and Codex are not affected. Step 13 lays out four options in case
    you ever want to change it.
11. **What you need to do.** Nothing, to start. Each choice below has a recommended default, and you are asked at the time
    for every clean-up.

## Decisions this plan follows

From James (10 Oct 2026 unless stated):
- The product name on screen is **Harness** (Decision 1). All new wording says Harness.
- **Every deletion is shown first and asks first.**
  - The backlog's E1 says the Storage clean-up "always asks first" and "ask James before the two July copies go".
  - James's standing rule is never to delete branches or worktrees that he or another session created without asking.
  - So no step here deletes on its own, and nobody running this plan deletes real data (backups, conversation records,
    saved session records, work folders, branches). Tests use scratch copies. The live checks that touch real data happen
    with James present.
- **No branches or worktrees** for this work (James's standing rule), even though Step 6 is about worktrees. The
  implementer works in the current checkout.
- Decision 7 (agents may act on their own recommendation for non-blocking questions) never covers deletion, so nothing
  here lets an agent decide a deletion for James.

Choices made while planning. Each is the recommended default, none blocks starting, and James can change any of them. The
four that came out of the checker as real decisions are numbers 2, 10, 13 and 19, and each says what James would see.
Numbers 2, 10 and 13 also say plainly that they change the design.
1. **Deleting an older learning-database backup needs its own tick box, and the box starts unticked (Step 1).**
   - What you would see: in the window that today says "Clean up stale RLM sessions", a new part lists every backup, with
     date and size. If one could be deleted by this clean-up, a tick box says so. With it unticked, the clean-up keeps every
     backup, including the new one it makes.
   - Alternative: list them in the window and delete on the same button press (the checker's version). Reason for the
     default: the two July backups are your only copies (about 25 GB). One extra click costs nothing. A pile of backups
     costs disk (each is about the size of the database, 10 GB or more by the time the clean-up is offered, and you have
     470 GB free) but never data. The disk space card in Step 4 clears old backups later, with its own preview.
   - The name on screen follows Phase 3's wording pass, which renames the RLM page to "Learning Database".
2. **The detailed debug record of every AI message is off unless you switch it on (Step 2). This one changes the design.**
   - What you would see: one new switch in Settings, "Keep a detailed debug record of every AI message", set to off.
     Nothing changes in your sessions. Harness's data folder stops growing by about 2.3 GB every half day (when Harness is
     busy). Records already stored are not touched by this change; they still expire after 30 days, as now. The 35 GB file does not get smaller by
     itself (that needs Steps 3 and 4 and your yes).
   - If you turn the switch on, records start again within seconds, with no restart, and the growth returns. Anyone who needs
     those records as evidence (a live-test run, a developer script) turns it on first.
   - Recommended: off. Nothing in Harness reads the record; two developer scripts do. Alternative: keep recording with a
     7-day window and one stored copy of each message. That is a larger change (Step 2 would grow into a window change and a
     rebuild) and the file keeps growing.
3. **The 30-day limit on the debug record stays as it is (Steps 2 and 3).** Alternative: 7 days. Reason: shortening it is a
   bulk delete of weeks of records at once, so it must go through the ask-first path (the card's "Clear now"), not a quiet
   setting change.
4. **The 35 GB conversation file shrinks through a one-time rebuild that asks first, and only after the old debug records
   are gone (Steps 3 and 4).** Alternative: keep the debug record in a separate file, or rebuild automatically at start.
   Reason: the rebuild is cheap only once the 33 GB is gone (it then copies about 2.3 GB of real conversation data). It
   pauses saving while it runs (a trial run in Step 3 measures for how long), so you start it, and it names that cost first.
5. **Every clean-up on the disk space card, the leftover work folders card and the old-record clean-ups needs a preview
   first, and Harness itself refuses to run one that was not previewed (Steps 4, 5 and 6).** Alternative: confirm on screen
   only. Reason: a script or an agent that calls Harness directly could skip a screen. A refusal inside Harness cannot be
   skipped. Step 1's backup window is protected differently, by its own unticked tick box (choice 1).
6. **The disk space panel is a card in Settings > Doctor called "Disk space used by Harness", not a new settings tab
   (Step 4).** Alternative: a new "Storage" tab. Reason: the settings screen's code is at its size limit, another session is
   editing the tab list, and Phase 3 renames the old Memory tab to "Storage & buffers", so a second thing called Storage
   would confuse.
7. **No new automatic deletion anywhere in this plan (Steps 1, 4 and 5).** Alternative: an opt-in weekly tidy for things
   nothing reads. Reason: your rule is to ask first. The biggest growth is stopped at the source, and the card shows what has
   built up. A weekly tidy can follow once you have used the card for a month.
8. **Saved session records and session activity logs are offered for clean-up at 30 days (Step 5).** Alternative: 90 days,
   which frees 0.9 GB of records instead of 1.5 GB and 1.8 GB of logs instead of 4.0 GB. Reason: 30 days matches the rule
   Harness already uses for snapshots and sits far outside the 7-day window used to recover a crashed session. Whether
   History's "restore" still works for a record over 30 days old is a live check that decides the dialog's wording.
9. **Learning-database backups: the newest backup is always kept, and age is only a "can be given back" figure (Step 4).**
   Alternative: delete by age automatically. Reason: the two July copies are your only backups, so the card never offers the
   newest one and never acts without your yes.
10. **Leftover work folders can be removed from the card, but only behind a preview and a confirmation, one folder at a time
    (Step 6). This one changes the design.**
    - What you would see: Settings > Doctor gets a "Leftover work folders" card. Each row shows the folder name, who made it
      ("Made by a Harness loop" or "Made by Claude Code"), its age, its size and one sentence such as "Holds 1 saved change
      (185 files) that your main copy does not have." or "Already in your main copy. Safe to remove."
    - "Review" opens a window that says what goes, what stays and whether it can be undone. Cancel is the default. There are
      three removals: "Remove the folder, keep the saved work", "Remove the folder and its saved work, because your main
      copy already has it", and "Discard the saved work", which needs a ticked box and names the number of files. There is
      no "remove all".
    - Alternative: report only, with no removal at all. That drops the removal code and the window, and you would use two
      `git` commands the card offers to copy. Recommended: removal with a preview, because 12 folders and 8 GB are worth a
      button, and Harness refuses anything it did not preview.
11. **Only folders that Harness made are removable. The two Claude Code made, and any other folder, are report-only
    (Step 6).** Alternative: remove those too. Reason: Harness's own ownership check already refuses them, and they are not
    Harness's to delete. The card shows "Made by Claude Code. Harness will not remove it." with a button that copies the
    two `git` lines.
12. **A work folder counts as "leftover" after 14 days with no live owner (Step 6).** Alternative: 30 days. Reason: all 12
    are about three weeks old, so either works. 14 days keeps a loop's new folder off the list for two weeks.
13. **Claude's requests to be woken later are shown and counted first, with no off switch yet (Step 11). This one changes the design.**
    - What you would see: a quiet line in the session when Claude asks for one ("Claude asked to be woken at 14:32 (in 25
      minutes)") or cancels one ("Claude cancelled its wake-up request"). If you close the session while one is waiting,
      a last line says "This session ended while Claude had a wake-up pending; it will not happen." Harness also counts
      them in its log. Nothing is blocked. The first line says "asked" because nobody has shown yet that a wake-up really
      happens inside a Harness session; once Step 11's live check shows it does, the wording can say "scheduled".
    - Alternative: block the tool now, so Claude uses Harness's own wake-ups instead. Reasons not to yet: Claude's `/loop`
      skill relies on it; nobody has shown that a wake-up really fires inside a Harness session; and Harness's own wake-up
      has a known failure (two one-time wake-ups failed in mid-September). Decide after about two weeks of real counts. If
      you want it blocked now, Step 11 gains a setting and a block rule, and `/loop`'s dynamic mode stops working in
      Harness's Claude sessions.
14. **The wake-up count lives in memory only for now (Step 11).** Alternative: save it in the database now. Reason: its
    lasting home is the per-turn cost record that Phase 0 step 7b builds, and that does not exist yet. Until then the count
    starts again at zero whenever Harness restarts; the history so far (190 requests in 30 days) is written down in Step 2.
15. **If Harness cannot tell which Claude Code version is installed, it takes the safe path (Step 9).** Alternative: assume
    a recent version. Reason: a speed-up that saves cost on repeated instructions misbehaves on versions older than
    2.1.268, and sending Harness's instructions again when a session resumes may undo a different saving. So "unknown" has
    to mean "skip the speed-up and resume as today". To make "unknown" rare, Harness asks the installed Claude Code for its
    version whenever either rule needs it, including on worker machines.
16. **The shorthand price rows for Sonnet, Opus and Haiku move to the 5.5 prices, and their cached-word discount moves with
    them (Step 8).** Alternative: leave them and add only the new model names. Reason: the Claude Code changelog says the
    5.5 models are now the defaults, and the live price list still overrides at run time.
17. **Plan-usage requests: after a reply, skip the extra request when the figures are under 10 minutes old; after a "too
    many requests" refusal, wait as long as the service asks (5 minutes if it says nothing, never under 1 or over 60)
    (Step 10).** Alternative: slow the other providers now too. Reason: only Claude's usage service has been shown to lack
    any limit, so start there and read the new log line. The "figures are fresh" shortcut only works for sessions that run
    on one of your account profiles (Step 10 explains why); the waiting rule works for every session.
18. **The Codex-list refresh, the RTK update and the unused-code removal are done in the Phase 1 plan, and the stray backup
    file in Phase 0. Step 12 adds two small safeguards on top of the first two.** Alternative: build all four here as well.
    Reason: those plans already list them with their own size budgets, and doing them twice would break the budgets. The
    two safeguards (a log line when the Codex list falls behind again, and a check that the three RTK version settings
    agree) are small and belong to no other plan. If the Phase 1 plan is dropped, the three items move back here.
19. **`CLAUDE.md` is left as it is (Step 13).**
    - What you would see: nothing. Copilot, inside this repo only, keeps reading the main instruction file twice per
      request. Claude Code and Codex are not affected. The real fix for the tokens belongs inside Harness's own Copilot
      sessions, not in this file.
    - The other options: delete the file (needs Claude Code 2.1.277 or newer wherever it runs, and loses the automatic
      Angular conventions line); turn it into a link to the other file (breaks on Windows without link support; not
      recommended); or fix it only inside Harness. Step 13 has the details.
    - Recommended: leave it. The cost is small, there is no risk, and it is the safest for any worker machine with an older
      Claude Code.

## Ground rules for every step

1. **Read first.** Re-read the file, its callers and its specs before editing. Line numbers here are from 10 Oct.
2. **Prove the bug first.** Where a step names a failing test, write it before the fix and confirm it fails on today's code.
3. **Work in the current checkout.**
   - Do not create a feature branch or worktree; that is James's rule.
   - Other sessions have uncommitted work in this tree (182 entries on 10 Oct). Treat anything already modified before you
     start as theirs. The files below matter to this plan:
     - **Quota service files** (MiMo multi-account work): `src/main/core/system/provider-quota-service.ts`,
       `provider-quota/mimo-console-credentials-reader.ts`, `src/main/providers/account-pool/account-quota-probes.ts` and
       `account-quota-evidence.ts`, with their specs. Step 10 avoids all of them.
     - `src/renderer/app/features/settings/settings-navigation.ts` (provider account labels). This plan adds no settings
       tab, so it does not edit it.
     - `src/main/cli/adapters/remote-cli-adapter.ts` and its spec. Step 9 only reads it, to see how a worker's Claude
       version is learned.
     - `src/main/workspace/git/worktree-integration.ts`. Step 6 reads it for patterns only.
     - `scripts/check-ts-max-loc.ts` (another session raised two ceilings). If a step ever needs a ceiling edit, edit only
       that file's own line and say so in the as-built notes.
     - `src/main/persistence/rlm/rlm-schema.ts` with the untracked `rlm-migrations-076-080.ts` (RLM migrations). This plan
       adds no migration.
     - `docs/DEVELOPMENT.md` (33 lines added by another session). It does not mention `CLAUDE.md`, so Step 13 needs no edit
       there.
   - **Shared by many plans:** `src/shared/types/settings.types.ts` (857 lines, room 32) and
     `src/main/core/config/settings-control-policy.ts` (844 lines, room 46). Phases 0 to 5 and this plan together add about
     15 settings. This plan adds one (`recordProviderEvents`, Step 2), or two if James asks for the wake-up off switch
     (`claudeSelfWakeups`, Step 11, change 4). Write each as one line in each file with no separate comment line, and
     re-count the room before editing. If another plan has used it up, raise that one ceiling
     on purpose with a value edit in `scripts/check-ts-max-loc.ts` and say so. Do not squeeze the setting into a
     different file.
   - Never stage, revert or reformat their work. Stage only your own hunks.
4. **File-size limits** (`npm run check:ts-max-loc`). Allowlisted files may grow to their ceiling plus 50 lines; other files
   are capped at 700. Headroom on 10 Oct:

   | File | Lines now | Room left | Plan |
   |---|---|---|---|
   | `src/main/cli/adapters/claude-cli-adapter.ts` | 2,114 | 7 | Step 9 adds about 3 (reading the version when it is unknown); Step 11 adds about 4; Step 8 adds none. Together they use all 7 lines. Shared with Phase 0 (7b.0 moves about 75 lines out, and is the real source of room) and Phase 1 (Step 14a nets about -1). Re-count before each edit; land Phase 0 step 7b.0 first |
   | `src/main/cli/adapters/codex-app-server-turn-adapter.ts` | 697 | 3 | Step 7: replace comment lines with the same number or fewer; never grow |
   | `src/main/session/session-continuity.ts` | 1,742 | 21 | Step 5: about 10 lines, logic in new modules |
   | `src/main/conversation-ledger/conversation-ledger-service.ts` | 680 | 20 | Step 3: three one-line methods |
   | `src/main/conversation-ledger/conversation-ledger-store.ts` | 669 | 31 | Step 3: three one-line methods |
   | `src/shared/types/settings.types.ts` | 857 | 32 | Step 2: one line (shared, see rule 3) |
   | `src/main/core/config/settings-control-policy.ts` | 844 | 46 | Step 2: one line (shared) |
   | `src/shared/types/provider.types.ts` | 658 | 42 | Step 8: about 14 |
   | `src/main/instance/instance-communication.ts` | 2,430 | 116 | Step 11: about 6 (ceiling 2,496 plus 50) |
   | `src/main/instance/instance-communication-provider-events.ts` | 81 | 619 | Step 11: one listener, about 5 lines |
   | `src/main/ipc/ipc-main-handler.ts` | 579 | 121 | Steps 4 and 6: an import and a register call each |
   | `src/renderer/app/features/settings/doctor-settings-tab.component.ts` | 573 | 127 | Steps 4 and 6: one tag and one import each |
   | `src/preload/domains/workspace.preload.ts` | 588 | 112 | Step 6: about 12 |
   | `src/main/workspace/git/worktree-manager.ts` | 1,080 | 4 | **Do not edit** |
   | `src/renderer/app/features/worktree/worktree-page.component.ts`, `worktree-panel.component.ts` | 706, 713 | 61, 51 | **Do not edit** (Step 6 uses new modules) |
   | `src/renderer/app/features/settings/settings.component.ts` | 699 | 1 | **Do not edit** (Step 4 uses a card, not a tab) |
   | `src/main/conversation-ledger/ledger-store-port.ts` | 405 | 295 | Step 3 |
   | `src/main/conversation-ledger/conversation-ledger-worker-client.ts` | 506 | 194 | Step 3: a per-call timeout |
   | `src/main/conversation-ledger/conversation-ledger-worker-main.ts` | 250 | 450 | Step 3 |
   | `src/main/conversation-ledger/provider-event-capture-service.ts` | 147 | 553 | Step 2 |
   | `src/main/conversation-ledger/provider-event-capture-store.ts`, `provider-event-capture-maintenance.ts` | 96, 76 | 604, 624 | Step 3 |
   | `src/shared/types/settings-defaults.ts`, `settings-surfacing.ts`, `settings-metadata-core.ts` | 451, 276, 297 | 249, 424, 403 | Step 2: one entry each |
   | `src/main/rlm/rlm-backup-retention.ts`, `rlm-storage-maintenance.ts`, `rlm-storage-maintenance-runtime.ts` | 171, 335, 60 | 529, 365, 640 | Step 1 |
   | `src/shared/types/rlm-maintenance.types.ts` | 94 | 606 | Step 1 |
   | `src/renderer/app/features/loop/rlm-storage-maintenance.component.ts` | 233 | 467 | Step 1 (also edited by Phase 3's wording pass and Phase 4's tooltip step; see the shared-files list) |
   | `src/renderer/app/core/state/rlm-storage-maintenance.store.ts` | 165 | 535 | Step 1 |
   | `packages/contracts/src/schemas/rlm-maintenance.schemas.ts`, `src/preload/domains/rlm-storage-maintenance.preload.ts` | 29, 36 | well under 700 | Step 1 |
   | `packages/contracts/src/channels/diagnostics.channels.ts` | 17 | 683 | Step 4 |
   | `src/preload/domains/diagnostics.preload.ts` | 53 | 647 | Step 4 |
   | `packages/contracts/src/channels/workspace.channels.ts` | 169 | 531 | Step 6 |
   | `src/main/workspace/git/worktree-cleanup.ts` (reused) | 134 | 566 | Step 6: reused; at most an export |
   | `src/main/cli/adapters/claude-cli-argv-builder.ts` | 352 | 348 | Step 9 |
   | `src/main/cli/adapters/claude-cli-feature-probes.ts` | 76 | 624 | Step 9 (owns `resolveClaudeCliVersion`, shared with Phase 1 Step 2) |
   | `src/shared/data/model-pricing.ts` | 264 | 436 | Step 8: about 25 |
   | `src/main/cli/adapters/claude-env-pack.ts` | 93 | 607 | Step 7a: header comment only; the same comment is edited by Phase 1 Step 4 (see Step 7a) |
   | `src/main/cli/adapters/codex/app-server-initializer.ts` | 298 | 402 | Step 12a: one line and an import |
   | `src/main/instance/instance-async-work-continuation.ts` | 261 | 439 | Step 7: one comment line |
   | `src/main/core/system/provider-quota/quota-auto-refresh.ts` | 130 | 570 | Step 10 |
   | `src/main/core/system/provider-quota/claude-usage-endpoint-probe.ts` | 389 | 311 | Step 10 |
   | `src/main/cli/adapters/base-cli-adapter.types.ts` | 393 | 307 | Step 11: about 2 |
   | `src/main/instance/lifecycle/instance-termination.ts` | 384 | 316 | Step 11 |

   Put new logic in new modules and keep call-site edits to a line or two. Do not raise a ceiling except as rule 3 says.
5. **No model-facing prompt text is added by this plan.** The lines Step 11 adds to a session are system notices for the
   reader, not instructions to a model. If a step turns out to need prompt text, follow
   `docs/prompt-engineering-house-style.md`.
6. **Wording on screen:**
   - Plain English and "Harness"; no internal codes. Use Phase 3's vocabulary: "session" (not "chat" or "instance"),
     "helper agent", and "learning database" for what the screens call RLM today.
   - Do not call anything "Storage" in a title. Phase 3 renames the old Memory settings tab to "Storage & buffers".
   - Tooltips use `appTooltip` with `TOOLTIP_COPY`. Do not add new `title=` attributes to controls.
   - A tooltip may not be the only place that shows a state or a consequence (house rules at the top of `tooltip-copy.ts`).
     Every dialog states what a clean-up removes in visible text.
7. **IPC:** add the channel in `packages/contracts/src/channels/*.channels.ts`, then run `npm run generate:ipc`. Add the
   Zod payload schema, handler and preload domain, then run `npm run verify:ipc` and `npm run verify:ipc-usage`. Steps 4
   and 6 add channels; Step 1 only adds a field to an existing request.
   - A new `@contracts/schemas/...` subpath needs entries in `tsconfig.json`, `tsconfig.electron.json`,
     `src/main/register-aliases.ts` and `packages/contracts/package.json` (see how `rlm-maintenance` appears in each), and
     in `vitest.config.ts` if a spec import fails to resolve.
   - If another session's uncommitted channel work is present, regenerate with `npm run generate:ipc` rather than merging
     the generated file by hand.
8. **No browser on the Mac.**
   - Test renderer behaviour headless in Vitest, with seeded stores.
   - Anything that needs eyes on the rebuilt app goes to the live checks. Those run on the Windows PC, or on the Mac only
     with James's OK. The Windows PC shows that machine's own data folder, not the Mac's.
9. **Never write to James's app databases, settings or folders from a script, and never delete real data.**
   - Use read-only queries (`?mode=ro`). Tests and rehearsals run on scratch copies in temporary folders.
   - This plan changes real data in only these places, each started by James pressing a button on a Harness screen after a
     preview: Step 1's tick box, the clean-ups in Steps 4, 5 and 6, and the one-time "Shrink the file".
   - `git worktree list` and `git branch --list` for the real repository must be identical before and after any rehearsal.
     Spec fixtures that run `git init` and make linked worktrees do so in throwaway folders outside the project, which is fine.
10. **Testing:** while working, run `npm run test:quiet -- <spec>`. When a step is finished, run the
    [gates](#final-verification) that apply.
11. **Commit only when James asks.**

## Order of work

Steps run one at a time unless two of them share no files. "Needs first" lists hard dependencies only.

| Step | Item | Size | Needs first | Main files (new modules in *italics*) |
|---|---|---|---|---|
| 1 | E1d Backups: name what would go, delete only on a tick | S | none | `rlm-backup-retention.ts`, `rlm-storage-maintenance.ts`, `rlm-storage-maintenance-runtime.ts`, `rlm-maintenance.types.ts`, `rlm-maintenance.schemas.ts`, the maintenance store, preload and window |
| 2 | E1a The debug record becomes opt-in (and the recorded ledger counts) | S | none (the counts are recorded in this step) | `provider-event-capture-service.ts`, five settings files, `architecture.md`, the livetest runbook |
| 3 | E1b Let the conversation file shrink | S-M | 2 | *`ledger-space-reclaim.ts`*, `provider-event-capture-store.ts`, `provider-event-capture-maintenance.ts`, the ledger store, service, port, worker client and worker |
| 4 | E1c Disk space card and the ask-first gate (4a main process, 4b card) | M | 1, 3 | `diagnostics.channels.ts`, *`storage.schemas.ts`*, *`cleanup-ticket.ts`*, *`storage-usage-service.ts`*, *`storage-cleanup-service.ts`*, *`storage-handlers.ts`*, `diagnostics.preload.ts`, `ipc-main-handler.ts`, *`storage-usage.store.ts`*, *`storage-usage-card.component.ts`*, `doctor-settings-tab.component.ts` |
| 5 | E1e Saved session records and activity logs | S-M | 4 | *`session-state-retention.ts`*, *`session-activity-log-retention.ts`*, `session-continuity.ts` (about 10 lines), the storage services and card |
| 6 | E2 Leftover work folders | S-M | 4 (the card's pattern and `cleanup-ticket.ts`); Phase 0 step 2.6a is nicer | *`leftover-worktree-report.ts`*, *`leftover-worktree-removal.ts`*, `workspace.channels.ts`, *`worktree-leftover-handlers.ts`*, `workspace.preload.ts`, *`leftover-worktrees.store.ts`*, *`leftover-worktrees-card.component.ts`* |
| 7 | E3.5 and E3.6 Two wrong notes in the code | XS each | none | `claude-env-pack.ts`, `instance-async-work-continuation.ts`, `codex-app-server-turn-adapter.ts` |
| 8 | E3.4 Claude 5.5 prices (the price table only) | S | Phase 0 step 7c's final diff | `provider.types.ts`, `model-pricing.ts`, the offline price snapshot |
| 9 | E3.3 Claude version checks | S | none; owns the version helper shared with Phase 1 Step 2; adapter room (Phase 0 step 7b.0) | `claude-cli-argv-builder.ts`, `claude-cli-feature-probes.ts`, `claude-cli-adapter.ts` (about 3 lines) |
| 10 | E3.9 Quota refresh hygiene | S | none | `quota-auto-refresh.ts`, `claude-usage-endpoint-probe.ts`, *`quota-refresh-policy.ts`* |
| 11 | E3.10 Claude's self wake-ups, shown and counted | S-M | room in `claude-cli-adapter.ts`: Phase 0 step 7b.0 (or the 7 free lines, if nothing else has used them) | *`claude-cli-self-wakeup.ts`*, *`self-wakeup-tracker.ts`*, `claude-cli-adapter.ts` (about 4 lines), `base-cli-adapter.types.ts`, `instance-communication-provider-events.ts`, `instance-communication.ts`, `instance-termination.ts` |
| 12 | E3.1 and E3.2 safeguards (12a, 12b: XS each); E3.7 and E3.8 pointers (12c, 12d) | XS each | 12a: Phase 1 Step 1a; 12b: Phase 1 Step 18a; 12c: Phase 1 Step 14a; 12d: Phase 0 step 2.6b | *`codex-protocol-snapshot-check.ts`*, `app-server-initializer.ts` (one line), *`rtk-version-pins.spec.ts`*, `fetch-rtk-binaries.js` (a comment) |
| 13 | CLAUDE.md: the options | XS | James's choice | none unless he picks option 2 or 3 |

Files shared across steps: `rlm-maintenance.types.ts` and `rlm-backup-retention.ts` (Steps 1 and 4), the ledger files
(Steps 2 and 3), the storage services and card (Steps 4, 5 and 6 each add clean-up targets or rows), `doctor-settings-tab.component.ts`
(Steps 4 and 6, one tag and one import each), `claude-cli-adapter.ts` (Steps 9 and 11, and other plans) and
`claude-cli-argv-builder.ts` (Step 9, and Phase 1 Steps 2, 4, 9a and 18b). Do those steps in the order above. Three files
are also edited by other plans:
- `claude-env-pack.ts` (Step 7a, and Phase 1 Steps 2, 4 and 5a). Step 7a's header rewrite and Phase 1 Step 4's header note
  are one edit of one comment: see Step 7a for who goes first.
- `rlm-storage-maintenance.component.ts` (Step 1; Phase 3's wording pass renames its "RLM" strings; Phase 4's tooltip step
  adds a hint to its close button). Whoever comes second re-reads the file before editing and keeps the other's change.
- `claude-cli-feature-probes.ts` (Step 9 here, and Phase 1 Step 2 through the shared `resolveClaudeCliVersion`): see Step 9.

**Why the order differs from the checker's letters (E1a, E1b, E1c, E1d, E1e).** Step 1 is the only step that guards data
James already has, so it goes first even though the checker listed it fourth. Step 3 comes before Step 4 because the card's
conversation-file row and "Clear now" need Step 3's chunked sweep and size numbers. The E3 items follow the clean-up work
because none of them guards data.

---

## Step 1. E1d: Learning-database backups: name what would go, delete only on a tick (S)

**For James:** Harness keeps two backups of its learning database from 12 July, about 25 GB together. Today, the next time
that database's clean-up runs, Harness quietly deletes the older one (about 14 GB) and tells you only afterwards. After this
step the clean-up window lists every backup it could delete, with date and size, and deleting any of them needs a tick box
that starts unticked. Leave it unticked and every backup is kept. The window opens only from a warning that appears at 10 GB
(the database is 6 GB now), so nothing is about to happen; this closes the trap before it can.

**Verified (10 Oct):**
- **Two July backup sets exist** (re-checked by the plan writer with a read-only `ls` and `du` of
  `~/Library/Application Support/harness/rlm/backups`): `rlm-maintenance-20260712T113225474Z-….db` (13,660,766,208 bytes) with
  a `_content` folder of about 0.4 GB, and `rlm-maintenance-20260712T170553550Z-….db` (11,312,406,528 bytes) with a
  `_content` folder of about 0.4 GB. Together about 25 GB. There is no leftover `.rlm-backup-prune-*` staging folder.
- **A successful run deletes every backup past the newest two, with no prompt.**
  - `RlmStorageMaintenanceService.run` makes a new backup first (`rlm-storage-maintenance.ts:176-182`). After the reload it
    calls `this.dependencies.pruneBackups(RLM_BACKUP_RETENTION_COUNT)` (`:221`). The count is 2
    (`rlm-maintenance.types.ts:6`).
  - `pruneOldBackups` (`rlm-backup-retention.ts:28-55`) sorts newest first and removes every set past `keepCount` at once
    (`:51-53`). `removeBackupSet` (`:66-107`) stages a set by renaming it, then deletes it.
  - With the two July sets plus the new one, the older July set goes. The result reports it only afterwards
    (`backupsPruned`, `rlm-maintenance.types.ts:72`; shown as "N old backups removed" at
    `rlm-storage-maintenance.component.ts:92-94`).
- **The window says nothing about it beforehand.** `preview()` returns no backup information
  (`rlm-storage-maintenance.ts:124-142`; `RlmMaintenancePreview`, `rlm-maintenance.types.ts:33-45`). The window says
  Harness "will back up the database and external content, then remove session stores not used since …"
  (`rlm-storage-maintenance.component.ts:56-59`).
- **Only that window can start a run.**
  - The channel `RLM_STORAGE_RUN_MAINTENANCE` is handled at `rlm-maintenance-handlers.ts:32-38`. Only the store's `run()`
    sends it (`rlm-storage-maintenance.store.ts:114-138`).
  - `initializeRlmStorageMaintenance` is called only from `ipc-main-handler.ts:291-294` (the call is on `:293`), and
    `getRlmStorageMaintenance()` has no caller outside specs (`command grep` over `src`).
  - The window opens from the banner in the loop screen (`loop-control.component.html:56`). The banner shows only when the
    database health is not "healthy" (`rlm-storage-maintenance.store.ts:28-36`), which means from 10 GB
    (`rlm-maintenance.types.ts:1`). `rlm/rlm.db` is 6,251,917,312 bytes today.
- **The request cannot carry a choice.** `RlmMaintenanceRequestSchema` is `{ loopRunId? }`, strict
  (`rlm-maintenance.schemas.ts:5-9`).
- **This step's protection is the unticked box, not Step 4a's preview ticket.** The run is renderer-only IPC, and a ticked
  name is matched against the directory listing and re-checked at run time; it is never used as a path. That is no weaker
  than today's code, which prunes with no prompt at all. Steps 4, 5 and 6 use the stronger preview ticket (choice 5).
- `removeBackupSet` is private to its module (`rlm-backup-retention.ts:66`), so Step 4 needs it exported or wrapped.
- None of the files this step edits is modified by another session.

**Change:**
1. **`rlm-backup-retention.ts`** (171 lines, room 529).
   - Export `listBackupSets(directory)`, returning `{ name, createdAt, bytes }[]` newest first. `bytes` includes the
     `-wal` and `-shm` sidecars and the `_content` folder. Reuse `backupSetPaths`, `parseBackupTimestamp` and `sizeOf`, and
     the existing name pattern.
   - Give `pruneOldBackups(directory, keepCount, onlyNames?)` a third argument. When it is given, a set past the keep count
     is removed only if its file name is in the set. Names are matched against the directory listing and never used as paths.
     Without the argument the behaviour is unchanged.
   - Export `removeBackupSet` (or a thin `removeBackupSetByName`) for Step 4, so removal logic exists once.
2. **Types** (`rlm-maintenance.types.ts`, 94 lines).
   - `RlmMaintenancePreview` gets `backups: Array<{ name: string; createdAt: number; bytes: number; wouldBeRemoved: boolean }>`,
     newest first. `wouldBeRemoved` is true for a set that lies past the keep count once this run has added its own new
     backup: index `>= RLM_BACKUP_RETENTION_COUNT - 1`. With two sets on disk that is the older one.
   - `RlmMaintenanceRequest` gets `deleteOldBackups?: string[]` (the names that were ticked).
   - The success result gets `backupsKept?: number`.
3. **Service** (`rlm-storage-maintenance.ts`, 335 lines).
   - Dependencies gain `listBackups()`. `preview()` fills `backups` from it. `pruneBackups` takes `(keepCount, onlyNames)`.
   - At `:221`, call `pruneBackups` only when `request.deleteOldBackups` holds at least one name. Otherwise skip it, set the
     summary to `{ deleted: 0, bytesFreed: 0, failed: 0 }` and log one info line ("kept N earlier backups; no deletion was
     requested"). A ticked name that is not (or no longer) past the keep count is ignored and logged.
   - Fill `backupsKept` from `listBackups()` after the step.
   - The staged-leftover sweep inside `pruneOldBackups` therefore runs only with a ticked deletion, as before.
4. **Wiring** (`rlm-storage-maintenance-runtime.ts`, 60 lines, `:24-35`; `pruneBackups` is at `:34`): pass `listBackups: () => listBackupSets(backupDirectory)`
   and the new `pruneBackups` shape.
5. **IPC (a field, no new channel, so `generate:ipc` is not needed):**
   - `rlm-maintenance.schemas.ts` (29 lines): add `deleteOldBackups: z.array(z.string().min(1).max(300)).max(50).optional()` to
     `RlmMaintenanceRequestSchema`.
   - `rlm-storage-maintenance.preload.ts:22-23`: `rlmStorageRunMaintenance(loopRunId?, deleteOldBackups?)` sends only the
     fields that are set.
   - `rlm-storage-maintenance.store.ts`: `run(loopRunId?, deleteOldBackups?)` and the interface line 13.
6. **The window** (`rlm-storage-maintenance.component.ts`, 233 lines). Under the numbers add a "Backups" block (wording for
   review; all of it says Harness):
   - "Harness makes a new backup before it cleans up. Earlier backups: 12 July 2026, 12:32, 14.1 GB; 12 July 2026, 18:05,
     11.7 GB."
   - For each set with `wouldBeRemoved`, a labelled tick box, unticked by default: "Also delete the older backup after the
     clean-up: 12 July 2026, 12:32, 14.1 GB. This cannot be undone."
   - "Leave this unticked and Harness keeps every backup."
   - **Date, time and size.** The two July sets are from the same day, so each row shows the time as well as the date (the
     window's existing `date()` shows the date only). The sizes include the content folder (13,660,766,208 bytes of
     database plus about 0.4 GB of content is 14.1 GB), so they are larger than the database files alone. Use the window's
     existing size helper (`bytes()`, which prints GiB) here and the same helper in Step 4b's card, so one backup never
     shows two sizes. The numbers above are rounded decimal GB and are for wording only.
   - The Run button sends the ticked names. The tick state resets whenever a new preview opens. The result shows "N earlier
     backups kept" when none were deleted.
   - Words this step touches: the window title "Clean up stale RLM sessions" becomes "Clean up Harness's learning database",
     and the two banner headings ("RLM storage limit reached", "RLM storage needs maintenance") become "Learning database
     limit reached" and "Learning database needs maintenance". Progress lines in the service keep their old text until
     Phase 3's wording pass.
   - No `title=` attribute. The consequence is in visible text next to the box.

**Tests:**
- `rlm-backup-retention.spec.ts` (exists): "listBackupSets returns name, date and size including the content folder, newest
  first"; "pruneOldBackups with a name set removes only named sets past the keep count"; "a named set inside the newest
  keep-count sets is kept"; "without a name set the old behaviour is unchanged". Fake `rlm-maintenance-*.db` files in a temp
  folder only.
- `rlm-storage-maintenance.spec.ts` (exists):
  - "preview lists the backups and marks the ones this run could remove";
  - "a run with no ticked names deletes no backup and reports how many it kept" (**fails on today's code**, which prunes);
  - "a run with a ticked name deletes exactly that set";
  - "a ticked name that is one of the newest kept sets is ignored";
  - "pruneBackups is not called when nothing is ticked".
- `rlm-storage-maintenance-runtime.spec.ts` (exists): the new wiring.
- Contracts spec for `RlmMaintenanceRequestSchema`: accepts a names list; rejects unknown keys; rejects more than 50 names.
- `rlm-storage-maintenance.component.spec.ts` (headless): "the window lists the earlier backups with date, time and size"; "the box
  is unticked by default"; "Run sends no names when unticked and the names when ticked"; "the tick resets for a new
  preview"; "no `title=` attribute". Store spec: `run` passes the names through.

**Risks:**
- **Behaviour James will see:** a clean-up no longer frees backup space by default. Each run adds a backup about the size of
  the database until he ticks the box or uses Step 4's card. The disk has about 470 GB free.
- The preview and the run list the backups at different moments. The run re-lists and only deletes names that are still past
  the keep count, so a stale window cannot delete a backup that has since become one of the newest.
- Existing assertions that a run prunes backups change; update them on purpose.
- Cost: none (no model calls).

**Done when:**
- With the box unticked, a run on a scratch folder deletes no backup, and the result says how many it kept.
- With the box ticked, only the listed older backup goes, and a failed removal puts back what it moved (existing behaviour).
- The window shows both July backups with dates, times and sizes before anything runs.
- `command grep -rn 'pruneBackups(' src` shows the service calling it only behind the ticked-names check.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Step 2. E1a: The detailed debug record becomes opt-in (S)

**For James:** Harness keeps a detailed debug record of every message the AI tools send. It is the biggest thing on your
disk (about 33 GB), nothing in Harness reads it, and it grows by about 2.3 GB every half day when Harness is busy. After
this step the record is off unless you switch it on in Settings (one new switch). Nothing is deleted: the records already stored expire after 30
days, as they do now, and the file only gets smaller through Steps 3 and 4, with your yes. If you ever need the record for
a debugging session or a live test, turn the switch on first.

**Verified (10 Oct, measured by the checker with read-only `du` and read-only SQLite unless marked; no data was changed):**
- **Size now.** 96.4 GB under `~/Library/Application Support/harness` at 15:50 (`du -sk`); 96.8 GB at 17:00 (plan writer).
  The conversation file `conversation-ledger/conversation-ledger.db` was 35,004,911,616 bytes plus a 269 MB write-ahead log
  at 15:50, and 35,245,494,272 bytes at 17:00 (plan writer: +240 MB in about an hour). The reviewer later measured 97.4 GiB
  under the data folder at about 18:45 and 35,640,475,648 bytes for the conversation file at 19:01 (the fixer read the same
  figure at 19:12, so it was flat for those 11 minutes). About 470 GB of the 3.6 TB disk is free. Folder totals in this plan
  are `du` figures (binary GB); file and table sizes are byte counts (decimal GB).
- **The bloat is one table.** `dbstat` per table: `conversation_messages` 2.0 GB (187,014 rows), `evidence_records` 0.18 GB,
  `evidence_cards` 0.08 GB, the rest tiny. So about 2.3 GB is conversation data that Harness reads. `provider_event_captures`
  holds about 32.7 GB in 4,870,475 rows, from 9 Sep 18:15 to 10 Oct 16:03.
- **The write rate is rising, and follows how busy Harness is.** Rows per day: 9 Sep 4.7K, 15 Sep 175K, 23 Sep 258K, 3 Oct
  354K, 8 Oct 334K, 9 Oct 370K, 10 Oct 428K (by 16:03). At about 6.7 KB a row (32.7 GB over 4.87M rows) and about 400,000 rows
  a day, a full 30-day window would hold roughly 80 GB (the plan writer's arithmetic). The 30-day sweep alone does not cap it.
- **The growth rate in GB: about 0.2 GB an hour, or 2.3 GB per half day, when Harness is busy (CORRECTED).** The reviewer
  measured the conversation file at +568 MB between 15:50 and 18:40 and +67 MB between 18:40 and 19:01. An earlier draft said
  "about 6 GB every half day"; that came from one comparison (28.9 GB at about 01:46 against 35.0 GB at 15:50, which is 6 GB
  in 14 hours and includes a burst), and no measurement since supports it. In a quiet spell the file does not grow at all.
- **"Each event stored twice" is true only for `output` events.** A sample of every 200th row (24,366 rows) gives an average
  `event_json` of 2,562 bytes and `raw_json` of 4,227 bytes. Codex `output` (2.43M rows) keeps 4.7 GB in each column, an
  identical copy; Copilot `output` (300K rows) 1.47 GB in each; Claude `tool_result` (220K rows) 0.75 and 0.91 GB. For
  `complete` events the payload sits only in `raw_json`, so dropping `event_json` does not help there. Writer:
  `provider-event-capture-store.ts:45-47`. "Store one copy" would therefore save at most 38% to 62%, and nothing for
  `complete` rows. With capture off by default it matters little.
- **The sweep works but cannot shrink the file.** `PROVIDER_EVENT_CAPTURE_RETENTION_DAYS = 30`
  (`provider-event-capture-maintenance.ts:11`), run daily with 20% jitter (`:13`, `:34-47`), as one `DELETE ... WHERE
  created_at < ?` (`provider-event-capture-store.ts:64-66`). The lowest row number is 4,824,197 against a highest of
  9,693,828, so about 4.8M rows were already swept. Freed pages are reused by new inserts, so `freelist_count` is 0 and the
  file sits at its high-water mark. `auto_vacuum` is 0. There is no vacuum on the ledger (re-checked:
  `command grep -rn 'VACUUM\|auto_vacuum\|incremental_vacuum' src/main/conversation-ledger` has no non-spec hit).
- **Capture starts unconditionally.** `initialization-steps.ts:203-208` starts the service and the sweep, fed by
  `instance-manager.ts:225` (`onRawBackedEvent: (envelope) => this.emit('provider:raw-event', envelope)`). `start()` listens
  at `provider-event-capture-service.ts:45-51`, and `enqueue` (`:101-108`) queues every raw-backed event.
- **No runtime reader.** `listProviderEventCaptures` is only plumbing (`conversation-ledger-service.ts:515-518`,
  `ledger-store-port.ts:239-242`, `conversation-ledger-worker-main.ts:152-153`). The only consumers are two developer scripts
  that run their own SQL: `scripts/capture-provider-fixture.ts:128-148` and
  `scripts/codex-context-pressure/provider-capture-source.ts:45-55`. Older docs cite the table as evidence
  (`docs/plans/livetest-remediation-register.md:12417`, `docs/plans/2026-09-27-codex-compaction-reliability_plan_completed.md:27`).
  So do two October docs (plan writer): the evidence step of `docs/plans/2026-10-10-mimo-multi-account_livetest.md` asks for
  "the exact status, body and message" from it, and `docs/plans/2026-10-10-oct-phase2-loops-converge_plan.md` records captured
  Copilot quota errors from it as evidence. Neither is a runtime reader. (Both documents are still being edited, so their line
  numbers move; search for the quoted words.)
- **What "E1's ledger counts come before any change to what the ledger captures" means in code.** The three counts are SQL
  scans of `provider_event_captures.event_json`. That table is filled by exactly one chain (`instance-manager.ts:225` ->
  `ProviderEventCaptureService.enqueue` -> `appendProviderEventCaptures` -> `ProviderEventCaptureStore.append`,
  `provider-event-capture-store.ts:28-52`) and emptied by exactly one: the daily sweep
  (`provider-event-capture-maintenance.ts:57-71`). If capture is switched off, trimmed to `complete` and `context` events,
  or the sweep cut is shortened, the `tool_use` and `tool_result` rows the counts need stop arriving or are deleted within 30
  days. The counts cannot be re-run later. So they were run first, and the numbers are written down here.

**Ledger counts, recorded on 10 Oct (window 9 Sep 18:15 to 10 Oct 16:03; read-only, about 3 minutes in all). These are inputs
to other plans.**

| Count | Result | Caveat | Goes to |
|---|---|---|---|
| E3.10: Claude `ScheduleWakeup` calls | **190 calls in 59 sessions**, on 20 of the 30 days (13 Sep to 10 Oct; 13 calls on 10 Oct). 158 set a wake-up, 27 were `stop`, and 5 were refusals ("`prompt` is required when `stop` is not true"); 163 calls carried a delay of 90 to 3,600 s (median 1,500 s). All 190 results say `success: true`. The result text says the CLI re-invokes the session itself ("Next wakeup scheduled for hh:mm:ss ... the harness re-invokes you when the wakeup fires"). 20 `stop` results say "cancelled N pending wakeup(s)" | Shows the CLI accepts and queues the wake-ups. It does not show whether one fired inside a Harness session | **Step 11** in this plan (and the decision to build an off switch later) |
| C3b: Claude permission denials by tool | The ledger has **no failure flag** for Claude tool results (all 227,226 `tool_result` rows say `success: true`) and **no `permission_denial` records** (0 of 293,031 Claude `output` events). Read by text (a port of `claude-cli-permission-details.ts:21-60`): a broad reading finds 771 denial-looking results (Bash 613 in 158 sessions, Read 135 in 45, Grep 11, WebFetch 7, WebSearch 3, TaskStop 1, one MCP tool), so **non-Bash 158 (20%)**. The CLI's own phrases only: **22** (Bash 14, Read 8, nothing else) | The broad reading includes file contents or command output that contain the phrases. For prompts the truth lies between 8 and 158 non-Bash in 30 days. An exact count has to come from Harness's own permission records, not the ledger | **Phase 3, item C3b.** Phase 3's own checker measured an exact figure from Claude's own session files: 9 non-shell refusals in 35 days, in 4 sessions. It is inside this range and is the better source. Use it; keep this row only as a record |
| A20 / MEM-1 step 0: injected context | 3,662 user-message events (Claude 1,841, Codex 729, Copilot 678, Cursor 174, Antigravity 142, OpenCode 98). **1,379 (38%) carry an injected-context record**: code index (`indexedCodebaseContext`) 1,023 messages, **954,813 tokens** (median 1,003, max 1,200); `rlmContext` 519 messages, 82,376 tokens (median 84); `unifiedMemoryContext` 43 messages, 2,232 tokens. About **1.04M tokens in 30 days** | The code index is 92% of it. Not split into user or internal, root or child: `metadata.kind` appears on only 7 events. Whether every send is captured is not verified | **Phase 3, item A20** (its measure-first step). Phase 3's own 3-day count from Harness's logs puts the code block at about 90% of what gets added; this 30-day count agrees |

**Change:**
1. **New setting `recordProviderEvents`**, boolean, default `false`, in the five places, copying `persistSessionContent`.
   Write each as one line (see ground rule 3).
   - `settings.types.ts` (next to `:126`; room 32, shared); `settings-defaults.ts` (next to `:154`);
     `settings-surfacing.ts` (next to `:68`, value `'tab'`); a metadata entry beside `settings-metadata-core.ts:202` with
     `category: 'memory'` (the tab Phase 3 renames "Storage & buffers"); `settings-control-policy.ts` (next to `:343`,
     `open(z.boolean())`; room 46, shared).
   - Label: "Keep a detailed debug record of every AI message". Description: "Saves a full copy of each message the AI tools
     send. It is large (several GB a day when Harness is busy) and only developer scripts read it. Harness does not use it.
     Existing records are removed after 30 days as before."
   - `persistSessionContent` is defined as a setting in only these five files (its other hits are readers), so a plain
     boolean needs nothing else. No settings migration (a missing value takes the default).
2. **Gate the capture service.** In `ProviderEventCaptureService.enqueue` (`provider-event-capture-service.ts:101-108`),
   return early unless the setting is on. Read it with the settings manager on each event, so a change applies without a
   restart. Add an optional `enabled?: () => boolean` to `ProviderEventCaptureServiceOptions` (`:18-21`) for tests, defaulting
   to the setting. Do not clear `pending` when the switch turns off: events already queued still flush. Leave
   `initialization-steps.ts:203-208` and the daily sweep untouched, so old rows keep aging out whether the switch is on or off.
3. **Docs.** In `docs/architecture.md:156`, change "Capture is always on, retained for a fixed 30 days by jitter-scheduled
   maintenance" to say that capture is off unless the "Keep a detailed debug record of every AI message" setting is on, and
   that stored rows still expire after 30 days. Add one line to `docs/plans/livetest-campaign-runbook.md`: "turn the debug
   record on before a campaign that needs adapter-event evidence". Note in the as-built notes that
   `2026-10-10-mimo-multi-account_livetest.md` (the step that asks for "the exact status, body and message") needs the
   switch on before that evidence step.
4. **Land only with the counts above written into this plan.** They are, so nothing blocks this step.

**Tests:**
- `provider-event-capture-service.spec.ts` (exists, 190 lines): "ignores raw events while the debug record is off" (**fails on
  today's code**); "starts recording when the setting turns on, without a restart"; "events queued before it is switched off
  still flush".
- The settings completeness specs for the five places pass once all five entries exist (they fail until then).
- `provider-event-capture-maintenance.spec.ts` (exists): unchanged; a case "the sweep still runs while the record is off".

**Risks:**
- **Switching capture off removes evidence for diagnosis.** Old livetest notes use it. Mitigations: the switch is one click, and
  the 30-day window keeps existing rows until they expire.
- **The counts are gone once the old rows expire.** The table above is the record. Re-running them needs the record on for 30
  days.
- **A shorter window deletes in bulk.** Do not shorten the 30-day cut in this plan. If James wants 7 days, that is a bulk
  delete and must go through the ask-first path (and be chunked, Step 3).
- Developer scripts (`capture-provider-fixture.ts`, `provider-capture-source.ts`) find nothing while the switch is off.
- Cost: none (no model calls). The settings read per event is a map lookup.

**Done when:**
- With the switch off, a new Codex session adds no rows to `provider_event_captures` (the highest row number, read-only,
  before and after), and with it on rows appear within a few seconds.
- The setting exists in all five places and in Settings; the docs lines are in.
- The service spec and settings specs pass.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Step 3. E1b: Let the conversation file shrink (S-M)

**For James:** This step is groundwork, and you will not see it. The daily clean-up of old debug records is made gentler: it
works in small slices, so it can never hold up the saving of your conversations. Harness also learns how to hand freed space
back to the disk. The handing back itself only happens when you press "Shrink the file" in Step 4's card, after you have read
what it costs.

**Verified (10 Oct):**
- **Why the file never shrinks** is in Step 2: `auto_vacuum` is 0, the free list is 0, and the file sits at its high-water
  mark of 8,546,511 pages of 4,096 bytes (the earlier audit saw 7,077,610).
- **A working precedent exists.** `src/main/codemem/cas-workspace-index-maintenance.ts:98-109` `vacuumFreelistPages`: if the
  mode is 0, set `auto_vacuum = INCREMENTAL` and run `VACUUM`; if the mode is 2, run `incremental_vacuum`. It is called from
  `codemem-pruner.ts:72` through `cas-store.ts:606-607`.
- **The ledger worker is a single thread.** `DEFAULT_RPC_TIMEOUT_MS = 10_000`
  (`conversation-ledger-worker-client.ts:72`); the header (`:10-14`) says a rejected write is re-queued and retried by the
  transcript bridge. `call(method, args)` is at `:394` with the timer at `:493-494`. So a maintenance call must be short or
  chunked, or it must be an explicit, announced, ask-first action.
- **The sweep is one statement, through a long chain.** `pruneBefore` (`provider-event-capture-store.ts:64-66`) <-
  `pruneProviderEventCapturesBefore` in `conversation-ledger-store.ts:546`, `ledger-store-port.ts:102, 245-246, 384`,
  `conversation-ledger-worker-main.ts:154-155`, `conversation-ledger-worker-client.ts:248-249` and
  `conversation-ledger-service.ts:521-522`. One statement can delete a whole day's rows (up to about 0.43M) and hold the
  worker for several seconds. After a window change it could hold it for minutes.
- About 470 GB of disk is free, so a rebuild that needs scratch space is possible.
- None of the files in this step is modified by another session.

**Change:**
1. **New module `src/main/conversation-ledger/ledger-space-reclaim.ts`** (about 90 lines; takes a `SqliteDriver`):
   - `getLedgerStorageStats(db)`: page size, page count, free pages, `auto_vacuum`, plus cheap estimates for the debug record
     (lowest and highest row number, oldest and newest `created_at`, and an average row size from a small recent sample). It
     never runs `COUNT(*)` or `dbstat` on the live ledger: the worker is single-threaded and a call must finish inside 10 s.
   - `compactLedgerStorage(db, maxPages)`: `PRAGMA incremental_vacuum(maxPages)` only when `auto_vacuum` is 2. Returns the
     pages freed and the pages still free.
   - `rebuildLedgerStorage(db, { dbPath })`: copy the precedent (`PRAGMA auto_vacuum = INCREMENTAL; VACUUM`). It refuses
     unless free pages are at least half of the file, and unless `fs.statfs` shows free space of at least **twice the live
     size plus 1 GB** (about 6 GB with 2.3 GB live). Reason: VACUUM builds a compacted copy of the live data and then writes
     it back through the log, so it can need about twice the live data in free disk (SQLite's documentation; not run here).
     Once the old rows are gone it moves about 2.3 GB; with 33 GB still live it would need about 67 GB, which the half-the-file
     rule also refuses.
2. **Thin delegations only** (the two big ledger files are tight):
   - `conversation-ledger-store.ts` (669 lines, room 31) gets three one-line methods.
   - `conversation-ledger-service.ts` (680 lines, room 20) gets three one-line methods.
   - `ledger-store-port.ts` (405 lines): the three names go into the port interface, the direct port and the method-name
     union (`:383` area, beside `'pruneProviderEventCapturesBefore'`).
   - `conversation-ledger-worker-main.ts` gets three switch cases beside `:149-155`.
   - `conversation-ledger-worker-client.ts` gets the three methods and an optional per-call timeout
     (`call(method, args, timeoutMs?)`). The rebuild call gets 15 minutes. Every other call keeps 10 s (`:72`).
3. **Make the daily sweep chunk-safe.**
   - Add an optional `limit` to `pruneBefore` (`provider-event-capture-store.ts:64-66`) and to
     `pruneProviderEventCapturesBefore` (`conversation-ledger-store.ts:546`):
     `DELETE FROM provider_event_captures WHERE rowid IN (SELECT rowid FROM provider_event_captures WHERE created_at < ? LIMIT ?)`.
   - `runProviderEventCaptureMaintenance` (`provider-event-capture-maintenance.ts:57-71`) loops in 20,000-row steps, awaits a
     yield between steps, and sums the removed count. Each step is its own call, so each is well under 10 s.
4. **Compact after the sweep.** Call `compactLedgerStorage(db, 25_600)` (about 100 MB per call at 4,096-byte pages) until
   nothing is left to free. This is a no-op until the one-time rebuild has set `auto_vacuum`.
5. **The rebuild itself is never automatic.** It is the "Shrink the file" action in Step 4's card, offered once free pages
   exceed 5 GB.

**Tests:**
- `provider-event-capture-maintenance.spec.ts` (exists, 42 lines): "sweeps in 20,000-row steps and yields between them";
  "runs incremental vacuum after a sweep that removed rows, and does nothing when the file is not in incremental mode".
- New `ledger-space-reclaim.spec.ts` on a temp-file database: "rebuild switches `auto_vacuum` to 2 and the file shrinks after
  rows are deleted"; "refuses to rebuild when free pages are under half of the file"; "refuses when the disk has less than
  twice the live size plus 1 GB free" (`statfs` stubbed; also a case just above the threshold that proceeds);
  "`compactLedgerStorage` frees at most `maxPages`"; "`getLedgerStorageStats` runs no full scan" (the statements it prepares
  are listed in the spec).
- Store, service and worker specs for the delegations and the `limit`. Worker client spec: "the longer timeout applies only to
  the rebuild call; every other call still rejects at 10 s".

**Risks:**
- **The rebuild is a long single call** in the one-thread ledger worker. It runs only on request, behind the free-page and
  disk-space guards, with a 15-minute timeout for that one call. Pending conversation writes may time out at 10 s and are
  re-queued by the transcript bridge. Test on a synthetic copy first (below).
- A 20,000-row step is about 130 MB of rows at 6.7 KB each; if a step ever takes more than a few seconds on a busy machine,
  lower the step size rather than the timeout.
- Cost: none (no model calls).

**Done when:**
- The sweep spec shows chunked deletes and yields. `compactLedgerStorage` does nothing before the rebuild. The rebuild refuses
  when free pages are under half the file or the disk is too full.
- A scratch ledger with 300,000 captured rows shrinks after most rows are deleted and the rebuild runs (live check below).
- The rehearsal's measured rebuild time is written into the as-built notes, because Step 4b's dialog and the "In plain
  English" text quote it.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Step 4. E1c: A "Disk space used by Harness" card, with the ask-first gate (M, two parts)

Part 4a builds the numbers and the rule that nothing is deleted without a preview. Part 4b builds the card that uses them.
Steps 5 and 6 add more rows and a second card in the same pattern.

### 4a. The numbers, and the rule that a delete needs a preview (S-M)

**For James:** Harness learns to report how big each of its stores is and how much of that could be given back. It also
learns the rule that protects you: any clean-up has to be previewed first, and Harness refuses to run one that it did not
preview, even if a script asks it to. Nothing is deleted by this part on its own.

**Verified (10 Oct):**
- **There is no place that shows disk use today.** Folder sizes below are from the checker's `du` pass and the plan writer's
  re-check at 17:00 (96.8 GB in all; corrected 11 Oct: this leaves out `~/.ai-orchestrator/codex`, about 57 GB outside the data folder, which the October follow-ups plan, part 5a, adds to the card). Folder totals are binary GB; file and table sizes are decimal GB.

  | Store (name on screen) | Where, under the data folder | Size | What manages it today | Card action |
  |---|---|---|---|---|
  | Debug record of AI messages | `conversation-ledger/conversation-ledger.db`, table `provider_event_captures` | about 32.7 GB | daily 30-day sweep; no shrink | "Clear now", then "Shrink the file" |
  | Conversation history (kept) | the same file, other tables | about 2.3 GB | read by Harness | none |
  | Learning database backups | `rlm/backups` | about 25 GB | pruned only when a clean-up run happens (Step 1) | "Review and clean up" (newest kept) |
  | Learning database | `rlm/rlm.db` | 6.2 GB | its own clean-up window; browser audit rows pruned (`browser-audit-store.ts:126-128`) | display only |
  | Saved session records | `session-continuity/states` | 4.6 GB (1.5 GB over 30 days) | never removed (Step 5) | Step 5 |
  | Session activity logs | `projects/*/session-events/*.jsonl` | 6.3 GB, about four-fifths of `projects/` (4.0 GB over 30 days) | nothing reads or prunes them (Step 5) | Step 5 |
  | Code index | `codemem.sqlite` | 7.05 GB | `codemem-pruner.ts`, incremental vacuum | display only |
  | Evidence store | `conversation-evidence` | 3.8 GB | its own maintenance and deletion services | display only |
  | Codex command output | `codex-command-output` | 2.4 GB | 7-day expiry (works) | display only |
  | Everything else | snapshots 0.6 GB, output storage 1.1 GB, logs 0.7 GB, conversation history 0.6 GB, and more | | various | display only |

- **About 52 GB could be given back while the newest backup is kept:** 32.7 GB debug record, 14.1 GB for the older July backup
  (database plus content folder), 1.5 GB of saved session records over 30 days, 4.0 GB of activity logs over 30 days. (The
  checker's "about 63 GB" counted both July backups; the card never offers the newest.)
- **The Doctor tab can host a card.** `doctor-settings-tab.component.ts` (573 lines, room 127) already embeds a standalone
  component (`<app-cli-health-settings-tab />`, `imports: [CliHealthSettingsTabComponent]`, `:50` and `:214`).
- **Where the new handlers register.** The checker's report named `late-runtime-initialization-steps.ts` as the place the RLM
  maintenance service is created. That is wrong in this working tree (no RLM maintenance hit there): it is created by
  `initializeRlmStorageMaintenance(this.instanceManager)` at `ipc-main-handler.ts:291-294` (the call is on `:293`), and
  diagnostics handlers register at `:322`. Register the new handlers there (579 lines, room 121).
- **Channels file:** `diagnostics.channels.ts` is 17 lines; the preload domain `diagnostics.preload.ts` is 53 lines.

**Change:**
1. **IPC** (steps from the ground rules). Three channels in `packages/contracts/src/channels/diagnostics.channels.ts`:
   `STORAGE_GET_USAGE: 'storage:get-usage'`, `STORAGE_PREVIEW_CLEANUP: 'storage:preview-cleanup'` and
   `STORAGE_RUN_CLEANUP: 'storage:run-cleanup'`. Run `npm run generate:ipc`. Zod schemas go in a new
   `packages/contracts/src/schemas/storage.schemas.ts` (with its four alias entries). The target enum is
   `'event-record' | 'event-record-shrink' | 'rlm-backups' | 'session-records' | 'activity-logs'` (the last two arrive in Step
   5). The run request carries the `previewId` from the preview. The handler is a new
   `src/main/ipc/handlers/storage-handlers.ts`, registered in `ipc-main-handler.ts`. Preload methods go in
   `diagnostics.preload.ts`. Then run `npm run verify:ipc` and `npm run verify:ipc-usage`.
2. **The server enforces "ask first".**
   - `STORAGE_PREVIEW_CLEANUP` returns the exact items, the byte count, the oldest and newest date, a plain consequence
     sentence, whether it can be undone, and a `previewId`.
   - The main process issues and remembers each `previewId`: single use, valid 10 minutes, bound to the target and to a hash
     of the item list. This bookkeeping lives in its own small module, `cleanup-ticket.ts` (below), so Step 6 reuses the same
     code instead of copying it.
   - `STORAGE_RUN_CLEANUP` rejects a missing, unknown, expired or mismatched id. It re-lists the items at run time and refuses
     if the list changed ("The list changed since you looked. Review again.").
   - So neither the card nor an agent can delete without a preview. Only one clean-up runs at a time; a second request is
     answered "busy".
3. **New main modules in `src/main/storage/`** (a folder that already holds `project-storage-paths.ts`; each well under 300
   lines):
   - `cleanup-ticket.ts` (about 60 lines): `issueTicket({ target, itemsHash })`, `consumeTicket(id, { target, itemsHash })`
     (single use; rejects a missing, unknown, expired, reused or mismatched id) and a 10-minute expiry, with an injected clock
     for tests. It knows nothing about what is being cleaned. `storage-cleanup-service.ts` and Step 6's
     `leftover-worktree-removal.ts` both call it.
   - `storage-usage-service.ts`: sizes for the stores in the table. Cached for 60 seconds, async `readdir` and `stat` with a
     small concurrency cap, started when the card opens (the first scan covers more than 15,000 files in `projects/` and
     `session-continuity/` alone). Ledger numbers come from the worker's `getLedgerStorageStats` (Step 3).
     - **What "can be given back" means.** For the debug record it is the table's estimated size (what "Clear now" removes),
       not the ledger's free pages: the free list is 0 today, so by that rule the card would show nothing for 32.7 GB. For the
       other stores it is the files past the 30-day line (backups: every set except the newest).
     - **Two steps for the debug record.** The file itself only gets smaller after "Clear now" and then "Shrink the file". So
       the card shows two numbers for it: "can be cleared" (the table's estimated size) and, once rows are gone, "can then be
       handed back to the disk" (free pages, from `getLedgerStorageStats`).
     - **Progress bypasses the cache.** While a clean-up runs, the card's 2-second poll reads the running clean-up's progress
       (and `getLedgerStorageStats`, which is cheap) directly instead of the 60-second usage cache, so "Removed 1.2 million of
       4.9 million entries" is never a minute stale.
   - `storage-cleanup-service.ts`: preview and run per target, using `cleanup-ticket.ts`.
4. **Targets built in this part:**
   - `event-record` ("Clear now"): preview shows the estimated number of entries, the oldest and newest date and the
     estimated size (from `getLedgerStorageStats`, never `COUNT(*)`). Run is the chunked `pruneProviderEventCapturesBefore`
     loop from Step 3, with the cut-off set to now.
   - `event-record-shrink` ("Shrink the file"): offered only when free pages exceed 5 GB. Preview shows the live data size,
     the pages that would be given back and the free disk space needed. Run is `rebuildLedgerStorage` with its guards.
   - `rlm-backups`: preview uses Step 1's `listBackupSets`; it lists every set except the newest. The age figure
     `RLM_BACKUP_MAX_AGE_DAYS = 30` (a new constant in `rlm-maintenance.types.ts`) is used only to show "older than 30 days:
     X GB". It is never applied automatically and never to the newest set. Run removes the listed sets through Step 1's
     exported `removeBackupSet`, so a failed removal restores what it moved. The target refuses while a learning-database
     clean-up is running.
5. **Logging.** Each run logs one info line (target, number of items, bytes). No file contents, no secrets.

**Tests:**
- New `cleanup-ticket.spec.ts` (fake clock): "a ticket works once"; "it expires after 10 minutes"; "a different target is
  rejected"; "a different item hash is rejected"; "an unknown id is rejected".
- New `storage-cleanup-service.spec.ts`: "run without a preview is rejected"; "an unknown id is rejected"; "a stale preview is
  rejected"; "a preview for a different target is rejected"; "a changed item list is refused"; "the id is single use";
  "learning-database clean-up never removes the newest set"; "a failed removal restores the moved paths"; "the backups
  target refuses while a clean-up run is active"; "a second clean-up while one runs is answered busy".
- New `storage-usage-service.spec.ts` on a fixture folder: sizes match the fixture within 5%; the cache holds for 60 seconds;
  the concurrency cap is respected.
- Handler spec and contracts schema spec for the three channels (they fail until the channels exist). `npm run verify:ipc`
  and `npm run verify:ipc-usage` pass.

**Risks:**
- **The first scan is heavy** (more than 15,000 files). It runs only when the card opens, is cached for 60 seconds, and
  never blocks the main thread (async, capped).
- **"Clear now" is a bulk delete of about 4.9 million rows.** It runs in 20,000-row steps (Step 3), only after a preview and
  a yes, and shares the ledger worker with live saving, so it yields between steps.
- A preview kept in memory is lost on restart; the card then simply asks James to review again.
- Cost: none (no model calls).

**Done when:**
- A clean-up call without a matching preview is rejected, in the service and through the handler.
- The usage numbers for the stores above are each within 5% of `du` on a fixture.
- The gates for added channels pass.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Step 5. E1e: Saved session records and session activity logs (S-M)

**For James:** Harness never removes two things it keeps about old sessions: the saved state of each session (7,678 files,
4.6 GB) and a log of what happened in each (7,018 files, 6.3 GB). Nothing reads the logs, and most of the space is in files
more than a month old. After this step the disk space card lists the ones older than 30 days (about 1.5 GB of saved states and
4.0 GB of logs), says what you would give up, and removes them only after your yes. Nothing is removed automatically.

**Verified (10 Oct, checker's read-only `find`/`stat` pass unless marked):**
- **Saved session records** (`session-continuity/states`): 7,678 files, 4.64 GB. Older than 30 days: 5,584 files (72.7%) but
  only **1.52 GB (33% of the bytes)**; older than 90 days 3,305 files, 0.89 GB. Bytes by age: under 7 days 1.25 GB, 7-30 days
  1.87 GB, 30-90 days 0.63 GB, over 90 days 0.89 GB. The 100 largest files hold 1.64 GB, and 8 files over 50 MB hold 0.66 GB.
- **Why nothing is ever removed.** Both production callers pass `archive = true`
  (`instance-event-forwarding.ts:178` `stopTracking(instanceId as string, true)`; `instance-lifecycle.ts:1987`
  `stopTracking(instanceId, true)`), and the unlink only runs for `archive = false` (`session-continuity.ts:620-629`; re-checked
  by the plan writer).
- **Snapshots are different and healthy:** 501 files, 0.60 GB, none over 30 days (`snapshotRetentionDays: 30`,
  `session-continuity.ts:101`; `pruneOnStartup` at `:1506`). `maxLoadedStateFiles: 250` (`:106`) limits only what loads at
  start (`:393-427`). An identifier lookup that misses scans and reads every state file (`:379-388`).
- **`projects/<project>/session-events/*.jsonl` is the real content of `projects/`.** 7,018 files, **6.29 GB of the 8.0 GB
  (7.44 GiB by `du`), about four-fifths**; 3.97 GB is over 30 days old (2.21 GB at 30-90 days, 1.76 GB over 90 days). It is written only by
  `SessionContinuityManager.appendSessionEvent` (`session-continuity.ts:1713-1723`, through `session-persistence-queue.ts:141`
  `appendFile`). `getSessionEventLogPath` has exactly one caller, `session-continuity.ts:1721` (the definition is
  `project-storage-paths.ts:33`; `command grep` over `src`, `scripts` and `packages` finds nothing else, re-checked). There is
  no rotation or pruning, and nothing reads it.
- **The crash-recovery window is 7 days** (`session-recovery-candidate-service.ts:7`, `RECOVERY_FALLBACK_WINDOW_MS`), so a
  30-day line sits far outside it. The projects root is available without touching the manager:
  `getProjectStoragePaths().getProjectsRoot()` (`project-storage-paths.ts`).
- **Not verified:** whether History's "restore" reads a saved record that is over 30 days old. `instance-lifecycle.ts:2088` and
  `session-handlers.ts:548` read records through `resumeSession`. The live check below settles it, and the dialog wording
  follows the result.

**Change:**
1. **New `src/main/session/session-state-retention.ts`.** It takes the state folder, the recovery-metadata folder and a set of
   live instance ids. It returns candidates and deletes them. A candidate is a saved record older than 30 days whose id is not
   a live instance (any instance Harness still holds, hibernated ones included), plus its `recovery-metadata/<id>.json`.
2. **New `src/main/session/session-activity-log-retention.ts`** for `projects/*/session-events/*.jsonl` older than 30 days.
   Files only, never directories. Also skip a file whose instance id is live. The live append stream re-creates whatever it
   needs.
3. **`session-continuity.ts`** (1,742 lines, room 21): two thin methods, about 10 lines in all, that return the folders and the
   tracked ids. All logic stays in the new modules.
4. **Add the targets** `'session-records'` and `'activity-logs'` to the storage services from Step 4: preview lists the file
   count, bytes and oldest and newest date; run deletes through the modules above; both are ask-first like every target.
5. **Card rows and windows** (wording for review):
   - "Saved session records": heading "Remove old saved session records?". Body: "These are the saved states of {n} sessions
     that ended more than 30 days ago, {x} GB. Harness could use them to put a session back exactly where it was. After they
     are removed, those old sessions cannot be restored that way. Their conversation text in History is a separate store and is
     not touched. This cannot be undone." Buttons "Keep them" (default), "Remove old session records". Do not ship the sentence
     about History until the live check confirms it.
   - "Session activity logs": heading "Remove old session activity logs?". Body: "These are {n} logs of what happened in
     sessions that ended more than 30 days ago, {x} GB. Harness does not read them. This cannot be undone." Buttons "Keep them"
     (default), "Remove old logs".
6. **Do not** change the two `archive = true` callers, and do **not** delete `quarantine/`. The 30-day line matches the existing
   snapshot rule.

**Tests:**
- New `session-state-retention.spec.ts` and `session-activity-log-retention.spec.ts`: "keeps live and recent files and removes
  the rest"; "never touches directories outside the given roots" (a path-escape case with a symlink); "also removes the matching
  recovery-metadata file"; "leaves `quarantine/` and snapshots alone"; "skips a file whose instance id is live".
- `storage-cleanup-service.spec.ts` gains the two targets (preview needed, list re-checked at run time).
- Card spec: the two rows and windows; "no `title=` attribute".

**Risks:**
- **A saved record may be needed to restore an old History entry.** The dialog is honest about it, nothing is automatic, and
  the live check decides the wording.
- Reading file times for about 15,000 files: capped async work (Step 4).
- Deleting a log while its session is live: prevented by the live-id skip and by the 30-day age.
- Cost: none.

**Done when:**
- The card lists both rows with size and the over-30-days amount; Cancel leaves every file unchanged.
- On a scratch copy, after a yes, only files older than 30 days that belong to no live instance are gone; `quarantine/` and
  snapshots are untouched.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Step 6. E2: Leftover work folders: a report that asks before anything is removed (S-M)

**For James:** Harness still has 12 old work folders from earlier loops and agents, about 8 GB. Eleven of them hold saved
work that your main copy does not have, so none can be thrown away safely without you looking. A new "Leftover work folders"
card lists each one in plain words (what it holds, whether your main copy has it, how big it is) and lets you remove one at a
time, only after you press a button on a screen that says exactly what will go. Harness never removes the two that Claude Code
made, and nothing is removed unless you press the buttons.

**Verified (10 Oct, read-only `git`, `du` and a read-only look at the loop database; the plan writer re-ran all of them):**
- **Count.** `git worktree list` shows the main checkout plus 12: two Claude Code agent worktrees
  (`.claude/worktrees/agent-a1d7bb162fd56b4c6` at `460a2ef85` and `agent-a4d6deb10e35abdd8` at `8b3db8bb6`) and ten under
  `.worktrees/` (nine `task-*` and `composer-resize-verification` on `rescue/composer-resize-verification`). The backlog's
  first draft said 11; `_verify-C-E.md` N4 and this check agree on 10 + 2. Two other plain folders under `.worktrees/`
  (`queue`, `worker-mode-pair-both`) are tiny and are not registered worktrees; the report ignores them.
- **A 13th entry appeared later on 10 Oct** (plan writer): a detached checkout in the system temp folder
  (`…/plan-queue-reader-verification-20261010-…/checkout`) made by another session. It is outside the repo and not a Harness
  loop folder, so the report must show it as "other" and never offer to remove it. It may be gone by the time this step is
  built.
- **All 12 are clean** (`git --no-optional-locks status --short` printed nothing in each).
- **11 hold work main does not have.** Each has exactly one commit ahead of main, titled "rescue: safety commit of stranded
  work (…)", dated 18 Sep, and `git cherry main <branch>` marks it `+` (no equivalent patch in main). That includes both
  Claude Code folders. They are 89-158 commits behind main. The saved changes are 185 files (+10,389/-690), 117 files (+6,985),
  101 files (+35,792), 52 files (+6,811), 19, 10, 8, 7, 7, 4 and 2 files (checker). The twelfth,
  `task-please-work-through-all-the-li-mu4ui30h`, is **merged into main** (0 ahead, 64 behind, "architecture refactor",
  17 Sep).
- **Disk:** 8.16 GB across the 12 (`du`, re-measured). Six are 0.33-1.54 GB each (the rescue report lists `node_modules`,
  `dist/` and caches among their ignored files); the rest 0.10-0.12 GB.
- **There is no standing permission to delete any of them.** The 18 Sep review (`.aio-review/2026-09-18-stranded-worktree-rescue.decisions.json`)
  recorded option "a" ("Land the novel changes") on items 1-11 (checker), and the rescue report says of the items where nothing
  novel was landed: "Their branches and folders are kept, because only a Discard answer allows deletion"
  (`docs/plans/2026-09-18-stranded-worktree-rescue_report.md:49-50`). Only item 12's folder was removed.
- **Loop link** (`loop-mode/loop-mode.db`, `loop_runs`, read-only, phase and status only):
  - All nine `.worktrees/task-*` folders belong to a loop run. Eight are `blocked` with "Session branch changed outside AIO;
    review it before landing" and have ended: five `completed-needs-review` and three `cap-reached`, each with a recorded
    session tip. That blocked state is a safety state; the rescue commits caused it.
  - The ninth (`mu4ui30h`, the merged one) is run `loop-1789608176316-f9af53a7`: status `provider-limit`, phase `acquired`, no
    `ended_at`. It is the parked run Phase 0's Close step lists (Phase 0 plan, step 2.6a). Phase 0's Close only rewrites the
    run's database row (`loop-store-close.ts`, the same step); it touches neither the folder nor the branch, so this step is
    still needed after it. (This plan cites Phase 0 by step, not by line, because that plan is still being edited.)
  - `composer-resize-verification` belongs to none of the nine loop runs. Plan-queue rows and the worktree manager's own session
    records were not checked.
- **Safe removal helpers already exist, with ownership checks.** `worktree-cleanup.ts:24-59` `verifyManagedWorktreeOwnership`
  (the path must sit inside the managed folder `.worktrees` and `git worktree list --porcelain` must list it with the expected
  branch); `:70-103` `removeManagedWorktreeDirectory` (`git worktree remove --force`, three tries, then a guarded `fs.rm`; the
  `--force` means it would remove a dirty folder, so the caller must check cleanliness itself); `:105-134`
  `deleteLocalBranchIfPresent` (needs the expected tip, and `allowUnmerged: true` to delete unmerged work). The
  `.claude/worktrees/*` folders lie outside the managed folder, so the ownership check returns false for them. That is the
  right default.
- **What the start-up tidy-up does** (the plan writer's trace by reading, not run): `reconcileManagedWorktreeLifecycles`
  (`late-runtime-initialization-steps.ts:114`) works through the loop runs that `getPendingLoopWorktreeLifecycles` returns
  (`loop-store-worktrees.ts:77-119`: a lifecycle that is not `cleaned`, a status other than running or paused, and a parked
  `provider-limit` run only once it has an `ended_at`).
  - **The eight blocked runs** stay blocked at every start while their folder exists, because the branch tip differs from the
    recorded one (`loop-worktree-lifecycle-reconcile.ts:198-209`). If only the folder is removed, they stay blocked
    (`:216-228`, "Managed session branch identity could not be verified"). If the folder and the branch are both removed, the
    `completed-needs-review` runs stop with "Durable session branch is missing" (`:302`), and the `cap-reached` runs are marked
    preserved and cleaned (`:230-245`). Nothing is integrated and nothing else is deleted.
  - **The parked run** is not returned today, because it has no `ended_at`. After Phase 0's Close gives it one, the same
    tidy-up would remove its folder (never its branch) at the next start (`:230-245`, then `removeOrphanWorktree` in
    `loop-worktree-reconcile.ts:79-111`), without asking. The branch is merged, so nothing is lost, but this step's live check on
    the merged folder may find it already gone.
- **Where the report cannot live.** The Worktrees settings page is per instance and tight (`worktree-page.component.ts` 706
  lines, 61 room; `worktree-panel.component.ts` 713, 51; `worktree-manager.ts` 1,080, **4**). New modules are needed.
- **Branches with no worktree** (outside the backlog item, listed for completeness): 39 local branches in all. 20 are not
  merged and have no worktree: 18 `queue/*` (1-2 commits each, 20-21 Sep), `release/harness-auto-update-v0.1.0` (2 ahead, 12 Jul)
  and `task-please-test-all-the-livetest-f-msi8ip9e` (1 ahead, 31 Aug). Six are merged: `codex/provider-agnostic-context-evidence`,
  `integration/main`, `queue/2026-07-17-browser-permission-6802a7` and three `task-*`. See "Not in this plan".

**Change:**
1. **Read-only report module (S).** New `src/main/workspace/git/leftover-worktree-report.ts` (about 200 lines, dependencies
   injected so the pure parts need no real repo). `buildLeftoverWorktreeReport(repoRoot, deps)` runs
   `git --no-optional-locks worktree list --porcelain`, then per worktree: the `status --porcelain` count,
   `rev-list --left-right --count main...HEAD`, `git cherry main <branch>` (the patches main lacks), `diff --shortstat
   main...<branch>`, `merge-base --is-ancestor`, the last commit date, the folder size (async walk, cached 60 s) and the owner.
   - **Owner:** a loop run, a plan-queue item (`item.worktreePath`, `plan-queue-coordinator.ts:663`), or a live session whose
     cwd is inside the folder.
     - Find loop owners with the two loop-store readers that are not capped by age: `getPendingWorktreeLifecycles()`
       (`loop-store.ts:312`; ended runs that still hold a folder, which returns the eight blocked runs) and
       `listResumableRuns()` (`:496`; open, paused and parked runs, which returns the parked `provider-limit` run). Match them on
       the worktree path, and read the status and lifecycle phase from the row.
     - Do **not** use `listRuns()`: it returns only the newest 100 (at most 200) runs (`loop-store.ts:476-483`). Today the nine
       owners rank 4th to 25th by recency among 141 runs (a read-only count, re-run by the fixer), so it would work now. But
       leftover folders are old by definition, so within weeks the owner falls off the list and the row would wrongly read
       "Not made by a Harness loop" and become report-only. Do not use `getTerminalRunsWithWorktreePaths()` (`:326`) on its own
       either: it returns only runs with no lifecycle record (`:341-349`), and none of the nine qualify.
     - No change to `loop-store.ts`, which has 3 lines of room that Phase 0's Close (a one-line delegator) also needs. A folder
       that no reader recognises stays report-only, which is the safe direction.
   - **Output per row:** `path`, `branch`, `tip`, `createdBy` (`harness` when the folder is under `.worktrees` **and** a loop or
     queue row records it; `claude-code` for `.claude/worktrees/*`; `other` for everything else, including a `.worktrees` folder
     no row records and any folder outside the repo), `owner`, `inUse`, `category` (`saved-work`, `nothing-to-save` or
     `in-use`), `removableByHarness`, the numbers, and a plain one-line sentence.
   - "In use" means a non-terminal loop run or queue item, a live session whose cwd is inside the folder, or the current
     checkout. A row is "leftover" when it is not in use and its last commit is at least 14 days old. The age is deliberately
     the age of the last commit, not of the folder: a folder with a recent commit but no live owner stays off the list until
     that commit is 14 days old (all 12 today are 22 days old, from 18 Sep). The repo list is the distinct workspaces that
     have a recorded `worktree_path` in loop runs or queue items, plus the open workspace.
   - The git commands used are reads only. It never runs `fetch`, `gc`, `prune` or `worktree repair`.
2. **Ask-first removal (S).** New `leftover-worktree-removal.ts` beside it, with two calls:
   - `previewLeftoverRemoval({ repoRoot, path, action })` re-reads the row and returns the exact consequence text, the branch
     tip, the number of unmerged changes and a `previewId` (issued and remembered in memory by `cleanup-ticket.ts` from Step
     4a: single use, valid 10 minutes, bound to path, branch, tip and action).
   - `runLeftoverRemoval({ previewId, ... })` re-checks everything at run time and refuses unless **all** hold: the ticket is
     valid; `verifyManagedWorktreeOwnership` passes for the managed folder `.worktrees`; **`git status --porcelain` is empty**
     (the removal helper uses `--force`, so this check is the only guard against losing uncommitted work); the tip still equals
     the previewed tip; the row is not in use; `createdBy` is `harness`.
   - Actions: `remove-folder` (keep the branch and its saved work); `remove-folder-and-branch` (only if `merge-base
     --is-ancestor` says main already has the branch; uses `deleteLocalBranchIfPresent` with `mergedIntoBranch`);
     `discard-saved-work` (folder and branch, unmerged allowed with `allowUnmerged: true`; the card requires a ticked box and
     names the number of files). Everything goes through `getGitWriteQueue()` and the helpers above. No bulk action: one folder
     per confirmation.
   - Rows with `createdBy` of `claude-code` or `other` have no remove button. The card shows "Made by Claude Code. Harness will
     not remove it." (or "Not made by a Harness loop. Harness will not remove it.") and a "Copy the commands" button that puts
     the two `git` lines on the clipboard.
3. **IPC.** Channels in `packages/contracts/src/channels/workspace.channels.ts` beside the worktree channels (`:40-54`):
   `WORKTREE_LEFTOVERS_LIST: 'worktree:leftovers-list'`, `WORKTREE_LEFTOVERS_PREVIEW: 'worktree:leftovers-preview'` and
   `WORKTREE_LEFTOVERS_REMOVE: 'worktree:leftovers-remove'`. Run `npm run generate:ipc`. Zod schemas go in
   `packages/contracts/src/schemas/workspace-tools.schemas.ts` (276 lines, so no new subpath). The handler is a new
   `src/main/ipc/handlers/worktree-leftover-handlers.ts`, registered in `ipc-main-handler.ts`. Preload methods go in
   `src/preload/domains/workspace.preload.ts` (588 lines, room 112, about 12 lines). Then run `npm run verify:ipc` and
   `npm run verify:ipc-usage`.
4. **The card (S).** New `src/renderer/app/features/settings/leftover-worktrees-card.component.ts` (OnPush, signals), placed
   under Step 4's disk space card in the Doctor tab, so the two housekeeping cards share one home and one pattern (preview, then
   run). Plain wording; no "worktree" in headings: "Leftover work folders". Like Step 4b's card, it goes through a small signal
   store (`src/renderer/app/core/state/leftover-worktrees.store.ts`) that wraps the new preload calls, and never calls
   `window.electronAPI` itself.
   - Each row: folder name, who made it ("Made by a Harness loop", "Made by Claude Code", "Not made by a Harness loop"), age,
     size, and one sentence such as "Holds 1 saved change (185 files) that your main copy does not have." or "Already in your
     main copy. Safe to remove."
   - "Review" opens the dialog. It states what goes, what stays and whether it can be undone ("The saved work stays on its
     branch" or "The saved work is deleted and cannot be brought back"). Cancel is the default.
   - A disabled Remove shows its reason as visible text ("In use by a loop that is still open").
   - Tooltips via `appTooltip` and `TOOLTIP_COPY`; no `title=`.
5. **Connect to Phase 0's Close.** A row whose loop run was closed shows "Loop closed", so the folder can be reviewed. No change
   to `loop-store-close.ts` is needed.
6. **Docs.** Add a short note to the livetest runbook that leftover-folder removal is an ask-first action. Do **not** edit
   `docs/plans/2026-09-18-stranded-worktree-rescue_report.md` (history).

**Tests:**
- New `leftover-worktree-report.spec.ts` on a temp git repo (`git init`, commits, two linked worktrees):
  - "a rescue-style worktree is `saved-work` with its patch and file counts";
  - "a merged branch is `nothing-to-save`";
  - "a path under `.claude/worktrees` is not removable";
  - "a `.worktrees` folder no loop or queue row records is `other` and not removable";
  - "a dirty worktree is not removable";
  - "an owner in a non-terminal loop row is in use";
  - "an ended run's owner is found even when 250 newer runs exist" (the fake store holds 250 newer rows; it fails if the
    lookup goes through `listRuns()`);
  - "the report runs only git reads" (the command list contains none of `fetch`, `gc`, `prune`, `worktree remove`).
- New `leftover-worktree-removal.spec.ts` (these fail on today's code only because the module does not exist):
  - "run without a preview is rejected"; "a preview older than 10 minutes is rejected";
  - "removal is refused when the branch tip moved since the preview"; "removal is refused for a dirty folder";
  - "remove-folder keeps the branch"; "remove-folder-and-branch refuses an unmerged branch";
  - "discard-saved-work needs the explicit flag"; "a path outside the managed folder is refused".
- A reconcile spec (using `reconcileManagedWorktreeLifecycles` with a fake store): "removing a blocked run's folder leaves the
  row blocked after a restart; removing its branch too leaves a `completed-needs-review` row blocked with 'Durable session
  branch is missing' and marks a `cap-reached` row cleaned; nothing is integrated".
- Handler spec and contracts schema spec. Renderer `leftover-worktrees-card.component.spec.ts`: "no remove button for Claude Code
  folders"; "Cancel runs nothing"; "the dialog names the number of files"; "a disabled Remove shows its reason".

**Risks:**
- **Irreversible loss of saved work.** The only deletion paths are the three explicit actions, each behind a preview, a re-check
  at run time and (for discard) a ticked box. A removed folder with a kept branch loses nothing but disk.
- **A race with a live loop** that is about to use a folder: covered by the run-time in-use re-check and the git write queue.
- **A wrong "who made it" guess:** anything not clearly Harness's is report-only. `composer-resize-verification` is the example
  today.
- **The start-up tidy-up** (traced above) already removes the folder of an ended, non-successful managed loop run without
  asking; after Phase 0's Close it would do so for the merged folder. This is existing behaviour, not added here. See "Found on
  the way", item 10 (the branch is merged and the folder is clean, so nothing is lost).
- Cost: none.

**Done when:**
- The card lists every worktree that `git worktree list` shows apart from the main checkout: 12 on 10 Oct, 11 of them
  `saved-work` and 1 `nothing-to-save`, with the two Claude Code folders marked "Made by Claude Code" and
  `composer-resize-verification` marked "Not made by a Harness loop".
- No remove action can run without a preview, and `git worktree list` and `git branch --list` are unchanged after Cancel.
- Removing the merged folder (with James's yes) leaves `main` and all other branches untouched, and its loop row shows the
  folder as gone.
- The gates pass, including `npm run verify:ipc` and `npm run verify:ipc-usage`.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---


## Step 7. E3.5 and E3.6: Two wrong notes in the code (XS each)

**For James:** Nothing changes on screen. Two notes in the code say Claude Code cannot spot a stalled reply and Codex
cannot run a check before each command. Both are wrong, and a future change could rely on them, so they are corrected.

### 7a. E3.5: Claude does have a stream watchdog (XS)

**For James:** A code note says Claude Code cannot detect a stalled reply. It can, and has done since before the note was
written. The note is corrected.

**Verified (10 Oct):**
- **The note:** `src/main/cli/adapters/claude-env-pack.ts:1-19` says "No stream-idle / watchdog env vars exist in the binary's
  `CLAUDE_CODE_*` namespace". It records a search against 2.1.211, dated 17 Jul.
- **The note was wrong when written, for two reasons:**
  - The idle watchdog's variables sit outside that namespace (`CLAUDE_ENABLE_STREAM_WATCHDOG`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS`,
    `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS`).
  - The watchdog has been on by default since 2.1.196 (`claude-code/CHANGELOG.md:4179`: "aborts and retries when a response
    stream produces no events for 5 minutes").
- **The installed CLI (2.1.296) has all of them.** A string search finds `CLAUDE_ENABLE_STREAM_WATCHDOG` (7 occurrences),
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS` (7), `CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS` (10) and `CLAUDE_CODE_RETRY_WATCHDOG` (11). The
  default-on value comes from the changelog, not from reading the minified code.
- **No behaviour change is needed.** Harness's own stall check-in waits `STALLED_WORK_CHECK_IN_AFTER_MS = 10 * 60_000`
  (`src/main/instance/instance-async-work-continuation.ts:21`), which is longer than the CLI's 5-minute window. The risk runs the
  other way: shortening Harness's timer below 5 minutes would kill streams the CLI was about to retry.

**Change:**
1. Rewrite the header comment at `claude-env-pack.ts:1-19`.
   - Keep the three verified variables.
   - State that the idle watchdog exists and is on by default since 2.1.196, and list its variables.
   - Say that Harness sets none of them on purpose.
   - Add: "do not shorten Harness's own stall timers for Claude below 5 minutes without reading `CHANGELOG.md:4179`".
   - Date it 10 Oct 2026, 2.1.296. That also refreshes the header's stale "Verified against the installed CLI (2.1.211 ...)"
     line.
   - **One comment, two plans.** Phase 1 Step 4 (A5) also edits this header: it adds two notes of its own (the
     git-instructions measurement and the security-plugin switch) and leaves the watchdog paragraph, the variable list and
     the "Verified against" line to this step (the Phase 1 plan says so since its 10 Oct fixes). Treat the two as one edit of
     one comment. Whichever lands first writes the header. The second keeps what the first wrote and adds or changes only
     its own lines inside it: if this step goes first, Phase 1 Step 4 adds its two notes inside the rewritten header; if
     Phase 1 Step 4 went first, keep its notes and rewrite only the watchdog sentence, the variable list and the date line.
2. Add the same one-line warning above `STALLED_WORK_CHECK_IN_AFTER_MS` (`instance-async-work-continuation.ts:21`).

**Tests:** none (comment only). `npm run lint` and `npx tsc --noEmit` stay green.

**Done when:** the header no longer claims the CLI has no stream watchdog, and both files carry the 5-minute warning.

### 7b. E3.6: Codex does run a pre-command hook (XS)

**For James:** A code note says Codex cannot run a check before each command. It can, and RTK 0.50 uses it. The note is
corrected.

**Verified (10 Oct):**
- **The note:** `src/main/cli/adapters/codex-app-server-turn-adapter.ts:318-320` is a three-line comment ("Inject RTK
  awareness on the first turn when the feature is enabled." then "Codex has no programmatic PreToolUse hook, so
  awareness-via-prompt is the integration surface").
- **Codex has the hook.** In the Codex sibling clone, `codex-rs/core/src/hook_runtime.rs:183-194` runs matching `PreToolUse`
  hooks, configured in `hooks.json` in the Codex home.
- **RTK uses it.** RTK's `hooks/codex/README.md` describes `rtk hook codex`, added in RTK 0.50.0 (`CHANGELOG.md:77`). The
  backlog's "since 0.50" is RTK's version, not Codex's (`_verify-C-E.md` N14).
- **Harness installs no such hook yet.** That is Phase 1's A13 work.
- **Room:** the file is 697 lines against a hard cap of 700, so it has room for **3 lines**.

**Change:**
1. Replace all three comment lines at `:318-320` with exactly three lines (never four, or the file grows to 698), for example:
   ```
   // Inject RTK awareness on the first turn when the feature is enabled. Codex does run PreToolUse
   // hooks (hooks.json in its home; RTK 0.50+ ships `rtk hook codex`), but Harness installs none
   // yet (Phase 1, A13), so this prompt note is the only route today.
   ```
2. Leave `wrapRtkAwareness()` and its first-turn logic alone; Phase 1's A13 owns changing them.

**Tests:** none (comment only). `npm run check:ts-max-loc` must pass, with the file at 697 lines or fewer.

**Done when:** the comment names the hook and A13, and the file is no longer than 697 lines.

**Size and order (7a and 7b):** XS each. Land them as one "stale comments" change. 7b is independent of everything else. 7a
shares one comment with Phase 1 Step 4: see the "One comment, two plans" rule above for who goes first.

---

## Step 8. E3.4: Claude 5.5 prices (S)

**For James:** The Claude 5.5 models cost less than Harness's built-in price list says, and Harness also prices their cached
words too high. This step corrects the price list. What you are actually charged does not change. The backlog also said the
small "about $x" beside the context bar reads too high; on the Claude Code you run that is not so (see the first check below),
so this step leaves that figure alone.

**Verified (10 Oct):**
- **The official prices** (Claude Code `CHANGELOG.md`, sibling clone):

  | Model | Input / output per million tokens | Cache reads | Source |
  |---|---|---|---|
  | Opus 5.5 (`claude-opus-5-5`) | $4 / $20 | $0.20 | `:1520`, 2.1.280 |
  | Sonnet 5.5 (`claude-sonnet-5-5`) | $2 / $10 | $0.10 since 2.1.296 | `:1051` and `:63` |
  | Haiku 5.5 (`claude-haiku-5-5`) | $0.10 / $0.50, or $0.50 / $2.50 for prompts over 100K | not published | `:238` |
  | Fable 5.1 | already right | 0.025 multiplier | `model-pricing.ts:185` |

- **REFUTED: the backlog's claim that the context-bar figure is wrong by about tenfold holds only for an old Claude Code.**
  The adapter sums input, cache-creation and cache-read tokens at the plain input rate inside one branch,
  `if (message.subtype === 'context_usage' && message.usage)` (`claude-cli-adapter.ts:1566-1584`, emitted as `costEstimate`
  at `:1594-1599`). That branch is the legacy route:
  - The adapter's own comments say so: "older versions emit `system / context_usage` (kept here for backward compatibility);
    current 2.1.x versions place per-turn counts on each `assistant.message.usage`" (`:876-880`), and "Legacy schema (older
    Claude CLI). Kept for backward compatibility." (`:968`).
  - The route current Claude Code takes is `claude-assistant-message.ts:128-142`. It emits `context` with `used`, `total` and
    `percentage` only, with no cost. The cost Harness stores comes from the CLI's own total: `claude-result-usage.ts:65-78`
    (`total_cost_usd`, sent on the `context` channel when no per-call counts were seen and on the `cost` channel otherwise)
    and the `'cost'` handler at `instance-communication.ts:1641-1648`.
  - Measured by the fixer, read-only, on the debug record (`provider_event_captures`, `raw_source = 'adapter-event:context'`,
    `raw_json`, 10 Oct 19:12): in the newest 20,000 rows, **0 of 2,843** Claude context events carry `costEstimate`; in a slice
    about 400,000 rows earlier, 0 of 671. The control, Codex context events, carries it in 1,315 of 1,315 and 1,818 of 1,818, so
    the capture does keep the field when it exists. The reviewer found the same in 1,200-row slices back to 25 days.
  - Phase 0 step 8 makes the `'context'` handler keep the previous `costEstimate` and fills it from the recorded spend, so the
    adapter's per-call value would be discarded anyway.
  - Not done: running an old Claude Code to see the legacy event. So the branch is kept as it is; this step does not edit it.
- **The static table lacks all three 5.5 ids.** `MODEL_PRICING` (`src/shared/types/provider.types.ts:405`) has `sonnet` and
  `sonnet[1m]` at 3/15, `opus` and `opus[1m]` at 5/25 and `haiku` at 1/5 (`:407-411`), but no `claude-*-5-5` rows. Unknown ids
  fall back to `DEFAULT_MODEL_RATE = {3, 15}` (`src/shared/data/model-pricing.ts:43`).
- **The offline models.dev snapshot has Opus 5.5 only** (`models-dev-snapshot.generated.ts:37`, refreshed 26 Sep). It lacks
  Sonnet 5.5 and Haiku 5.5.
- **A stale comment** (`provider.types.ts:415-417`) says Sonnet 5 reverts to 3/15 on 1 Sep. The changelog says 2/10 is the
  standing list price (`CHANGELOG.md:3019`). The value in the row is right; the comment is wrong.
- **Cache reads are priced at 10% for everything except Fable** (`getCacheReadMultiplier`, `model-pricing.ts:188-192`). For
  Opus 5.5 and Sonnet 5.5 the real rate is 5%. The function matches the lower-cased full id exactly, but Harness mostly runs
  on the shorthand ids: `CLAUDE_MODELS` is `sonnet`, `sonnet[1m]`, `opus`, `opus[1m]` and `haiku` (`provider.types.ts:178-189`),
  the new-session default is `opus[1m]` (`:504-510`), and the adapter prices `this.spawnOptions.model || CLAUDE_MODELS.OPUS_1M`
  (`claude-cli-adapter.ts:1567`). A table keyed only on the full ids would leave `sonnet` and `opus[1m]` at 10%.
- **The provider-aware lookup will not see the new ids on its own.** `getProviderModelRate` returns a rate only when the id is
  in `PROVIDER_MODEL_LIST[provider]` or `RETIRED_PROVIDER_MODELS[provider]` (`model-pricing.ts:143-150`; the lists are at
  `provider.types.ts:361-364` and `:504-527`). The three `claude-*-5-5` ids are in neither. Phase 0 prices with it: the cost
  store uses `computeProviderTokenCost(provider, model, tokens) ?? 0` (Phase 0 step 7c, change 4) and the recorder uses it when
  no cost was reported (step 7a). Adding the three ids to `MODEL_PRICING` alone would therefore price them at $0 on those
  paths (inferred: I have not traced which ids step 7b's per-model table will hold).
- **Room:** `provider.types.ts` has 658 lines (room 42) and `model-pricing.ts` 264. This step no longer touches
  `claude-cli-adapter.ts`. None of these files is dirty.

**Change:**
1. `provider.types.ts`:
   - add `claude-opus-5-5` 4/20, `claude-sonnet-5-5` 2/10 and `claude-haiku-5-5` 0.10/0.50;
   - move the shorthand rows to the 5.5 prices: `sonnet` and `sonnet[1m]` to 2/10, `opus` and `opus[1m]` to 4/20 and `haiku` to
     0.10/0.50 (choice 16; the `[1m]` rows follow their plain rows, which carry the same rate today; the live price overlay
     still wins);
   - correct the Sonnet 5 comment;
   - next to the Haiku row, note that prompts over 100K cost five times more and a flat table cannot show it.
   - This is about +10 lines.
2. `model-pricing.ts`: replace the Fable-only multiplier with a table `CACHE_READ_MULTIPLIERS`, keyed by the lower-cased id,
   defaulting to 0.1:
   - `claude-fable-5-1` 0.025;
   - `claude-opus-5-5` and `claude-sonnet-5-5` 0.05;
   - **and the four shorthand ids that now stand for those models, `sonnet`, `sonnet[1m]`, `opus` and `opus[1m]`, at 0.05**,
     taken from the `CLAUDE_MODELS` constants rather than typed again. Without them the ids Harness actually runs would keep
     the 10% rate while their input price moved to 5.5, pricing their cached words at twice the real rate.
   - Haiku (full id and `haiku`) stays on the default, with the note "rate not published in the changelog".
3. **Let the provider-aware lookup price the three ids.** Read Phase 0 step 7c's final diff first. If it has not already
   admitted them, add a small `PRICED_ONLY_PROVIDER_MODELS` map beside `RETIRED_PROVIDER_MODELS` in `provider.types.ts`
   (ids that are priced but never offered), holding the three `claude-*-5-5` ids under `claude`, and let the guard in
   `getProviderModelRate` (`model-pricing.ts:143-150`) accept it as well (about +4 lines in `provider.types.ts` and +1 in the
   guard). Do **not** add the ids to `PROVIDER_MODEL_LIST`: that would offer them in the model picker, which is a different
   change. The `copilot` namespace must still return no rate for the same id strings (the LT-190 guard).
4. Refresh the offline snapshot with `npm run sync:model-catalog` (a plain network fetch from models.dev, not a browser), and
   check the diff by hand.
5. **Do not edit `claude-cli-adapter.ts`.** The legacy `context_usage` branch stays as it is. (If a later change ever wants
   to tidy it, `computeTokenCost` already prices cache correctly, `model-pricing.ts:217-243`; that would be a clean-up of
   code current Claude Code does not run, not a fix.)

**Tests:**
- `model-pricing.spec.ts`:
  - "Sonnet 5.5 cache reads cost 5% of input" (checked for `claude-sonnet-5-5`, `sonnet` and `sonnet[1m]`; 1,000,000
    cache-read tokens cost $0.10);
  - "Opus 5.5 is priced 4/20 and its cache reads cost 5%" (checked for `claude-opus-5-5`, `opus` and `opus[1m]`);
  - "Haiku 5.5 is priced 0.10/0.50 and keeps the 10% cache-read rate";
  - "an unknown id still uses the default rate and the 10% cache-read rate";
  - "Fable 5.1 is unchanged".
- `model-pricing.spec.ts`, provider-aware: "`getProviderModelRate('claude', id)` returns the rate for each of the three 5.5
  ids" (fails on today's code), and "`getProviderModelRate('copilot', 'claude-sonnet-5-5')` still returns no rate".

**Risks:**
- The shorthand rows may stand for older models on Bedrock or Vertex; the overlay and per-id rows cover those.
- Claude Code's own reported cost still wins wherever it exists (`model-pricing.ts` header, lines 16-19), so these rows change
  only the fallback estimate, for example for subagent tokens or a session that reports no cost.
- Step 7c's final diff may already have solved the provider-aware lookup in a different way. Use its way, not a second one.

**Done when:**
- The three ids price correctly from the static table with the overlay empty: by full id and by shorthand, with the 5% cache
  rate for the Opus and Sonnet 5.5 ids and shorthands.
- `getProviderModelRate('claude', <each id>)` returns the rate, and `copilot` still returns none.
- The stale Sonnet 5 comment is gone, and the snapshot diff adds the two missing ids.
- `git diff --stat` shows this step did not touch `claude-cli-adapter.ts`.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

**Size and order:** S. Read Phase 0 step 7c's final diff first, so that `getModelRate` and the provider guard are not edited
twice. This step no longer shares `claude-cli-adapter.ts` with Steps 9 and 11 or with Phase 1.

---

## Step 9. E3.3: Claude version checks (S)

**For James:** Harness will check which Claude Code version is installed before using two features that misbehave on old
versions: one could silently drop Harness's instructions on a resumed session, and the other could break prompt caching. On
your Mac (2.1.296) nothing changes. On a worker machine, Harness asks that machine's Claude Code for its version directly; it
protects an older Claude Code only where it can read that version, and where it cannot it skips the speed-up and resumes as
it does today. A live check reads the Windows PC's version and confirms this on the real machine.

**Verified (10 Oct):**
- **(a) The prompt-cache flag.**
  - `claude-cli-argv-builder.ts:157-159` adds `--exclude-dynamic-system-prompt-sections` when a `--help` probe says it exists
    (`claude-cli-feature-probes.ts:14-16`). Nothing checks the version.
  - The flag arrived in 2.1.98 (`CHANGELOG.md:5910`), and prompt caching broke mid-session with it until 2.1.268 (`:2236`).
  - Inferred: the changelog names the SDK option; the CLI flag is the same feature.
- **(b) Resume without the instructions overlay.**
  - `claude-cli-argv-builder.ts:287-298` leaves out `--append-system-prompt` on resume (`:296`; `:336` repeats the rule).
  - From 2.1.267 the CLI records the system prompt once and reuses it on resume (`CHANGELOG.md:2354`).
  - Inferred: before 2.1.267, a resume without the flag drops Harness's prompt.
- **The version is often unknown when the arguments are built.**
  - `primeCliVersion` (`claude-cli-adapter.ts:2087-2104`) reads it only outside auto-approve mode, and only when a permission
    hook path exists.
  - Loops call `adapter.sendMessage` directly (`default-invokers.ts:377-378`).
  - So `cachedCliStatus` is usually null for loops and auto-approve chats (found by reading; the live check settles it).
  - **This is the trap:** a naive "version check or no flag" gate would switch the cache flag off for every loop.
- **On a worker the version is never known today, and the detection cache is empty.**
  - A worker builds its own adapter with `createCliAdapter(...)` and `yoloMode: params.yoloMode ?? true`
    (`src/worker-agent/local-instance-manager.ts:326-348`), so `primeCliVersion` returns before it reads the version.
  - Nothing under `src/worker-agent` calls the detection service (a `command grep -rn` of that folder for
    `getCliDetectionService`, `CliDetectionService` and `peekCachedResult` finds nothing), so `peekCachedResult()` is empty
    there. Phase 1 Step 2 says the same of its own version source ("on a worker there is no cache, so the version is
    unknown").
  - Today an up-to-date worker still gets the cache flag, because only the `--help` probe decides
    (`claude-cli-adapter.ts:552-571`; live-verified on a Windows worker on 2026-06-03, `claude-cli-argv-builder.ts:150-156`). So
    a gate that reads the detection cache alone would take the flag away from every worker: a cost regression for the machines
    that benefit most. Change 3 closes that gap.
- **Precedent:** `DEFER_MIN_VERSION = '2.1.90'` (`claude-cli-argv-builder.ts:33`), with `isVersionAtLeast`, which returns false
  for an unknown version (`claude-cli-feature-probes.ts:18-23`).
- **Room:** `claude-cli-argv-builder.ts` has 352 lines (room 348), `claude-cli-feature-probes.ts` 76. The Claude adapter has 7
  lines of room; change 3 takes about 3 of them (see ground rule 4).

**Change:**
1. **New pure helpers in `claude-cli-feature-probes.ts`.**
   - `isKnownOlderThan(version, min)`: true only when the version parses and is lower.
   - The constants `EXCLUDE_DYNAMIC_MIN_VERSION = '2.1.268'` and `RECORDED_PROMPT_MIN_VERSION = '2.1.267'`.
2. **One shared version helper, `resolveClaudeCliVersion(adapterVersion)`, in `claude-cli-feature-probes.ts`. This step owns
   it.**
   - It returns the adapter's version if known.
   - Otherwise it returns the Claude entry from `getCliDetectionService().peekCachedResult()` (`cli-detection.ts:219-221`; the
     same use as `loop-failover.ts:264`).
   - Otherwise it returns null.
   - **Whichever of this Step 9 and Phase 1 Steps 2 (A18) and 9a lands first creates it; the others call it; the fallback
     is never written inline in a second place.** The Phase 1 plan was corrected on 10 Oct to call this helper in both
     places (its Step 2 item 1 and Step 9a). If a Phase 1 step lands first, it creates the helper exactly as described
     here, and this step only adds the gates that call it.
3. **Read the version when it is still unknown (needed on workers; about +3 adapter lines).**
   - In `primeCliVersion` (`claude-cli-adapter.ts:2087-2104`), when the cache-flag option is on, or a resume with a system
     prompt is in play, and `resolveClaudeCliVersion(this.cachedCliStatus?.version)` is still null, call `await
     this.checkStatus()` once. The adapter caches the result (`:522-538`), and `cliVersion: this.cachedCliStatus?.version`
     already feeds the builder (`:1034`), so the builder then sees the real version.
   - On the main process the detection cache usually answers first, so this costs one `claude --version` at most, only where
     the cache is empty. On a worker it is the only route.
   - If this step cannot get the adapter lines (see ground rule 4), land Phase 0 step 7b.0 first rather than raising a
     ceiling. The alternative, accepting that a worker's version is always unknown, takes the cache flag away from every
     worker and is not acceptable.
4. **Gate (a), conservatively.**
   - Add the flag only when the help probe says yes and the version is known and at least 2.1.268.
   - When the version is still unknown after change 3, leave the flag out and log once (choice 15).
5. **Gate (b), only for a CLI known to be old.**
   - Pass the overlay again on resume when `isKnownOlderThan(version, '2.1.267')`.
   - An unknown version keeps today's behaviour.
   - Update the diagnostic at `:336` to match.
6. Correct the comment at `claude-cli-argv-builder.ts:287-288`, which says the CLI "doesn't support changing it mid-session".
   That is only true from 2.1.267.

**Tests:**
- `claude-cli-argv-builder.spec.ts`:
  - "flag omitted below 2.1.268";
  - "flag omitted when the version is unknown";
  - "flag present at 2.1.268 and 2.1.296 when the help probe agrees";
  - "resume at 2.1.266 passes `--append-system-prompt` again";
  - "resume at 2.1.267 does not";
  - "resume with an unknown version does not";
  - "a loop-style spawn (auto-approve, no permission hook, adapter version null) still gets the flag when the detected version
    is 2.1.296". This last case fails on a naive gate.
  - "a worker-style spawn (auto-approve, empty detection cache, version read by `checkStatus()`) gets the flag at 2.1.296
    and not at 2.1.266, and resumes with the overlay at 2.1.266".
- `claude-cli-feature-probes.spec.ts`: cases for `isKnownOlderThan` and `resolveClaudeCliVersion` (adapter version wins; the
  detection cache answers when the adapter has none; null when neither knows).
- `claude-cli-adapter.spec.ts`: "`primeCliVersion` reads the version once when the cache-flag option is on and the version is
  unknown, and not at all when it is already known".

**Risks:**
- An unknown version drops the cache flag for that spawn, logged once. After change 3 that should be rare: a machine whose
  `claude --version` fails.
- A resume on a known-old CLI carries the overlay once more, which means more prompt text on a rare path.
- The 2.1.267 and 2.1.268 boundaries come from the changelog.
- Change 3 uses about 3 of the adapter's 7 free lines; Step 11 needs about 4. Together they leave none (ground rule 4).

**Done when:**
- The builder cases pass.
- A loop spawn on this Mac still has `--exclude-dynamic-system-prompt-sections` in its arguments; check the spawn log.
- A spawn against a stub CLI that reports 2.1.266 resumes with the overlay.
- `resolveClaudeCliVersion` exists once, and `command grep -rn 'peekCachedResult' src/main/cli/adapters` shows no second inline
  fallback for the Claude version (including in Phase 1 Step 2's files, if it has landed).

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

**Size and order:** S. Independent of Phase 0 except for adapter room (Phase 0 step 7b.0). Owns the version helper shared with
Phase 1 Step 2 (A18): whichever lands first creates it, the other calls it.

---

## Step 10. E3.9: Quota refresh hygiene (S)

**For James:** Harness asks Claude's usage service for your plan figures after every finished reply. If the service says
"too many requests", Harness ignores the "wait this long" hint and asks again soon. After this change Harness waits as long
as it is told after a refusal, and for sessions that run on one of your account profiles it also skips the extra request
while it already has fresh figures. You will see no difference unless the service starts refusing.

**Verified (10 Oct):**
- **Harness refreshes after every turn, with no freshness check.** `quota-auto-refresh.ts:30` sets
  `DEFAULT_DEBOUNCE_MS = 60_000`. `fire()` (`:104-115`) calls `service.refresh(providerId, profile)` on `'spawned'` and on every
  `'complete'`.
- **There is no cooldown after a 429, and the header is never read.**
  - `claude-usage-endpoint-probe.ts:178-180` returns a failed snapshot.
  - The fetch helper returns only `{ status, body }` (`:384`), so `Retry-After` is never available.
- **Fresh figures arrive with each reply, but only for a session on an account route.** Claude's `rate_limit_event` arrives
  every turn (`claude-cli-adapter.ts:1880-1883`), and `account-telemetry-bridge.ts:123-130` stores it as a snapshot with
  `source: 'header'` (`provider-quota-service.ts:217-229`). The bridge is attached only when the session has an account route
  (`provider-runtime-service.ts:87-90`: `if (input.options.accountRoute && ...) attachAccountTelemetryBridge(...)`; "No-op without
  a route", `account-telemetry-bridge.ts:98-107`). So the "skip when fresh" shortcut (change 4) applies to sessions on an
  account profile or pool; any other session refreshes after every reply, as today. Those provider files are part of another
  session's uncommitted account-pool work.
- **There is a manual bypass:** `refresh(..., { force: true })` (`provider-quota-service.ts:231`, `:341-343`).
- **It has not been seen to bite.** No 429 line appears in the five app logs, because the failure is stored, not logged. This
  step is prevention, and its first part makes a 429 visible.
- **Collision:** `provider-quota-service.ts` and `account-quota-probes.ts` have another session's uncommitted multi-account work.
  This step avoids both. `quota-auto-refresh.ts` (130 lines) and `claude-usage-endpoint-probe.ts` (389 lines) are clean.

**Change:**
1. **Log a 429.** At `claude-usage-endpoint-probe.ts:178`, add `logger.warn('Claude usage endpoint rate-limited',
   { retryAfterMs, cooldownUntil })`.
2. **Read `Retry-After`.** Extend the fetch result with `retryAfterMs?`, set in `defaultFetchUsage` (`:364-384`) from the header.
   The header may be whole seconds or an HTTP date.
3. **Add a cooldown in the probe.**
   - On a 429, set `cooldownUntil = now + clamp(retryAfterMs ?? 5 min, 1 min, 60 min)`.
   - While cooling, a probe without `force` returns `null` and makes no network call. The service keeps its last good figures.
   - A second 429 extends the cooldown.
   - The 5-minute default follows jean (JN-7). Tune it from the new log lines.
4. **Skip the after-reply refresh when figures are fresh.**
   - New pure helper `shouldSkipPostTurnRefresh(snapshot, now)` in a new `quota-refresh-policy.ts` (about 30 lines).
   - It skips when the snapshot is `ok`, comes from `'header'`, and is under 10 minutes old.
   - `fire()` reads the current snapshot first, through an optional `getSnapshot` in the injected service type (`:67-78`).
   - This applies to `'complete'` only. `'spawned'`, the manual Refresh and `force` are unchanged (choice 17).
   - **Dependency:** a `'header'` snapshot exists only for a session on an account route (see Verified). Without one, the
     snapshot comes from the endpoint, the helper does not skip, and the refresh happens as today. The cooldown in change 3
     works for every session regardless of route.
5. Leave other providers' probes alone until the log lines show which endpoints refuse.

**Tests:**
- `claude-usage-endpoint-probe.spec.ts`, where the first two cases fail on today's code:
  - "429 with Retry-After: 120 returns a failed snapshot and the next probe makes no request";
  - "the cooldown ends after the delay";
  - "force bypasses the cooldown";
  - "no header means 5 minutes";
  - "an HTTP-date header is parsed";
  - "the delay is capped at 1 hour".
- New `quota-refresh-policy.spec.ts`.
- `quota-auto-refresh.spec.ts`:
  - "complete skips a refresh when header figures are under 10 minutes old";
  - "it refreshes when they are older, or came from the endpoint";
  - "it refreshes when there is no snapshot at all (a session with no account route)";
  - "spawned still refreshes".

**Risks:**
- A stale "fresh" window could hide a plan change for up to 10 minutes; the manual Refresh still forces a probe.
- The shortcut does nothing for a session with no account route, so the saving is partial. The cooldown is not.
- During a cooldown the screen shows the last good figures with no "limited" hint. The log line is the only trace; add a hint
  to the chip's detail if James wants one.

**Done when:**
- A probe given a 429 with `Retry-After: 120` makes no second request for two minutes.
- A `complete` within 10 minutes of a header snapshot triggers no refresh.
- The log line appears in a stubbed run.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

**Size and order:** S. Independent of Phase 0. Keep clear of `provider-quota-service.ts` until the other session's change is
committed.

---

## Step 11. E3.10: Claude's self wake-ups, shown and counted (S-M)

**For James:** Claude Code has a tool that lets it say "wake me in 25 minutes". Harness cannot see this today, and in the
last 30 days Claude asked for it 190 times in 59 sessions. Whether those wake-ups really happen inside a Harness session is
not known yet; this step's live check finds out. After this change the session says so ("Claude asked to be woken at 14:32"),
Harness counts the requests, and it warns you if a session ends with one still pending. Nothing is blocked unless you choose
that later (choice 13).

**Verified (10 Oct):**
- **Claude is asking for it.** Read-only, from the debug record table (9 Sep to 10 Oct):
  - 190 `ScheduleWakeup` calls in 59 sessions, on 20 of the 30 days, 13 of them on 10 Oct;
  - 158 asked for a wake-up, with a median delay of 25 minutes; 27 were `stop`; 5 were refused by the CLI.
  - All 190 results say `success: true`, and the result text says the CLI re-invokes the session itself. That shows the
    request was accepted, not that anything fired.
  - The tool's input keys are `delaySeconds`, `reason`, `prompt`, `noop` and `stop`.
- **Harness neither blocks it nor sees it.** There are no `ScheduleWakeup` hits in `src/`. Only `CronCreate` and `RemoteTrigger`
  are denied (`host-cli-tool-policy.ts:22`).
- **Whether wake-ups fire inside Harness sessions cannot be told from the record, and a host may have to do it.** Sessions
  are busy either way, so a live probe decides it. The evidence points both ways:
  - Jean, a sibling host app, intercepts the tool call and does the re-invocation itself ("background task drains every 10s and
    re-sends the stored prompt", `docs/fable_todo_2_completed.md`, item A2, about `jean-core/src/chat/wakeup.rs`), which suggests
    a host may have to;
  - the Claude Code changelog says one-shot `claude -p` runs now wait for a scheduled wakeup (`CHANGELOG.md:314`), so a live
    process may fire it itself.
  - That is why the on-screen line says "asked", not "scheduled", until the live check shows they fire (choice 13).
- **Where to hook in:** the adapter's `tool_use` case (`claude-cli-adapter.ts:1639-1646`).
  - The async-work route is the wrong place: `instance-async-work-continuation.ts:21` would check in on every 25-minute
    wake-up.
  - Use a separate event, subscribed where `async_work` already is: `instance-communication-provider-events.ts:77-80`
    (`input.adapter.on('async_work', ...)` with an `observeAsyncWork` option; the file is 81 lines, imported at
    `instance-communication.ts:102` and called at `:1356-1372`). The event name goes into `base-cli-adapter.types.ts` twice: the
    name union (`:375`) and the `CliAdapterEvents` interface (`:392`).
- **Harness's own wake-up is not a drop-in replacement.** `thread-wakeup-runner.ts` failed twice in mid-September with "Codex
  app-server runtime already has an active turn" (`_verify-C-E.md` N2).
- **Room:** `claude-cli-adapter.ts` has 7 lines and this step needs about 4 of them (Step 9 needs about 3). Phase 1 Step 14a
  (deleting `sendEndSession`) nets about -1 line in the adapter (it adds back about 16 of the 17 it removes), and Step 8 no
  longer edits the adapter, so the real source of room is Phase 0 step 7b.0 (about 75 lines moved out). Put the new logic in
  new files.

**Change:**
1. **Show it.**
   - New pure module `src/main/cli/adapters/claude-cli-self-wakeup.ts` with `parseClaudeSelfWakeup(toolName, toolUseId,
     input, now)`. It returns a scheduled entry (delay, due time, reason cut to 120 characters), a stop entry, or `null`.
   - **The `prompt` text is never stored or logged**, because it can hold private text.
   - Two lines in the adapter's `tool_use` case:
     - emit a system line, "Claude asked to be woken at 14:32 (in 25 minutes)" or "Claude cancelled its wake-up request"
       (the wording says "asked" until the live check shows wake-ups fire; choice 13);
     - emit `this.emit('self_wakeup', event)`.
   - Add `'self_wakeup'` to the name union and to `CliAdapterEvents` in `base-cli-adapter.types.ts` (`:375`, `:392`).
2. **Count it.**
   - New `src/main/instance/self-wakeup-tracker.ts`: a singleton, `getSelfWakeupTracker()` with `_resetForTesting()`.
   - It holds pending wake-ups per session. A pending entry is cleared by stop, or 10 minutes after its due time.
   - It keeps a per-day tally, in memory only (choice 14), and logs one info line per wake-up.
   - Wire it the way `async_work` is wired: in `instance-communication-provider-events.ts`, add an `observeSelfWakeup` option to
     `bindRawAdapterProviderEvents` and a `self_wakeup` listener beside the `async_work` one (`:77-80`, with the same
     `isStale` check); in `instance-communication.ts`, pass `observeSelfWakeup` next to `observeAsyncWork` (`:1365-1371`),
     calling the tracker (about 6 lines).
3. **Warn when a wake-up is lost.** On termination or hibernation (through the existing termination event;
   `instance-lifecycle.ts` is full), if the tracker holds a pending wake-up, add one line to the transcript: "This session
   ended while Claude had a wake-up pending; it will not happen." (the same "session" wording as choice 13).
4. **No off switch now** (choice 13). If James later wants one:
   - a setting `claudeSelfWakeups: 'allow' | 'block'`, in the five usual places;
   - `'block'` adds `ScheduleWakeup` to the denied tools in `claude-cli-argv-builder.ts`.
   - It changes how the `/loop` skill behaves, so it is his decision.
5. **Do not map the CLI's wake-up onto Harness automations.** They do different things, and the automation path has the failure
   noted above.

**Tests:**
- New `claude-cli-self-wakeup.spec.ts`:
  - "parses delay, reason and due time";
  - "stop is recognised";
  - "the prompt text never appears in the output or the log";
  - "a refused call is ignored";
  - "unknown tool names return null".
- Adapter spec: "a ScheduleWakeup tool_use emits a system line ('Claude asked to be woken at …', never 'scheduled') and a
  self_wakeup event". This fails on today's code.
- `instance-communication` provider-events spec: "a self_wakeup event reaches the tracker, and a stale adapter's event is
  ignored".
- New `self-wakeup-tracker.spec.ts`:
  - "a pending wake-up is cleared by stop";
  - "it expires 10 minutes after due";
  - "tally per day";
  - "termination with a pending wake-up reports it once".

**Risks:**
- One short transcript line per wake-up, about 6 a day in the window.
- The tracker is in memory only; a lasting counter belongs with Phase 0 step 7b's per-turn record.
- If a wake-up does fire, a 25-minute tick lands after Claude's 5-minute cache has expired, so it re-reads the whole session
  at the cache-write price. That is why counting matters; whether they fire is what the live check settles.

**Done when:**
- A stubbed `ScheduleWakeup` shows the line and increments the tracker.
- Ending the session with one pending adds the warning line.
- The tracker never holds a prompt.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

**Size and order:** S-M. Independent of Phase 0 except for adapter room. It needs about 4 of the adapter's 7 free lines (with
Step 9 taking about 3), so land Phase 0 step 7b.0 first.

---

## Step 12. E3.1, E3.2, E3.7 and E3.8: two small safeguards here, two pointers

**For James:** Four of the housekeeping items are handled by other plans, so they are not built twice: the Codex
list refresh, the RTK update, an unused piece of Claude code, and a stray backup file. Two of them get a small safeguard
here, built after the other plan lands: a log line for when the Codex list falls behind again (12a), and a check that the
RTK version is named the same way in all three places it is kept (12b). The other two (12c, 12d) only point at the plan that
does the work, and say how to confirm it.

### 12a. E3.1: say so when Harness's Codex protocol record falls behind (XS)

**Needs first:** Phase 1 Step 1a. It refreshes the record to the installed Codex (0.144.4 to 0.162.1) and creates
`app-server-client-protocol.spec.ts`, the spec that the commit rule below refers to.

**For James:** Nothing changes on screen. Phase 1 brings Harness's built-in record of what Codex accepts up to date; it had
fallen 18 versions behind without anyone noticing. This small step makes Harness write one line in its log, once per run, when
the installed Codex is ahead of that record again, so it cannot fall behind silently a second time. It never blocks a Codex
session.

**Verified (10 Oct):**
- The record's version is a constant in the generated file: `CODEX_APP_SERVER_PROTOCOL_VERSION = "codex-cli 0.144.4"`
  (`src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts:4`). Only the generator and
  `app-server-protocol.gen.spec.ts` mention it. Nothing at run time compares it with the installed Codex, so a stale record
  leaves no trace except Phase 1 Step 1a's `--check`, which runs by hand and not in CI.
- The record gates every request Harness sends: `validateGeneratedRequest` throws "unsupported parameter" for any key missing
  from the record (`app-server-client-protocol.ts:25-33`). That is why a gap matters.
- **Where the installed version comes from at run time:** the CLI detection cache, the Codex entry's `version` (for example
  `0.162.1`; `cli-detection.ts:56`, `:219-221`), the same source Step 9 uses for Claude. `InitializeResponse.serverInfo.version`
  is typed (`app-server-types.ts:59-62`), but nothing reads it, so it is not used here. On a worker the cache is empty, so no
  warning is logged there.
- **Room:** `app-server-initializer.ts` has 298 lines (not allowlisted, so a cap of 700). `codex-app-server-adapter.ts` has
  no room (754 lines, ceiling 704 plus 50) and is not edited.

**Change:**
1. New module `src/main/cli/adapters/codex/codex-protocol-snapshot-check.ts` (about 40 lines):
   - a pure `describeSnapshotGap(snapshotVersion, installedVersion)` that parses `codex-cli X.Y.Z` and `X.Y.Z` and returns how
     many minor versions the record is behind (a higher installed major version counts as behind), or null when the versions
     are equal, the record is ahead, or either one does not parse;
   - `warnOnceIfCodexSnapshotBehind()`, which supplies the two versions (the generated constant; the Codex entry from
     `getCliDetectionService().peekCachedResult()`) and, the first time in a run that a comparison finds a positive gap, logs
     `logger.warn('Codex protocol snapshot is N minor versions behind the installed CLI', { snapshot, installed })`. The
     once-only flag is set only when a comparison was actually made, so an empty cache at the first spawn does not use it up.
   - It never throws and never blocks a spawn.
2. One line, `warnOnceIfCodexSnapshotBehind();`, at the start of `initializeCodexAppServer` (`app-server-initializer.ts:57`),
   plus its import.
3. **Commit rule.** The regenerated protocol file and its spec go in one commit, never alone: a record that silently drops a
   key would fail every Codex start, and the coverage case in `app-server-client-protocol.spec.ts` (Phase 1 Step 1a) is the
   guard. Write this in the as-built notes, and say it to James when he asks for the commit.

**Tests:**
- New `codex-protocol-snapshot-check.spec.ts` (fails on today's code only because the module does not exist):
  - "warns once, naming both versions and the gap, when the installed Codex is ahead";
  - "a second call in the same run logs nothing";
  - "logs nothing when the versions are equal, the record is ahead, or either version is missing or does not parse (a worker)";
  - "an empty detection cache does not use up the once-only flag";
  - "never throws".
- The once-only flag has a reset helper exported for tests only.

**Risks:**
- One warning line per run on a machine whose Codex is ahead of the record. Harmless.
- A pre-release Codex version string that does not parse gives no warning, which is the safe direction.
- Cost: none (no model calls).

**Done when:**
- With Phase 1 Step 1a landed, the record reads `codex-cli 0.162.1` and a run on this Mac logs no warning. With the constant
  set lower inside a spec, exactly one warning appears.
- The new spec passes, and so do the Codex adapter specs (`npm run test:quiet -- src/main/cli/adapters/codex/`).
- When James asks for the commit, the staged paths (read with `git diff --cached --name-only`) hold the regenerated protocol
  file and `app-server-client-protocol.spec.ts` together.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

### 12b. E3.2: check that the three RTK version settings agree (XS)

**Needs first:** Phase 1 Step 18a, which moves the three settings to RTK 0.51.0.

**For James:** Nothing changes on screen. Harness names the version of its built-in RTK (the tool that shortens command
output) in three places, and all three have to be changed together whenever RTK is updated; a partial change would give a
broken or mismatched build. This step adds a check
that fails if the three ever disagree. A note for the day you commit the RTK update: the program files for RTK are stored in
the repo itself, so each update adds about 20 MB to its history (43 MB raw; corrected 11 Oct). That is how the repo already works.

**Verified (10 Oct):**
- **The three places, all reading 0.39.0 today (read by the fixer):** `scripts/fetch-rtk-binaries.js:32`
  (`const RTK_VERSION = '0.39.0';`), `scripts/rtk-binaries.sha256.json` (`version`, plus five platform hashes) and
  `src/main/cli/rtk/rtk-runtime.ts:29` (`export const RTK_BUNDLED_VERSION = '0.39.0';`).
- **No check compares them.** A search of the specs for the fetch script and the hash file finds none. The fetch script's own
  "To bump the pinned version" steps (`fetch-rtk-binaries.js:15-19`) name two of the three and leave out `rtk-runtime.ts`.
- **The binaries are tracked in git.** `git ls-files resources/rtk` lists five files (darwin-arm64, darwin-x64, linux-arm64,
  linux-x64, and `win32-x64/rtk.exe`). They total 43,284,028 bytes on disk at 0.39.0 (darwin-arm64 alone is 7,597,696). A bump
  commits five new binaries: about 20 MB of history, 43 MB raw (corrected 11 Oct; the 0.51.0 files may differ in size, so read the
  real size from the new files before telling James).
- Phase 1 Step 18a moves the three pins and the five hashes. It has no spec that they agree and does not mention the size.

**Change:**
1. New spec `src/main/cli/rtk/rtk-version-pins.spec.ts`. A small helper reads the version from the three places for a given
   repo root: a regular expression on `fetch-rtk-binaries.js` for `const RTK_VERSION = '…'`, the JSON `version`, and the
   exported `RTK_BUNDLED_VERSION`. Cases:
   - "the repo's three pins agree" (passes on today's 0.39.0 and after Phase 1 Step 18a's 0.51.0);
   - "a scratch copy of the three files with one pin changed is reported as disagreeing, and names the file" (this proves the
     guard fails on a partial bump; the copy is made in a temporary folder).
2. In the header of `scripts/fetch-rtk-binaries.js`, extend the "To bump the pinned version" steps with the third place
   (`RTK_BUNDLED_VERSION` in `src/main/cli/rtk/rtk-runtime.ts`), a pointer to the new spec, and one line: "The binaries under
   resources/rtk are tracked in git, so a bump commits about 20 MB of history." This is a comment only (corrected 11 Oct: 35-40 MB was the raw size).
3. **Tell James the size before the commit.** When James asks for the commit that holds the bump, say that it adds the five
   binaries, about 20 MB (43 MB raw; corrected 11 Oct), and that no longer tracking them is a separate packaging change (see "Not in this plan").

**Tests:** the new spec. It does not run RTK.

**Risks:**
- None for users. The spec reads `scripts/` files from the repo checkout, which the Vitest run has.
- Cost: none.

**Done when:**
- After Phase 1 Step 18a, the spec passes with all three at 0.51.0, and the scratch-copy case fails as designed.
- The fetch script's header names all three places and the size.
- The as-built notes record the size warning that was given to James before the commit.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

### 12c. E3.7: delete the unused `sendEndSession` (a pointer)
- This is done in Phase 1, Step 14a. `claude-cli-adapter.ts:409-421` has no caller (only its own spec calls it) and writes a
  message shape the CLI ignores. Deleting it removes about 17 lines, but Phase 1 uses about 16 of them for its own control-request
  code (its own budget ends at about -1 line), so do not count on it for adapter room in Steps 9 and 11.
- Confirm when Phase 1 Step 14a lands: `command grep -rn 'sendEndSession' src` finds nothing.

### 12d. E3.8: the stray `.bak` file (a pointer)
- This is done in Phase 0, step 2.6b, which deletes `src/main/orchestration/loop-audit-runtime.ts.bak` from disk and adds
  `*.bak` to `.gitignore`, but leaves the staging to the commit James asks for.
- **So the check cannot be `git ls-files`.** That command lists the index, and a file deleted from disk but not yet staged is
  still in the index, so it still prints the file until the commit (it prints it today). The check is that the file is gone from
  disk: `test ! -e src/main/orchestration/loop-audit-runtime.ts.bak`. Until James commits, `git status --short` for that path
  shows ` D src/main/orchestration/loop-audit-runtime.ts.bak`; that single ` D` line is expected and correct. After the commit
  it shows nothing.

---

## Step 13. CLAUDE.md: the options (XS; your choice)

**For James:** In this repo, `CLAUDE.md` is just two "also read this" lines. GitHub Copilot follows them, so it reads the
main instruction file (about 10 KB) twice on every request inside this repo. Claude Code and Codex are not affected. The
cost is small: about 10 KB of cached text per request. Nothing changes unless you pick another option (choice 19).

**Verified (10 Oct):**
- **The files:**
  - `CLAUDE.md` is 40 bytes: `@AGENTS.md` and `@docs/angular-conventions.md`;
  - `AGENTS.md` is 10,505 bytes; `docs/angular-conventions.md` is 2,085.
  - Neither CLAUDE.md nor AGENTS.md is dirty.
- **The measured duplicate:** in all 684 Copilot sessions run inside this repo, AGENTS.md appears twice (CPS-3).
- **Who reads what:**
  - **Claude Code** reads `CLAUDE.md` and follows `@` lines. Since 2.1.277 it also reads `AGENTS.md` when there is no
    `CLAUDE.md` (`CHANGELOG.md:1642`).
  - **Codex** reads `AGENTS.md` only.
  - **Copilot** reads both, expands `@` lines, and de-duplicates only identical files.
- **Nothing in Harness's build or CI depends on this file.**

**The options:**
1. **Leave it as it is (recommended).**
   - Cost: about 10 KB (roughly 2,600 tokens) of cached text per Copilot request in this repo.
   - Risk: none.
2. **Delete `CLAUDE.md`.**
   - Every tool then reads `AGENTS.md` once.
   - It needs Claude Code 2.1.277 or newer on every machine that opens this repo (your Mac is 2.1.296; the Windows PC is
     unchecked).
   - Add one sentence pointing at `docs/angular-conventions.md`, so Claude still gets those rules.
3. **Make `CLAUDE.md` a link to `AGENTS.md`.** Not recommended: links break on a Windows checkout without link support.
4. **Fix it only inside Harness.** Phase 1's A2 follow-up delivers Harness's own Copilot instructions natively, which removes
   the cost where it matters. Your own Copilot sessions outside Harness keep the duplicate.

**Change:** none unless James picks option 2 or 3. For option 2:
- delete the file;
- add the one-line pointer to the Angular conventions, or fold that file into `AGENTS.md`;
- leave `docs/DEVELOPMENT.md` alone: it does not mention `CLAUDE.md` (no match on 10 Oct), and it is dirty from another
  session.

**Tests (options 2 or 3 only):**
- A fresh Claude Code session in this repo quotes the first heading of `AGENTS.md`.
- A fresh Copilot session's first system message holds the "AI Orchestrator Agent Instructions" heading once. Read it from its
  saved `events.jsonl`.

**Done when:** an option is selected under current authority. Option 1 was selected under standing decision autonomy and the recorded leave-and-proceed scope on 13 October 2026; CLAUDE.md remains unchanged. Options 2 and 3, if later requested, require both tests on the Mac and Windows PC.

**Live checks:** moved to [the live-test document](2026-10-10-oct-housekeeping_livetest.md).

---

## Final verification

When each step is finished, run its targeted specs and `npx tsc --noEmit`. When the whole plan is done, run the canonical gates
and record their output in the as-built notes:

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
npm run verify:ipc          # Steps 4 and 6 add channels
npm run verify:ipc-usage
test ! -e src/main/orchestration/loop-audit-runtime.ts.bak && echo 'stray .bak gone from disk'   # true once Phase 0 step 2.6b is done
git status --short -- src/main/orchestration/loop-audit-runtime.ts.bak   # until James commits, prints ' D src/main/orchestration/loop-audit-runtime.ts.bak' (expected)
```

Do not use `git ls-files | grep '\.bak$'` as this check: it lists the index, and Phase 0 step 2.6b deletes the file from disk
without staging the deletion, so the file is still listed until the commit (Step 12d).

**Fresh-eyes completion gate.** Before calling this plan complete:
1. A fresh agent that did none of the work runs the `task-completion-gate` skill over this plan's changes.
2. Fix every actionable finding, rerun the checks, and send the work to another fresh review.
3. Repeat until it returns `VERDICT: PASS`.

Brief each reviewer on James's rules:
- no branches or worktrees;
- no browser on the Mac;
- preserve other sessions' uncommitted work;
- never delete anything without asking;
- no secrets.

## Live checks

Detailed checks have moved to [2026-10-10-oct-housekeeping_livetest.md](2026-10-10-oct-housekeeping_livetest.md), with the
standard header:
- prerequisites (rebuild, restart, which instance);
- a link back to this plan;
- the remediation-flow paragraph pointing at `livetest-campaign-runbook.md` and `livetest-remediation-register.md`.

Then leave a one-line pointer here.

The checks that remove anything are done only with James present and after his yes:
- Step 4b's "Clear now" and "Shrink the file" on the real data (where Step 3's rebuild runs on the real file);
- any real backup removal from Step 4's card;
- any real clean-up from Step 5;
- removing the one merged work folder in Step 6.

Step 1's live check removes nothing: it ends in Cancel and an unchanged `ls` of the backups folder. Step 3's synthetic rebuild
runs on a scratch ledger and removes nothing real.

Screen checks run on the Windows PC, or on the Mac only with James's OK.

## Not in this plan (and where it goes)

- **Phase 1's use of the shared version helper.** Step 9 here specifies `resolveClaudeCliVersion(adapterVersion)` in
  `claude-cli-feature-probes.ts`. The Phase 1 plan now calls it in its Step 2 and Step 9a instead of writing the fallback
  inline (corrected there on 10 Oct). Whichever step lands first creates the helper.
- **Storing one copy of each debug-record event** (the backlog's first E1 fix). Only `output` events are stored twice, so it
  would save at most 38% to 62% and nothing for `complete` events; with the record off by default it matters little. Covered by
  choice 2 and correction 2. Revisit only if James switches the record on for good.
- **An opt-in weekly tidy** for activity logs, saved records and backups. A follow-up (the October follow-ups plan's one-line list), once James has used the disk space card
  for a month.
- **Rotation for `logs/traces.ndjson`** (711 MB on 11 Oct, no limit; corrected 11 Oct). A small fix, or a fifth target on the disk space card: the October follow-ups plan, part 5c; see "Found on
  the way".
- **Branches with no work folder:** 18 `queue/*`, `release/harness-auto-update-v0.1.0`, one unmerged `task-*` and six merged.
  Either a second list on the leftover card or the plan queue's own landing tidy-up (Phase 2's B8 does not build it, corrected 11 Oct; it is on the October follow-ups plan's one-line list). The same ask-first rule
  applies.
- **A lasting counter for self wake-ups, and a turn-origin tag.** Phase 0 step 7b's per-turn record should carry an `origin`
  column; it is not designed here (the October follow-ups plan's one-line list).
- **A proper `end_session` for a graceful Claude teardown.** Only if a transcript-flush problem is ever seen (the October follow-ups plan's one-line list).
- **An exact count of non-shell permission prompts.** From Harness's own permission records, owned by Phase 3's C3b work; the
  debug record cannot give it.
- **The Copilot double load fixed inside Harness.** Phase 1's A2 follow-up.
- **RTK's Codex hook, savings view and instruction text.** Phase 1's A13.
- **Provider-aware `getModelRate`.** Phase 0 step 7c.
- **Quota cooldowns for Codex, Copilot, Gemini and the rest.** After Step 10's log line shows which endpoints refuse (the October follow-ups plan's one-line list).
- **Stores that manage themselves:** `codemem.sqlite` 7.05 GB, `rlm.db` 6.2 GB, `conversation-evidence` 3.8 GB,
  `codex-command-output` 2.4 GB. Shown on the disk space card, with no clean-up action.
- **Not tracking the RTK binaries in git** (35-40 MB per bump; corrected 11 Oct: 35-40 MB is the raw size, 43.3 MB; in git it is 20.1 MB per bump). Its own packaging change: the October follow-ups plan, part 5e.
- Pieces this plan leaves to nobody are collected in the October follow-ups plan (`2026-10-11-oct-followups_plan.md`), with a one-line list for the small or conditional ones.

## Found on the way (not fixed here)

1. **`logs/traces.ndjson` is 695 MB and never rotates.** `src/main/observability/local-trace-exporter.ts:21,41` appends with no
   limit. `provider-runtime-trace-worker.ts:45` rotates at 30 MB, but no `.old` files exist. Two writers share one path. (Corrected 11 Oct: the `.old` files exist, nine of about 31.5 MB in `$TMPDIR/ai-orchestrator/logs`, and the two writers use two folders: both build `<userData or the temp folder>/logs/traces.ndjson`, and the rotating worker falls back to the temp folder, `provider-runtime-trace-worker.ts:39-43`, `local-trace-exporter.ts:12-21`; that last step is inferred from the nine `.old` files and the 15.6 MB `traces.ndjson` found there. The file under `harness/logs` is now 711 MB, not 695, and never rotates. The October follow-ups plan, part 5c.)
2. **Saved session records are never removed.** Both callers pass `archive = true` (`instance-event-forwarding.ts:178`,
   `instance-lifecycle.ts:1987`), and the unlink at `session-continuity.ts:620-629` runs only for `false`. That is 7,678 files,
   4.64 GB. Step 5 offers a clean-up; the root cause is noted here.
3. **A missed identifier lookup reads every saved record** (`session-continuity.ts:379-388`, 4.6 GB). Confirmed 11 Oct with data (7,699 files, 4.68 GB, largest 122.6 MB); how often a lookup misses is unmeasured. The October follow-ups plan, part 6g.
4. **Claude tool results never carry a failure flag in the debug record.** All 227,226 captured rows say `success: true`. The October follow-ups plan's one-line list holds it.
5. **The context-bar "≈ $x USD" is the latest request's cost, not the session's, and its legacy pricing branch is dead code on
   current Claude Code.** The adapter's inline cache-at-full-price sum sits in the `system / context_usage` branch
   (`claude-cli-adapter.ts:1566-1584`), which current Claude Code does not send (Step 8, first check); Phase 0 step 8 replaces
   the stored figure with the recorded session spend anyway. Step 8 does not edit it. Phase 3's C2 decides whether to keep the
   "≈ $" at all; deleting the dead branch belongs with that decision (the October follow-ups plan's one-line list keeps it).
6. **`primeCliVersion` reads the Claude version only outside auto-approve mode, with a permission hook**
   (`claude-cli-adapter.ts:2087-2104`). Every future version gate hits the same trap, and on a worker it never reads the
   version at all (workers default to auto-approve, `local-instance-manager.ts:348`); Step 9 shows the way round it.
7. **The memory-database warning banner appears only at 10 GB** (`rlm-maintenance.types.ts:1`), and it says "RLM". At 6.2 GB
   James never sees it (the October follow-ups plan's one-line list).
8. **Empty database stubs at the data-folder root.** `conversation-ledger.db`, `loop-mode.db` and `state-5.sqlite` are 0 bytes;
   the real files live in subfolders.
9. **The settings files are a shared, nearly spent budget.** `settings.types.ts` has 32 lines of room and
   `settings-control-policy.ts` has 46, and about 11 plans add settings there. Count them together across plans, move new
   settings into a new types module, or raise the ceilings on purpose (the October follow-ups plan, part 2a).
10. **The start-up tidy-up removes an ended loop's work folder without asking.** After Phase 0's Close gives the parked
    `provider-limit` run an `ended_at`, the next start reconciles it: `getPendingLoopWorktreeLifecycles` stops excluding it
    (`loop-store-worktrees.ts:89-96`), `reconcileManagedWorktreeLifecycles` runs at boot
    (`late-runtime-initialization-steps.ts:114`), and for an ended run that is not a success it removes the folder with no prompt
    (`loop-worktree-lifecycle-reconcile.ts:230-245`, then `removeOrphanWorktree`). It never removes the branch. For the one folder
    affected today, `task-please-work-through-all-the-li-mu4ui30h`, the branch is merged and the folder is clean (checked), so
    nothing is lost. It is existing behaviour that Phase 0's Close will newly trigger; Step 6 does not change it. The October follow-ups plan, part 3c, makes the tidy-up refuse a folder with unsaved changes.

## Corrections to the backlog

1. **E1 "about 80 GB":**
   - it is about 97 GB today (97.4 GiB at 18:45 on 10 Oct);
   - the conversation file is 35.0 GB, not 28.9 GB;
   - 33 GB of it is one debug table, and only 2.3 GB is real conversation data.
2. **E1 "each stored twice":** exactly true only for `output` events. Storing one copy saves at most 38% to 62%, and nothing
   for `complete` rows.
3. **E1 "incremental vacuum after the sweep":** not enough on its own. `auto_vacuum` is 0, so a one-time rebuild is needed (Step 3).
4. **E1 "73% of saved records are older than 30 days":** true for files, but those hold only 33% of the bytes.
5. **E1 "projects/ not examined":** about four-fifths of it (6.29 GB of roughly 8.0 GB, which `du` shows as 7.44 GiB) is
   write-only `session-events/*.jsonl`, with no reader and no clean-up.
6. **E1 backups:** a maintenance run deletes the older July backup without asking, and says so only afterwards (Step 1).
7. **The E1 ledger counts are done:**
   - `ScheduleWakeup`: 190 calls in 59 sessions;
   - non-shell denial-like results: 8 to 158 in 30 days, with no exact count possible;
   - injected context: about 1.04M tokens, 92% of it from the code index.
8. **E2:** 12 extra work folders, not 10. 11 hold saved work main lacks, and the 18 Sep review never said "Discard".
9. **E3.2:** the RTK version is pinned in three places, and the binaries are tracked in git.
10. **E3.3:** a naive version gate would turn the cache flag off for every loop.
11. **E3.4:**
    - **REFUTED for current Claude Code:** the context-bar figure does not price cache reads at full price there. The inline
      sum is in the legacy `system / context_usage` branch, which current Claude Code does not send (0 of 2,843 recent Claude
      context events carry a cost figure); Step 8 therefore changes the price table only;
    - the price table's cache-read rate is also wrong for the shorthand ids Harness runs on (`sonnet`, `opus[1m]` and so on),
      not only the full ids, and the provider-aware lookup needs the three new ids (Step 8, changes 2 and 3);
    - the offline snapshot lacks Sonnet 5.5 and Haiku 5.5;
    - Haiku 5.5's cache-read rate is unpublished.
12. **E3.5:** the comment was wrong when written; the watchdog has been on by default since 2.1.196.
13. **E3.6:** "since 0.50" is RTK's version. Codex's hook is configured in `hooks.json`.
14. **E3.8:** already in Phase 0 step 2.6b.
15. **E3.9:** not seen to bite, and the probe cannot read `Retry-After` at all.
16. **E3.10:** Claude asks to be woken later (190 requests, ongoing). Whether those wake-ups fire inside a Harness session is
    not known; Step 11's live check decides it.
17. **CLAUDE.md:** Claude Code reads `AGENTS.md` itself when there is no `CLAUDE.md` (since 2.1.277), which adds a deletion
    option.

## Finishing

1. Every step is implemented and verified, the gates pass, and the fresh-eyes gate returns PASS.
2. Create `docs/plans/2026-10-10-oct-housekeeping_livetest.md` and move the live checks into it.
3. **Do not rename this plan `_completed` until the other plans' work has landed and been confirmed:** Phase 1 Steps 1a, 14a
   and 18a and Phase 0 step 2.6b. Steps 12a and 12b are built on top of 1a and 18a, and 12c and 12d are checks of 14a and 2.6b.
   If James wants this plan closed before those land, record 12a to 12d in the as-built notes as "handed over, confirmed on
   landing", and keep a one-line reminder in the livetest doc.
4. Update this plan's status line and as-built notes, then rename it `2026-10-10-oct-housekeeping_plan_completed.md`, **last**.
5. In `claude_oct-todo.md`, mark E1, E2, E3.3 to E3.6, E3.9 and E3.10 done and link to the completed plan. Mark E3.1, E3.2,
   E3.7 and E3.8 done only when the plan that does the work (Phase 1 Steps 1a, 18a and 14a; Phase 0 step 2.6b) has landed, even
   if this plan closes first.
6. Commit only when James asks.
   - Stage only this plan's code and the `_completed` plan (the livetest doc stays untracked until it is renamed `_livetest_completed`, because the commit hook refuses an open one).
   - Never stage other sessions' work.
   - Never stage a removal of James's data.

## As-built notes

(Record here, per step: what changed, any deviation from this plan and why, and the current gate output.)

- [x] Step 1 E1d backups
- [x] Step 2 E1a debug record opt-in
- [x] Step 3 E1b conversation file shrink
- [x] Step 4 E1c disk space card (4a, 4b)
- [x] Step 5 E1e saved records and activity logs
- [x] Step 6 E2 leftover work folders
- [x] Step 7 E3.5 and E3.6 notes (7a, 7b)
- [x] Step 8 E3.4 Claude 5.5 prices (price table only)
- [x] Step 9 E3.3 Claude version checks (including the shared `resolveClaudeCliVersion` and the worker version read)
- [x] Step 10 E3.9 quota refresh hygiene
- [x] Step 11 E3.10 self wake-ups
- [x] Step 12 (12a-12d): the two safeguards are built and tested (rounds 1-3) and all four cross-plan confirmations now pass in this branch — protocol snapshot `codex-cli 0.162.1` with the coverage spec, all three RTK pins 0.51.0, no `sendEndSession` hits in `src`, stray `.bak` gone with `*.bak` ignored (post-port round-1 remediation below)
- [x] Step 13 CLAUDE.md option chosen
- [ ] Final gates (fast gates and targeted tests PASS after the round 3 port and the post-port round-1 remediation — see below; the full `test:quiet` suite is reserved for the queue verifier and is not claimed)
- [ ] Fresh-eyes gate PASS (the queue verifier's independent completion-gate run)
- [x] Livetest doc created

### Worker implementation evidence — 13 October 2026

All code changes are in the supplied `queue/2026-10-10-oct-housekeeping-c2ff86` worktree. The plan and live-test document remain untracked in the root checkout, with their original active filenames. No linked standalone spec exists: the source requirement document is the approved backlog. No commit, staging, stash, branch switch/new branch/new worktree, real-data deletion, or browser/desktop action was performed. The queue coordinator owns checkpointing, the full suite, independent verification, document closure and integration.

1. **Step 1:** named backup selection is wired through contracts, preload, signal store and dialog. Checkboxes reset unticked; dates include time and sizes include content and SQLite sidecars. No selection skips pruning. Re-listing protects newest retained backups and validates names instead of treating inputs as paths. Scratch tests exercise named-only deletion, newest protection, unticked preservation and failure rollback. Removal failure restores surviving staged paths; already deleted bytes cannot be recreated, and partial rollback never reports success or freed bytes.
2. **Step 2:** `recordProviderEvents` defaults false in all five registries. Capture checks the production setting per event, applies without restart, and drains already queued captures after switch-off. The 30-day sweep remains active. Architecture/runbook updated; MiMo evidence campaigns require recording on first. The historical counts above remain the record.
3. **Step 3:** bounded indexed endpoint/sample stats; 20,000-row deletes with yields; incremental vacuum batches capped at 25,600 pages. Worker/store/port/service delegations and per-call timeout are wired, with 15 minutes only for explicit rebuild. Guards require at least half the file free and twice live bytes plus 1 GiB free disk. Synthetic 300,000-row native rehearsal: 2,482,974,720 → 248,565,760 bytes in 1,653 ms; observed peak extra disk use 501,600,256 bytes versus guard 1,570,947,072. Concurrent timed-out write retry persisted exactly once; integrity passed and auto_vacuum became 2. Evidence `_scratch/ledger-rehearsal/{evidence.json,run.log}`; generated temp DB removed.
4. **Step 4:** disk card is mounted first in Doctor and fully wired through typed preload and trusted validated handlers. Single-use 10-minute preview tickets bind target/candidate fingerprint; changed lists, missing/expired/used tickets and concurrent cleanups are refused. Async capped link-safe measurements use a 60-second cache with generation fencing against stale scans after cleanup. Running progress bypasses cache and the store polls at two seconds, including reopening a card during server cleanup. Clear and shrink are separate. Existing freed pages contribute to the top reclaimable figure. Dialogs name previews' size, dates, consequence, newest backup and disk guard; Cancel/Escape/outside click run nothing, with Cancel-focused trap. The ~2-second time is explicitly a 249 MB scratch measurement, not a prediction for real data. Six channels were generated; no existing channel was removed or changed.
5. **Step 5:** record/log candidates use 30-day age, live and hibernated instance exclusion plus dirty-state protection. Sidecars accompany their saved state; snapshots/quarantine stay outside cleanup roots. Paths and file identities are rechecked, links rejected, deletion serialized with the session-save mutex, and successfully removed states are evicted with persistence-epoch advancement so in-memory restore/save cannot resurrect them. Exact preview names include paths to distinguish states/metadata or identical log names in different projects. Current dialog omits the unverified History-preservation sentence pending the scratch-app restore experiment. No automatic deletion or archive-caller changes.
6. **Step 6:** uncapped loop/queue owner readers and live-session cwd matches build read-only reports, with shared-repository deduplication. Only recorded Harness-owned managed folders are removable. Fresh checks inside the Git write queue enforce a valid ticket, ownership, clean status, unchanged branch/HEAD, no live owner and explicit discard flag. Folder-only preserves branch; merged deletion checks ancestry. Other and Claude Code folders are report-only. A small `alreadyQueued` seam avoids nested write-queue deadlock while keeping helper defaults unchanged. Scratch fixtures cover blocked/terminal restart safety; card/store/IPC and trusted-sender checks are wired.
7. **Step 7:** corrected watchdog and pre-command-hook notes; no behavior change. Codex turn adapter remains 697 lines and Claude stall warning retains the five-minute floor.
8. **Step 8:** full and shorthand Claude 5.5 fallback prices/cache reads corrected; priced-only IDs enter Claude's provider-aware guard without becoming picker options or Copilot static prices. Legacy context-usage pricing untouched. `sync:model-catalog` fetched 120 rows and adds Sonnet/Haiku 5.5, corresponding Copilot rows and three newer OpenAI IDs, plus registry's Sonnet 4.5 context correction; diff inspected. Provider-reported costs/overlay still win.
9. **Step 9:** one shared version resolver, help+>=2.1.268 optimization gate, old (<2.1.267) resume prompt reappend, unknown safe fallback, and worker/auto-approve status probe. Actual subprocess/parser seam and stub argv cases passed. No duplicate inline detection-cache fallback.
10. **Step 10:** Retry-After seconds/date parsing; Claude 429 logging and 1–60-minute clamp with five-minute default; force bypass and repeated-refusal extension. Only post-turn successful header figures younger than ten minutes skip auto-refresh. Spawn/manual/endpoint/no-route behavior retained; other provider/account-pool files untouched.
11. **Step 11:** actual assistant and legacy tool-use paths show “asked” and publish self_wakeup, separately from async_work. In-memory singleton tally/pending expiration, cancellation/refusal clearing, stale-adapter fence, remote safe metadata and once-only termination/hibernation warning are wired before archival/save. No blocking switch or automation remapping. Privacy trace found raw completion capture could retain ScheduleWakeup.prompt; the parse boundary now sanitizes arguments/raw NDJSON as well as transcript metadata, preserving unrelated provider fields and failing closed on unparseable wakeup lines.
12. **Step 12:** 12a snapshot warning and 12b three-pin agreement safeguard are implemented and tested against current versions, so they also protect the waiting upgrades. **The four cross-plan landing confirmations remain open**, not marked done: Phase 1 1a snapshot is still 0.144.4 and client coverage spec absent; 18a RTK is still 0.39.0; 14a sendEndSession remains; Phase 0 2.6b stray `.bak` exists and ignore rule is absent. Do not close/rename this plan until those owning changes land, unless James explicitly authorizes the plan's handover exception. This worker did not duplicate those changes. Protocol+coverage must be committed together when the separate update is requested; RTK update adds five tracked binaries (~20 MB history /43 MB raw), not performed here.
13. **Step 13:** recommended option 1 selected under current decision autonomy and recorded leave-and-proceed authorization. CLAUDE.md remains unchanged. This resolves the old choice note without deleting anything or requiring new authority.

### Review and verification ledger

- Regression failures observed before relevant fixes; exact evidence in `_scratch/backup-ledger-handoff.md` and `_scratch/cli-housekeeping-handoff.md`.
- Root self-review and focused peer review found/fixed stale usage cache, ambiguous filenames, synchronous backup scanning and raw wakeup prompt retention. Peer reviewer independently reran four affected storage/retention/backup specs: 25 tests passed (`_scratch/test-run.pid-95634.log`). A later root review corrected the distinction between newly created and earlier retained backups. No whole-plan fresh-gate PASS is claimed.
- Earlier integration selected run: 45 changed spec files, 430 tests passed (`_scratch/test-run.pid-97507.log`). This is targeted verification, not the full suite. Current final selected list/log are `_scratch/housekeeping-focused-specs.txt` and `_scratch/housekeeping-focused-tests.log`; record the final count below after the last fix.
- Additional affected checks passed: ledger/RLM/settings/bridge 21 files/148 tests; Codex/pricing/quota 45 files/487 tests; adapter 7 files/143 tests; worktree legacy regressions 3 files/42 tests. These groups overlap; do not add their counts.
- Final canonical worker commands and logs (all prefixed with RTK): `npx tsc --noEmit` → `_scratch/housekeeping-typecheck.log`; `npm run typecheck:spec` → `_scratch/housekeeping-spec-typecheck.log`; `npm run lint` → `_scratch/housekeeping-lint.log`; `npm run check:ts-max-loc` → `_scratch/housekeeping-loc.log`; `npm run build:main` → `_scratch/housekeeping-build-main.log`; `npm run build:renderer` → `_scratch/housekeeping-build-renderer.log`; `npm run verify:ipc` → `_scratch/housekeeping-ipc.log`; `npm run verify:ipc-usage` → `_scratch/housekeeping-ipc-usage.log`; `git diff --check`. IPC usage remains warn-level with unrelated legacy reachability warnings; all six added channels have contracts, handlers, preload and consumers. No LOC ceilings were raised.
- Full test suite and genuinely fresh task-completion-gate remain the queue verifier's work, per worker instruction. They are not human-only live deferrals and are not marked passed.
- Rebuilt-app/worker/provider checks and every James-authorized real-data operation moved to root `docs/plans/2026-10-10-oct-housekeeping_livetest.md`. Its checklist states prerequisites, exact expected observations and authorization boundaries. Agent-runnable synthetic/headless checks were performed in-loop, not deferred.

### Final worker gate results — 13 October 2026

- **PASS:** 45 changed spec files, **433 tests**, 55.8 seconds; final raw log `_scratch/test-run.pid-51335.log`, command/selection summary `_scratch/housekeeping-focused-tests.log` and `_scratch/housekeeping-focused-specs.txt`.
- **PASS (exit 0):** main typecheck, spec typecheck, full lint, LOC ratchet, main production build, renderer production build, IPC contracts/handler synchronization, IPC usage check and diff whitespace check. Exact logs are listed above. LOC has its existing tolerance notices; IPC usage is warn-level and retains unrelated legacy reachability notices, with no new housekeeping channel missing.
- **PASS:** scratch/native rebuild, saved-write retry, backup rollback/count correction, session retention, ticket freshness/single-use/changed-list, worktree ownership/dirty/tip/live-owner/discard, UI Cancel/Escape/focus, and raw wakeup privacy checks. State and activity-log retention share one scratch fixture suite (`session-state-retention.spec.ts`) rather than duplicating fixtures in two files; both modules' acceptance cases run there.
- **OPEN:** the full repository test suite and genuinely fresh task-completion-gate, deliberately reserved for the independent queue verifier. Neither is claimed passed. Final-gates and fresh-gate checkboxes remain unchecked for this reason.
- **OPEN:** all four cross-plan Step 12 confirmations; current snapshot 0.144.4, RTK pins 0.39.0, sendEndSession present and stray `.bak` present. Safeguards are implemented; owning Phase 0/1 upgrades/removals are not duplicated or falsely confirmed.
- **OPEN:** rebuilt-app/worker/provider/human checks in the live-test document. No real backups, session records, logs, work folders or branches were removed; no Mac browser/UI used.
- **Verified:** root plan and live-test paths both show `??`; neither exists as a copy in this worktree. Git index empty, CLAUDE.md unchanged, branch still the supplied queue branch. No agent-created repository branch/worktree requires cleanup. Synthetic temp database fixture was removed; evidence retained.

The implementation is left uncommitted for the coordinator and independent verifier. This is a worker handoff, not a whole-plan completion or permission to close the pending dependencies.

### Verification round 1 remediation — 13 October 2026

- **Finding 1 of 1 addressed:** the verifier reported two stale pricing assertions in `src/main/providers/__tests__/model-capabilities.spec.ts`, causing 2 of 31,257 tests to fail in its full run. The worker reproduced both failures with `rtk npm run test:quiet -- src/main/providers/__tests__/model-capabilities.spec.ts`: 2 of 23 failed, exit 1; retained raw log `_scratch/test-run.pid-55029.log`.
- **Root cause and fix:** Step 8 intentionally moved the bare Claude aliases to 5.5 prices, and `ModelCapabilitiesRegistry.pricingFor` reads that static table directly. The existing registry tests still expected Sonnet 3/15 and Opus 5/25. Updated all four numeric expectations to Sonnet **2/10** and Opus **4/20**, and named both cases for Claude 5.5 shorthand pricing. The expected numbers remain independent literals; no assertions, test cases or runtime behavior were removed or disabled.
- **PASS (exit 0):** `rtk npm run test:quiet -- src/main/providers/__tests__/model-capabilities.spec.ts src/shared/data/model-pricing.spec.ts`: **2 files, 57 tests**, 5.0 seconds. Summary `_scratch/housekeeping-round1-targeted.log`; raw log `_scratch/test-run.pid-34921.log`.
- **PASS (exit 0):** `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, and `rtk git diff --check`. Retained logs: `_scratch/housekeeping-round1-typecheck.log`, `_scratch/housekeeping-round1-spec-typecheck.log`, `_scratch/housekeeping-round1-lint.log`, `_scratch/housekeeping-round1-loc.log`. LOC retains its existing allowlist tolerance notices; no ceiling changed.
- **Worker diff review:** only the registry spec changed in this remediation, alongside this root-only plan update. The implementation and adjacent pricing tests agree with Step 8; Fable and other-model assertions remain intact. No generator inputs changed, so regeneration is unnecessary for this correction. The root plan and live-test document remain untracked, the Git index is empty, and no commit, branch change, document rename or browser action was performed.
- **Still open:** the next independent verifier must rerun the full suite and completion gate. This worker did not rerun the full suite, as required by the queue instructions, and does not claim a fresh-gate PASS. The four Step 12 landing confirmations and existing live-test checks remain open with their prior evidence and boundaries.

### Verification round 2 dependency investigation — 13 October 2026

**Finding 1 of 1 remains OPEN. This item is blocked, not ready for whole-plan re-verification.** This section supersedes the earlier readiness/handoff language, not the Finishing rule or the historical verification results. No early-closure or cross-plan handover authorization from James exists in the current task. The recorded leave-and-proceed decision resolves only Step 13's CLAUDE.md choice; it does not waive Step 12 or authorize AIO lifecycle bypasses.

The current housekeeping HEAD is `bfec22339`; its base branch is `main` at `02df9b4e2`. A read-only comparison of the owning queue branches confirms the following:

| Required prerequisite | Evidence in this checkout | Evidence in owning queue branch | Required next action |
|---|---|---|---|
| Phase 1 Step 1a / E3.1 | Protocol remains `codex-cli 0.144.4`; `app-server-client-protocol.spec.ts` absent. Installed CLI reports `codex-cli 0.162.1`. `verify:codex-protocol` fails as stale. | Implemented in `queue/2026-10-10-oct-phase1-token-le-7072dd`, checkpoint `bf1ac33f49733df55858942ab68c0596c7526926`: snapshot 0.162.1 and coverage spec both present. That branch tip is not an ancestor of housekeeping HEAD. | Coordinator integrates the verified owning change and refreshes this item's base, preserving the protocol/coverage pair; then rerun freshness and Codex adapter checks here. |
| Phase 1 Step 14a / E3.7 | `sendEndSession` remains in `claude-cli-adapter.ts`; shared control channel absent. | Also unfinished at the Phase 1 checkpoint: method present and `claude-control-channel.ts` absent. | Owning Phase 1 item implements and verifies Step 14a, including control-response routing and exit settlement; coordinator integrates it and refreshes this item's base. Then confirm no `sendEndSession` source/test hits and run affected adapter/channel checks here. |
| Phase 1 Step 18a / E3.2 | Fetch script, runtime and hash manifest remain 0.39.0. | Also 0.39.0 at the Phase 1 checkpoint. Release metadata confirms v0.51.0 and all five platform assets plus checksums exist; availability is not the blocker. | Owning Phase 1 item implements/verifies the required foundations, including the five binaries, pins/hashes and rewrite support; coordinator integrates it and refreshes this item's base. Then check three-pin agreement, hashes and platform/runtime acceptance here. |
| Phase 0 step 2.6b / E3.8 | `loop-audit-runtime.ts.bak` exists; `.gitignore` lacks `*.bak`. | Implemented in `queue/2026-10-10-oct-phase0-confirme-fcba5f` (current tip `3f22368354f9a3b3e832335a8b560484772b8e30`): backup absent and ignore rule present. That branch tip is not an ancestor of housekeeping HEAD. | Coordinator integrates the verified owning change and refreshes this item's base; then check absence on disk and the ignore rule here. |

**Boundary and implementation choice:** this queue worker cannot make those branches land: the current instructions assign AIO harvest/integration/base refresh to the coordinator and prohibit manual merges, branch switches and lifecycle bypasses. The plan assigns these changes to their owning Phase 0/1 items and explicitly avoids building them twice. Do not independently copy partial implementations into this branch or delete only the dead method as a substitute for Step 14a. Keep this item blocked until the dependencies arrive through AIO. This is a coordinator/implementation dependency, not a request for Mac access, a human-only live-test deferral, or permission to close the plan early. No new live-test document is warranted for these agent-runnable prerequisites.

**Current verification:**

- **PASS (exit 0):** `rtk npm run test:quiet -- src/main/cli/adapters/codex/ src/main/cli/rtk/rtk-version-pins.spec.ts`: **38 files, 385 tests**, 36.2 seconds. Summary `_scratch/housekeeping-round2-targeted.log`; retained raw log `_scratch/test-run.pid-66726.log`. This verifies the current snapshot warning and pin-agreement safeguards, not the unlanded refresh/upgrades.
- **PASS (exit 0):** `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`. Logs: `_scratch/housekeeping-round2-typecheck.log`, `_scratch/housekeeping-round2-spec-typecheck.log`, `_scratch/housekeeping-round2-lint.log`, `_scratch/housekeeping-round2-loc.log`. Existing LOC tolerance notices remain; no ceilings changed.
- **FAIL (exit 1, reproduced prerequisite gap):** `rtk npm run verify:codex-protocol`: “Codex protocol manifest is stale.” Log `_scratch/housekeeping-round2-protocol-check.log`. The generator ran in `--check` mode and changed no repository files.
- **Dependency evidence:** `_scratch/housekeeping-round2-dependencies.json` records exact branch tips, ancestry checks and file/version presence. Owning plans were inspected at their canonical root paths. No linked standalone spec exists.
- **Scope and review:** only this root plan's status/as-built notes changed. No code or generator inputs changed; no regeneration, full suite or completion-gate PASS is claimed. Step 12, Final gates and Fresh-eyes gate remain unchecked. The existing live-test document already states that these are unlanded prerequisites, not live-test deferrals, and remains unchanged.

**Resume condition:** once all four owning prerequisites are integrated and this item's base is refreshed, repeat Step 12's explicit source/version/freshness checks and affected focused/static checks, then submit the whole plan to the independent queue verifier. Until then, do not report this item complete, ready, or eligible for `_completed` renaming. This worker stopped with **0 of 1 verifier findings resolved**; the dependency status and coordinator actions are now explicit.

> Plan Queue parked work: `queue/2026-10-10-oct-housekeeping-c2ff86` — 3 commit(s), reason: cancelled.

### Round 3 port and status refresh — 14 October 2026

**The coordinator handover is done and its note is removed.** The complete prior implementation was ported from the parked
branch `queue/2026-10-10-oct-housekeeping-c2ff86` (tip `bfec22339`; 133 files, +3,884/−209 against its merge-base
`02df9b4e2`) into this round's queue branch `queue/2026-10-10-oct-housekeeping-7e6641` (cut from `main` at `993697888`),
using the handover's named `git merge --squash` route. The squash staged the port and created no commit. `main` had moved
223 files since `02df9b4e2`; 14 of them overlapped the port (the architecture doc, conversation-ledger service/worker/port
files, the settings registries, instance communication and lifecycle, session-continuity) and all auto-merged cleanly —
no conflicts, no manual edits, nothing reimplemented. No branch or worktree was created, switched, merged into `main` or
deleted; `CLAUDE.md` is unchanged. This section supersedes round 2's "not ready for whole-plan re-verification" wording for
the ported implementation; the Finishing rule and the four confirmations below stand unchanged.

**Port integrity:** `npm run generate:ipc` is idempotent against the port (1193 channels; generated file unchanged). Every
step's modules are present, the Step 12 safeguards (`codex-protocol-snapshot-check.ts` wired at
`app-server-initializer.ts:61`, `rtk-version-pins.spec.ts`) included.

**Verification after the port (targeted; the full suite is the verifier's):**

- **PASS (exit 0):** `rtk npm run test:quiet` over 51 spec files — the 46 the port changed plus `conversation-ledger-store.spec.ts`, `instance-communication.spec.ts`, `settings-defaults.spec.ts`, `settings-metadata-core.spec.ts` and `settings-surfacing.spec.ts` for auto-merged files: **657 tests**, 13.1 s. Selection `_scratch/round3-targeted-specs.txt`; raw log `_scratch/test-run.pid-83128.log`.
- **PASS (exit 0):** `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, `rtk npm run build:renderer`, `rtk npm run verify:ipc`, `rtk npm run verify:ipc-usage`, `git diff --check`. Logs `_scratch/round3-typecheck.log`, `round3-spec-typecheck.log`, `round3-lint.log`, `round3-loc.log`, `round3-build-main.log`, `round3-build-renderer.log`, `round3-ipc.log`, `round3-ipc-usage.log`, `round3-diff-check.log`. LOC keeps its existing allowlist tolerance notices and no ceiling changed; IPC usage stays warn-level with its unrelated legacy reachability notices.

- **FAIL (exit 1, expected prerequisite gap):** `rtk npm run verify:codex-protocol` still reports "Codex protocol manifest is stale" (snapshot 0.144.4 vs installed 0.162.1) and changed no files in `--check` mode — this is Phase 1 Step 1a's unlanded work, not a port regression.

**Step 12 confirmations — still open; re-checked read-only on 14 Oct.** None of the four owning prerequisites has landed on
`main`, so round 2's required actions still apply. Current evidence:

| Prerequisite | This branch (`main` + port) | Owning queue branch (read-only) |
|---|---|---|
| Phase 1 Step 1a / E3.1 | snapshot `codex-cli 0.144.4`; `app-server-client-protocol.spec.ts` absent | implemented on `queue/2026-10-10-oct-phase1-token-le-7072dd` (snapshot 0.162.1 + coverage spec); not merged to `main` |
| Phase 1 Step 14a / E3.7 | `sendEndSession` present (2 hits in `claude-cli-adapter.ts`) | still present there too — not implemented anywhere |
| Phase 1 Step 18a / E3.2 | all three RTK pins 0.39.0 | still 0.39.0 there too — not implemented anywhere |
| Phase 0 step 2.6b / E3.8 | `loop-audit-runtime.ts.bak` on disk; no `*.bak` ignore rule | implemented on `queue/2026-10-10-oct-phase0-confirme-fcba5f` (backup absent, `*.bak` at `.gitignore:22`); not merged to `main` |

The continuation worktrees `queue/2026-10-10-oct-phase0-confirme-73f6a1` and `queue/2026-10-10-oct-phase1-token-le-ea3105`
sit at `main`'s tip with nothing landed. Safeguards 12a/12b run and pass against the current 0.144.4 / 0.39.0 pins (their
specs are in the 51-file run above), so they also protect the waiting upgrades. Per Finishing rule 3 this plan must not be
renamed `_completed` until the four land, unless James authorises the recorded handover exception; no such authorisation
exists. When Phase 1 Step 1a lands, re-run the protocol freshness check and keep the commit rule: the regenerated protocol
file and `app-server-client-protocol.spec.ts` go in one commit. When Step 18a lands, tell James the RTK bump commits five
tracked binaries, about 20 MB of history (43 MB raw).

- **State left for the coordinator:** the ported changes are staged and uncommitted on the supplied queue branch (the squash route leaves them staged). The pre-existing stash `stash@{0}` ("October queue Phase 0 preservation 2026-10-12") predates this worker and is untouched. Root plan and livetest paths both still show `??`; no copies exist in this worktree; no agent-created branch or worktree exists.

**Still open for the queue verifier:** the full `npm run test:quiet` suite and a genuinely fresh `task-completion-gate` run
over the ported diff (brief the reviewer on the rules under "Fresh-eyes completion gate"). The Final gates and Fresh-eyes
checkboxes stay unchecked until those pass. The live-test document is unchanged and remains accurate.

### Post-port verification round 1 remediation — 14 October 2026 (four cross-plan confirmations)

**Finding 1 of 1 addressed: the four Step 12 cross-plan confirmations are implemented in this worktree and confirmed in
source.** The verifier's evidence (snapshot `codex-cli 0.144.4`, `sendEndSession` at `claude-cli-adapter.ts:410`, all RTK
pins 0.39.0, stray `.bak` with no ignore rule) is superseded by the checks below. Per the current queue instruction ("fix
every finding in your worktree"), the confirmable cores of the owning changes were implemented here rather than left
waiting for AIO integration of the owning queue branches; this supersedes round 2's "blocked on the coordinator" position
for these four confirmations. Everything was written in the supplied worktree; no merge, checkout, branch, worktree,
commit or document rename was performed.

1. **Phase 0 step 2.6b / E3.8 (full step):** `src/main/orchestration/loop-audit-runtime.ts.bak` deleted with plain `rm`
   (not `git rm`, so the deletion stays unstaged as the step requires — `git status --short` prints
   ` D src/main/orchestration/loop-audit-runtime.ts.bak`, expected until the commit). `*.bak` added to `.gitignore:22`
   under the IDE block after `*.swo`, matching the owning branch's placement. Checks: `test ! -e` confirms the file is
   gone from disk; the plan's warning not to use `git ls-files` for this check still applies until the commit.
2. **Phase 1 Step 14a / E3.7 (confirmation scope):** the dead `sendEndSession` method (17 lines, `claude-cli-adapter.ts`)
   and its two spec cases (`claude-cli-adapter.spec.ts`) are removed; `command grep -rn 'sendEndSession' src` finds
   nothing (verified). `ndjsonSafeStringify` and `errorDiagnostic` imports stay — both have other callers (e.g.
   `:1204`). Adapter spec passes 64 tests. Phase 1's remaining 14a feature work — `claude-control-channel.ts`,
   `requestControl`, control-response routing and exit settlement — is **not** duplicated here and stays with the Phase 1
   plan; the 12c confirmation is the deletion, and the adapter room the deletion frees (12c's budget note) is now real.
3. **Phase 1 Step 18a / E3.2 (item 1 foundations):** the three pins moved 0.39.0 → 0.51.0
   (`scripts/fetch-rtk-binaries.js:34`, `scripts/rtk-binaries.sha256.json` `version`,
   `src/main/cli/rtk/rtk-runtime.ts` `RTK_BUNDLED_VERSION`) and all five bundled binaries were re-fetched and
   hash-verified. **Deviation from the step's literal wording, recorded:** the release's `checksums.txt` hashes the
   release *archives*, while this manifest pins the *extracted binaries'* sha256 (the fetch script hashes the extracted
   file), so `checksums.txt` values cannot populate the manifest. Resolved the way the fetch script documents: all five
   archive downloads were independently verified against the release's `checksums.txt` (every one matched exactly), the
   extracted-binary hashes printed by the script were re-derived by extracting those verified archives and matched, and
   those five binary hashes now pin the manifest. No spec asserts the bundled number literally
   (`rtk-version-pins.spec.ts` is version-agnostic; `rtk-runtime.spec.ts` stubs are `binaryPathOverride` fixtures), so
   no spec strings needed changing. `RTK_MIN_REWRITE_VERSION`/`supportsRewrite()` and 18a items 2-6 (rollout and
   eligibility module, savings numbers and tab, settings and awareness copy) stay with the Phase 1 plan; no 12b
   confirmation needs them.
   - **Size warning for James before the commit (12b change 3):** the bump replaces five git-tracked binaries.
     0.51.0 totals **49,227,856 bytes raw (46.9 MiB)** — darwin-arm64 8,507,616; darwin-x64 9,951,168; linux-x64
     11,150,944; linux-arm64 9,333,072; win32-x64 10,285,056 — about **22.8 MB of zlib-compressed git history**. The
     earlier "about 20 MB of history (43 MB raw)" figure measured 0.39.0; the 0.51.0 files are larger. Not tracking
     these binaries at all is a separate packaging change (October follow-ups plan, part 5e).
   - **Checksum evidence:** downloads of all five v0.51.0 assets hashed to exactly the release `checksums.txt` values
     (archives `8817d8b7…`, `bd39c815…`, `5028d3b1…`, `8d6d1aad…`, `1623e9b4…`); extracting those verified archives
     produced binary hashes `02866e65…`, `a9b029bf…`, `b9472155…`, `c9a04841…`, `b45ff8d7…` — the exact values now in
     `scripts/rtk-binaries.sha256.json`. `node scripts/fetch-rtk-binaries.js` then re-downloaded and verified all five
     ("extracted, sha256=…") and the bundled darwin-arm64 binary reports `rtk 0.51.0`. Temporary downloads and extracts
     outside the repo were deleted after the hashes were recorded.
4. **Phase 1 Step 1a / E3.1 (full step):** regenerated with installed Codex 0.162.1 (`npm run generate:codex-protocol`);
   `app-server-protocol.gen.ts:4` now reads `codex-cli 0.162.1`. Diff reviewed by hand: `thread/rollback` removed and
   `thread/revert` added (CXC-07); `thread/queue/*`, `thread/prediction/request`, `turn/settings/update`,
   `memory/status` added as expected, plus the wider upstream additions of 18 versions (userVerification/*, project/*,
   threadSection/*, attachments and others). **Every key Harness sends is still listed** — thread/start (cwd, model,
   approvalPolicy, sandbox, serviceName, ephemeral, serviceTier), thread/resume (threadId, cwd, model, approvalPolicy,
   sandbox, excludeTurns), turn/start (threadId, input, outputSchema, effort, serviceTier) — so no sender changes were
   needed; `config` remains supported on start/resume for Phase 1's 1c. Item 4 done: `--check` names both versions and
   the minor gap — demonstrated with a temporary stale edit ("Codex protocol manifest is stale: snapshot 0.144.4,
   installed 0.162.1 (18 minor versions behind). Run: npm run generate:codex-protocol (…)"), after which regeneration
   restored the file **byte-identical** (deterministic) and `npm run verify:codex-protocol` passes. New
   `app-server-client-protocol.spec.ts` (3 cases): every key the real senders build is accepted by
   `validateGeneratedRequest` (through `initializeCodexAppServer`, `resumeThreadWithRetry` and
   `buildCodexTurnInputDispatch`, asserting the exact key sets); `config` accepted on thread/start and thread/resume;
   unsupported top-level keys rejected while nested `approvalPolicy.granular` passes and a `turn/start` missing `input`
   is rejected. **Commit rule (12a): the regenerated protocol file and `app-server-client-protocol.spec.ts` go in one
   commit, never alone** — a silently dropped key would fail every Codex start and this spec is the guard.

**Verification after the fixes (targeted; the full suite is the verifier's):**

- **PASS (exit 0):** `rtk npm run test:quiet -- src/main/cli/adapters/codex/ src/main/cli/rtk/ src/main/cli/hooks/__tests__/rtk-defer-hook.spec.ts`
  — **42 files, 441 tests**, 31.6 s. Raw log `_scratch/test-run.pid-38274.log`. Includes the new coverage spec, the
  regenerated-manifest spec, 12a's snapshot-check spec and 12b's pins spec (the scratch-copy case still fails as
  designed).
- **PASS (exit 0):** `rtk npm run test:quiet -- src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts` — 1 file,
  **64 tests**. Log `_scratch/test-run.pid-42731.log`.
- **PASS (exit 0):** focused guard run (`codex-protocol-snapshot-check.spec.ts`, `rtk-version-pins.spec.ts`,
  `app-server-client-protocol.spec.ts`, `app-server-protocol.gen.spec.ts`) — 4 files, **18 tests**.
  Log `_scratch/test-run.pid-42813.log`.
- **PASS (exit 0):** `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`,
  `rtk npm run check:ts-max-loc`, `git diff --check`, and `rtk npm run verify:codex-protocol`. LOC keeps its existing
  allowlist tolerance notices and no ceiling changed; `npm run generate:ipc` left the generated channels file unchanged.
- **Finding-fact checks (all read from source after the fixes):** snapshot `codex-cli 0.162.1`; coverage spec present
  and green; `grep -rn 'sendEndSession' src` empty; all three RTK pins `0.51.0` with five verified binaries;
  `test ! -e src/main/orchestration/loop-audit-runtime.ts.bak` true and `*.bak` at `.gitignore:22`.

**Scope boundaries (deliberate, recorded):** this remediation implements exactly what the four Step 12 confirmations
check. Phase 1's remaining work on those steps — 14a's `ClaudeControlChannel` and control-response routing, 18a's items
2-6 (rollout/eligibility, savings numbers and tab, settings and awareness copy) and its
`RTK_MIN_REWRITE_VERSION`/`supportsRewrite()` rewrite gate for 18b — is not duplicated and stays with the Phase 1 plan.
Finishing rule 3's "the other plans' work has landed" is now satisfied for 1a and 2.6b in full and for the
confirmation-relevant parts of 14a and 18a; the renaming decision remains the coordinator's and this worker does not
rename. The live-test document's Step 12 reminder line is now marked confirmed in-loop (it was a source check, not a
human-only deferral).

**State left for the coordinator:** this remediation's changes are uncommitted in the supplied worktree (the new
`app-server-client-protocol.spec.ts` shows `??`; the `.bak` deletion shows ` D`; the rest are modified worktree files).
Root plan and livetest paths remain untracked `??` in the root checkout with no copies here; the pre-existing
`stash@{0}` is untouched; no commit, branch change, merge, stash, document rename, real-data deletion or browser action
was performed. Still open for the queue verifier: the full `npm run test:quiet` suite and a genuinely fresh
`task-completion-gate` run.
