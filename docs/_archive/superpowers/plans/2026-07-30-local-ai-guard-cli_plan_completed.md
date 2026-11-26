# Local AI Guard CLI Implementation Plan

**Status:** Completed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe privileged CLI that discovers, validates, and enrols Local AI Guard targets through the running Harness parent.

**Architecture:** A new pure-JavaScript SEA command calls dedicated, schema-validated methods on the existing orchestrator-tools RPC socket. The Electron parent injects Local AI runtime operations; enrolment re-runs functional validation in the parent before using the authoritative target repository.

**Tech Stack:** TypeScript, Node SEA, Electron parent RPC, Zod 4, Vitest

## Global Constraints

- Work in the current checkout; do not create a branch or worktree.
- Use strict test-first development and observe each focused test fail before production edits.
- Do not expose socket paths, instance ids, endpoint credentials, raw prompt/model output, or secret resolver values.
- Do not write Local AI target rows directly from the SEA CLI.
- Do not commit or push.

---

### Task 1: CLI and RPC Contract

**Files:**
- Create: `src/main/mcp/local-ai-cli-contracts.ts`
- Create: `src/main/mcp/local-ai-cli.ts`
- Create: `src/main/mcp/local-ai-cli.spec.ts`
- Modify: `src/main/mcp/aio-mcp-dispatcher.ts`
- Modify: `src/main/mcp/aio-mcp-dispatcher.spec.ts`

**Interfaces:**
- Consumes: `OrchestratorToolsRpcClientLike.call(method, payload)`.
- Produces: `runLocalAiCli(argv, deps)` and method constants for `list`, `discover`, `validate`, and `enrol`.

- [x] **Step 1: Write failing command tests**

  Cover help, JSON parsing, invalid config JSON, strict result parsing, human
  summaries without evidence values, and dispatcher routing.

- [x] **Step 2: Verify RED**

  Run:

  ```bash
  npm run test:quiet -- src/main/mcp/local-ai-cli.spec.ts src/main/mcp/aio-mcp-dispatcher.spec.ts
  ```

  Expected: FAIL because the Local AI CLI module and dispatcher route do not exist.

- [x] **Step 3: Implement the SEA command**

  Parse exactly one command, optional `--json`, and one JSON configuration for
  `validate`/`enrol`. Validate every parent response with the bounded public Zod
  schemas before printing it.

- [x] **Step 4: Verify GREEN**

  Re-run the focused command and expect every test to pass.

### Task 2: Parent RPC Validation and Enrolment

**Files:**
- Create: `src/main/mcp/orchestrator-tools-rpc-local-ai.spec.ts`
- Modify: `src/main/mcp/orchestrator-tools-rpc-server.ts`

**Interfaces:**
- Consumes injected `list`, `discover`, `validate`, and `create` Local AI runtime operations.
- Produces authenticated `orchestrator_tools.local_ai.*` RPC methods.

- [x] **Step 1: Write failing parent tests**

  Assert strict payload validation, unavailable-operation errors, bounded result
  parsing, failed-required-probe rejection, duplicate rejection, and successful
  validation-before-create ordering.

- [x] **Step 2: Verify RED**

  Run:

  ```bash
  npm run test:quiet -- src/main/mcp/orchestrator-tools-rpc-local-ai.spec.ts
  ```

  Expected: FAIL because the RPC methods and injected operations do not exist.

- [x] **Step 3: Implement the parent methods**

  Parse requests before runtime work. For enrolment, reject an existing endpoint,
  run functional validation, require a non-empty result with all required probes
  passing, re-check duplication, then create and return `{ target, validation }`.

- [x] **Step 4: Verify GREEN**

  Re-run the focused command and expect every test to pass.

### Task 3: Canonical Runtime Wiring

**Files:**
- Create: `src/main/local-ai-guard/local-ai-public-operations.ts`
- Create: `src/main/local-ai-guard/local-ai-public-operations.spec.ts`
- Modify: `src/main/ipc/handlers/local-ai-guard-handlers.ts`
- Modify: `src/main/ipc/handlers/local-ai-guard-handlers.spec.ts`
- Modify: `src/main/app/orchestrator-tools-step.ts`
- Modify: `src/main/app/orchestrator-tools-step.spec.ts`

**Interfaces:**
- Consumes `LocalAiGuardRuntime` and `AuxiliaryLlmCandidate[]`.
- Produces shared bounded discovery sanitization and functional validation used by both IPC and CLI.

- [x] **Step 1: Write failing shared-operation and wiring tests**

  Assert that CLI wiring receives all four operations and that IPC discovery and
  validation preserve current sanitization, bounds, and non-persistence.

