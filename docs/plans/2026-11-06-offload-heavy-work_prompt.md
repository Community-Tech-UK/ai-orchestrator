You are implementing an approved plan in the AI Orchestrator (Harness) repository. James's Mac is overloaded by full test runs. Your goal is for `npm run test:quiet` full runs from agent sessions and loops to run on his Windows PC, inside WSL, and come back exactly as if they had run locally. If the PC can't do a run, it happens on the Mac and says why.

James has approved starting this work by sending you this prompt.

## Read first

1. `docs/plans/2026-11-06-offload-heavy-work_plan.md`: the plan, and the source of truth for every step. Read all of it, including "How it will work", "Rules it must keep" and "Risks".
2. `docs/plans/2026-11-05-plan-queue-reliability_plan.md`, Part 1: work this depends on.
3. `docs/research/2026-11-05-offloading-work-from-the-mac.md`: background. Where it disagrees with the plan, the plan wins.
4. `AGENTS.md`, and every file you're about to change, with its callers and tests. The code has moved since the plan was written, so check each claim before relying on it.

## Scope

Do Stages 0, 1 and 2 of the plan, in order. Stages 3 to 6 are out of scope. Set the plan's status to in progress when you start.

## James's decisions, which are settled

- Use WSL, in a new Linux space called `harness-checks`, separate from his existing Ubuntu.
- No sandbox. Windows drives and Windows programs stay reachable from it. Keep Windows folders off its path, as step 1.1 says.
- Tests can use the whole PC, with no cap and no game pause.
- A pass on the PC can land code with no full Mac run. There's no trial week.
- SSH carries the work, not the Harness worker link. The plan says why.

## The repository is shared

Other sessions are working here. When this prompt was written, `scripts/run-tests-quiet.js`, `vitest.pool.ts`, `src/main/plan-queue/plan-queue-gate-receipts.ts` and `src/main/plan-queue/plan-queue-group-landing.spec.ts` held someone else's uncommitted reliability work. Build on top of uncommitted work and leave it in place.

- Work on `main` in this checkout, with no new branches or worktrees.
- For a clean copy, use a temporary clone under `_scratch/` and delete it afterwards. In this checkout, never use `git stash`, `git reset`, `git restore`, `git clean` or `git checkout --`.
- Commit each finished stage to `main`, staging only your own changes. Check `git diff --cached` first. Where a file also holds someone else's uncommitted edits, stage only your hunks.
- Don't push. Don't commit active plans, specs or this prompt.

## Working on the PC

The node is `windows-pc`. Find `run_on_node`, `upload_to_node`, `download_from_node`, `read_node_output` and `terminate_node_instance` through Harness's tool search.

- Write each job as a script file and upload it to `C:\Users\shutu\.orchestrator\_scratch\aio-transfers`, which WSL sees as `/mnt/c/Users/shutu/.orchestrator/_scratch/aio-transfers`. Have the node's agent run one command. Inline commands get mangled by PowerShell.
- Have scripts write a report file, and read it with `download_from_node`. A helper replying "done" or "started" proves nothing.
- Anything that must outlive its command needs `systemd-run --user --collect --unit=NAME`, with `XDG_RUNTIME_DIR=/run/user/$(id -u)` set. Jobs started with `nohup` or `&` die with the `wsl.exe` session. After starting a job, prove it's running.
- Create `harness-checks` from a clean Ubuntu image. Never export or copy his existing Ubuntu, which holds his credentials.
- Leave his existing Ubuntu and `docker-desktop` as they are. Don't run `wsl --shutdown`, restart Docker or update WSL.
- The PC has 10 agent slots, and 9 were in use when this was written. Terminate each instance as soon as you've read its output.
- Step 1.6's browser commands go through the Browser Gateway to `windows-pc`. Never use a browser on the Mac.

## Working on the Mac

It's overloaded, which is the reason for this work. Run targeted tests while you iterate, and the full suite only to finish a stage. Never quit or restart Harness.

## Finishing a stage

1. Run the step's tests, then the checks in `AGENTS.md`.
2. Prove the real route with a real run, as the plan's "Done when" says. Unit tests alone don't count for anything that claims to work end to end.
3. Have a fresh agent that didn't do the work review it with the `task-completion-gate` skill, at `~/.agents/skills/task-completion-gate`. Fix what it finds and repeat until it returns `VERDICT: PASS`.
4. Tick the steps in the plan, add as-built notes, and commit.

Anything that truly needs a restarted PC, a person or an outside service goes in a `_livetest.md`, under the rules in `AGENTS.md`. The plan stays `_plan.md`, because Stages 3 to 6 remain.

## What waits for James

Finish everything else first, then list these for him.

- **Pushing.** Step 1.5 and the GitHub half of step 0.1 can't be proven without a push. Run the CI commands inside `harness-checks` instead, and report them as ready to push.
- **Step 2.9.** It needs a Harness rebuild and restart. Write and test the code, then stop there. Queue checks stay on the Mac until he has done that and reliability step 1.3 is installed too.

## When to stop and ask James

Ask when a step needs the Windows administrator account, a PC or WSL restart, a new login or a paid service, or when `tailscale serve` can't reach WSL. Ask too if a test differs between Linux and the Mac and you can't find the real cause. Never skip a test to get past it. Carry on with anything that doesn't depend on the answer.

## Done means

- Stage 0 is in, and the full suite gives the same result on the Mac as before.
- `harness-checks` passes the full suite from a clean checkout, and matches the Mac on the same commit.
- A real full run from an agent session and from a loop each comes back from the PC with normal output and exit code.
- Dropping the connection mid-run gives an honest fallback to the Mac.
- Browser work on the PC stays usable during test load, as step 1.6 checks.

Keep going until all of those are true, or everything left is waiting on James.

## Final report

Write for James in plain English: what now works, the measured time for a full run, what's waiting for him, and what you didn't test. End with a checklist of each step and its real status.
