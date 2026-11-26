# Local Signing and Review Hook Stability Implementation Plan

> **For agentic workers:** Execute this plan inline. Keep this file untracked and active until every agent-runnable verification passes; rename it with `_completed` only at the end.

**Goal:** Make local macOS packaging independent of Apple's timestamp service and eliminate the full-suite race in the doc-review capture-hook integration test.

**Architecture:** Keep production/release signing behavior unchanged. The localbuild command will set Electron Builder's supported macOS timestamp option to `none`, which reaches `@electron/osx-sign` through its per-file options callback while retaining the real signing identity and Team ID verification. The capture server will retain its non-blocking hook contract; its integration test will wait for the observable hook outputs using a bounded readiness helper instead of a short fixed polling budget.

**Tech Stack:** Node.js 22, Electron Builder 26, `@electron/osx-sign`, TypeScript, Vitest 3.

## Global Constraints

- Preserve all unrelated staged, modified, and untracked work.
- Do not commit or push.
- Do not weaken stable-release signing, notarization, or Team ID verification.
- Keep `src/main/doc-review/assets/serve-review.mjs` synchronized with the portable skill copy if server behavior changes.

---

### Task 1: Local macOS timestamp independence

**Files:**

- Modify: `scripts/__tests__/localbuild.spec.ts`
- Modify: `scripts/localbuild.js`
- Read/retain: `scripts/__tests__/sign-local-macos.spec.ts`
- Read/retain: `scripts/sign-local-macos.js`
- Modify: `docs/packaging-native-modules.md`

- [x] Add a regression assertion that localbuild configures Electron Builder with `--config.mac.timestamp=none`.
- [x] Run the targeted localbuild spec and confirm that assertion fails against the current implementation.
- [x] Add the minimal Electron Builder option required to disable timestamping for localbuild's per-file signing options.
- [x] Run the targeted signer and localbuild specs and confirm they pass.
- [x] Document that localbuild uses a real identity without requesting a trusted timestamp, while stable release signing remains timestamped and notarized.

### Task 2: Capture-hook integration test stability

**Files:**

- Modify: `src/main/doc-review/serve-review.spec.ts`
- Read/retain unless evidence requires a runtime change: `src/main/doc-review/assets/serve-review.mjs`

- [x] Reproduce the hook-output race repeatedly and confirm the fixed 500 ms polling budget is the failing boundary.
- [x] Add a bounded file-readiness helper that waits until all requested hook outputs exist and reports a useful timeout failure.
- [x] Replace the duplicated short polling loop with the helper without changing the server's intentionally non-blocking hook behavior.
- [x] Run the capture-server spec repeatedly, including under concurrent load if needed.

### Task 3: Verification and closure

**Files:**

- Rename after all checks pass: `docs/plans/2026-07-15-local-signing-and-review-hook-stability-plan.md` to `docs/plans/2026-07-15-local-signing-and-review-hook-stability-plan_completed.md`

- [x] Run the targeted signer/localbuild and capture-server specs.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Review the final diff and repository status, then record as-built notes below.
- [x] Rename this plan with `_completed` only after every applicable check succeeds.

## As-Built Notes

- Local macOS packaging now passes `--config.mac.timestamp=none` to Electron Builder. This reaches `@electron/osx-sign` through Electron Builder's per-file callback and emits `codesign --timestamp=none`; stable release configuration remains unchanged.
- The doc-review integration spec now uses an 8-second bounded `waitForFiles` readiness helper and waits for both hook outputs. A deliberate 650 ms hook delay reproduced the old `ENOENT` before the helper and passed afterward; the capture server remains non-blocking.
- Targeted verification: 3 files, 17 tests passed; the capture-server spec also passed 10 consecutive delayed-hook runs.
- Canonical verification: both TypeScript checks passed, lint passed, the TypeScript LOC ratchet passed, and the full suite passed 1,361 files / 13,389 tests in 346.7 seconds on an unchanged HEAD.
- Runtime packaging verification: `node scripts/localbuild.js` completed custom signing and produced `release/Harness-0.1.0-mac-arm64.dmg`; `codesign --verify --deep --strict`, helper Team ID verification, and `hdiutil verify` all passed.
- A concurrent Moore loop committed the tracked workspace changes while this task was running. This task did not invoke commit or push.
