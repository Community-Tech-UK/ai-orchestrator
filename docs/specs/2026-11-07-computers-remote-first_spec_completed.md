# Use the other computers first, and this Mac last

**Status:** Approved by James on 7 November 2026; his review on 8 November chose, for decision 1, to plan step 6 now, and
for decision 2, Mac-only tests on the test Mac on straight away. Planned in
[2026-11-07-computers-remote-first_plan_completed.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-07-computers-remote-first_plan_completed.md). As of 11 November: built except Stage 6.6 (Undistilled) and Stage 7; Stage 7's detailed plan is [2026-11-11-agent-sessions-on-other-computers_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-11-agent-sessions-on-other-computers_plan.md).
**Follows:** [2026-11-06-offload-heavy-work_plan.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-11-06-offload-heavy-work_plan.md) (Stages 0 to 5 built and pushed; its measurement week ends about 13 November).
**Asked for (7 November 2026):** "fill up the Windows PC and any other slave machines and THEN start using the host
machine(s)", with "a really good and easy to use UI/UX for this stuff in settings or wherever it belongs".

## In plain English

### The short answer

Yes. Three more kinds of work can leave the Mac, and the PC has plenty of room for them: today it did about 8 hours of
test work across its 3 slots, roughly a fifth of what those slots could have done since midnight.

1. **The checks that aren't tests: type checks, lint and the two builds.** This is the biggest thing left. The Plan Queue runs
   them on the Mac every round, about 2½ minutes a time, and it ran 68 rounds on 5 November (2½ hours of checks that day).
   Every agent also runs the same five checks before it says it's done, and so does every push. Those aren't recorded
   anywhere, so the real total is higher.
2. **Smaller test runs.** Only full runs and lists of 50 or more test files go to the PC today. There are hundreds of smaller
   runs a day. The bar should drop to wherever the PC stops being slower overall, which is a number to measure, not guess.
3. **The agents themselves.** Plan Queue workers, loops and automations could run as sessions on the PC. This is the
   largest change and probably the smallest saving: the earlier measurements put the AI tools at 1% to 10% of the Mac's
   processor use. It also needs each AI tool signed in on the PC. It comes last, and only if the first two leave the Mac
   still busy.

Then one place to see and steer all of it: a **Computers** page that lists this Mac, the Windows PC and any other computer,
in the order they should be used, with this Mac at the bottom.

### What you would notice

- Agents and the queue keep typing the same commands. The heavy part happens on the PC, and the answer comes back as normal.
- The Mac does the work only when every other computer is full or away, and the output says which and why.
- Settings › Computers shows each computer, what it's doing now, what it's allowed to take, and where today's work ran.
  You can pause a computer, change the order, or turn a kind of work off for it, without editing files.

## What still runs on the Mac (measured 7 November 2026)

From the Plan Queue's own records for the last 7 days (87 verdicts with checks):

| Check | Runs | Average | Total | Where it runs |
|---|---|---|---|---|
| Full test run | 87 | 24.6 min | 2,137 min | Mostly the PC since 6 November |
| `typecheck:spec` | 87 | 50 s | 72 min | Mac |
| `build:main` | 87 | 38 s | 55 min | Mac |
| `tsc --noEmit` | 87 | 27 s | 40 min | Mac |
| `build:renderer` | 87 | 23 s | 33 min | Mac |
| `lint` | 87 | 13 s | 20 min | Mac |

- **Per day:** 2 hours 33 minutes of non-test checks on the Mac on 5 November, 1 hour 5 minutes on 6 November.
- **The run log** (`~/.ai-orchestrator/remote-checks/runs.jsonl`): 59 of 67 runs today went to the PC, and 85 of 98 over the
  two days it has existed. Of the 13 that ran here, 10 asked to stay on the Mac, 2 lost the connection and 1 failed to set up.
- **Not measured:** agents' own check runs, pushes, and small test runs. Nothing records them. Step 1 adds a record so the
  next decision rests on numbers.
- **One reading at about 15:00, a quiet moment** (load 9 on 18 cores): Cursor was the busiest program at about 1½ cores,
  running for 19 hours, then VS Code, the window system and Chrome. No tests were running on the Mac, and the one Claude
  session used 1.4%. One reading proves little, but it agrees with the earlier plan's samples (AI tools 1% to 10%), and it
  says some of what's left is your own editors, which no computer can take. Step 1 replaces guesses like this with a record.

## What exists today

Checked in the code on 7 November 2026.

- **Two separate systems.** "Other computers" (Settings tab, and a Control Center page at `/remote-nodes`) pairs computers
  that run whole agent sessions, browsers and Android. The test machine is a separate set of scripts set up by a file,
  `~/.ai-orchestrator/remote-checks/config.json`, with its own SSH key. Harness only reads its log (Queue health lines).
  You can't see or change the test machine from Harness.
- **Nothing is "remote first".** Work goes to another computer only when something names one: the node picker on a new
  session, a pinned automation, `run_on_node`, or browser and Android requests. Otherwise everything runs here.
- **Choosing a computer ignores how busy it is.** The scoring (`src/main/remote-node/worker-node-registry.ts:166-215`)
  looks at memory, free session slots, latency and account bindings. Not processor load, not core count.
