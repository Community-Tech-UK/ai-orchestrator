# Spec: Plan Queue jobs on other computers

**Status:** Approved by James, 8 November 2026 (both questions answered, below); built on 11 November 2026 on the queue branch and waiting for the independent check, with the live checks in the plan's livetest document. This is step C.1 of
[2026-11-08-agent-sessions-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-agent-sessions-on-other-computers_plan.md),
the option that plan recommends first.
**Plan:** [2026-11-08-plan-queue-jobs-on-other-computers_plan_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-plan-queue-jobs-on-other-computers_plan_completed.md).

## In plain English

A Plan Queue job would do its work on the Windows PC and finish on this Mac exactly as it does now. Harness sends the
job's starting code to the PC, the agent works there, and after each turn of the agent's work there Harness copies
the changed files back into the job's folder on this Mac, then saves them here exactly as it does now. Checking,
landing and moving `main` stay here and don't change. The job's plan, which today the agent edits in place on this
Mac, goes out with the code and its edits come back the same way. If the PC drops out, the job carries on here from
the last saved point.

## James's decisions (8 November 2026)

1. **Which computer runs the jobs first? James: the Windows PC.** The test Mac would be easiest: same kind of computer, and it already
   builds and tests this project. But you decided it holds no sign-ins, and an agent needs one. The Windows PC has the
   sign-ins (once you've done step A.1), but each project then needs its tools installed and working on Windows,
   which nobody has tried for this project yet. **My recommendation: the Windows PC,** with a first step that checks one
   project builds and tests there, before any job is sent. Say if you'd rather allow a sign-in on the test Mac. (The
   PC's Linux space, where tests already run, would need the Linux worker this plan leaves out.)
2. **May the job's plan be replaced on this Mac when the job's copy comes back? James: yes,** as recommended. The
   question as put: if you haven't changed it here
   meanwhile. Today Harness never replaces a planning file the agent leaves; it saves a second copy beside it,
   because "check it hasn't changed, then write" can't be made perfectly safe. Harness already changes your plan this
   way when it trims it or adds a note: it moves the old version aside to a hidden file
   (`.<name>.aio-retained-<id>`) and keeps it for a week, on purpose, so that an edit an editor was still saving into the
   old file at that moment is never lost. There are about 80 in `docs/plans` now. Copy-back would add one per changed
   document per round. **My recommendation: allow it for the documents the job was sent with,** writing only when the
   job's copy actually differs, keeping a second copy whenever yours has changed, and keeping the hidden files as
   Harness does today. The queue's hourly sweep deletes them a week after their last change
   ([2026-11-11-plan-queue-retained-copy-sweep_plan_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-11-plan-queue-retained-copy-sweep_plan_completed.md)).

Everything else below was stated as decided, and stands. One of those decisions: a job on the PC gets no
Harness tools in the first version (none reach other computers today); the report its agent would send through one
comes back as a file instead, so nothing is lost (see "The report" below). Harness's other tools, such as browser
work through the Browser Gateway, aren't there either; Harness can't tell in advance which plans need them, so a
queue run can be kept on this Mac when it starts (below).

## What exists today (checked in the code on 8 November)

- **A job runs only here.** The worker session is started with the job's folder and no computer
  (`src/main/plan-queue/plan-queue-item-flow.ts:298-309`); the checker (`plan-queue-checker-spawn.ts:41-52`) and triage
  (`plan-queue-triage.ts:145-152`) likewise. Routing (`queueWorkerChoices` and `routeQueueSpawn` in
  `plan-queue-routing.ts`, from `:386`) picks provider, model and accounts only; nothing in `src/main/plan-queue` sets a
  computer, so `resolveExecutionLocation` always answers "here".
- **The coordinator saves the work, not the agent,** and saving does more than commit. `checkpoint`
  (`plan-queue-worktree.ts:233-279`) puts a checkout an interrupted landing left detached back on its branch
  (`recoverLeftoverUnqueued`, `:487`), trims the plan document (`dietAtCheckpoint`), refuses while a merge is still
  conflicted (`UnresolvedMergeError`), moves planning files to the main checkout so they never reach a commit
  (`movePlanningFiles`, `:285`), and only then runs `git add -A` and `git commit --no-verify --no-gpg-sign`. Checks, the base
  comparison, merging the base in, the squash commit and moving `main` all read that local folder
  (`plan-queue-landing.ts:77-103`, `:237-295`; `plan-queue-squash.ts:234-261`; `worktree-integration.ts:471`, `:519`).
- **A queue session on another computer is already guarded against pushing:** Harness sends `queuePushGuard` and the
  worker builds the guard from its own repository (`instance-lifecycle.ts:827-839`, `src/main/cli/adapters/remote-queue-push-guard.ts:24-32`,
  `src/worker-agent/local-instance-manager.ts:326`).
- **The agent edits its plan where it lives, on this Mac.** The worker prompt names the document's absolute path in
  the main checkout and says never to copy it into the job's folder; every other planning document is edited at its
  absolute path there too (`plan-queue-prompts.ts:61-64`). `dietAtCheckpoint` trims that same file
  (`plan-queue-plan-diet.ts:362`), and the checker reads it. A planning file found in the job's folder is moved to the
  main checkout, never replacing one already there: a different copy is saved beside it as
  `<name>.from-queue-<item>.md` (`plan-queue-planning-files.ts:1-20`).
- **A session on another computer gets no Harness tools:** `getMcpConfig` gives remote sessions none
  (`src/main/instance/lifecycle/spawn-config-builder.ts:126-128`), `getHarnessCliEnv` none either (`:236`), and
  nothing in `src/worker-agent` relays them. The worker prompt asks for a report through `plan_queue_report_ready`
  (`plan-queue-report-prompts.ts:8`, `:20-21`), but no AI tool has to send it yet: `REPORT_REQUIRED_PROVIDERS` is
  empty (`plan-queue-worker-report.ts:28`), `afterTurn` answers `ok` without a report (`:77`), and the job is saved
  and handed over when the turn ends (`plan-queue-item-flow.ts:404-420`). But a plan job can't pass without it when it
  leaves any check for a live test: the checker's PASS is turned into a FAIL for every deferred check the report
  doesn't list (`deferredPassProblems`, `plan-queue-deferred-checks.ts:113-125`, called from
  `plan-queue-verification.ts:147-148`), and the fix it asks for is a `plan_queue_report_ready` call.
