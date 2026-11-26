# ACP Long-Running Tool Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent AIO from cancelling legitimate long-running ACP tool calls at the ordinary ten-minute prompt inactivity timeout.

**Architecture:** Keep the existing request-timeout mechanism and select its duration from the adapter's authoritative tool-call state. Pending/in-progress tools receive a separate 60-minute bounded inactivity lease; all other prompt states retain the ten-minute lease.

**Tech Stack:** TypeScript, Node timers, Agent Client Protocol, Vitest

**Spec:** [2026-08-25-acp-long-tool-timeout_spec_completed.md](../specs/2026-08-25-acp-long-tool-timeout_spec_completed.md)

## Global Constraints

- Preserve the ten-minute inactivity timeout when no ACP tool is active.
- Preserve the repeating stall-warning behaviour.
- Keep active-tool execution bounded at 60 minutes of ACP silence.
- Do not add settings, renderer, IPC, or provider-specific branches.
- Do not commit unless James explicitly requests it.

---

### Task 1: Make prompt inactivity timeouts tool-state-aware

**Files:**
- Modify: `src/main/cli/adapters/acp-cli-adapter.ts`
- Test: `src/main/cli/adapters/acp-cli-adapter.spec.ts`

**Interfaces:**
- Consumes: existing `toolCalls: Map<string, AcpObservedToolCall>` and `AcpToolCallStatus`
- Produces: optional `activeToolTimeoutMs` in `AcpCliAdapterConfig` and timeout selection internal to `AcpCliAdapter`

- [x] **Step 1: Write the failing long-tool regression test**

Add a test whose fake ACP agent emits a pending `tool_call`, stays silent beyond
`promptTimeoutMs`, then completes the tool and prompt before
`activeToolTimeoutMs`. Assert that `sendMessage()` resolves with the final
assistant content. This test catches removal or mis-selection of the active-tool
lease.

```typescript
it('keeps a prompt alive past promptTimeoutMs while an ACP tool is pending', async () => {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/prompt', (message) => {
    proc.notify('session/update', {
      sessionId: 'sess-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'long-suite',
        title: 'Run complete test suite',
        kind: 'execute',
        status: 'pending',
      },
    });
    setTimeout(() => {
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'long-suite',
          status: 'completed',
        },
      });
      proc.notify('session/update', {
        sessionId: 'sess-acp-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'suite complete' },
        },
      });
      proc.respond(message.id, { stopReason: 'end_turn' });
    }, 90);
  });

  const adapter = new TestAcpCliAdapter(proc, {
    command: process.execPath,
    workingDirectory: '/tmp',
    promptTimeoutMs: 40,
    activeToolTimeoutMs: 160,
    stallWarningMs: 0,
  });
  await adapter.spawn();

  const response = await adapter.sendMessage({ role: 'user', content: 'run tests' });
  expect(response.content).toBe('suite complete');
  proc.exit();
});
```

- [x] **Step 2: Run the long-tool test and verify RED**

Run:

```bash
rtk npm run test:quiet -- src/main/cli/adapters/acp-cli-adapter.spec.ts
```

Expected: the new test fails with an ACP `session/prompt` timeout at the shorter
`promptTimeoutMs`.

- [x] **Step 3: Add the bounded-timeout regression test**

Add a second test whose fake agent emits a pending tool and never settles.
Configure a short `activeToolTimeoutMs`, assert rejection at that value, and
assert that AIO sent a `session/cancel` notification. This catches accidental
removal of the safety bound.

```typescript
it('cancels a pending ACP tool at activeToolTimeoutMs when it stays silent', async () => {
  const proc = createInitializedAgentHarness();
  proc.onRequest('session/prompt', () => {
    proc.notify('session/update', {
      sessionId: 'sess-acp-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'stuck-tool',
        title: 'Stuck command',
        kind: 'execute',
        status: 'pending',
      },
    });
  });

  const adapter = new TestAcpCliAdapter(proc, {
    command: process.execPath,
    workingDirectory: '/tmp',
    promptTimeoutMs: 120,
    activeToolTimeoutMs: 50,
    stallWarningMs: 0,
  });
  await adapter.spawn();

  await expect(adapter.sendMessage({ role: 'user', content: 'run it' }))
    .rejects.toThrow(/session\/prompt request timed out after 50ms/);
  expect(proc.receivedMessages).toContainEqual(
    expect.objectContaining({ method: 'session/cancel' }),
  );
  proc.exit();
});
```

- [x] **Step 4: Implement the minimal timeout selection**

