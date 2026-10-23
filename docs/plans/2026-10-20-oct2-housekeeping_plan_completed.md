# Oct-2 housekeeping: storage, versions, RTK, observation memory, and two research habits

## Status

Worker implementation ready for independent verification; not integrated or completion-gate approved.
All 20 implementation checklist entries are covered; see `2026-10-20-oct2-housekeeping_history.md` for the as-built
mapping, choices and evidence. Resume revalidation 23 October: 52 files / 441 tests, both type-checks, lint, LOC,
main/renderer builds, IPC verification and protocol freshness passed. Verifier round 1 failed two test gates, both
fixed in this worktree: the MEM-4 prompt fixture now opts in to observation memory explicitly (a new test pins the
opt-out default), and the Wake tombstone normalizer moved into `wake-context.types.ts`, keeping the context worker
closure at its audited 155 modules (guard-parser measurement; ceiling and assertions unchanged).
Post-fix targeted: 223 files / 3,436 tests, both type-checks, lint and LOC pass. The 23 October `main` merge resolved
four intent-preserving conflicts and one merge-surfaced `typecheck:spec` gap (details in history).
Decisions 9/10/11/14 follow (a); Windows `core.symlinks=false` selects the one-line instruction import fallback.
Live checks require the safely rebuilt/restarted app and, for real deletions, James’s click-time confirmation; see
`2026-10-20-oct2-housekeeping_livetest.md`. The worker did not run the full suite (queue instruction), restart Harness,
commit, stage, rename documents, or clean James’s real data. Coordinator owns the full suite, independent gate,
integration and completion renaming. No code implementation items remain open.

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items K4 (item 1 is in Phase B), K5, K6, K8, K9,
K10. **Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) · [B](2026-10-20-oct2-phaseB-land-built-work_plan.md)
· [C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) · [D](2026-10-20-oct2-phaseD-tokens_plan.md) ·
[E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · [F](2026-10-20-oct2-phaseF-tooltips_plan.md) · housekeeping (this) ·
[later](2026-10-20-oct2-later_plan.md) · [decisions](2026-10-20-oct2-decisions-for-james_completed.md).

## In plain English

Harness's data folder grew about 40 GB in nine days, to about 130 GB, plus 64 GB in the Codex store. About 105 GB can come
back safely, most of it with one yes from James. CLI updates James opted into never apply, because Harness skips them while
any session exists. The RTK Savings tab blocks the app for seconds. Observation memory records everything and almost never
helps. Two habits save the next research round from repeating this one.

## Ground rules

1. **Read first**; line numbers are from 20 Oct; trust names.
2. **Every deletion asks James first,** at click time, showing what and how much. Nothing is deleted by a migration or a
   start-up sweep without a setting James can see and has agreed to (the Codex backup keep-3 rule in Phase B Step 6 is
   such a setting, off until Decision 19). Two automatic clean-ups are agreed exceptions, each logging what it removes:
   sweeps of Harness's own leftover temporary folders (Step 1 item 5), which are not James's data; and removing
   observation-memory rows already past their own expiry date (Step 1 item 2), which every answer to Decision 9 includes.
3. **Never touch OpenCode's own database** (28 GB, shared with OpenCode desktop) from Harness.
4. **Current checkout only;** no branch or worktree; never stage, revert or stash other sessions' files; commit only when
   James asks. Never write to James's databases from a script.
5. **No browser or desktop app on the Mac;** eyes-on checks go to the livetest document (Windows PC; if it is down, stop and tell James, never fall back to the Mac).
6. Keep the Status block under about 1,500 characters.

**Settings keys:** `settings.types.ts` has about 4 lines of room (885/889): every new key in this plan goes in a separate
settings-types module that the main settings type extends, never in that file.

## Step 1. K4: storage

Sizes on 19 Oct (binary GB): conversation ledger 48.3 (capture stopped 17 Oct; shrinks only with a rebuild, possible from
about mid-November); RLM 33.8, of which the two 12 July backups are 24.1; Codex backups 40.7 in 443 copies (Phase B Step 6);
Codex sessions 23.4; code index 12.7 (22 of 34 roots are plan-queue worktrees); conversation evidence 8.0; session states
7.2; observation memory 0.4 inside RLM; 4,522 leftover `codex-nomcp-*` temporary homes; nine clean September task worktrees
7.8.

1. **Code index:** stop indexing sessions whose folder is under `.worktrees/` by default; index such a folder lazily only
   when a code-search tool is called there (safer than mapping it to the parent's index, which is stale for exactly the files
   a worker changes). Delete a worktree's index when the queue removes the worktree. Exempt roots James opened himself from
   the 10-root eviction (`maxWorkspaces: 10`, `index-worker-main.ts:408`).
2. **Observation memory clean-up** (after James has answered Decision 9, since every answer includes it): call
   `ObservationStore.applyDecay()` (`observation-store.ts:261-295`; its only caller
   today is an IPC handler the page never calls, `observation-ipc-handler.ts:130`) at start-up and daily. Whether to keep the
   feature at all is Step 5.
3. **Ledger shrink:** a one-time "Shrink now (frees about N GB)" on the Storage page once the ledger passes half free pages.
4. **Session states:** cap the size of new state files, and offer on the Storage page (asking at click time, like item 7)
   to remove states for sessions that are no longer in history.
5. **Temporary Codex homes:** sweep leaked `codex-nomcp-*` folders hourly, not only those older than a day at start-up.
   First confirm which code creates them (likely spec runs); if tests leak them, fix the tests' clean-up instead.
6. **Old work folders:** a safe clean-up listing each `.worktrees/task-*` and stale queue folder with age, size, clean or
   dirty state, unpushed commits and a live-process check. Archive dirty ones to a git ref before removing, offer Restore,
   always ask.
7. **The July RLM backups (24 GB):** the Storage page can already remove them; offer it with one sentence (Decision 14).
8. **Storage page** shows total size and weekly growth.

## Step 2. K5: versions

1. **CLI auto-update never applies** because it skips while any instance exists, idle and hibernated included
   (`cli-auto-update-service.ts:155-162`, count wired at `late-runtime-initialization-steps.ts:346`); 7 skips, no update
   applied. Count only sessions that cannot be interrupted (busy, or holding a pending approval), keep the "safe installer"
   filter, and show "Update waiting: 2 sessions are mid-turn" in the pill.
2. **Claude CLI floor table** in `claude-cli-feature-probes.ts` (today only two minimum constants): 2.1.300 for resumed
   sessions, 2.1.299 for side questions, 2.1.302 for tool-search cache stability; shown in plain words for remote computers.
3. **Copilot floor:** 1.0.100 (shared with Phase C Step 11's warning; one constant).
4. **Codex watch:** a compressed rollout (`.jsonl.zst`) would vanish from session lookups (`codex/session-scanner.ts:114`
   accepts only `rollout-*.jsonl`): accept `.zst` or pin compression off. Regenerate the protocol snapshot on every CLI bump
   (installed 0.163.0, snapshot 0.162.1).

## Step 3. K6: RTK

1. **The Savings tab blocks the main process** for the length of its queries (about 1.5-2.7 s warm, 5-6.5 s cold): full-table
   synchronous queries over James's 862 MB RTK history (`rtk-tracking-reader.ts:274-424`, called from
   `rtk-handlers.ts:61-75`). Default the tab to 7 days, run the reader in a worker, keep a small incremental daily roll-up,
   and show the last result at once with "Refreshing…".
2. **The next RTK version is a licence choice** (Decision 10): 0.52.0 (last all-Apache) or 1.x `rtk-oss`. Ship the licence
   file beside each bundled binary (`scripts/fetch-rtk-binaries.js`) either way; today none ships.
3. **A `git cat-file` burst** (about 3,000 calls an hour in work-finding on 16 and 19 Oct): a notice when one project calls
   RTK more than about 2,000 times an hour.

## Step 4. K10: Copilot reads this repository's AGENTS.md twice (Decision 11)

If James says (a): make `CLAUDE.md` a link to `AGENTS.md` and move its `@docs/angular-conventions.md` import into
`AGENTS.md`. Check first that the Windows PC checkout supports symlinks; if not, use a one-line `CLAUDE.md` that imports
only `AGENTS.md` and test whether Copilot still de-duplicates. Separately, after Phase A's restart, check that Harness's
instructions now reach Copilot's first message (0 of 1,238 did before the 18 Oct fix).

## Step 5. K8: observation memory and the Wake page

1. **Observation memory** (Decision 9): 48.5K observations and 8.7K reflections, 88% and 58% past their own expiry; only 20
   different reflections have ever been injected (773 injections between them); promotion is checked only at creation, when
   usage is 0 (`reflector-agent.ts:125-146`, created with `usageCount: 0` at `:266`), so it needs a re-check after injections
   (`recordInjection`, `observation-store.ts:234-238`) if the feature stays. Stop capturing queue, loop and scheduled
   sessions under every answer. Then follow Decision 9: (a) switch the feature off by default through a settings
   migration, run the clean-up, and hide its page and its prompt block; (b) keep it on, run the clean-up daily, and add
   the promotion re-check after each injection; (c) keep it on with only the clean-up and the machine-session rule.
2. **The Wake page:** 877 notes, 368 distinct; 553 legacy rows not shown since 3 May; "used: Nx" counts shows. Hide legacy
   rows and duplicates behind a "Hidden" tab, relabel "used" as "shown", add a one-line summary ("877 notes, 368 different,
   206 shown this week"), and add a tombstone so a removed note is never re-added by the miner.

## Step 6. K9: two research habits

1. `docs/decisions/rejected/<topic>.md`: a stance, the reason and a reopen condition per rejected idea, seeded from both
   October lists' "considered and rejected" sections; one AGENTS.md line: "Before proposing a feature or starting a research
   sweep, read docs/decisions/rejected/."
2. A read-only measurement kit under `scripts/audit/` (the context-ceiling replay, the composition scan, the polling scan),
   each header carrying the rules: label figures observed or modelled; print coverage first; at least three repeats; ±3% is
   noise; exclude research-sweep sessions; de-duplicate by message id; report the read, write and output mix beside any
   ratio.

---

## As-built handoff

1. Storage uses lazy worktree indexing with worker retirement/retry cleanup, conservative project-root retention, confirmed half-free-page ledger shrink, bounded state files and History-aware cleanup, owner-safe hourly temp maintenance, archived work-folder recovery, backup offers and measured totals/growth.
2. Versions use interruption-aware updates and waiting pill, shared CLI floors, compressed Codex rollouts and build-time protocol refresh.
3. RTK reads run off-main with incremental daily cache, seven-day view, last-result refresh, burst notices, pinned 0.52.0 binaries and packaged Apache licences.
4. CLAUDE now imports only AGENTS; Angular import moved into AGENTS. Windows probe and installed Copilot 1.0.100 instruction-source inspection recorded; restarted Harness first-message check is live-only.
5. Observation memory migrates OFF, machine capture is excluded, expiry cleanup remains scheduled; Wake has Hidden rows, shown summaries and miner tombstones.
6. Rejected stances/reopen conditions are seeded from both October lists; the normalized read-only audit kit enforces research measurement rules.

The implementation choices and their limits are recorded in history. Live steps are in the linked livetest document.

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`), summaries in the history file; fresh-eyes completion
gate (a new agent using the `task-completion-gate` skill), repeated with another new agent until `VERDICT: PASS`.

## Live checks

`2026-10-20-oct2-housekeeping_livetest.md` (standard header): the Storage page's offers and their freed bytes; a CLI update
applying with idle sessions open; the Savings tab opening without a stall.

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-housekeeping-e77162` — 1 commit(s), reason: verifier-unreliable.

Resume note (23 October): continued from checkpoint `c50f4e0c2`, based on `542f1f690`.
The existing seal matched all 154 deliverables; generators produced no tracked changes.
Fresh command receipts and logs are retained under the existing commands receipt and
worktree `_scratch/oct2-resume/`. A fresh `task-completion-gate` review found no actionable defects
and independently passed 7 files / 53 tests; its final verdict is deferred pending the coordinator's
full suite. Final acceptance and completion renaming remain with the queue verifier/coordinator.