- **A new job folder here gets its setup from the main checkout, not an install.** It is made by
  `WorktreeManager.createWorktree` (`plan-queue-worktree.ts:155`), which first copies the main checkout's local
  settings files (`copyConfigFiles`, `worktree-manager.ts:193`, `:220`: `.env.local`, `.env.development.local`,
  `.env.*.local`, `docker-compose.override.yml`, from `worktree.types.ts:180`), then links what `.worktreeinclude`
  lists from the main checkout, which in this repository is `node_modules` (`installDependencies`, `:260-280`). Only
  if that gives no dependencies does it fall back to `provisionWorktreeDependencies` (`:284`; a reattached folder
  goes straight there, `plan-queue-worktree.ts:207`): a copy-on-write clone of `node_modules`
  (`worktree-deps.ts:163-221`), then a plain copy, then Node's own copy, and a real `npm install` only as a last
  resort, with a 5-minute limit (`:224-233`). The untracked files that leaves are recorded and kept out of every
  save (`workPathspec`, `plan-queue-worktree.ts:451-455`).
- **The worker is told to read the plan's linked spec and update its as-built notes** too (`plan-queue-prompts.ts`, the worker prompt's
  rules and task). A live-test job builds and launches the dev app on this Mac (`buildLivetestWorkerPrompt`).
- **Harness already edits the plan in place when it has to,** with a check that the file is unchanged first
  (`changeDocumentFile` and `assertDocumentFileUnchanged` in `plan-queue-document-mutation.ts:39-51`): the trim, and
  the parked notes (`appendParkedNote`, `removeParkedNote`, `plan-queue-doc-close.ts:471-488`).