Add `DEFAULT_ACTIVE_TOOL_TIMEOUT_MS = 60 * 60_000` and an optional
`activeToolTimeoutMs` adapter configuration field. Add an internal predicate
that returns true when any observed tool is `pending` or `in_progress`. When a
prompt timer is refreshed, arm it with the active-tool value only while that
predicate is true; otherwise use the request's ordinary prompt timeout. Refresh
once more after a valid session update is handled so tool start/completion state
immediately changes the applicable lease.

```typescript
const DEFAULT_ACTIVE_TOOL_TIMEOUT_MS = 60 * 60_000;

private hasActiveToolCall(): boolean {
  return [...this.toolCalls.values()].some(
    (tool) => tool.status === 'pending' || tool.status === 'in_progress',
  );
}

private refreshCurrentPromptTimeout(): void {
  const id = this.currentPromptRequestId;
  if (!id) return;
  const pending = this.pendingRequests.get(id);
  if (!pending || pending.method !== 'session/prompt') return;

  const timeoutMs = this.hasActiveToolCall()
    ? this.acpConfig.activeToolTimeoutMs ?? DEFAULT_ACTIVE_TOOL_TIMEOUT_MS
    : pending.timeoutMs;
  clearTimeout(pending.timer);
  pending.timer = this.createRequestTimeout(id, pending.method, timeoutMs);
}
```

Clear the per-turn `toolCalls` map before each prompt and after it settles so a
provider that omits a terminal update cannot extend the following turn.

- [x] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
rtk npm run test:quiet -- src/main/cli/adapters/acp-cli-adapter.spec.ts
```

Expected: all ACP adapter tests pass, including the existing silent-prompt,
update-refresh, interrupt, and stall-warning cases.

- [x] **Step 6: Run canonical verification**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

**Evidence (2026-08-26) — all six green, on a clean checkout.** The earlier attempts recorded
against this step on 2026-08-25 could not produce an all-green aggregate because the shared
checkout kept changing underneath them: the twelve `prompt-retention` failures and the thirty
`copilot-account-handlers` failures both belonged to other sessions' uncommitted work, and the LOC
gate was blocked by an unrelated modified `context-worker-client.ts` at 708 lines. All of that work
has since been committed; `context-worker-client.ts` is now 698 lines and the ratchet passes.

```
npx tsc --noEmit                       → 0
npx tsc --noEmit -p tsconfig.spec.json → 0
npm run lint                           → 0   ("All files pass linting")
npm run check:ts-max-loc               → 0   (2,760 production files checked)
npm run build:main                     → 0   (incl. scripts/sync-dist.js asset mirroring)
npm run test:quiet                     → 0   (1,796 files / 19,042 tests passed in 198.9s)
```

The ACP adapter suite passes in isolation as well. The one code change in the tree at the time of
this run was an unrelated Copilot adapter fix (register item LT-527), which does not touch any ACP
path.

- [x] **Step 7: Run the independent completion gate**

The first fresh gate (2026-08-25) returned `FAIL`: repository-wide gates were red only in
concurrent out-of-scope work, and it asked for explicit integration coverage of `in_progress`,
repeated active updates, every terminal status, and overlapping tools. That coverage was added.
The second pass was blocked at the time by an unrelated LOC failure in another session's file.

**Second fresh gate, 2026-08-26 — `VERDICT: PASS`, no findings.** A fresh reviewer with no part in
the implementation read the plan against committed source and confirmed each item independently:

- `DEFAULT_ACTIVE_TOOL_TIMEOUT_MS = 60 * 60_000` in `acp-prompt-timeout-policy.ts`.
- `activeToolTimeoutMs` on `AcpCliAdapterConfig`, defaulted at construction.
- `hasActiveAcpToolCall()` matches `pending` and `in_progress` only.
- `refreshCurrentPromptTimeout()` runs on both update paths (`acp-cli-adapter.ts:1160` and `:1239`).
- The per-turn `toolCalls` map is cleared **before** each prompt (`:556`) and again in the `finally`
  (`:609`), so a provider that omits a terminal update cannot extend the following turn.
- The 60-minute bound is enforced, and `cancelTimedOutPrompt()` (`:2156`) sends `session/cancel`.
- 48/48 ACP adapter tests pass, covering the long-tool survival case, repeated `in_progress`
  refreshes, bounded cancellation with `session/cancel`, each terminal status restoring the ordinary
  lease, and overlapping tools holding the active lease until all settle.

- [x] **Step 8: Close documentation lifecycle**

Recorded above. Renamed to `2026-08-25-acp-long-tool-timeout_plan_completed.md`; the spec is now
`2026-08-25-acp-long-tool-timeout_spec_completed.md`.

The real-provider check requiring a rebuilt/restarted app remains deferred and is recorded in
[2026-08-25-acp-long-tool-timeout_livetest.md](2026-08-25-acp-long-tool-timeout_livetest.md). It is
**not** claimed as verified.
