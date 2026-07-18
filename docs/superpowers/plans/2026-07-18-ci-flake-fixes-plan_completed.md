# CI Flake Fixes Implementation Plan

> **Status:** Completed and verified on 2026-07-18. Implementation was performed inline; a fresh read-only verifier ran the required independent completion gate.

**Goal:** Make the Linux CI test shards deterministic without weakening the production lifecycle guarantees they exercise.

**Architecture:** Keep production behavior unchanged. Synchronize the integration test with the `BrowserWriteJournal`'s documented asynchronous flush lifecycle before deleting its temporary directory, and assert the Codex broker disconnect through the stable typed runtime-error contract rather than OS-specific socket wording.

**Tech Stack:** TypeScript, Node.js sockets/filesystem, Vitest.

## Global Constraints

- Preserve unrelated changes in the dirty working tree.
- Do not commit or push.
- Use the existing CI failures as the red phase: run `29636765977` failed on Linux before these edits.
- Run targeted tests repeatedly, then the repository's canonical verification checklist.

---

### Task 1: Synchronize browser journal teardown

**Files:**

- Modify: `src/main/browser-gateway/browser-gateway-reliability-reconnect.spec.ts`

**Interfaces:**

- Consumes: `BrowserWriteJournal.flushPending(): Promise<void>`.
- Produces: deterministic test teardown that cannot race queued journal writes.

- [x] **Step 1: Preserve the test's journal for teardown**

Add a suite-scoped `BrowserWriteJournal` reference and assign the test-created journal to it.

- [x] **Step 2: Await journal durability before deleting its directory**

In `afterEach`, call `await journal?.flushPending()` before `fs.rm(journalDir, { recursive: true, force: true })`.

- [x] **Step 3: Verify the focused browser tests**

Run:

```bash
rtk npm run test:quiet -- src/main/browser-gateway/browser-gateway-reliability-reconnect.spec.ts src/main/browser-gateway/browser-write-journal.spec.ts
```

Expected: both files pass with no `ENOTEMPTY` teardown error.

### Task 2: Assert the stable Codex transport contract

**Files:**

- Modify: `src/main/cli/adapters/codex/app-server-client.spec.ts`

**Interfaces:**

- Consumes: `CodexAppServerRuntimeError` fields produced by `transportFailure()`.
- Produces: a cross-platform disconnect assertion covering `kind`, `recoverability`, and request `method`.

- [x] **Step 1: Replace the message regex assertion**

Change the in-flight rejection expectation from `/closed|Connection/i` to:

```ts
await expect(inFlight).rejects.toMatchObject({
  name: 'CodexAppServerRuntimeError',
  kind: 'transport-closed',
  recoverability: 'retry-thread',
  method: 'thread/start',
});
```

Keep the expectation attached before destroying the socket so the rejection cannot become unhandled.

- [x] **Step 2: Verify the focused Codex test**

Run:

```bash
rtk npm run test:quiet -- src/main/cli/adapters/codex/app-server-client.spec.ts
```

Expected: the broker lifecycle tests pass on the local platform while asserting the same stable fields Linux produces for `ECONNRESET`.

### Task 3: Regression and repository verification

**Files:**

- Update: this plan with as-built results.

- [x] **Step 1: Repeat the focused test set**

Run the three affected spec files repeatedly to catch remaining lifecycle races.

- [x] **Step 2: Run canonical gates**

Run:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

Expected: every command exits successfully.

- [x] **Step 3: Record evidence and close the plan**

Update this document with actual commands/results, rename it to `2026-07-18-ci-flake-fixes-plan_completed.md`, and verify the completed document and code changes remain uncommitted.

## As-Built Result

- `browser-gateway-reliability-reconnect.spec.ts` now retains its test-created journal and awaits `flushPending()` before deleting the temporary directory. This closes the Linux `ENOTEMPTY` teardown race without changing production journal behavior.
- `app-server-client.spec.ts` now asserts the stable `CodexAppServerRuntimeError` contract (`transport-closed`, `retry-thread`, `thread/start`) while remaining attached before socket destruction. Linux `ECONNRESET` and orderly FIN closure therefore exercise the same behavior contract.
- Focused browser tests passed: 2 files, 9 tests.
- Focused Codex tests passed: 1 file, 24 tests.
- Combined affected tests passed 10 consecutive runs: 3 files and 33 tests per run.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed.
- `npm run test:quiet`: passed with 1,524 files and 14,983 tests in 399.3 seconds.
- Independent completion gate: PASS. Its fresh run repeated the 10 focused iterations and all canonical gates; the full suite passed with 1,524 files, 14,983 passed, 1 pre-existing platform skip, and 0 failed in 430.27 seconds. It found no test weakening, suppression, scope drift, dependency/config changes, secrets, or async lifecycle issues.