- **A session's folder goes to the other computer unchanged** (`src/main/cli/adapters/remote-cli-spawn-params.ts:21`), and the worker refuses any
  folder outside its list (`worker-instance-spawn-validation.ts:43-64`). Nothing on a worker creates a git worktree.
- **Test runs already send code safely,** but over SSH: `snapshot.js` makes a commit in a temporary object store, and
  `scripts/remote-checks/run-remote.js:86-105` streams `git pack-objects --thin` into `remote-run.sh receive`, which keeps it in a bare
  repository on the far side. On the PC that far side is its Linux space, a different disk and a different git from
  the Windows worker that runs sessions.
- **The worker's folder sync can't carry a repository:** it skips `.git` and symlinks (`security-filter.ts:28-32`,
  `directory-scanner.ts:87`), so commits don't travel.

## Design

### Which jobs can go

Plan jobs only. A live-test job stays on this Mac: it builds and runs the dev app here. Checker and triage sessions
stay here in the first version; the checker reads the copied-back folder.

### Out: the job's code reaches the other computer

- The job's folder on this Mac is still made first, as now, and stays the job's real home: checks, landing and crash
  recovery keep working on it unchanged. While the job runs elsewhere, nothing edits it except the copy-back below.
- Harness sends the folder's commit over the worker's own connection, not SSH, because the session runs where the
  worker is. New worker call `queue.receive`: a thin `git pack-objects` stream of the commit (minus what that computer
  already has, as `run-remote.js` does), sent in chunks, stored in a bare repository the worker owns
  (`~/.orchestrator/queue-repos/<project>.git`, `core.autocrlf=false`, no remotes).
- New worker call `queue.prepare`:
  - a worktree of that commit on the job's branch under `~/.orchestrator/queue-worktrees/<branch>`;
  - the job folder's setup, the way this Mac gives it, from an installed checkout of the project kept on that
    computer beside the bare repository (`~/.orchestrator/queue-repos/<project>-installed/`), made by the first step
    below and installed again there whenever the lock file in the job's starting commit differs. The worker runs the
    same `createWorktree` route with that checkout as its main checkout: what `.worktreeinclude` lists is linked from
    it, with `provisionWorktreeDependencies` as the fallback, so a cold `npm install` per job stays the last resort.
    On Windows, linking `node_modules` needs a directory link the worker is allowed to make, and the fallback copies
    can't be copy-on-write (`worktree-deps.ts` shells out to `cp`, which plain Windows lacks, and falls through to
    Node's own copy); the first step measures whichever route works there, checks the module can be bundled into the
    worker at all, and the design is revisited if it is too slow for each job. The untracked files this leaves are
    recorded, and `queue.collect` leaves them out exactly as `workPathspec` does here;
  - **no local settings files.** `.env.local` and the other files `copyConfigFiles` copies here can hold secrets, so
    they never leave this Mac by this route, as test runs already refuse them (`snapshot.js`). The first step runs the
    project's quick checks without them; a project that needs them stays here;
  - a planning folder `~/.orchestrator/queue-docs/<item>/` (below).
  Both folders, and the job's report folder (below), are added to the worker's allowed list for that session only,
  and given to the AI tool as its working folder and extra folders, so the worker allows them even if the tool's own
  sandbox is tighter than a queue worker's full-access mode. The worker's normal list is unchanged.
- All the `queue.*` calls need a new capability, `queueJobs: 1`, checked on both sides, as `queuePushGuard` is.

### Out and back: the plan and other planning documents

None of this Mac's paths exists on the other computer, so a job sent there gets its own planning folder.

- **What goes out:** the job's document, its linked spec, and any other planning document the plan links to by path
  inside the repository, each at its path relative to the repository. The prompt says that a full path into this
  Mac's checkout (`/Users/suas/work/<repo>/...`) is at the same place under the planning folder there.
- **The prompt names the paths there:** "your document is `<planning folder>/<path>`; edit every planning document
  inside `<planning folder>`, at its path in the repository; make code changes in `<job folder>`". The rule that
  planning documents never go in the job's folder is unchanged.
