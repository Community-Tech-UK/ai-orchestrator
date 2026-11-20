## Snapshot of capability-289cd23b-6d9a-453e-b548-e8cafccfdd23_history.md

# History: capability repair 289cd23b

## Round 1 (2026-11-17)

- Reproduced: `ps -axo pid,command` returns "operation not permitted" in this session; neither adapter logged prompt length.
- Change: `logPromptSize` in Antigravity and Gemini adapters, called after `buildArgs` in `sendMessage` and `sendMessageStream`. Debug line `agy prompt size` / `gemini prompt size` with `surface`, `sessionId`, `promptChars`, `advisoryMemoryDelivered`. `buildArgs` itself stays side-effect free (an existing test requires it).
- Test: new case in `google-prompt-delivery.spec.ts` for both providers: first-call chars > second-call chars, values equal the real spawned prompt length, log carries no prompt text.
- Checks: `npm run test:quiet` on google-prompt-delivery, google-prompt-provenance, antigravity-cli-adapter*, gemini* all pass (47 + 27 tests); `npm run checks` all 7 pass.
- Not done: runtime probe (checker's job); debug lines only appear if the log level for the subsystem is debug.

## Resume 2026-11-18
Parked earlier because the checker found no available test computer (Mac busy, PC unreachable). On resume `dev-app.js status` answered for both. No code change; google-prompt-delivery.spec.ts passed (1 file, 9 tests). The runtime probe stays with the checker.

## Post-merge gate failure 2026-11-18
`npm run test:quiet` after merging main: 50926 passed, 0 failed, but 1 unhandled rejection "Harness's data folder is not available outside the app" from `ticketBriefPath` called inside `recording()` in plan-queue-ticket-round.spec.ts ("does not set a ticket job aside as a missing document when it starts"). Cause: that test finished once the item read `working`, before the fake worker's setImmediate turn ran; afterEach had already set the data dir to null. Not related to the adapter change (this branch touches only the two adapters and google-prompt-delivery.spec.ts). Fix: the test now also waits until the worker turn is recorded. Evidence: spec x3 green (12 tests each); full `npm run test:quiet` 3919 files, 50926 tests passed, exit 0; `npm run typecheck:spec` and `npm run lint` pass.

## Round 19 Nov (resume after park)

- Park reason: runtime probe on ct-test-mac found no gemini/agy in Harness's CLI list; session ran as Claude; no prompt-size lines.
- Re-checked: adapter diff unchanged (3 files, +63 lines); google-prompt-delivery.spec.ts 9/9 pass (exit 0).
- `list_remote_nodes`: ct-test-mac supportedClis [claude,codex,copilot,cursor,opencode]; windows-pc [claude,codex,antigravity,copilot,cursor,opencode]. No connected node lists gemini.
- This Mac has gemini and agy on PATH but browser/computer rules and the plan's authority limit probing to windows-pc / ct-test-mac.
- Outcome: no code change possible; reported ready so the checker can probe agy on windows-pc and record the gemini half as blocked by setup.

## Round 20 Nov (resume after park)

- Park reason: waiting for the linked capability repair; original check stays open.
- James's decision (20 Nov): Gemini CLI is retired, so the probe covers Antigravity on windows-pc only. Gemini half out of scope.
- Re-checked: branch diff vs main unchanged (3 files, +63 lines). `npm run test:quiet -- src/main/cli/adapters/google-prompt-delivery.spec.ts`: 1 file, 9 tests passed, exit 0 (ran on the Windows PC).
- No code change. The remaining acceptance item (runtime probe via plan_queue_report_capability_probe) belongs to the independent checker.

## Second resume 20 Nov
- Park reason: waiting on linked repair; original check open. Branch diff vs main unchanged (3 files, +63 lines). google-prompt-delivery.spec.ts: 1 file, 9 tests passed (ran on the Windows PC). No code change; probe (Antigravity on windows-pc only) stays with the checker.
