# October housekeeping live checks

**Status:** open. Code and scratch/headless verification are recorded in [the implementation plan](2026-10-10-oct-housekeeping_plan.md). These checks are not claimed verified.

**Prerequisites:** the queue coordinator must first integrate the verified work and build/restart Harness with this code on the machine under test. Screen checks use `windows-pc` through the AIO Browser Gateway after worker/browser preflight. Mac browser or desktop work requires James's permission for this task. Real data lives on the Mac; any real deletion/rebuild needs James present and his affirmative confirmation. Use scratch data for the restore experiment. Do not alter other sessions' settings, folders, branches or worktrees.

**Remediation flow:** read [the campaign runbook](livetest-campaign-runbook.md) before running checks. A reproduced defect gets a new LT-NNN index row and full section in [the remediation register](livetest-remediation-register.md), plus matching implementation status in `2026-07-19-livetest-failure-remediation-followup_plan.md` (resolve its current lifecycle filename first). Keep per-check dated evidence here. Never rename this document `_livetest_completed` until every open check passes.

**Current authorization and routing override:** the runbook's old standing Mac fallback text does not authorize Mac use. Follow James's 8 October rule. No browser or app check was attempted by the queue worker, and no worker-unavailability claim is made.

## Checklist and expected observations

- [ ] Step 1 / 4: real backup list and Cancel, with unchanged filesystem listing. Both July backup sets should appear with date, time and database-plus-content sizes. No backup deletion is a test step.
- [ ] Step 2: rebuilt-app debug setting off → Codex messages add no capture rows; toggle on without restart → rows appear; turn off afterward. Read `SELECT max(rowid) FROM provider_event_captures` using SQLite read-only mode before/after. The MiMo multi-account campaign's exact status/body/message evidence step requires this setting on first.
- [x] Step 3 synthetic 300,000-row rehearsal: verified in-loop; see evidence below. This is not a deferred check.
- [ ] Step 4: Settings > Doctor on the rebuilt app; compare disk rows against filesystem measurements, distinguishing estimates from exact file sizes. Review one target then Cancel/Escape/outside click; listings must remain unchanged.
- [ ] Step 4 real-data clear/rebuild: only James starts the actions after preview. Confirm recording off, clear or await normal expiry, rebuild, then read-only `PRAGMA auto_vacuum` is 2 and conversation file is under 5 GB. Check last messages in History so concurrent writes were retried without loss. Measure pause duration; the shipped dialog identifies its ~2-second figure as a 249 MB scratch trial and explicitly says the real file may take longer.
- [ ] Step 5: use a scratch user-data copy of session continuity and History, start a visible rebuilt app with James's Mac authorization where needed, select an old History entry, clean old saved records in that scratch copy, then attempt restore. Record whether restore works. Current wording omits the unverified History-preservation claim and says removal prevents restoring from these records.
- [ ] Step 6: compare the rebuilt card with `git worktree list`, Review then Cancel, verify branches and folders unchanged. Only after James confirms may an eligible merged folder be removed; never remove blocked rescue work as a test.
- [ ] Step 9: through approved worker tools, read `claude --version` on `windows-pc` and relevant workers. On >=2.1.268, new session spawn logs contain `--exclude-dynamic-system-prompt-sections`; below it the flag is absent, and a resumed pre-2.1.267 session retains Harness instructions. Local stub/adapter cases already passed.
- [ ] Step 10: on a rebuilt-app routed Claude session, confirm the snapshot source is `header` after a reply and a completion inside ten minutes starts no endpoint request. Without an account route the endpoint path still runs. Stubbed 429/header cooldown checks passed in-loop; optionally collect warning logs over a week.
- [ ] Step 11: ask Claude for a 90-second `ScheduleWakeup`; immediate notice says “asked”, then observe whether a turn really starts at +90s. Repeat closing first; transcript must retain the pending-wakeup warning once. No off switch is added and no successful firing is inferred.
- [x] Cross-plan confirmations for Step 12: confirmed in-loop on 14 Oct (source checks, not live tests) after the owning changes landed in the queue branch — protocol snapshot 0.162.1 with `app-server-client-protocol.spec.ts` coverage, all three RTK pins 0.51.0 (five binaries hash-verified), no `sendEndSession` source/test hits, stray `.bak` absent with `*.bak` ignored. Evidence in the plan's "Post-port verification round 1 remediation" notes. Safeguards 12a/12b pass against the new pins.

