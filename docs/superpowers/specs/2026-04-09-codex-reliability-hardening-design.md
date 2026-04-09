# Codex Reliability Hardening Design

**Date:** 2026-04-09
**Status:** Draft
**Scope:** `app-server-client.ts`, `codex-cli-adapter.ts`, `app-server-broker.ts`, `limits.ts`

## Problem

Codex CLI integration frequently hangs for extended periods (12+ minutes observed) before timing out. The root causes are missing layered timeout defenses in the JSON-RPC client and adapter. When Codex stops responding mid-turn, the only safety net is a 5-minute turn-level timeout that fires too late and leaks its timer.

Additionally, process management gaps risk zombie/orphan processes, and the graceful shutdown window is too aggressive for Codex to flush state.

## Research Summary

### Approaches Evaluated

1. **@openai/codex-sdk** — Rejected. Spawns a new CLI process per turn (no persistent connection), lacks approval flow, turn steering, fine-grained streaming, and broker support. OpenAI explicitly recommends app-server for rich client integration. The SDK is designed for CI/CD batch jobs.

2. **t3code patterns** — Adopted partially. t3code's key reliability feature is a 20s per-RPC request timeout with cleanup on process exit. However, 20s is too aggressive for reasoning tasks that can legitimately take 60+ seconds. t3code also lacks notification idle watchdog and stuck turn detection.

3. **opencode patterns** — Informational. Uses HTTP API (not CLI), with SSE chunk-level timeouts and retry with exponential backoff respecting `retry-after` headers. Less relevant for our process-based integration.

