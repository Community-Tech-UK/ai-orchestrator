# Claude renewal during background sleep wakes

> Implementation complete and landed in base (commit `4ca6ef366`, "provider hardening"). Queue worker re-verified on 2026-10-06: focused tests, both typechecks, lint, size check and both builds pass. Ready for the queue's independent verifier, which owns the full quiet suite and the fresh completion-gate review. No commit or push by the worker. Live sleep/expiry and installed-app checks stay deferred to the live-test document.

**Goal:** Prevent the two usage pollers from launching Claude's credential renewal during macOS maintenance wakes or an unavailable network.

**Architecture:** Claude Code continues to own credentials. A bounded preflight checks macOS graphical-wake capability and Claude's network endpoints before starting doctor; failure skips this cycle and retains the expired/transient result. No credential backups, restores, direct refresh POSTs, or native CLI changes.

**Evidence:** On 5 October all 24 retained renewal failures were ENOTFOUND following DarkWake. One observed account credential had empty access/refresh fields and expiry zero. James restored both accounts manually. The exact operation clearing credentials has not been captured. Matching upstream report: https://github.com/anthropics/claude-code/issues/85149 (closed stale, no confirmed fix).

## Constraints and review focus

- Work in current checkout; preserve unrelated dirty files; no branches/worktrees/commit/push.
- Never output credential or doctor stdout/stderr contents.
- Unknown macOS power state and network failures defer renewal; no eventual fail-open.
- Graphics capability is conservative full-wake evidence; it does not independently prove DataProtection Keychain unlocked.
- Existing Claude sessions can renew themselves; this change only protects usage-poller initiated renewal.
- Drain doctor output without logging it. Increase the 15/20 second deadline to 120 seconds: native OAuth HTTP timeout alone is 30 seconds, followed by other requests and lock handling.
- Preserve profile routing and stripped authentication environment. Healthy access-token reads remain unchanged.
- Don't restart Harness or disrupt active sessions. Source changes require a normal rebuilt app before installed Harness benefits; standalone launchd polls reload Python source each invocation.

## Tasks

- [x] Add Harness renewal readiness helper and wire it before doctor spawn; coalesce concurrent calls in each refresher and drain output.
  - Files: `src/main/core/system/provider-quota/claude-auth-refresh-readiness.ts`, `claude-credentials-reader.ts`.
  - Readiness injects platform, bounded pmset reader and host resolver. For macOS require current capabilities to contain CPU, Graphics and Network; other platforms skip pmset. Require both platform.claude.com and api.anthropic.com resolution with Chromium DNS cache disabled; absent resolver defers. Recheck power after DNS before spawn.
- [x] Add standalone monitor readiness helper and wire before doctor; raise timeout. Owner: prior_auth_fix agent. Files outside this repo: `/Users/suas/work/token-usage-monitor/poller.py`, new helper/tests.
  - Bounded unauthenticated HTTPS HEAD checks and the same graphical-wake requirement; no secret input.
- [x] Verify actual readiness and transient reader/probe behavior through runtime calls without renewing live credentials; only then add regression tests.
  - Fake darkwake with CPU/Network only must not spawn doctor; unknown state defers; fully awake and working DNS passes; either host failure/hang defers; power transition during probe defers; successful expired-token refresh rereads; no pre-expiry work.
- [ ] Run focused tests then canonical typechecks, lint, size check, both builds, full quiet suite; record actual exit results and local log paths.
  - [x] Focused tests, both typechecks, lint, size check, both builds: all exit 0 on 2026-10-06 in the queue worktree (see "Queue worker verification").
  - [ ] Full quiet suite: owned by the queue's independent verifier (queue workers are told not to run it). Earlier red runs were confined to unrelated Browser Gateway specs.