## Synthetic evidence — 13 October 2026

Scratch rehearsal used Electron in Node mode, with no window and no real data. 300,000 captured rows; 270,000 deleted in 14 bounded calls. Database size 2,482,974,720 → 248,565,760 bytes. Rebuild 1,653 ms (round trip 1,660 ms). Peak extra free-disk use 501,600,256 bytes sampled every 5 ms; guard required 1,570,947,072 bytes. Mode changed 0 → 2, integrity check passed. A concurrent conversation write forced a 20 ms test timeout, then retry persisted exactly one message; production ordinary timeout remains 10 seconds and rebuild 15 minutes.

Retained evidence is under the queue worktree `_scratch/ledger-rehearsal/evidence.json` and `run.log`, with rehearsal sources/bundles. The generated 249 MB temp database was removed after evidence was retained. The synthetic check is complete and must not be treated as a deferred live test.

## Original detailed steps transferred from the plan

## Step 1. E1d: Learning-database backups: name what would go, delete only on a tick (S)

**Live checks:** none for the window itself. It cannot be opened on the real data until the database nears 10 GB, so the
headless component spec is the check. The same backup list is reachable at any size through Step 4's card (the "Learning
database backups" row), which is where the real folder is first checked: both July backups listed with the dates and sizes
above, then Cancel, then `ls` of `rlm/backups` is unchanged.

## Step 2. E1a: The detailed debug record becomes opt-in (S)

**Live checks:** (needs a rebuilt app; Windows PC, or the Mac only with James's OK.) With the switch off, start one Codex
session and send two messages: `SELECT max(rowid) FROM provider_event_captures` (read-only, `mode=ro`) is unchanged. Turn the
switch on without restarting and send one more message: the number rises within seconds. Turn it off again.

## Step 3. E1b: Let the conversation file shrink (S-M)

**Live checks:**
- **Synthetic rebuild (an agent can do it; no app).** Create a scratch ledger with 300,000 captured rows, delete most, run the
  rebuild, and confirm the size drop and that a conversation write attempted during the call is retried afterwards. **Record
  how long the rebuild call took and how much free disk it used at its peak.** Step 4b's dialog uses the measured time, not
  a guess, and the free-space guard is checked against the measured peak.
- The real-data rebuild is part of Step 4's live check and needs James present.

## 4a. The numbers, and the rule that a delete needs a preview (S-M)

**Live checks:** in 4b.

### 4b. The card in Settings > Doctor (S-M)

**For James:** Settings > Doctor gets a "Disk space used by Harness" card. It lists each store in plain words with its size, a
quiet "can be given back" amount where there is one, and a "Review and clean up" button for the four things that can be
cleaned. The window that opens says what will go, how much, what stays and whether it can be undone, and Cancel is the
default. When more than 10 GB could be given back, one quiet line at the top of the card says so. No pop-up, no banner.

**Change:**
1. **New standalone `src/renderer/app/features/settings/storage-usage-card.component.ts`** (OnPush, signals, `inject()`),
   placed first in the Doctor tab: add the tag and one import in `doctor-settings-tab.component.ts` and nothing else. It
   reads and acts through a small signal store, `src/renderer/app/core/state/storage-usage.store.ts`, that wraps the new
   preload calls (the pattern of `rlm-storage-maintenance.store.ts`); the card never calls `window.electronAPI` itself.
2. **Rows** use the plain names in the table above. Self-managed stores show "Harness tidies this itself" and no button. Names
   avoid "RLM" and "ledger". The card's own title is "Disk space used by Harness" (not "Storage": see ground rule 6).
3. **The window.** Proposed wording. All of it says Harness. The numbers are examples: the window shows the preview's numbers,
   with proper plural and number formatting.
   - Clear now: heading "Clear the debug record?". Body: "This removes the detailed debug record of AI messages: about 4.9
     million entries from 9 Sep to 10 Oct, about 33 GB. Harness does not use it. Developer scripts that replay captured
     messages will find nothing until you switch the record on again. This cannot be undone. The conversation file stays the
     same size until you also choose Shrink the file." Buttons: "Keep it" (default), "Clear the debug record".
   - Shrink the file: heading "Shrink the conversation file?". Body: "Harness will rebuild the conversation file to give back
     about 30 GB of disk space. While it runs, usually about {measured time} (Step 3's rehearsal measures it; do not ship the
     words "about a minute" unless it did), Harness cannot save new conversation records; your sessions keep running and the
     records are saved afterwards. It needs about 6 GB of free disk for a moment. Nothing in your conversation history is
     removed." Buttons: "Not now" (default), "Shrink the file". The free-disk figure is the guard's own number (twice the live
     size plus 1 GB) taken from the preview, so the sentence and the guard cannot disagree.
   - Learning database backups: heading "Delete older learning database backups?". Body: "These are copies Harness made before
     earlier clean-ups: 12 July 2026, 12:32, 14.1 GB. Your newest backup (12 July 2026, 18:05, 11.7 GB) stays. Deleted backups
     cannot be brought back." Buttons: "Keep them" (default), "Delete the older backups". Sizes include each backup's content
     folder, as in Step 1.
   - Every window shows the numbers from the preview, not from the row. Cancel, Escape and a click outside run nothing. Focus
     lands on the window, not on the destructive button.