- **What comes back:** `queue.collect` (below) also returns every planning-folder file that changed since Harness
  last sent it. Harness writes them into the main checkout before saving, so the plan trim and the checker read the
  agent's latest edits, as now:
  - a document Harness sent, and the job changed, replaces the main checkout's copy only if that copy is byte for byte
    what was sent, using `assertDocumentFileUnchanged` and `changeDocumentFile` immediately before the write
    (question 2). Each such write keeps the old version as a hidden file (`changeDocumentFile` in
    `plan-queue-document-mutation.ts`), as every guarded plan change does today; the queue's sweep deletes it a week later. If James changed
    it here meanwhile, the job's version is saved beside it as `<name>.from-queue-<item>.md`, and the job is held,
    saying "the plan changed here while the job was on the Windows PC", for James to choose;
  - Harness's own later writes to a sent document (the trim, a parked note) become the new "what was sent", and go
    back out with the next starting commit, so they are never mistaken for James's edits;
  - a planning document the job created, or one it wasn't sent with, follows the existing rule exactly: created if
    new, never replacing a file, a different copy beside it. Once one the job created has been copied here (its
    `_livetest.md`, say), it counts as sent from then on, so the next round's edits to it replace it the same way. So an unlinked existing document the agent edits there
    comes back as a `.from-queue` copy, for the checker and James to see.

### There: the session and its Harness tools

- The worker session is started with `forceNodeId` and the folder from `queue.prepare`, plus `queuePushGuard`, as now.
  The account rules pick the account as now; placement is refused if that computer isn't signed in to it (from step
  A.2's sign-in report). That report checks the sign-in, not whose it is, so a computer signed in as another account
  still stops at the start-time check, as a named session does today.
- **The report, without a Harness tool,** following the tool's own rules: a report belongs to one worker turn, is
  cleared when the next turn starts (`plan-queue-item-flow.ts:321` and `:350` set `workerReport: null`), is accepted
  only from the current worker while the job is working or fixing (`recordWorkerReport`), and is read when the turn
  ends, before the report gate (`afterTurn`, `plan-queue-item-flow.ts:405`).
  - Each worker turn's prompt (the first one, fix and reminder prompts) names a report file for that turn only:
    `~/.orchestrator/queue-reports/<item>/<turn id>.json`, outside both the job folder and the planning folder, so it
    is never copied back as a document or committed. It asks for the fields `plan_queue_report_ready` takes, instead
    of the tool call; the wait rule (`WORKER_WAIT_RULE`, "handed over when you report") says the work is handed over
    when the turn ends; and a fix round's finding that says "Report each one with plan_queue_report_ready"
    (`plan-queue-deferred-checks.ts:123`) is reworded for a job elsewhere to name that turn's file.
  - When the turn ends, before `afterTurn`, Harness asks the worker for that turn's file only (new call
    `queue.readReport`), checks it with the tool's own schema (`PlanQueueReportReadyArgsSchema`, from
    `@contracts/schemas/plan-queue`, as `src/main/mcp/plan-queue-tools.ts:363` parses it), and stores it through
    `recordWorkerReport` as that worker's report, so the gate, the checker and the deferred-check rule see it exactly as
    a tool report. A file from another turn is never read, and the worker deletes the folder's older files then.
  - A missing or malformed file counts as no report, and a malformed one is named in the next finding, in words.
- **Later, a real tool:** the worker could start a small local tool server for the session with only
  `plan_queue_report_ready`, each call going back over the worker connection and accepted only from the computer that
  session runs on, for that session's own job. Not needed while the file works.

### Back: each checkpoint copies the files here, then saves them here

**When copy-back happens:** once per worker turn on the other computer, at the save that follows it
(`checkpoint(item, 'round N work')` in `plan-queue-item-flow.ts`), or when a job is paused, parked or discarded with such a turn not yet saved. Every
other save is this Mac's alone: in particular every merge of `main` into the job and the save after it happen between turns: at landing
(`plan-queue-item-landing.ts:307` and `:400`, the second after `syncItemWithBase`, `plan-queue-landing.ts:77-103`), at
the start of checking (`plan-queue-start-verification.ts:61-72`) and in check groups (`plan-queue-check-groups.ts:263-265`), after the last copy-back, and the commit they make goes out before the next turn there. So each turn there
starts from this Mac's current commit, and nothing here moves the job's folder while a turn runs there. With it go
the base branch's tip and the commit the job started from, because the worker's prompts tell the agent to compare its
work with the base branch (`git log`, `git diff`). Harness
records the commit each turn started from and refuses a collect, parking the job with a plain reason, if this Mac's
folder has moved since then, rather than make the folder match an older commit and undo a merge.

