# Plan: agent sessions on other computers

## Status

On main: yes (this landing commit)
live: [livetest](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-agent-sessions-on-other-computers_plan_livetest.md)
covers B, A.2, B.5 and D.

- **Open:** nothing in stage A, and nothing needs James. A.1 was done and checked on 15 November (see A.1); a 16 November re-park asking for more PC sign-ins was a misreading of its old wording, now removed. The automatic sign-in plan takes over future sign-ins and other computers.
- **16 November verifier fixes:** a "This Mac" pick is forgotten when the visible session changes. Placement checks the
  sign-in of the account the session will run on (asked of the pool for the model the session or its agent pins), and starts it on exactly that account. Every scheduled-job busy-Mac
  check (first fire, pending claim, retry, dispatch) reads the job's own never-use and use-last lists. `run_on_node`
  reserves a helper-agent slot while it starts, and a running one counts afterwards. Specs for these were added in
  round 3 (the round 2 note listed some that were missing). A job that wakes an existing session stays under this
  Mac's busy check (18 November). A scheduled job admitted as going elsewhere waits for this Mac's busy check if
  placement then puts it here (19 November). Details: history file.
- **Decision (James, 11 November):** Plan Queue jobs first (stage C, its own plan). So the default is one switch, off,
  "Start sessions and scheduled jobs on other computers when they can": nothing sends a session's latest code to another
  computer yet, so turning it on is James's call.
- **Part of:** stage 7 of [2026-11-07-computers-remote-first_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-07-computers-remote-first_plan.md).

## In plain English

Harness can already run an agent session on the Windows PC, but only when someone names the PC. This plan makes the PC the
first choice for the sessions that can run there safely, with this Mac taking what's left and saying why.

Not every kind of session can move yet:

| Kind of session | Can it run on the PC? | Why |
|---|---|---|
| A session you start, and automations | **Yes, first.** | They only need a folder the PC can open and a signed-in AI tool there. |
| Plan Queue jobs | **Later, in its own stage.** | A job's code, its checks and its landing all live in a copy of the repository on this Mac. Nothing yet sends that work to the PC and brings it back. |
| Loops | **Not in this plan.** | A loop keeps its control files, checks and working copy on this Mac's disk throughout. |

## What I found (8 November 2026)

- **One place decides where a session runs** (`src/main/instance/lifecycle/execution-location-resolver.ts`), but it only
  acts on a preference the caller gives it. Nothing gives one by default, so everything runs here unless named.
- **Falling back to this Mac is silent:** when no computer is chosen, the resolver logs at info level only (`:98-116`).
- **Work on another computer skips this Mac's limits** (`src/main/work-admission/work-admission.ts:90`), so nothing counts
  it against how much Harness runs at once.
- **Signing in:** a session on the PC uses the PC's own Claude or Codex sign-in, checked there; if it's missing, the
  session stops with "Sign in for that account on this node" (`src/worker-agent/worker-account-route.ts:133-143`).
  Harness has a sign-in command per computer only for OpenCode; for Claude and Codex it's a terminal command on the PC.
- **Folders:** the PC only opens folders on its allow-list (`src/worker-agent/worker-instance-spawn-validation.ts:43-53`);
  today that is `C:\Users\shutu\Documents\Work`. A session in a folder the PC doesn't have can't go there.
- **Plan Queue landing is local git** (`src/main/plan-queue/plan-queue-landing.ts`): merging, checks and moving `main`
  all happen in the Mac's repository.

## Stages

### A — Sign-in on the PC (James, once)

- [x] A.1 Done by James at the PC on 15 November: the default Claude login (james@shutupandshave.com), each of the six pooled Claude accounts in its own `claude-cli-profiles` folder (claudeadapt-1, -2, -3, claudeadapt, claudeadapt-it, claudecomtech), and Codex on his personal OpenAI account. Verified from the coordinator the same evening: `claude auth status` per folder showed each expected email, and a Claude and a Codex test job each ran on the PC. Future sign-ins (new accounts, other computers, renewals) move to Harness (15 November: to be done by Harness instead, through [automatic sign-in for every AI tool](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-15-codex-device-login-handoff_plan.md); James signs in by hand only if he wants it sooner.) Nothing is left for James under A.1. Harness sees which accounts the PC has (A.2);
  placement already prefers a computer that has a home folder for the account a session
  uses (a hint; the sign-in itself is checked when the session starts there).