4. **The top line.** When the "can be given back" total (defined in 4a) is over 10 GB, the card's first line reads "Harness
   can give back 52 GB of old files; the biggest part takes two steps. Review below." (plain text, not a toast or banner). The
   total counts the debug record's whole estimated size, which only returns to the disk after "Clear now" and then "Shrink the
   file", so the line says so. It is also the visible statement of the consequence that no tooltip may be the only home for.
5. **Progress.** While a clean-up runs, the card asks for the numbers every 2 seconds, bypassing the 60-second usage cache (see
   4a), and shows "Removed 1.2 million of 4.9 million entries" (no new push event is added).
6. **Tooltips** use `appTooltip` with `TOOLTIP_COPY`; no `title=`. A tooltip is never the only place that says what a clean-up
   removes: the window states it.

**Tests:**
- New `storage-usage-card.component.spec.ts` (headless, seeded): "Cancel runs nothing"; "Escape runs nothing"; "the window names
  the size and the consequence for each target"; "the destructive button is not focused on open"; "the top line appears only
  above 10 GB, is plain text and mentions the second step"; "self-managed rows have no button"; "progress is read from the
  running clean-up, not the cache"; "no `title=` attribute".
- `doctor-settings-tab.component.spec.ts` (exists): the card renders.

**Risks:**
- A destructive button sits next to size numbers that can be wrong by a few per cent (they are cached for 60 seconds). The
  window shows the preview's numbers, and the server re-lists at run time.
- Cost: none.

**Done when:**
- The card lists the ledger, learning-database backups, saved session records (Step 5), session activity logs (Step 5) and the
  self-managed stores, each within 5% of `du`.
- A clean-up cannot run without a preview, and Cancel leaves every file unchanged (compare a file listing before and after).
- After the old rows have aged out (or been cleared with a yes) and the one-time rebuild, the conversation file is under 5 GB
  and `PRAGMA auto_vacuum` reads 2.
- The canonical gates and `npm run verify:ipc` and `npm run verify:ipc-usage` pass.