- [ ] Independent fresh completion-gate review (owned by the queue verifier) against task-specific working-tree diff, criteria, security, async handling and verification evidence. Fix and repeat until PASS.
- [x] Update as-built evidence and retain explicit live sleep/expiry and installed-app deferrals. Rename completed only after all agent-runnable gates pass and fresh review PASS. (As-built notes below; live-test document retained unchanged. Rename is the queue coordinator's step after verifier PASS.)

## Live verification remaining

Installed-app rollout and natural sleep/expiry checks are pending in [the live-test document](2026-10-05-claude-auth-darkwake_livetest.md). These are not verified, and no live credentials or active sessions will be disturbed to force them.

## Current verification evidence

- Awake helper passed with real pmset and Node DNS; production Chromium helper passed in a disposable no-UI Electron process. This environment rejected child sandbox startup, so that scratch smoke used --no-sandbox --disable-gpu; no installed/system settings changed.
- Compiled reader with an obvious placeholder expired credential and simulated dark wake returned expired without invoking doctor. Isolated VM comparison of HEAD versus changed reader with a mocked transport proved old unsafe spawn1/new unsafe spawn0 (`_scratch/claude-auth-before-after.js`).
- Both restored live accounts passed a read-only compiled reader/probe check without requesting renewal.
- Focused Harness43 tests passed; standalone full400 unittest tests passed independently; Python compilation passed.
- Main build, renderer build, root typecheck, spec typecheck, lint and size check passed. Logs: `_scratch/claude-auth-*.log`, focused `_scratch/test-run.pid-22580.log`.
- Initial lifecycle test mock failed to intercept CommonJS default transport; corrected to match existing named/default mock idiom. Full run using system Homebrew Node was interrupted with exit130 after revealing its missing standalone-executable fuse; no success claimed. Project-pinned Node24.15.0 passes both standalone-build tests and lifecycle tests (7 tests, `_scratch/test-run.pid-67978.log`). Full run is now using pinned Node and four forks to avoid an inadvertently serial run while other sessions were testing.
- First pinned full run completed exit1:16 failures/29798 tests, all in four Browser Gateway files being independently edited. Subsequent focused current-tree reruns of those exact four files all passed:46 tests (`_scratch/test-run.pid-63231.log`) and13 (`_scratch/test-run.pid-75362.log`). Source and test counts changed midrun. No unrelated code edited. Latest current-tree main build and lint also passed. Fresh reviewer owns final full rerun plus independent builds.
- Fresh telemetry grouping confirms all retained failed-renewal sessions contain actual `tengu_doctor_command` events; independent native dispatch trace confirms doctor command→doctorHandler→event. This identifies doctor invocations as renewal initiators, while the particular launcher and final credential-clearing call remain unproven.
- Ruling: follow James's required runtime-before-test-update order for this bug; no existing Harness assertions were weakened. Source-level regression comparison and new focused tests preserve evidence. No commit/push or isolation workspace created.
- Fresh independent verification: both typechecks, lint, size gate and both builds exit0; auth-focused43 tests and Python400 tests pass; production Chromium readiness and simulated expired/deferred/renewed flow pass without live doctor. The final full suite exits1 with four persistent failures only in independently changing `src/main/browser-gateway/browser-mcp-stable-tools.spec.ts`; exact focused rerun also exits1. Logs: `_scratch/test-run.pid-79390.log`, `_scratch/test-run.pid-66889.log`, focused auth `_scratch/test-run.pid-61499.log`, Python `/tmp/claude-auth-fresh-python-tests.log`. Completion gate cannot PASS while the full suite is red. No auth-source actionable finding reported; leave plan active and request a fresh gate after the unrelated owner restores the wider check.
- Final read-only live usage recheck: both restored accounts pass and need no reauthentication. Recovery remains James's manual sign-in, not evidence of expired-token renewal. No installed-app update/restart performed.
- Standalone monitor has no Git history and no pre-edit filesystem backup was retained. Its implementer's transcript contains full original reads and patch provenance; the fresh reviewer inspected final files and independently ran the suite, but cannot claim a filesystem baseline comparison.

## As-built

- Harness: `src/main/core/system/provider-quota/claude-auth-refresh-readiness.ts` (new) gates `createClaudeCliAuthRefresh` in `claude-credentials-reader.ts`. On macOS it reads `/usr/bin/pmset -g systemstate` (3 s timeout, `LC_ALL=C`) and requires CPU, Graphics and Network; it then resolves `platform.claude.com` and `api.anthropic.com` separately through Chromium's resolver with the DNS cache disallowed (each bounded by the existing 5 s probe timeout); it rechecks power before returning ready. Any error, missing resolver, or missing host defers. Non-macOS skips pmset.
- The refresher logs only a fixed debug line when deferring, drains doctor stdout/stderr without reading them into memory or logs, uses a 120 s deadline, and coalesces concurrent calls per refresher (one per profile reader) with retry allowed after settlement. Profile routing (`CLAUDE_CONFIG_DIR`) and stripped auth environment are unchanged. `read()` only calls the refresher when the stored credential is expired or inside the 90 s skew, so healthy reads are untouched.
- Standalone monitor (outside this repo): `/Users/suas/work/token-usage-monitor/claude_refresh_safety.py` (new) and `poller.py` `claude_refresh_via_cli` use the same graphical-wake rule plus unauthenticated, proxy-bypassed, `~/.curlrc`-ignoring HTTPS HEAD checks of both hosts, then a second power check; doctor timeout is 120 s with output captured and discarded.
- 2026-10-06 queue worker addition: `claude-credentials-reader.spec.ts` gains "never asks Claude Code to refresh a credential that is still valid", covering the plan's "no pre-expiry work" case directly (previously only implied by the code path). No source behaviour changed.

## Queue worker verification (2026-10-06)

Run in the queue worktree with project-pinned Node v24.15.0. Logs are under the worktree's `_scratch/`.

- Focused: `npm run test:quiet -- src/main/core/system/provider-quota/ src/main/runtime/network-readiness.spec.ts` → exit 0, 22 files / 261 tests (`_scratch/test-run.pid-69276.log`). Auth-only subset → exit 0, 5 files / 51 tests before the new test (`_scratch/test-run.pid-59339.log`).
- Standalone monitor: `./run-tests-quiet.sh` → exit 0, 400 tests (`/tmp/claude-auth-queue-python-tests.log`).
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` → all exit 0 (`_scratch/claude-auth-queue-*.log`).
- `npm run build:main`, `npm run build:renderer` → both exit 0; compiled `dist/main/core/system/provider-quota/` contains `claude-auth-refresh-readiness.js` and the reader references the readiness factory and 120 s deadline.
- Not run by the worker: full quiet suite and fresh completion-gate review (verifier-owned). No generated files changed.