4. **Web research findings** — Informed process management changes:
   - Zombie process accumulation (GitHub #12491): 1,300+ orphans consuming 37GB RAM due to missing process group kills
   - Shell command orphans (#4337): `setsid()` + `kill(-pid)` needed for clean tree termination
   - Don't stack retry layers (Nanobot lesson): SDK retries + app retries caused 10+ minute hangs

### Decision: Targeted Timeout Hardening (Approach A)

Add layered timeouts at each level without restructuring the architecture. This directly addresses every identified failure mode with minimal risk while preserving all existing features (broker, structured output, notification routing, approval flow).

## Changes

### 1. Per-RPC Timeout in `request()` — app-server-client.ts

**Problem:** `AppServerClientBase.request()` has zero timeout. If any JSON-RPC call hangs (e.g., `initialize`, `thread/resume`), it waits indefinitely until the overall 5-minute turn timeout catches it.

**Fix:** Add a configurable timeout parameter to `request()` with method-aware defaults:

| Method Category | Timeout | Rationale |
|----------------|---------|-----------|
| Control: `initialize`, `thread/start`, `thread/resume`, `thread/compact/start` | 60s | These should respond within seconds; 60s is generous |
| Turn: `turn/start` | No per-RPC timeout | Long-running by design; turn-level timeout + notification watchdog handle this |
| Default (everything else) | 30s | Catch-all for any other RPC calls |

On timeout: reject the promise with a `ProtocolError`, remove from pending map, log a warning. The timeout timer is stored alongside the pending request (matching t3code's pattern) and cleared on response.

```typescript
request<M extends AppServerMethod>(
  method: M,
  params: AppServerRequestParams<M>,
  timeoutMs?: number,  // NEW: optional per-call override
): Promise<AppServerResponseResult<M>> {
  if (this.closed) {
    throw new ProtocolError('codex app-server client is closed.');
  }

  const id = this.nextId++;
  const effectiveTimeout = timeoutMs ?? this.resolveDefaultTimeout(method);

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (effectiveTimeout > 0) {
      timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError(
          `RPC timeout: ${method} did not respond within ${effectiveTimeout}ms`
        ));
      }, effectiveTimeout);
      timer.unref(); // Don't prevent clean process exit
    }

    this.pending.set(id, { resolve, reject, method, timer });
    this.sendMessage({ id, method, params });
  });
}
```

Response handling clears the timer:
```typescript
if (pending) {
  if (pending.timer) clearTimeout(pending.timer);
  this.pending.delete(message['id']);
  // ... resolve/reject as before
}
```

Exit handling clears all timers:
```typescript
protected handleExit(error?: Error): void {
  this.closed = true;
  for (const [id, pending] of this.pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.reject(error || new ProtocolError('Connection closed'));
    this.pending.delete(id);
  }
  this.resolveExit();
}
```

### 2. Notification Idle Watchdog — codex-cli-adapter.ts

**Problem:** In app-server mode, if Codex stops sending notifications mid-turn (process alive but stalled), the only safety net is the 5-minute turn timeout. Users stare at a spinner for minutes.

**Fix:** In `captureTurn()`, maintain a notification idle timer that resets every time any notification arrives. If 90 seconds pass with zero notifications, reject the turn completion promise as stalled.

```typescript
// Inside captureTurn(), after installing notification handler:
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const resetIdleWatchdog = () => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!state.completed) {
      state.rejectCompletion(
        new Error(`Codex turn stalled: no notifications received for ${CODEX_TIMEOUTS.NOTIFICATION_IDLE_MS}ms`)
      );
    }
  }, CODEX_TIMEOUTS.NOTIFICATION_IDLE_MS);
  idleTimer.unref();
};

// Start watchdog after turn/start response
resetIdleWatchdog();

// Reset on every notification (inside the handler):
// this.handleTurnNotification(state, notification);
// resetIdleWatchdog();  // <-- add this

// Clean up in finally block:
// if (idleTimer) clearTimeout(idleTimer);
```

**Why 90 seconds:** Codex's `stream_idle_timeout_ms` defaults to 300s (5 min). 90s is well below that but generous enough that legitimate reasoning pauses (model thinking, tool execution) won't trigger false positives. If a tool call takes >90s, Codex still sends periodic `commandExecution/outputDelta` notifications for live output.

### 3. Fix Turn Timeout Timer Leak — codex-cli-adapter.ts

**Problem:** The `setTimeout` in the `Promise.race` at line 885-886 is never cleared on success. The timer holds a reference even after the turn completes normally.

**Fix:** Wrap the timeout in a cancellable pattern and clear it in the `finally` block:

```typescript
let turnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;

try {
  // ... setup code ...

  const timeoutMs = this.config.timeout;
  const completionOrCrash = Promise.race([
    state.completion,
    client.exitPromise.then(() => {
      if (!state.completed) {
        throw new Error('codex app-server exited unexpectedly during turn');
      }
      return state;
    }),
    new Promise<never>((_, reject) => {
      turnTimeoutTimer = setTimeout(
        () => reject(new Error(`Codex app-server turn timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
      turnTimeoutTimer.unref();
    }),
  ]);

  return await completionOrCrash;
} finally {
  if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer);
  if (idleTimer) clearTimeout(idleTimer);
  // ... existing cleanup ...
}
```

### 4. Process Group Spawning — app-server-client.ts

**Problem:** `SpawnedAppServerClient` spawns without `detached: true`, preventing proper process group kills. This causes zombie/orphan processes identical to the issue that produced 1,300+ zombies in Codex GitHub #12491.

**Fix:** Add `detached: true` to spawn options and update `terminateProcessTree()` to use negative PID for group kill:

```typescript
this.proc = spawn('codex', ['app-server'], {
  cwd: this.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
  shell: isWindows,
  detached: !isWindows, // NEW: process group isolation (Unix only)
});