**Live checks:** (need a rebuilt app; Windows PC for the screen itself, or the Mac only with James's OK. The real data lives on
the Mac, so the real-data checks below happen there, with James's OK and James present.)
- **Screen check (any machine):** open Settings > Doctor, compare each row with `du`, press "Review and clean up" on one row and
  Cancel. The folder listing is unchanged afterwards.
- **Real data (needs James's yes and a restart; never without James watching).**
  1. Confirm the Step 2 switch is off.
  2. Wait until the daily sweep has aged out the old rows (about 30 days), or use "Clear now" with a yes.
  3. Press "Shrink the file" and note how long Harness paused saving conversation records (compare with Step 3's measured
     rehearsal time).
  4. Check the file with `ls -l`: under 5 GB, and `PRAGMA auto_vacuum` (read-only) reads 2.
  5. Confirm that a conversation write during the rebuild was retried, not lost (the session's last messages are in History).
- **Backups row (James's yes first):** the row lists both July backups with the dates, times and sizes in Step 1. Press Review, read
  the window, and Cancel. `ls` of `rlm/backups` is unchanged. Deleting the older backup is James's call, not a test step.

## Step 5. E1e: Saved session records and session activity logs (S-M)

**Live checks:** (need a person and a rebuilt app; on a scratch copy of the data folder, never the real one. The data to copy
lives on the Mac and the copy must be started in a visible app, so this happens only with James's OK.)
- **Saved-record restore.** Copy `session-continuity` and the History data into a scratch user-data folder and start Harness on
  it. Pick a History entry older than 30 days, run the "Saved session records" clean-up there, and see whether "restore" still
  works. Record the result in the livetest doc; it decides the dialog sentence.
- On the real Mac data, James decides whether to run either clean-up, after reading the numbers.

## Step 6. E2: Leftover work folders: a report that asks before anything is removed (S-M)

**Live checks:**
- **Scratch repo (an agent can do it; no app):** create a repo with one merged and one unmerged worktree, and drive the preview
  and run calls from a spec or script.
- **In the app (needs a rebuilt app; Windows PC, or the Mac only with James's OK):** open Settings > Doctor, check the card
  against `git worktree list`, press Review on one row and Cancel. Then, with James present and after his yes, remove only the
  merged folder `task-please-work-through-all-the-li-mu4ui30h`, after Phase 0's Close has ended its run (it may already be gone;
  see above). Never remove any of the eight blocked folders as part of a test.

## Step 8. E3.4: Claude 5.5 prices (S)

**Live checks:** none needed. The price table is checked by the unit specs above.

## Step 9. E3.3: Claude version checks (S)

**Live checks:** read `claude --version` on `windows-pc` and any other worker, through the approved worker route.
- If one is 2.1.268 or newer, run one session there and check the spawn log shows `--exclude-dynamic-system-prompt-sections`.
  This proves the worker route reads the version.
- If one is below 2.1.268, run one resumed session there and confirm Harness's instructions still apply: ask it for its role
  line.

## Step 10. E3.9: Quota refresh hygiene (S)

**Live checks:** (needs a rebuilt app and a session on an account profile; Windows PC, or the Mac only with James's OK.) After
one finished reply, the Claude snapshot's source reads `header`, and the next `'complete'` within 10 minutes starts no
endpoint request. In a session with no account route the source stays `admin-api` (what the usage-endpoint probe sets,
`claude-usage-endpoint-probe.ts:194, 320`) and the refresh still happens. Optionally, watch `app.log` for a week for the new
warning line.

## Step 11. E3.10: Claude's self wake-ups, shown and counted (S-M)

**Live checks:** needs a rebuilt app and a person (Windows PC, or the Mac only with James's OK).
- Start a Claude session and ask it to call `ScheduleWakeup` for 90 seconds. Then check:
  - (a) the line appears straight away;
  - (b) whether a new turn starts by itself at +90 s;
  - (c) what happens if the session is closed first.
- Result (b) decides whether wake-ups are real inside Harness. If they fire, the line's wording can later say "scheduled"
  (that wording change is not part of this step).

## 12a. E3.1: say so when Harness's Codex protocol record falls behind (XS)

**Live checks:** none beyond Phase 1 Step 1a's (one new and one resumed Codex session reach their first reply).

## 12b. E3.2: check that the three RTK version settings agree (XS)

**Live checks:** none (Phase 1 Step 18a has its own: a real RTK-enabled Claude session, and the Windows binary on the Windows
PC).

## Step 13. CLAUDE.md: the options (XS; your choice)

**Live checks:** before option 2, read `claude --version` on `windows-pc` and any other worker, through the approved worker route.
No browser is involved.