- [x] A.2 The Computers page shows, per computer, which AI tools and accounts are signed in there, and says plainly when
  one isn't.
  - **As built (8 November):** each worker checks its own Claude and Codex sign-ins, the tool's default one and every
    account with a home there, with the same check a routed session meets (`src/worker-agent/worker-sign-ins.ts`,
    reusing `checkWorkerAccountBinding` from `worker-account-route.ts`). At most every 10 minutes, in the background,
    so a heartbeat never waits; sent as `signIns` (schema in `worker-account-capability-schemas.ts`, moved out of
    `rpc-schemas.ts` to keep it under its size limit). The Computers list (Settings and Control Center) shows, for
    each connected computer, its AI tools, each sign-in ("Claude is signed in as ...", "Codex isn't signed in. To sign
    in, run this on that computer: `codex login`"), other accounts by this Mac's names for them, and "haven't been
    checked yet" before the first check (which, if it lasts, means that computer's Harness needs updating). This
    Mac's account names are read only for a tool another computer reports extra accounts for, because reading them
    runs this Mac's own sign-in checks. Display only: placement still uses the old home-folder hint.
  - **Not seen live:** needs the workers on the PC and the test Mac updated to this build and Harness rebuilt.

### B — Sessions you start, and automations

- [x] B.1 **A default preference.** A new session, and an automation with no computer pinned, asks for "a computer that
  takes agent sessions" unless it needs this Mac (a browser on the Mac, Mac-only tools, a folder only here).
  - **As built (11 November):** setting `preferOtherComputers` (Settings > Orchestration, off by default). When on, a
    one-shot scheduled job that names no computer sets `preferOtherComputer` (`automation-computer-preference.ts`, read by
    `automation-runner.ts`); a contained run, an authority grant, a system resume or a loop never asks. A session started
    from the new-session screen sets it too (`welcome-coordinator.service.ts`, sent through `INSTANCE_CREATE_WITH_MESSAGE`)
    unless a computer or local model is chosen or the person picked This Mac: the menu reports no computer both for that
    pick and for never choosing, so the coordinator remembers an actual pick until the next launch. Loops started from
    that screen stay here. Admission: a job that will run elsewhere skips this Mac's load check
    (`automationRunsOnOtherComputer`, which asks the placement rules now), so a busy Mac doesn't hold a job a free computer
    can take.
- [x] B.2 **Only where it can run:** the computer must take agent sessions, have room, be signed in to the session's
  account, and have the folder. Otherwise this Mac.
  - **As built (11 November):** `resolveNewSessionPlacement` (`lifecycle/default-computer-placement.ts`), used by
    `instance-lifecycle.ts` at create. Only a session that set `preferOtherComputer` and names no computer, placement or
    local model; only Claude and Codex (the two whose sign-in a computer reports), no extra folders. `selectNode` got two
    hard filters (`requiresSignIn`, `requiresFolderUnder`, in `node-eligibility.ts`): signed in for the account the
    session would use (an account the computer doesn't list, an unreadable check, or a worker that hasn't reported all
    count as not signed in), and the folder is an allowed folder or inside one, either slash, case ignored on a drive.
    Paused, switched-off and full computers were already refused. **Caveat:** a folder that exists is not proof it holds
    the same code (the test Mac's copies are days old); that is why the switch is off.
- [x] B.3 **Say why:** a session that ends up here when a computer was preferred says why in one quiet line, in words.
  - **As built (11 November):** one system line in the transcript, "Running on this Mac: <reason>." (no other computer
    connected, none set to take sessions, all full, tool missing, not signed in or not checkable yet, folder missing,
    extra folders, tool not Claude or Codex), kind `computer-choice`.
- [x] B.4 **Count remote work:** limits on how much runs at once cover work on other computers too.
  - **As built (11 November):** `AdmissionContext.otherComputer` (new) counts against the "at once" limits but skips this
    Mac's load check; `remote` keeps its old meaning (engine-owned work and pause-only checks, exempt). Scheduled jobs
    that name a computer, helper agents sent to a computer and `run_on_node` now use `otherComputer`, and the automation
    and helper-agent counters include work on other computers. Behaviour change: a remote scheduled job at workload 1 or
    2 now waits behind the limit; before it never did.
- [x] B.5 **Folders:** the page shows which of your project folders each computer has, and how to add one.
  - **As built (8 November):** each connected computer shows the folders it opens and how many projects it found in
    them, with "How to add a folder" (add it to `workingDirectories` in `.orchestrator\worker-node.json` in the home
    folder there, or the system-wide file when the worker runs as a service, then restart its worker). It doesn't match them to this Mac's projects: the copies there are separate
    and can be days old (see below), so a matching name would wrongly suggest the same code. Not seen live, as A.2.
- **Checks:** placement specs for each refusal and the fall-back reason; a real session started from Harness that runs on
  the PC, and one that falls back with its reason.

#### What stopped B (found 8 November, after D)

A session's folder is sent to the other computer as it is; nothing maps or copies it. The Windows PC only opens folders
under `C:\Users\shutu\Documents\Work`. The test Mac does have `/Users/suas/work`, but its copies of projects are
separate clones, some days old (12steps 6 days, Undistilled 4). A session sent there would edit old code, and its edits
would never reach this Mac. So "send sessions to other computers by default" needs the code sent out and the changes
brought back first. Options, for James:

1. **Plan Queue jobs first (stage C).** A job already works in its own copy and finishes as a branch that this Mac lands.
   Send the job's starting code the way test runs already send it, let the job commit on the other computer, then fetch
   its branch back and land it here as now. This is where most agent work is, and the round trip fits it naturally.
2. **Sessions that don't change code** (reviews, research, browser testing, reports from automations): send the code
   the same way, run there, keep nothing. No round trip needed.
3. **Your own sessions that edit code** stay on this Mac for now: their edits land in your folder as you watch, and a
   round trip under them would surprise you.

Recommendation: 1, then 2; leave 3 for later.

B.4 (counting work on other computers against the limits) doesn't depend on the folders, but it only matters once
work goes to other computers without being named, so it waits with B.1. Today each computer's own "at once" limit
already stops Harness choosing a full one.

### C — Plan Queue jobs (its own design first)

- [x] C.1 Design how a job's work reaches the PC and comes back: the test machine's snapshot route already sends code there
  safely; the return trip, and landing from it, are new. Written up for James before any code.
  - **Written (8 November), waiting for James:**
    [2026-11-08-plan-queue-jobs-on-other-computers_spec_planned.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/specs/2026-11-08-plan-queue-jobs-on-other-computers_spec_planned.md).
    **James approved it on 8 November** (the Windows PC first; yes to replacing his unchanged plan). Build plan:
    [2026-11-08-plan-queue-jobs-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-08-plan-queue-jobs-on-other-computers_plan.md).
    Two questions in it: the Windows PC first (recommended) or a sign-in on the test Mac; and letting a job's own
    plan be replaced here when its copy comes back, if James hasn't changed it meanwhile. Decided in it: no Harness
    tools on the other computer in the first version; the job's report comes back as a file. Reviewed against the code by
    fresh agents until nothing was missing; each round's gaps (how saving works, the plan document, planning files,
    the report tool, dependencies, hidden plan backups, live-test jobs, clean-up) are in it.

### D — Browser work across the Windows PC and the test Mac

Found (8 November): when an agent names no computer, `selectPreferredBrowserNode`
(`src/main/browser-gateway/browser-remote-offload-policy.ts`) always picks the Windows PC while it is connected; the
test Mac (`ct-test-mac`, paired, Chrome and the extension ready) only gets browser work if the PC is gone. And James's
global instructions tell every agent to name `windows-pc`, so nothing would spread even if the gateway did.

- [x] D.1 **The gateway chooses per session.** For a request that names no computer: the computer this session already
  used (within the last 30 minutes), so its tabs stay together; otherwise a computer already showing a tab on the same
  website (its sign-in is likely there); otherwise the browser computer with the fewest sessions using it, then the
  Computers page's order. Paused computers get no new session; one already using a paused computer stays (as the
  Computers page's pause means everywhere), and with every one paused the request is refused, not run here. A named
  computer, or `local`, is still obeyed exactly; a name that matches no connected computer doesn't move a session.
- [x] D.2 **Agents stop naming the PC.** The tool description and James's global instructions say: leave the computer
  out and the gateway shares the work between the Windows PC and the test Mac; name one only to use a sign-in saved
  there. The rule against this Mac's own browser is unchanged.
- [x] D.3 **Say where.** A tab opened by the gateway's choice says which computer it is on, as today.
- **Checks:** specs for each step of the choice, stickiness, expiry, pause, a named computer and `local`; then two real
  sessions opening pages at once and landing on different computers.
- **As built (8 November):** `src/main/browser-gateway/browser-computer-balancer.ts`, used by
  `routeBrowserGatewayRequest`, which the RPC server now calls with the session's id. Committed in 1b71b328e after two
  independent reviews and the full suite (one failure, in another session's uncommitted mobile-gateway spec). James's
  global instructions (`~/.agents/AGENTS.md`, synced to Copilot, Grok and Cursor) say to leave the computer out.
  **Not yet seen live:** two real sessions landing on different computers needs Harness restarted on this build, which
  waits until James has no sessions running.

### Noticed along the way

- **"Copilot" on a computer means the GitHub CLI (`gh`) is installed there** (`detectClis` in
  `src/worker-agent/capability-reporter.ts`), not that Copilot's own CLI is. The Computers page now shows that list, so
  a computer with `gh` but no Copilot will claim it. Not changed here: placement uses the same list.

### Out of this plan

- **Loops** stay on this Mac. Their files, checks and working copy assume this disk throughout.
- **Linux on the PC as a worker:** possible later (a Linux worker exists in code but has never run); the Windows worker
  comes first because it is already paired and signed in.

## Risks

| Risk | Answer |
|---|---|
| Windows splits some command arguments wrongly (`src/main/cli/adapters/windows-cli-spawn.ts`) | The worker already runs Claude and Codex there day to day; new placement adds no new command shapes. Watch the first week. |
| A session moves to the PC and can't find its files | B.2 only places where the folder exists. |
| The PC is busy with test runs | Its order, pause and agent-session switch are on the Computers page; placement also weighs how busy it is. |

## Decisions

1. **Where to start:** James left it to me (8 November). D, then B; C is designed before any code.

> Closure history: `2026-11-08-agent-sessions-on-other-computers_plan_history_f9f5e7a0a10944d50f939ccb2d4f6683f939dce0decd632d9d3e7acd08cce862_completed.md`.