- [x] **Step 2: Verify RED**

  Run:

  ```bash
  npm run test:quiet -- \
    src/main/local-ai-guard/local-ai-public-operations.spec.ts \
    src/main/app/orchestrator-tools-step.spec.ts \
    src/main/ipc/handlers/local-ai-guard-handlers.spec.ts
  ```

  Expected: FAIL because the shared operation module and runtime injection do not exist.

- [x] **Step 3: Implement and wire shared operations**

  Move the existing safe discovery and validation logic into the focused module,
  call it from the renderer IPC handlers, and inject list/discover/validate/create
  operations into the orchestrator-tools RPC server.

- [x] **Step 4: Verify GREEN**

  Re-run the focused command and expect every test to pass.

### Task 4: Documentation, Build, and Live Configuration

**Files:**
- Modify: `docs/AIO_MCP_CLI.md`
- Modify: `docs/llm/AIO_MCP_CLI_REFERENCE.md`
- Modify: `docs/superpowers/specs/2026-07-30-local-ai-guard-cli_spec_planned.md`
- Modify: `docs/superpowers/plans/2026-07-30-local-ai-guard-cli_plan.md`

**Interfaces:**
- Consumes the completed command contract.
- Produces operator and agent instructions plus live target configuration evidence.

- [x] **Step 1: Update CLI documentation**

  Document all four commands, JSON configuration semantics, validation-before-
  enrolment behaviour, environment requirements, and safe failure handling.

- [x] **Step 2: Run focused and canonical verification**

  Run:

  ```bash
  npx tsc --noEmit
  npx tsc --noEmit -p tsconfig.spec.json
  npm run lint
  npm run check:ts-max-loc
  npm run build:main
  npm run test:quiet
  npm run build:aio-mcp-dist
  ```

- [x] **Step 3: Verify the built command**

  Run:

  ```bash
  dist/aio-mcp-cli-sea/aio-mcp --help
  dist/aio-mcp-cli-sea/aio-mcp local-ai --help
  ```

- [ ] **Step 4: Configure the live Windows endpoint**

  From a Harness-spawned shell with the injected RPC environment, run discovery,
  validate the selected configuration, enrol it, and list it back. If the parent
  app must be rebuilt/restarted first, record the exact live step in a dedicated
  `_livetest.md` instead of claiming enrolment.

  Deferred to
  [2026-07-30-local-ai-guard-cli_plan_livetest.md](./2026-07-30-local-ai-guard-cli_plan_livetest.md)
  because the resumed implementation shell had no injected parent-RPC
  environment and the running packaged parent predated the new RPC methods.

## Verification Evidence

- Latest focused CLI/dispatcher/RPC/runtime/IPC/app suite: 6 files, 97 tests
  passed.
- Production and specification TypeScript checks: passed.
- Direct changed-file ESLint and project Angular lint: passed.
- TypeScript LOC ratchet: passed without raising a ceiling.
- `build:main`: passed, including preload bundle and asset sync.
- `build:aio-mcp-dist`: passed; the SEA binary lists `local-ai` and its four commands.
- First full suite: 16,729/16,730 passed; one unrelated Cursor timeout test
  failed, then its isolated 52-test file passed.
- Clean full-suite rerun: 1,644 files, 16,763 tests passed in 542.6 seconds.
- Final full suite after review repairs: 1,646 files, 16,781 tests passed in
  595.4 seconds.
- Fresh completion-gate full suite: 1,646 files, 16,781 tests passed with an
  8 GB verifier heap.
- Review repair: enrolment now requires `lifecycle: "enrolled"` at both the CLI
  and parent boundaries.
- Review repair: validate/enrol RPC deadlines now cover the complete bounded
  functional probe sequence; the maximum Ollama case receives 491,000 ms.

- [x] **Step 5: Independent completion review**

  Send the complete diff and acceptance criteria to a fresh agent using the
  `task-completion-gate` skill. Repair and repeat until it returns
  `VERDICT: PASS`.

- [x] **Step 6: Close the documentation lifecycle**

  Update as-built evidence, link completed filenames, then rename the plan to
  `_plan_completed.md` and the spec to `_spec_completed.md`. Leave all changes
  uncommitted.

## As-Built Summary

The SEA command, strict contracts, authenticated parent dispatch, shared public
runtime operations, renderer reuse, app initialization, documentation, and
tests are complete. Two fresh completion-gate reviews returned `VERDICT: PASS`
with no unresolved findings.

The installed/running Harness parent predates these RPC methods, so the
Windows endpoint discovery, functional validation, durable enrolment, readback,
and duplicate rejection remain live checks in
[2026-07-30-local-ai-guard-cli_plan_livetest.md](./2026-07-30-local-ai-guard-cli_plan_livetest.md).
