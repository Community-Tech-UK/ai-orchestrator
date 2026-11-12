# Test Runner Guide

Use `npm run test:quiet` for local Vitest runs. It prints failures verbatim plus a one-line pass summary and stores the full output in `_scratch/test-run.log`.

## Normal Workflow

Run a focused spec while investigating:

```bash
npm run test:quiet -- path/to/file.spec.ts
```

Run the unsharded full suite once at the final gate:

```bash
npm run test:quiet
```

The default suite excludes `*.e2e.spec.ts` and `**/soak.spec.ts`. Run those with `npm run test:slow`. Load and benchmark suites use `npm run test:load` and `npm run bench`.

### Packaged archive regression on macOS

After changing Electron or rebuilding native modules, run:

```bash
npm run smoke:asar-integrity
```

This automated test copies the development Electron app into `_scratch/`, enables
archive integrity checks on that copy, and uses invisible offscreen windows with
an isolated profile. It checks normal resource loading, loading after an atomic
archive replacement (Electron #52283), rejection of changed bytes in the original
archive, and real in-memory SQLite operations. It never starts the installed
Harness app. The test-only `--no-sandbox` flag allows execution from an agent shell
already inside a macOS sandbox; production sandbox settings are unchanged.

The command prints the evidence directory and returns nonzero on a failed check
or timeout. Logs and structured results remain there; a successful run removes
its disposable app and data. To check a different Electron build without changing
the installed dependency, pass its `.app` path after `--`. This signed-archive test
requires macOS, Python 3, `codesign`, and rebuilt native modules.

### Real embedding model

Unit tests run on the word hash: `test-setup-shared.ts` blanks `AIO_EMBEDDING_MODEL_DIR`, so results do not depend on whether the model has been fetched. `npm run verify:embedding-model` checks the real model end to end. It is a script rather than a spec because the ONNX runtime rejects typed arrays from Vitest's sandboxed context.

### Retrieval evaluation (WS16)

`npm run bench:retrieval` runs the labeled retrieval eval harness against the REAL codemem BM25 + lesson-digest engines over the committed fixture dataset (`benchmarks/retrieval/fixtures/*.jsonl`), reporting Recall@1/5/10 + NDCG@10 with a per-type breakdown and a deterministic dev/held-out split. It compares against the committed baseline (`benchmarks/retrieval/baseline.json`) and **exits non-zero on a regression**, so a ranking change shows a measurable delta before it lands.

- Uses the in-memory wasm sqlite driver, so it runs under plain Node (no native rebuild) and never touches real stores.
- `--update-baseline` locks in an improvement (regenerate the snapshot deliberately) and only ever touches the committed synthetic suite/baseline — it never runs the local suite, even combined with `--local`.
- The synthetic suite also runs in the unit tier (`src/main/memory/retrieval-eval/synthetic-suite.spec.ts`) as a baseline-reproduction guard.

`npm run bench:retrieval -- --local` additionally runs the local-personal suite against the operator's real RLM (`rlm.db`) and codemem (`codemem.sqlite`) stores, discovered at runtime under the current Harness user-data layout (packaged `harness`, falling back to dev `harness-dev`; see `src/main/memory/retrieval-eval/local-suite.ts`). Both stores are opened READ-ONLY — a real SQLite-engine read-only connection that structurally cannot write back to the source file — and the run never touches fixtures, the baseline, or any tracked file:

- A missing store prints an explicit `skipped` line (distinct from a crash or silent no-op).
- An opened-but-unqueryable store (missing expected tables, or a query throws) prints an explicit `failed` line.
- If a healthy codemem store is found and `benchmarks/retrieval/local-queries.jsonl` exists, the suite runs those `code`-type queries against the real BM25 path (`searchHydratedChunks`) for the workspace passed via `--local-workspace=<path>` (default: this repo checkout) and prints R@1/5/10 + NDCG@10 with the same `metrics.ts` machinery as the synthetic suite.
- `local-queries.jsonl` is **gitignored and never created by the tool** — it is the operator's own personally-labeled query set, one JSON object per line, same shape as the committed synthetic queries: `{"id": "...", "type": "code", "query": "...", "relevant": ["relative/path/from/workspace.ts"]}`. Without this file, the store-health lines still print but query metrics are `skipped`.
- Read-only driver selection (`src/main/memory/retrieval-eval/local-suite-driver.ts`): by default `--local` re-runs the local suite inside a short-lived `ELECTRON_RUN_AS_NODE=1` child so the native `better-sqlite3` addon (ABI-matched to the installed Electron, opens the file in place with `SQLITE_OPEN_READONLY`, **no size ceiling**) can read a multi-gigabyte daily-driver store. The child prints its result as JSON on a `__WS16_LOCAL_SUITE_JSON__` sentinel line; the parent driver line reports `native-child`. If no Electron binary is found under `node_modules/electron`, or `--local-force-wasm` is passed, it falls back to the in-process WASM reader (`openSqliteWasmFileReadOnly`, `sqlite3_deserialize` with `SQLITE_DESERIALIZE_READONLY`), which loads the whole store into a 32-bit WASM heap and therefore reports `failed` ("greater than 2 GiB") for stores at/over that size — a real, surfaced failure, not silent data loss. Use `--local-force-wasm` to exercise that path deliberately.
- `--local-user-data=<path>` overrides discovery entirely (points at any user-data root, e.g. a specific instance or a throwaway fixture) — useful for testing this command itself without touching a real store.
- See the WS16 livetest for the manual store-mtime verification procedure.

## Reading the Result

The **last line** is the verdict, on both paths:

```
✓ 1827 files · 19604 tests passed in 321.7s
✗ FAILED — 2 of 19706 tests failed (exit 1).
```

Two traps, both of which have produced a false "green" in practice:

- **Do not pipe when the exit code matters.** `npm run test:quiet | tail -3`
  reports the exit status of `tail`, not the run. Use `${PIPESTATUS[0]}`,
  redirect instead (`> out.txt 2>&1`), or read the verdict line.
- **`grep -c '✗' _scratch/test-run.log` is not a failure check.** That log is
  vitest's raw output; the curated failure list is on the wrapper's stdout. An
  empty grep there says nothing about pass/fail.

The wrapper floors its exit code to 1 whenever the JSON report contains a failed
test, because vitest itself has been observed exiting 0 with failures. If you
need the counts programmatically, read `_scratch/test-results[.suffix].json`
(`numFailedTests`, `success`) rather than inferring from output.

## Cache and CI

- The local cache is enabled by default. After mass deletes or renames, use `AIO_TEST_NO_CACHE=1` or `--no-cache`.
- CI can shard with `npm run test -- --shard=N/4`; local full runs are normally unsharded.
- CI pins `AIO_TEST_MAX_FORKS=2`. An unpinned idle 4-core runner sizes to 3 forks, and the heaviest shard has exited 1 after every test passed with `[vitest-worker]: Timeout calling "onTaskUpdate"` (birpc's 60s parent ACK). That is a worker-reporting timeout, not a failed assertion. `run-tests-quiet.js` treats that exact shape (JSON report present, 0 failures, Vitest summary all-passed, exactly one unhandled worker-RPC timeout) as a pass and prints a note. Any real failed test, missing report, or extra unhandled error still fails.
- Vitest projects are `renderer` (jsdom + Angular TestBed) and `main` (plain Node + zone, without Angular). Both run parallel isolated forks — see Worker Fan-Out below. CI shards on top of that.
- A `main` spec that needs browser globals opts in with `// @vitest-environment jsdom` on its first line. Building a simulated browser for every file was about a quarter of a full run. `src/test-setup-zone-flags.ts` turns off zone.js's `EventTarget` patch: it is written for browsers, and on Node's real `EventTarget` it stops messages reaching worker threads, so any spec starting a real `Worker` would time out.
- CI's test job runs `npm run build:main` first, because five specs start a real worker from `dist/main`. Locally those specs test whatever build is on disk.
- **Inside a `.worktrees/*` checkout, `scripts/__tests__/dependency-compatibility.spec.ts` validates the root checkout's install.** Those worktrees get a `node_modules` of per-entry symlinks into the root checkout's install, so `npm ls --omit=dev --all` run in the worktree resolves every package outside the project and reports the whole tree as `extraneous` (measured 2026-09-20 and again 2026-10-06 on clean queue worktrees). The spec follows the `node_modules/.package-lock.json` symlink to the checkout that owns the install and runs `npm ls` there, but only when that checkout's `package.json` and `package-lock.json` are byte-identical to the worktree's. If they differ the spec fails and names the owning checkout: the linked tree was not installed from this branch's manifests, so run a real install in the worktree.
- On failure, the quiet runner may add a summary from a local Ollama/LM Studio endpoint. Configure `AIO_AUX_LLM_URL` or disable summaries with `AIO_TEST_SUMMARY=0`.

## Remote Checks

A plain full run (`npm run test:quiet`, with no arguments or just `--no-cache`) goes to a test machine named in `~/.ai-orchestrator/remote-checks/config.json`, if that file exists. Agents and loops type the same command. Output streams into the usual `_scratch/test-run.*.log`, the JSON report comes back with local paths, and the exit code and verdict line are the usual ones. The result says where the run happened, for example `Ran on the Windows PC in 5m 52s.`

- **Several test machines:** the first machine is the file's top level, as it always was, so copies of these scripts and of Harness from before the list still use it. Further machines go in `moreMachines`, in the order to try them, each with its `host`, `label` and, for a Mac, `"platform": "darwin"`. `queueChecks` sits at the top and covers every machine. A paused machine, or one with test runs or checks turned off, is skipped. Every machine but the last is asked with `AIO_SLOT_WAIT=0`, so a busy one passes the run on at once instead of waiting for a slot; the last one waits as before. The run happens on the Mac only when none of them takes it, and the reason names each one.
- **What goes:** the exact files on disk, including uncommitted ones, as a git pack over SSH. It follows `.gitignore` and leaves out names such as `.env`, `*.pem` and `*.key`. Only `CI` and the no-cache setting travel with it. The real repository is never written to.
- **Commit-time tests:** when a commit's staged files reach 50 or more spec files, the hook sends the run to the test machines in the same way. `scripts/test-staged.js` hands the list to `scripts/remote-checks/run-staged.js`, which estimates the reach by following imports backwards in about 2 seconds, because Vitest's own answer means transforming every spec. The estimate only decides where the tests run; Vitest still chooses them. What goes is the staged tree, not the working tree, including the temporary index of `git commit -a` and `git commit <path>`, so another session's unstaged edits aren't tested. File names travel as JSON on stdin, never in a remote command. If the machine can't produce a valid result, the hook runs the tests on the Mac as it always has and says why, so a commit is never blocked by the machine being away. That Mac run tests the working tree, as it always did. A staged file with a secret-looking name is refused and tested on the Mac. Mac-only specs the change reaches still run on the Mac.
- **Long lists of spec files:** `npm run test:quiet -- <50 or more spec files>` goes too, with no other arguments. It sends the files on disk, like a full run.
- **What stays on the Mac:** other targeted runs, `-u`, `--coverage`, `--project`, `--shard`, `test:slow`, `test:coverage` and a direct `npx vitest`. After a run on Linux, the macOS-only specs listed in `scripts/remote-checks/mac-only.js` run on a Mac and count towards the result: on a test Mac in the list, started beside the main run, or on this Mac when there is none or it couldn't. A run that went to a test Mac covers them itself.
- **Queue checks** stay on the Mac until `"queueChecks": true` is added to the config.
- **Other projects:** `scripts/remote-checks/harness-remote-check.js` gives another repository the same route. A project's quiet runner calls it first, through a link at `~/.ai-orchestrator/remote-checks/harness-remote-check.js` that points at this repository's copy, and carries on here if it exits 75 or the link is missing. It calls it only for a run that names no files, so the project's usual full-run commands must pass none: work-finding's `npm test`, which its `check`, `verify`, pre-push hook and CI use, once listed its globs and so never left the Mac. Only repositories in `scripts/remote-checks/projects.js` can go: they're matched by their real git folder, and `remote-run.sh` refuses any name without a recipe. Each has its own store and checkouts on the far machine and shares the 3 slots. Its recipe installs what it needs and runs its own quiet runner, and a test count in the result line stands in for the report. Unstaged and untracked files outside the folders in `sends` are left out. After a failing run its full log is in the suite's `_scratch/test-machine.pid-*.log`. Work-finding's desk suite is the only one in use. A suite marked `needsMac` goes only to a test Mac, and runs here when none takes test runs. Undistilled has such a recipe but its runner doesn't call the script yet: two of its browser tests pass only in James's working copy and fail in any fresh checkout, this Mac's included. 12steps was measured and stays on the Mac, for reasons in `docs/plans/2026-11-06-offload-heavy-work_plan*.md`.
- **Checks:** `npm run checks` (`scripts/remote-checks/checks.js`) sends the type checks, lint, size and wording checks and both builds the same way, one snapshot for all of them, and runs every one whatever fails. It runs only commands on a fixed list, which `remote-run.sh` keeps too, and the far side refuses anything else. The Plan Queue sends the checks it recognises as one batch through it and still keeps a receipt per check; a worktree without the script runs each one as before. The pre-push hook uses `--set push`. Each check still works on its own, here.
- **Forcing the Mac:** `AIO_REMOTE_CHECKS=off npm run test:quiet`, and the same for `npm run checks`.
- **Fallback:** if the far machine can't produce a valid result, the run happens on the Mac and prints why. A result only counts if the snapshot's fingerprint, Node version and lockfile hash come back matching, and a report with tests in it arrives. Failing tests are a result, not a fault, and aren't rerun.
- **Taking turns:** session and loop full runs on the Mac share one lock in `~/.ai-orchestrator/remote-checks/`, and use 8 workers. They print a line each minute while waiting and go ahead after 20 minutes, or 5 for loops, saying so.
- **Log:** one JSON line per run in `~/.ai-orchestrator/remote-checks/runs.jsonl`. Commit-time, long-list and other projects' runs carry `"kind":"commit"`, `"kind":"targeted"` or `"kind":"project"`, and a checks run `"kind":"checks"` with each check's result; a full run of this project has no `kind`. A run that never tries the machine, such as a short list of spec files, carries `"kind":"local"` and the number of spec files; Queue health leaves those out. A commit-time fallback has `exitCode: null`, because the Mac's run happens after the line is written. `npm run report:where-work-ran -- --since <date>` sums the log per day.
- **In Harness:** Queue health shows where full runs went and how many moved to the Mac. A notice appears there only when the latest run couldn't reach the machine, for up to an hour with no newer run. `src/main/plan-queue/plan-queue-test-machine.ts` reads the log, which stays written by the scripts because they have to work with Harness closed.
- **The far machine:** `scripts/remote-checks/setup-linux.sh` prepares a clean Ubuntu 24.04. `remote-run.sh` is sent with every run, so nothing needs deploying. On Linux, runs use a systemd scope rather than a service, because a service's manager adopts orphans and `leftover-process-sweeper.real.spec.ts` expects process 1 to.
- **A test Mac:** the same `remote-run.sh` runs there with what macOS ships: bash 3.2, perl and `shasum`. Node comes from the darwin-arm64 download, as Linux's does. A run gets its own process group through perl's `setpgrp`, and the slot lock is perl's `flock`, because macOS has no `flock` command and no systemd. Tests need `rg`, and work-finding's need `flock`: install both with Homebrew (`brew install ripgrep flock`), whose folder the script adds after the system's, since an ssh command reads no login profile. `plan-queue-history-landing.spec.ts` needs a copy of `~/.config/git/hooks/plan-spec-guard.sh` at the same path there, and skips without it. When a run ends or is stopped, its group is killed, then anything left whose working folder is inside the run's checkout and whose parent is now process 1. Nothing secret goes on the test Mac.
- **This Mac reaches the Windows PC over Tailscale's IPv6 address.** Its Tailscale tunnel has no IPv4 route, and macOS blocks LAN addresses for Harness's child processes.

## iPhone Builds On The Test Mac

Simulator builds, simulators and Maestro for James's Capacitor iPhone apps run on the test Mac, through `aio-ios` (`scripts/remote-ios/`). Plan: `docs/plans/2026-11-12-iphone-builds-on-test-mac_plan*.md`.

- **The command:** `aio-ios build | run | test <flows> | sim <simctl arguments> | logs | status | stop`, from inside the app's repository; `aio-ios help` explains each. It sends the files on disk with `scripts/remote-checks/snapshot.js` (uncommitted included, secret-looking names left out) and `run-remote.js`'s pack sender, runs the job with `remote-ios.sh`, which is sent with every command, streams its output, and copies logs, screenshots and Maestro reports into the repository's `_scratch/aio-ios/<run>/`, which carries its own `.gitignore`. Exit codes are the job's own (xcodebuild's, Maestro's, simctl's); 75 means the test Mac couldn't do it; 2 is a usage mistake.
- **Which apps:** `scripts/remote-ios/apps.js`, matched by real git folder like `projects.js`, never anything under `~/work/ebrd`. Each recipe says how to install, build the web app and `cap sync` from a clean checkout, and which Xcode project, scheme and bundle id to build. Node comes from the repository's version file or the recipe, downloaded on the test Mac; `pnpm` there is corepack's, so it is the version `packageManager` names. paid-video-calls-ios-shell is left out: it isn't in git and takes its web files from another repository.
- **On the test Mac:** everything lives in `~/remote-ios/`: per app a git store, a persistent checkout (its `node_modules` and `Pods` survive the reset to each snapshot) and DerivedData; one simulator per slot, `aio-ios-slot-<n>`, kept booted, because a freshly booted or erased one leaves Capacitor apps blank for a minute or two. There is one slot. A session owns it from its first job until `aio-ios stop` or 30 minutes with nothing run; another session waits, printing a line a minute, for up to 45 minutes. A new owner starts by uninstalling what the last one installed, and `run` and `test` take any other app the session installed off the simulator first, since one left there can answer the app's links or show over it. Builds of one app take turns on its checkout. A job leads its own process group: it is stopped when the connection closes, after 90 minutes, or by `aio-ios stop`, and anything left whose working folder is inside the app's checkout goes too. It needs Xcode, Homebrew's `openjdk@21` and Maestro in `~/.maestro` there; nothing secret goes on the test Mac, so builds are unsigned (`CODE_SIGNING_ALLOWED=NO`).
- **The redirect:** `node scripts/remote-ios/setup.js` links `aio-ios` into `~/.local/bin` and copies `shim.sh` there as `xcodebuild`, `xcrun` and `maestro` (`--remove` takes them away; it never replaces a file that isn't its own). Outside a Harness agent session (no `AI_ORCHESTRATOR_INSTANCE_ID`) they run the real tool at once. Inside one, only a command a shell ran by name is considered: a shell sets `_` to the path of what it runs, so a program that starts Xcode itself without a shell (Capacitor's CLI, MCP servers such as xcodebuildmcp, Node scripts using `execFile` or `spawn` such as App Studio's device smoke test) passes its own path and runs here unchanged, as does anything inside a Fastlane lane (`FASTLANE_LANE_NAME`) or an Xcode build step (`XCODE_VERSION_ACTUAL`). Whatever goes through a shell still counts, whoever started it: npm's `package.json` scripts, Makefiles, shell scripts, and Node's `exec`, `execSync` or `shell: true`. None in the listed repositories runs simulator work that way today. A command behind a wrapper such as `timeout`, `nice` or `caffeinate` is started without a shell, so it runs here. For those, `redirect.js` decides: only simulator builds count for `xcodebuild` (a simulator destination or SDK, or neither), so archives, exports, device builds, XCTest runs, `clean`, frameworks and queries run here quietly, as does any `xcrun` but `simctl`; simulator work in a listed app exits 64 with the matching `aio-ios` command; anything else, or anything while the test Mac is paused, can't be reached within 5 seconds, or has just failed a job, runs here with one line saying why. `AIO_IOS_LOCAL=1` runs it here when James asks. Re-run `setup.js` after changing `shim.sh`. `~/.local/bin` comes before `/usr/bin` because `~/.zprofile` and `~/.zshrc` put it first.
- **When the test Mac counts as away:** when it can't be reached, or a job fails at the checkout, the simulator, Maestro or the build machinery there. A busy simulator, a Node version that can't be fetched or a job that ran out of time doesn't send others' work back here.
- **Log:** each `aio-ios` job that ran on the test Mac adds a `"kind":"ios"` line to the remote checks run log, and so does each redirected simulator command in a listed app that ran here, with the reason (the test Mac away or paused, or `AIO_IOS_LOCAL=1`). `status`, `stop`, usage mistakes and jobs the test Mac couldn't take add none. `report:where-work-ran`, the Computers page's "Today" and Queue health count them apart from test runs, and they never raise Queue health's "can't be reached" notice.
- **Tests:** `scripts/remote-ios/remote-ios.spec.ts` (app matching, simctl arguments, the redirect's choices, setup) runs anywhere. `remote-ios.darwin.spec.ts` runs the real `remote-ios.sh` against stand-in `xcrun`, `xcodebuild` and `maestro`, and holds `shim.sh`'s tests, which need macOS's `/bin/sh` to set `_` (Linux's dash doesn't), so it is in `mac-only.js`.

## Worker Heap

Both projects were `singleFork` until 2026-08-20, so one Node process ran a project's whole spec list and its heap grew across the run. A run that day died after 771 files with `FATAL ERROR: Ineffective mark-compacts near heap limit` (its reporter had collected 848 — it was not the unsharded full suite), followed by `ERR_IPC_CHANNEL_CLOSED` in the parent as it tried to talk to the dead worker — a worker OOM at V8's default ~4 GB ceiling, not a test failure. Parallel forks removed the accumulation; the raised ceiling stays for the still-serial slow tier and for any single heavy spec file.

`vitest.heap.ts` now raises that ceiling to a quarter of host RAM, capped at 8 GB, and leaves Node's default alone on hosts under 24 GB (on a small CI runner a ceiling above physical memory swaps a clean V8 OOM for an OS OOM-kill). `scripts/__tests__/vitest-heap-budget.spec.ts` asserts from inside the worker that the ceiling arrived.

Vitest 4 removed `poolOptions`. Each project's `test.execArgv` now supplies the worker heap ceiling, and the root `test.maxWorkers` applies the shared concurrency cap. The slow-tier configuration uses `maxWorkers: 1` to keep its filesystem work serial. The worker heap spec verifies the actual runtime ceiling after this migration.

## Worker Fan-Out

`singleFork: true` dated to 2026-01-20 with the rationale "avoid re-initializing TestBed for each file" — true only of the renderer project, which the `main` project then inherited in the multi-project split. It made every spec file of a project share one process, which is what let the heap grow and what put the wall clock at the sum of ~1.5k files.

Both projects now run parallel isolated forks (`isolate` defaults to true, so each file gets a fresh worker environment and no worker carries another file's state). The distinction is sharper than "one fork instead of many": under `singleFork` Vitest hands its **entire file list to a single pool task**, and worker recycling only happens between tasks — so one process really did run 771 files before it died. The parallel branch submits one file per task. Measured on an 18-core host, 2026-08-20:

| project | files | serial | 8 forks | 16 forks |
| --- | --- | --- | --- | --- |
| `main` | 1467 | ~550s | 153s | 125s |
| `renderer` | 288 | 35s | 25s | — |

`vitest.pool.ts` sizes concurrency from the cores the host has **spare** — `min(8, floor(cores - busy) - 1)` — not from its core count. Past 8 the returns are small, and a fixed fan-out multiplies badly here: several agent sessions share this checkout and each may start its own suite. A run launched at load average 467 on 18 cores took 1907s and failed four timing-sensitive specs. A saturated host now degrades to a single fork, which is no worse than the `singleFork` behaviour this replaced, and `AIO_TEST_MAX_FORKS=N` pins the count for benchmarking or CI (clamped to 64, so a typo cannot fork-bomb the host).

The Plan Queue fixes this at 8 with `AIO_TEST_MAX_FORKS` for its checklists, post-merge gate and landing hook: the count is chosen once, so a run started at a busy moment would otherwise stay on one worker for its whole life. Each run logs a `[test pool]` line with its worker count.

`busy` is measured from `os.cpus()` tick deltas over a 300ms window when the config loads (`sampleBusyCores()`), with the one-minute load average as the fallback only when no sample is available. Until 2026-09-05 the load average was the primary signal, and it lags: a loop agent that has just finished `npm run verify` inside its iteration leaves load1 at 25–57 on 18 cores, so the coordinator's own verify seconds later was sized to one fork, finished 822 of 1977 files in its 600s budget, and timed out on parallelism rather than on any test.

CPU starvation is not a neutral slowdown for specs that shell out under a timeout. Unlocking parallelism surfaced three such cases, all pre-existing:

- Both rtk spec files build a stub binary and then execute it, and the first execution of a freshly written file on macOS costs a ~290ms median with a >1s tail (Gatekeeper/code-signing evaluation, plus whatever endpoint protection is installed) against ~3ms once warm. They hit it through two different paths:
  - `rtk-runtime.ts` probes `rtk --version` under a 1s timeout and caches the result for the process, so one cold-start stall disabled rtk for a whole app session. `probeVersion()` now retries, with a more patient 4s budget on the second attempt: the binary is warm by then, so only a busy host explains the wait. A genuine non-zero exit still fails on the first attempt.
  - `rtk-defer-hook.mjs` never probes a version — it calls `rtk rewrite <command>` under a 2s timeout and degrades to "no rewrite, normal flow" when that times out. The test factory now warms the stub after writing it, so those specs stop measuring exec cold-start. The hook's own 2s budget is unchanged.
- `history-manager-advanced-options.spec.ts` never awaited `HistoryManager.startupTasks`, so teardown deleted the temp dir under a running backfill (ENOENT on write, ENOTEMPTY on `rmSync`). It now tracks each manager and waits, as the other history specs already did.
- `local-review-tool-runner`'s FIFO spec exceeded the global 5s `testTimeout` purely under host load; it passes on a calm box and needs no change beyond the load-aware fan-out above.

`scripts/__tests__/vitest-pool.spec.ts` guards the fan-out policy and asserts `singleFork: true` has not returned to the default config.