**The conversation between rounds:** closing the session at a save doesn't end its conversation. The next round
reopens it there, as a worker here is reopened today: `continuableWorkerSession` (`plan-queue-spawn.ts:123-132`)
matches provider, model, account and folder, the far folder stays the same across rounds, and a remote start carries
`resume` (`remote-cli-spawn-params.ts:28`). A job that falls back here has a different folder, so it starts a fresh
conversation here.

Saving stays in one place, this Mac, so every safeguard above keeps working unchanged.

1. Harness closes the job's session there first: a save happens after the agent's turn is over, but the session can
   stay open afterwards (`plan-queue-item-flow.ts:404-420`), and someone could chat to it, which would race both this
   step and step 4.
   Then the new worker call `queue.collect`: the worker records everything in its folder, apart from what its install left
   (`git add -A` with the same exclusions), as a commit on a side reference that isn't the job's branch, and answers
   with that commit's id, a thin pack from the last commit Harness sent, and the changed planning files. Its parent
   must be that last commit; anything else is refused with a plain reason and the job is parked, so a job can't land
   code Harness didn't see. That includes a commit the agent made itself there, against its instructions; here today
   such a commit would just be saved on top. The job's work is kept on that computer for James to look at.
2. Harness unpacks it here and makes the job's folder on this Mac match it, additions, changes, deletions and renames,
   as uncommitted changes, with new files left untracked, not staged, as an agent working here would leave them
   (the folder's own commit doesn't move; `relocatePlanningFiles` finds planning files among the untracked ones). Nothing else edits that folder while the job is away.
3. The existing `checkpoint` then runs on that folder exactly as today: leftover recovery, the plan trim, the conflict
   refusal, moving planning files to the main checkout, and the commit.
4. The commit it made goes back out through `queue.receive`, with the planning folder's documents as they now are.
   The far folder moves to the commit (`git reset --hard`; nothing runs there now, step 1 closed the session), and Harness sends the list of files saving left out (the planning
   files it moved, and any it couldn't move, which stay safe in this Mac's job folder); the worker deletes exactly
   those from its job folder, because `git reset --hard` keeps untracked files. Both sides then start the next round
   from the same commit, and a moved planning file can't come back as a new `.from-queue` copy each round.

- **A round with a merge to resolve stays here** in the first version. Landing merges a moved base into the job on
   this Mac (`syncItemWithBase`); a conflicted merge's state lives in that folder's git index, which step 1 can't carry.
   A clean merge just goes out as the next starting commit.

### When the other computer goes away

- The job is held and says so in the queue ("the Windows PC went away; waiting for it"). After 10 minutes it carries
  on here from the last checkpoint; work since then on the other computer is lost, as a crash loses it today. When the
  computer comes back, Harness removes its copy of that job.
- **If Harness on this Mac restarts mid-job,** it finds the job's computer and the last commit exchanged in two new
  fields on the job's row, written at each exchange. It first stops that job's session there if it is still running,
  then asks the computer to collect, as at a checkpoint, and carries on. If the computer has no copy, the job
  carries on here from the last checkpoint.

### Cleaning up

- When a job lands, is set aside or is discarded, Harness asks the computer to remove its job folder and planning
  folder (new call `queue.remove`). The bare repository stays, so the next job sends only what's new. A computer that
  is away does it when it comes back, from a list of jobs this Mac no longer has.
- **Pausing or parking a job while its computer is away:** the save skips the copy-back and keeps the last
  checkpoint here; the job says that later work there isn't included yet, and collects it if the computer returns
  before the job carries on.
- **Discarding a job while its computer is away:** discard saves the job's edits first
  (`retireForDiscard`, `plan-queue-worktree.ts:315`). With the computer away, Harness discards from the last
  checkpoint here and says that later work there is dropped.