- **The Plan Queue, loops and repo jobs never use other computers.** Nothing in `src/main/plan-queue` sets a node.
- **Two faults on the current page:**
  - The "Use other computers for GPU work" switch is saved but nothing reads it (`remoteNodesAutoOffloadGpu`).
  - The Control Center page's Start/Stop button starts as "stopped" after every reload, whatever the server is doing
    (`remote-nodes-page.component.ts:183`).

## What to build

### 1. Count what's left

A line in the run log for every check and test run, wherever it runs, with how long it took and which machine ran it. Small
test runs, agents' checks and pushes are then visible, and the Computers page has something true to show.

### 2. Send the other checks to the PC

- **One snapshot, all five checks.** The same route the tests use: the changed files go across once, and the PC runs the
  type checks, lint and both builds on them, then sends back each check's result. Five separate trips would copy the files
  five times.
- **The Plan Queue keeps one receipt per check,** as it does now, so its record of what passed doesn't change shape.
- **Agents get one command** (for example `npm run checks`) that runs the project checklist this way. `AGENTS.md`'s checklist
  then lists that command instead of five. Each check still works on its own, on the Mac.
- **Falls back the same way:** if the PC is away or full, the checks run here, and the output says why.
- **What stays on the Mac:** anything that needs macOS (packaging, Mac-only tests).

### 3. Lower the bar for test runs

Measure the fixed cost of a run on the PC (copying the files, the connection, a quick check that packages are installed)
against the same small run on a busy and a quiet Mac. Set the bar where the PC is no slower overall. "PC first" means
anything at or above that bar goes, not only 50 files or more.

### 4. The Computers page

Settings › **Computers** replaces the "Other computers" tab, because this Mac is on the list too. The Control Center page shows
the same list with live status.

**The list, in the order of use:**

| | Computer | Now | Takes |
|---|---|---|---|
| 1 | Windows PC | 2 of 3 test slots busy | Tests · Checks · Browser · Android |
| 2 | Test Mac | Away since 14:02 | Mac-only tests |
| 3 | This Mac | Used when the others are full or away | Everything |

- **Order:** drag to reorder, or Move up / Move down for the keyboard. This Mac starts at the bottom.
- **Takes:** one switch per kind of work, named for what it is: Test runs, Checks, Agent sessions, Browser, Android. The GPU
  switch goes until something uses it.
- **Room:** how many at once, for example "Up to 3 test runs", with the default shown.
- **Pause** sends new work elsewhere and lets current work finish. A paused computer says so in the list.
- **Now:** up, busy (and with what), or away (since when, and the last reason in plain words).
- **Today:** where the day's work ran, for example "Test runs: 59 on the Windows PC, 8 here", with why the 8 ran here in
  plain words. Each line opens the runs behind it.
- **Adding a computer** starts from the same page: pair it (the existing flow), and the page then offers to set it up for
  tests and checks too.
- **Queue health** keeps its lines and links to this page.

**Rules for the page:** it follows `docs/screen-and-wording-guide.md`. Words a person uses, not "node", "slot" or
"offload". No new welcome wizard (rejected in `docs/decisions/rejected/ui-and-product-scope.md`).

### 5. One list behind it

- **One record of computers:** the test machine joins the paired computers, so there's one list, not two.
- **The scripts must still work with Harness closed:** pushes, commits and agents' runs don't go through Harness. So the
  file the scripts read stays, and Harness writes it from the page. The page is where you change things, and the file
  is a copy for the scripts.
- **Choosing a computer** goes through the order, then each computer's switches and room, and then how busy it is: the
  load it reports, not only memory and free slots.

### 6. Agent sessions on other computers (last, and only if needed)

- **Plan Queue jobs, loops and automations** can start on the first computer in the order that takes Agent sessions and has
  room, and on the Mac otherwise.
- **The test:** after steps 2 and 3 have run for a week, is the Mac still busy, and are the AI tools a real share of what's left?
- **What it needs:** each AI tool signed in on that computer, by you, once. Login files are never copied between machines.
  A Linux worker has never run for real, so the PC's Windows worker would be used, or the Linux one proven first.

## Decisions for James

1. **Sign the AI tools in on the PC?** Only needed for step 6. Your Claude and Codex accounts would then live on the PC as
   well. If no, step 6 stays out and everything else goes ahead. Recommended: decide after steps 1 to 5 have run for a week,
   when step 6's test can be answered.
2. **Add the test Mac to the list?** It could take Mac-only tests and checks for public projects. It has no credentials
   on it, by design. After a restart someone must log in before it can work (FileVault), so it would often show as away.
   Recommended: yes, for Mac-only tests only, paused by default until you turn it on.

Everything else in this spec I'd do without asking: the order (you asked for it), measuring first, and the page.

## Not in this spec

- **Renting a machine, Noah's computers, a virtual machine on the PC:** unchanged from Stage 6 of the earlier plan.
- **Splitting one test run across computers:** still not needed. A lost machine would look like a smaller pass.
- **Changing what `exec_on_node` may run:** not needed. The checks use the test machine's own route, not the worker.

## Verification

- **Each step:** the run log shows where the work ran, and the step's tests cover both the PC and the fall-back.
- **The page:** a real check in the rebuilt app. Reorder, pause and resume, turn a kind of work off and see the next run
  go elsewhere, with the keyboard only as well.
- **Success:** after a week, the Mac's share of checks and test time is below 10%, with no rise in failed queue rounds.
