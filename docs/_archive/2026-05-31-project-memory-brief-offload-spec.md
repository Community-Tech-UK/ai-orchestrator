# Project Memory Brief Offload Spec

- Date: 2026-05-31
- Status: Proposed
- Scope: move project memory brief assembly off the Electron main thread without changing brief content or prompt semantics.

## Goal

`project-memory-brief.ts` currently participates in create/resume prompt assembly from the main process. That is acceptable for correctness but not for responsiveness: the brief path fans into read-model materialization, history expansion, snippet selection, and formatting work that can block the main event loop under larger projects.

The target state is:

1. main thread owns orchestration and deadline policy only,
2. a worker-safe core computes the brief from clone-safe inputs,
3. the create/resume path races the worker result against a deadline and omits the brief on timeout.

## Non-goals

1. Rewriting project memory storage.
2. Changing the brief prompt format or ranking heuristics unless required for worker safety.
3. Mixing this refactor into unrelated wake/MCP/ledger work.

## Current problem

The current brief path is not a simple pure formatter. It is tightly coupled to services whose import graph is not worker-safe:

1. project-memory read-model access and candidate expansion,
2. history/snippet lookup helpers,
3. Electron-adjacent service initialization in the transitive import closure.

That makes a direct “just call the existing service from a worker” migration risky.

## Proposed architecture

### 1. Split the brief system into gateway + worker-safe core

Create three layers:

1. **Gateway (`project-memory-brief.ts`)**
   - main-thread entrypoint
   - validates inputs
   - exports clone-safe snapshots / requests
   - applies deadlines and logging

2. **Worker-safe core (`project-memory-brief-core.ts`)**
   - pure selection + formatting logic
   - no Electron imports
   - no singleton access
   - takes clone-safe inputs only

3. **Snapshot builder / hydrator**
   - materializes the minimal data needed by the core:
     - project key
     - ranked candidates
     - snippet/text payloads
     - stats inputs

### 2. Reuse the existing context worker

Do not add a separate brief worker unless profiling later proves contention. The same context worker used for wake-context and MCP selection should expose a new RPC such as:

`build-project-memory-brief(snapshot, options) -> ProjectMemoryBriefResult | null`

The worker owns only the pure brief build, not Electron APIs.

### 3. Main thread remains authoritative for service wiring

The main thread should still:

1. decide whether a brief is attempted,
2. build the snapshot from live services,
3. race the worker call against a deadline,
4. inject the returned brief text into the system prompt if it arrives in time.

Late results should be dropped, not deferred into a later user-shaped preamble, because the brief belongs in initial prompt assembly.

## Required refactor steps

### Phase A — isolate the core

1. Identify the exact ranking, truncation, and formatting logic inside `project-memory-brief.ts`.
2. Extract it into a new worker-safe module with direct data arguments.
3. Add tests that prove the extracted core produces identical text/stats for representative inputs.

### Phase B — snapshot the data

1. Define clone-safe snapshot types for brief candidates and supporting snippet data.
2. Build those snapshots on the main thread from the existing services.
3. Ensure the snapshot excludes non-cloneable objects and Electron handles.

### Phase C — worker RPC

1. Extend the context-worker protocol/client/main with a brief-build RPC.
2. Execute the worker-safe core inside the worker.
3. Return only text + stats payloads needed by prompt assembly.

### Phase D — lifecycle integration

1. Replace synchronous brief assembly in `instance-lifecycle.ts` with a deadline-bounded worker call.
2. Keep behavior-safe fallback: no brief on timeout/error.
3. Preserve existing logging/telemetry.

## API shape

Suggested snapshot/result contracts:

```ts
interface ProjectMemoryBriefSnapshot {
  projectKey: string;
  query: string | null;
  candidates: Array<{
    id: string;
    title: string | null;
    score: number;
    sourceType: string;
    content: string;
    metadata: Record<string, unknown>;
  }>;
  tokenBudget: number;
}

interface ProjectMemoryBriefWorkerResult {
  text: string;
  stats: {
    projectKey: string;
    candidatesScanned: number;
    candidatesIncluded: number;
    truncated: boolean;
  };
}
```

Exact fields can change, but the contract must stay clone-safe and free of service instances.

## Risks

1. **Import-closure regressions**: the worker must not pick up Electron-coupled modules through a barrel.
2. **Snapshot cost**: if snapshot building itself becomes expensive on the main thread, the refactor only partially helps. Measure this separately.
3. **Behavior drift**: the extracted core must preserve ranking and truncation semantics.

## Verification

1. Unit tests for the new pure core.
2. Worker protocol/client tests for the new brief RPC.
3. Lifecycle tests proving timeout fallback remains non-blocking.
4. Packaged-app smoke test confirming the worker import closure stays Electron-safe.

## Exit criteria

This refactor is complete when:

1. create/resume no longer runs project-memory brief assembly synchronously on the main thread,
2. the worker path is deadline-bounded,
3. prompt content remains behaviorally equivalent,
4. the worker import closure is Electron-safe in packaged builds.
