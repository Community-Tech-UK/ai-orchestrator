# Codex follow-up local package

Status: agent-runnable work done; ready for independent verification. Two live checks are deferred to [the live-test doc](2026-09-30-codex-followup-local-package_livetest.md). Follow-up to [verified renderer fix](2026-09-30-codex-followup-rendering_plan_completed.md), session `x215k2118`.

The running process is `/Applications/Harness.app/Contents/MacOS/Harness`; no renderer development server is listening on port 4567. The installed package needs an updated build to pick up the verified renderer change.

Prepare a signed local arm64 package from the existing checkout using the repository packaging runbook. Build in `_scratch/codex-followup-local-package/release/` with publishing disabled, preserving existing release artifacts and the running installation. This package includes the checkout's existing work, not only the six-file renderer fix. Do not change source, dependencies, branches, worktrees or the closed implementation plan.

Checks: normal build prerequisites and native ABI verification; signatures and app/helper Team ID; packaged ASAR renderer matching the newly built renderer; DMG integrity; isolated packaged startup smoke if supported safely; fresh independent artifact review. Source verification remains the existing completion-gate PASS, subject to confirming the six source hashes remain unchanged.

- [x] Confirm the original implementation's reviewed source hashes remain unchanged.
- [x] Run the normal build pipeline and signed local packaging with `--publish never`.
- [x] Verify artifact signatures, ASAR renderer contents and disk image integrity.
- [x] Run the isolated packaged startup check or document the exact live requirement. In-session isolated run with Chromium's sandbox off passed (2026-10-06); the sandbox-on run is LC-2 in the live-test doc, because agent shells cannot start Chromium's sandbox.
- [x] Obtain fresh independent review of the package evidence (2026-09-30 review: FAIL, startup unresolved; superseded by the 2026-10-06 evidence below, which goes to the queue's fresh independent verifier).
- [x] Record any installation/relaunch checks in a `_livetest.md`, then close this packaging plan only after every agent-runnable item passes. Recorded as LC-1 and LC-2 in the live-test doc; no installation or relaunch is needed (see below). The `_completed` rename is left to the queue coordinator after independent verification.

Installing/relaunching the user's running app is a separate final handoff. The Computer Use instructions hard-deny control of Harness itself; do not bypass that rule with UI automation. Do not overwrite the running app bundle or interrupt active sessions while preparing the package.

## 2026-09-30 evidence (historical)

Build/package both exited 0 at 14:47 UTC; `_scratch/codex-followup-local-package/build-results.json` retains commands' logs. Deep/strict codesign, helper identity, and DMG integrity checks exited 0 (`verification.json`). All 155 actual renderer files match the production build; the two intentionally excluded `.gitkeep` files are recorded in `renderer-manifest.json`. Follow-up action markup and styles are present. `artifact-hashes.json` records SHA-256s and confirms the six reviewed source files and installed ASAR remain unchanged.

Startup has NOT passed. The official smoke timed out; a direct heap-flag probe also failed. A short owned-process native sample (`startup-native-stack.txt`) and retained stdout (`startup-stack.log`, line 269) show Chromium's GPU fatal error followed by repeated `_sigtramp`/libuv signal-handler frames. This refutes the earlier provider-detection-hang hypothesis for that sampled process. The packaged `when-exit` dependency registers SIGTRAP, supporting the inference that a fatal trap was intercepted and spun. The initiating sandbox denial's origin is unconfirmed. Do not treat this installer as ready or install it on the basis of signature checks.

Two macOS LaunchServices comparisons did not produce readiness; their empty logs do not identify a cause. All test-owned main processes were terminated, with no remaining exact scratch-bundle process. The installed app was preserved.

Concurrent edits to startup code appeared after this package was built (15:09 UTC onward); those edits belong to other work and were preserved. They are absent from this package and have not been verified by this task. Continue by coordinating that startup work, verifying a fresh snapshot under the normal runtime environment, then reviewing the updated artifact. Keep this plan active until the startup gate passes; no live-test deferral is being used to bypass a failed CLI gate.

Fresh `task-completion-gate` artifact review independently reran signature/helper/DMG checks and verified all 155 renderer bytes/hashes, both artifact hashes, the six original source hashes, and the installed ASAR hash/mtime. Verdict: FAIL solely for unresolved startup; report: `_scratch/codex-followup-local-package/independent-package-verdict.txt`. Direct probes also hit port 4880 already in use, so profile isolation did not isolate every listener. This is not proven to cause the GPU failure. Four of six preparation items are performed; startup and final lifecycle/handoff remain pending. No whole-installed-bundle before/after manifest exists; preservation evidence is limited to the ASAR digest/mtime and unchanged running process, alongside no installation action by this task.

## As built (2026-10-06 queue worker)

Outcome: the plan's purpose, getting the verified renderer change into the Harness James runs, was met by a newer build installed in `/Applications` on 2026-10-04 (who installed it is not recorded in the evidence read). This plan's 2026-09-30 DMG is superseded and must not be installed: it would downgrade the running app and it lacks the fatal-trap startup guard. Nothing was installed, relaunched or rebuilt by this task, and no source, dependency, branch or worktree changed.

Evidence, all under `_scratch/codex-followup-local-package/` unless stated:

- **Source hashes.** The six reviewed renderer files match `_scratch/codex-followup/pass4-independent-forensics.json` in both the queue worktree (HEAD `4ca6ef366`) and the root checkout.
- **Package unchanged.** `app.asar` SHA-256 `58bc5b5b…8c84` and DMG `8125a5c5…b971` still equal `artifact-hashes.json` after the probe.
- **Startup, sandbox off (passed).** `nosandbox-probe.mjs` launched the package with an isolated smoke profile and `--js-flags=--max-old-space-size=8192 --no-sandbox --disable-gpu`. Result `nosandbox-probe-result.json`: ready marker at 14.0 s, `Harness initialized` and `Packaged startup smoke completed` in `nosandbox-probe.log`, self-quit with exit 0, no FATAL, no forced kill, zero `Failed to initialize sandbox` lines. Errors/warnings: only thin-client port 4880 `EADDRINUSE` (held by the running Harness, non-fatal), the in-fence Seatbelt probe warning, and the expected "another install owns the Chrome manifest" notice. The Chrome native-messaging manifest still points at the production profile.
- **Why the 2026-09-30 smoke failed.** Every agent shell here runs inside Harness's Seatbelt signal fence (`ps` returns "operation not permitted"; the app's own `sandbox-exec` probe fails with `sandbox_apply: Operation not permitted`). macOS refuses nested sandboxes, so Chromium's GPU and network helpers exit with `Failed to initialize sandbox`, Chromium hits `GPU process isn't usable. Goodbye.`, and this build (no fatal-trap guard) spins on the trap. Turning Chromium's sandbox off removed every one of those failures. That is strong evidence the agent environment, not the package, caused the failure. The separating test, a sandbox-on launch outside Harness, is LC-2.
- **Installed app.** `/Applications/Harness.app/Contents/Resources/app.asar` was replaced 2026-10-04 19:06 local (SHA-256 `f997e32b…2e5b`). It contains `data-followup-prompt` / `Copy follow-up prompt` markup, `.codex-followup` styles and `dist/main/app/fatal-trap-signal-guard.js`. Production `shutdown.ndjson` shows the old packaged process quitting at 2026-10-04 18:10 UTC, after the replacement; the packaged app has kept spawning sessions from its bundle's `config/mcp-servers.json` through 2026-10-05 23:07 UTC. So the running app is that build, and it starts under the real sandbox.
- **Checks not run in-session.** The sandbox-on launch (fence, LC-2; `terminal-startup-check.mjs` ready for Terminal.app) and the follow-up buttons plus real OS clipboard in the running app (no debug port, Computer Use hard-denies Harness; LC-1). The Terminal script was syntax-checked and its executable path resolved, but deliberately not run here: in-fence it would reproduce the 2026-09-30 hang.
- **Deferral versus the 2026-09-30 note.** That note refused a live-test deferral to bypass a failed CLI gate. This deferral does not bypass one: the agent-runnable startup run now passes, and only the sandbox-on launch remains, which cannot run inside the fence and needs no rebuild or restart.
- **Code gates.** The packaging work changed no code.

## Verification round 1 fix (2026-10-06)

The verifier's full `npm run test:quiet` failed 1 of 29,841 tests: `plan-queue-landing.spec.ts` > `landItemBranch` > "lands the closed document when the item branch has no commits of its own" timed out at about 6.2 s. This branch adds no code of its own, so the failure is not caused by this plan. Run alone, the same test takes 0.87 s and the whole file 18/18 passes. Each test in the file drives real git through dozens of child processes, so under full-suite load it exceeded vitest's 5 s default budget.

Fix (the only branch change): `src/main/plan-queue/plan-queue-landing.spec.ts` now sets `vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })` with a short comment. This is the same idiom and budget as the other real-git specs (`git-write-queue.spec.ts`, `worktree-manager.spec.ts`), and the same 30 s budget as the sibling `plan-queue-coordinator.spec.ts` real-git suites. No assertion changed.

Evidence the setting takes effect: with `--testTimeout=100 --hookTimeout=100` on the command line, the patched file passes 18/18, while the original file under the same flags fails with "Test timed out in 100ms".

Checks run in the worktree: `npm run test:quiet -- src/main/plan-queue/plan-queue-landing.spec.ts` (18 passed), `npx tsc --noEmit`, `npm run typecheck:spec` and `npm run lint`, all exit 0. The full suite is left to the verifier, as instructed.