- **Falling back here never resumes the far session:** a worker conversation is only continued in the same folder
  (`continuableWorkerSession`, `plan-queue-spawn.ts:124`), so a job that falls back here starts a fresh session.

### Choosing where a job runs

- The Computers page gets a "Plan Queue jobs" switch per computer, off until James turns it on. A job goes to the first
  computer in the order that takes them, isn't paused, is signed in to the job's account, has room, and has passed
  the project check below; otherwise here, and the job's timeline says why in words.
- Room: each computer takes at most its own "jobs at once" (default 2), counted separately from this Mac's limit.
- Starting a queue run offers "Keep this run on this Mac", for plans that need this Mac's browser or Harness tools.

### First step: can the project build there?

- Per project, once: Harness sends the current `main` to the computer, makes the installed checkout there (the
  project's own install), runs its quick checks in it, times copying its dependencies into a fresh job folder, and
  records the results. A project that fails stays here, and the page
  says which projects each computer can take. On Windows this is where line endings, long paths, native modules and
  shell differences show up; the agent's own test runs inside a job depend on it.

## Left for the implementation plan

Points the reviews raised that the build plan must settle, none of which changes the design:

- How the installed checkout on the other computer relates to its bare repository (a worktree of it is the obvious
  answer).
- `createWorktree` always runs `git worktree add -b`, and its clean-up after a failure deletes the branch; sending a
  job again to a computer that already has its branch must reattach instead.
- Copy-back step 2 applies the change between the last commit sent and the collected one, rather than copying the far
  folder over this one, so files that exist only in this Mac's job folder (its links and local settings) are left alone.
- A default sign-in has no expected identity, so a computer signed in to a different account would still run the
  job; showing who each computer is signed in as (A.2) is how James can spot that.

## Not in the first version

- Loops, and your own sessions that edit code (plan stage B, option 3).
- Sessions that don't change code (plan stage B, option 2) reuse the "out" half later, with no copy-back.
- Running a job's checker or triage elsewhere.

## Risks

| Risk | Answer |
|---|---|
| The far copy and this Mac's folder disagree | Only Harness writes either; every collected commit must follow the last one exchanged, or the job parks. |
| The plan is edited in two places at once | The job's copy replaces this Mac's only if this Mac's is unchanged since it was sent; otherwise both are kept and the job waits for James. |
| Planning files or conflict markers reach a commit | Saving still happens only here, through the existing `checkpoint`, which already blocks both. |
| Windows toolchain trouble inside the agent's own test runs | The per-project first step must pass before any job goes there. |
| A large repository is slow to send the first time | Thin packs against what the computer already has; the first send per project is the only full one. |
| A leaked push | The existing push guard applies; the far repository has no remote at all. |
| An agent on the PC uses Harness tools it shouldn't | None in the first version; the report comes back as a file. A later tool would be the one report tool only, and this Mac accepts a call only from the computer and for the job that session belongs to. |
| Installed files reach a commit | The far side leaves out what its install left, as this Mac does. |
| Each job pays for a slow install on Windows | Dependencies come from a kept installed checkout there, as here from the main checkout; the first step measures the copy before any job goes. |
| Hidden plan backups pile up | Writing only when the job's copy differs keeps it to one per changed document per round; they stay, as today's do (question 2). |

## Checks this will need

Specs for each new worker call (including refusal of a commit that doesn't follow the last one), a turn's report
file read before the report gate and stored as a tool report, an older turn's file never read, a malformed one
treated as none, a job elsewhere with a deferred check
passing, installed files left out of `queue.collect`, the copy-back changing only
the job's folder (deletions and renames included), Harness's own trim not counted as James's edit, a live-test job
staying here, clean-up after landing, a planning file written on the far side ending up in the main checkout and not in the
commit (and not coming back the next round), the plan coming back, and being kept beside a plan James changed meanwhile, the hold and the fall-back here, and placement's refusals; a real job on the PC that
lands on `main` here; one where the PC is switched off mid-job and the job finishes here.