// Prevent detached child from keeping parent alive
if (this.proc.pid && !isWindows) {
  this.proc.unref();
}
```

Update `terminateProcessTree()`:
```typescript
export function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;

  if (process.platform === 'win32') {
    // Windows: taskkill /PID /T /F (existing behavior)
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 5000 });
    } catch {
      try { process.kill(pid, signal); } catch { /* already dead */ }
    }
  } else {
    // Unix: kill the process group (negative PID)
    try {
      process.kill(-pid, signal); // Kill entire process group
    } catch {
      try { process.kill(pid, signal); } catch { /* already dead */ }
    }
  }
}
```

**Electron consideration:** `detached: true` with `.unref()` means the child process won't prevent Electron from exiting. The existing `beforeExit`/`SIGTERM`/`SIGINT` handlers in `CodexBrokerManager` handle cleanup.

### 5. Stdin Writable Guard — app-server-client.ts

**Problem:** `sendMessage()` writes to stdin unconditionally. If the pipe is closed or broken, this causes silent EPIPE errors.

**Fix:**
```typescript
protected sendMessage(message: Record<string, unknown>): void {
  if (this.proc?.stdin?.writable && !this.closed) {
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  } else {
    logger.warn('Cannot write to codex app-server stdin: pipe not writable');
  }
}
```

### 6. Increase Graceful Shutdown — app-server-client.ts

**Problem:** `GRACEFUL_SHUTDOWN_MS = 50` is too aggressive. Codex needs time to flush state to its internal DB. The 50ms window likely contributes to "timeout waiting for child process to exit" errors on resume.

**Fix:** Increase to 3000ms (3 seconds):
```typescript
const GRACEFUL_SHUTDOWN_MS = 3_000;
```

The `close()` method already handles this correctly — closes stdin, waits up to `GRACEFUL_SHUTDOWN_MS`, then force-kills if the process hasn't exited. The `.unref()` on the timer prevents it from keeping the process alive.

### 7. Centralized Constants — limits.ts

Add Codex-specific timeout constants alongside existing `TIMEOUTS`:

```typescript
/**
 * Codex-specific timeout configuration.
 * Tuned based on research from t3code (20s per-RPC), opencode (SSE chunk timeouts),
 * and Codex CLI defaults (300s stream idle).
 */
export const CODEX_TIMEOUTS = {
  /** Default per-RPC timeout for JSON-RPC requests. */
  RPC_DEFAULT_MS: 30_000,

  /** Per-RPC timeout for control methods (initialize, thread/start, thread/resume). */
  RPC_CONTROL_MS: 60_000,

  /** Notification idle watchdog during turn execution. */
  NOTIFICATION_IDLE_MS: 90_000,

  /** Graceful shutdown wait before force-kill. */
  GRACEFUL_SHUTDOWN_MS: 3_000,

  /** App-server initialization timeout (existing, now centralized). */
  APP_SERVER_INIT_MS: 30_000,

  /** Broker startup polling timeout (existing, now centralized). */
  BROKER_STARTUP_MS: 10_000,
} as const;
```

## Files Modified

| File | Change |
|------|--------|
| `src/shared/constants/limits.ts` | Add `CODEX_TIMEOUTS` constant |
| `src/main/cli/adapters/codex/app-server-client.ts` | Per-RPC timeout, process group spawn, stdin guard, graceful shutdown |
| `src/main/cli/adapters/codex/app-server-types.ts` | Update `PendingRequest` interface to include timer |
| `src/main/cli/adapters/codex-cli-adapter.ts` | Notification idle watchdog, fix timer leak |
| `src/main/cli/adapters/codex/app-server-broker.ts` | Use centralized `CODEX_TIMEOUTS.BROKER_STARTUP_MS` |

## Testing Strategy

1. **Unit tests:** Mock JSON-RPC client to verify timeout rejection and cleanup
2. **Integration:** Verify existing Codex flows still work with new timeouts
3. **Typecheck:** `npx tsc --noEmit` + `npx tsc --noEmit -p tsconfig.spec.json`
4. **Lint:** `npm run lint`

## Risks

- **False positive idle watchdog:** If Codex has a legitimate 90s+ pause between notifications (e.g., very large file processing with no streaming output). Mitigated by the 90s being well above normal inter-notification gaps. Can be increased via constant if needed.
- **Process group kill scope:** `detached: true` + `kill(-pid)` kills the entire process group. If Codex shares a group with other processes (unlikely given detached spawn), those would also be killed. Mitigated by detached spawn creating an isolated group.
- **Graceful shutdown increase:** 3s adds latency to shutdown/restart. Acceptable tradeoff for reliability.
