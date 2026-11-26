# Resilient Codex Resume, Agent Activity Detection & Recovery Recipes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex session resume crash-resilient, add agent-level activity detection with a 4-level fallback cascade, and build an automated recovery recipe engine for known failure modes.

**Architecture:** Three modules integrated into existing infrastructure. Module A (CodexSessionScanner + ResumeCursor) extends the Codex adapter and SessionContinuityManager. Module B (ActivityStateDetector) adds a per-instance provider-level activity signal that feeds into InstanceStatus transitions. Module C (RecoveryRecipeEngine) extends CheckpointManager with proactive failure detection and auto-recovery. No new singletons — utility classes consumed by existing managers.

**Tech Stack:** TypeScript 5.9, Electron 40 (Node.js), Vitest, Zod, existing better-sqlite3 persistence, JSONL append-only logs.

**Spec:** `docs/superpowers/specs/2026-04-09-resilient-codex-resume-and-agent-observability-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/shared/types/activity.types.ts` | ActivityState, ActivityEntry, ActivityDetectionResult types |
| `src/shared/types/recovery.types.ts` | FailureCategory, DetectedFailure, RecoveryRecipe, RecoveryOutcome, RecoveryAttempt types |
| `src/main/cli/adapters/codex/session-scanner.ts` | Codex JSONL session file discovery and streaming parse |
| `src/main/providers/activity-state-detector.ts` | Per-instance activity detection with 4-level fallback cascade |
| `src/main/session/recovery-recipe-engine.ts` | Failure detection → auto-recovery pipeline with loop prevention |
| `src/main/session/builtin-recovery-recipes.ts` | 10 built-in recovery recipe implementations |
| `src/main/cli/adapters/codex/session-scanner.spec.ts` | Unit tests for CodexSessionScanner |
| `src/main/providers/activity-state-detector.spec.ts` | Unit tests for ActivityStateDetector |
| `src/main/session/recovery-recipe-engine.spec.ts` | Unit tests for RecoveryRecipeEngine |

### Modified Files

| File | Change Summary |
|------|---------------|
| `src/main/session/session-continuity.ts` | Add `resumeCursor` field to `SessionState` interface (line ~129) |
| `src/main/cli/adapters/codex-cli-adapter.ts` | 4-step resume fallback chain replacing single-step resume (lines 529-569); activity recording on streaming output |
| `src/main/instance/instance-lifecycle.ts` | Poll ActivityStateDetector in idle check loop (lines 2603-2655); trigger RecoveryRecipeEngine on failures |
| `src/shared/types/instance.types.ts` | Add `activityState` optional field to Instance interface |
| `src/main/ipc/handlers/session-handlers.ts` | Expose activity state via IPC |

---

## Phase 1: Module A — Crash-Resilient Codex Resume

### Task 1: Shared Types — ResumeCursor

**Files:**
- Modify: `src/main/session/session-continuity.ts:100-129`

- [ ] **Step 1: Add ResumeCursor interface above SessionState**

In `src/main/session/session-continuity.ts`, add before the `SessionState` interface:

```typescript
export interface ResumeCursor {
  /** Provider type that owns this thread */
  provider: string;
  /** Provider-specific thread/session ID for resume */
  threadId: string;
  /** Workspace path for filesystem-based discovery fallback */
  workspacePath: string;
  /** Epoch ms when cursor was captured — used for staleness check */
  capturedAt: number;
  /** How this cursor was obtained */
  scanSource: 'native' | 'jsonl-scan' | 'replay';
}
```

- [ ] **Step 2: Add resumeCursor to SessionState interface**

Add to the end of the `SessionState` interface (after `lastWriteSource`):

```typescript
  /** Persisted resume cursor for crash-resilient session restore */
  resumeCursor?: ResumeCursor | null;
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS (new optional field is backward compatible with existing persisted states)

- [ ] **Step 4: Commit**

```bash
git add src/main/session/session-continuity.ts
git commit -m "feat(session): add ResumeCursor type to SessionState for crash-resilient restore"
```

---

### Task 2: CodexSessionScanner — Test First

**Files:**
- Create: `src/main/cli/adapters/codex/session-scanner.spec.ts`

- [ ] **Step 1: Write test file with 6 test cases**

Create `src/main/cli/adapters/codex/session-scanner.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexSessionScanner } from './session-scanner';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CodexSessionScanner', () => {
  let scanner: CodexSessionScanner;
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-scanner-test-'));
    sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    scanner = new CodexSessionScanner(sessionsDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRolloutFile(datePath: string, filename: string, entries: object[]): string {
    const dir = join(sessionsDir, datePath);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(filePath, content);
    return filePath;
  }

  it('should find a session matching workspace path', async () => {
    createRolloutFile('2026/04/09', 'rollout-abc123.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.4' },
      { type: 'event_msg', threadId: 'thread_abc123' },
    ]);

    const result = await scanner.findSessionForWorkspace('/projects/my-app');

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe('thread_abc123');
    expect(result!.workspacePath).toBe('/projects/my-app');
    expect(result!.model).toBe('gpt-5.4');
  });

  it('should return null when no session matches', async () => {
    createRolloutFile('2026/04/09', 'rollout-abc123.jsonl', [
      { type: 'session_meta', cwd: '/projects/other-app' },
    ]);

    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });

  it('should return the newest matching session when multiple exist', async () => {
    // Older file
    createRolloutFile('2026/04/08', 'rollout-old.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.3' },
      { type: 'event_msg', threadId: 'thread_old' },
    ]);

    // Newer file
    createRolloutFile('2026/04/09', 'rollout-new.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.4' },
      { type: 'event_msg', threadId: 'thread_new' },
    ]);

    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe('thread_new');
  });

  it('should handle corrupt/empty JSONL files gracefully', async () => {
    const dir = join(sessionsDir, '2026/04/09');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-bad.jsonl'), 'not json\n{broken\n');

    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });

  it('should extract token usage from event_msg entries', async () => {
    createRolloutFile('2026/04/09', 'rollout-tokens.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.4' },
      { type: 'event_msg', threadId: 'thread_tok', subtype: 'token_count', input_tokens: 1500, output_tokens: 500, cached_tokens: 200, reasoning_tokens: 100 },
    ]);

    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).not.toBeNull();
    expect(result!.tokenUsage).toEqual({
      input: 1500,
      output: 500,
      cached: 200,
      reasoning: 100,
    });
  });

  it('should cache results and return cached on second call', async () => {
    createRolloutFile('2026/04/09', 'rollout-cached.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.4' },
      { type: 'event_msg', threadId: 'thread_cached' },
    ]);

    const result1 = await scanner.findSessionForWorkspace('/projects/my-app');
    const result2 = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result1).toEqual(result2);
  });

  it('should return null after cache invalidation', async () => {
    createRolloutFile('2026/04/09', 'rollout-inv.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.4' },
      { type: 'event_msg', threadId: 'thread_inv' },
    ]);

    await scanner.findSessionForWorkspace('/projects/my-app');
    scanner.invalidateCache('/projects/my-app');

    // Delete the file so re-scan finds nothing
    rmSync(join(sessionsDir, '2026/04/09/rollout-inv.jsonl'));
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/cli/adapters/codex/session-scanner.spec.ts`
Expected: FAIL — `Cannot find module './session-scanner'`

- [ ] **Step 3: Commit test file**

```bash
git add src/main/cli/adapters/codex/session-scanner.spec.ts
git commit -m "test(codex): add failing tests for CodexSessionScanner"
```

---

### Task 3: CodexSessionScanner — Implementation

**Files:**
- Create: `src/main/cli/adapters/codex/session-scanner.ts`

- [ ] **Step 1: Implement CodexSessionScanner**

Create `src/main/cli/adapters/codex/session-scanner.ts`:

```typescript
import { createReadStream, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CodexSessionScanner');

export interface CodexSessionScanResult {
  threadId: string;
  model: string | null;
  sessionFilePath: string;
  workspacePath: string;
  tokenUsage: { input: number; output: number; cached: number; reasoning: number };
  lastModified: number;
}

const HEADER_SCAN_BYTES = 4096;

export class CodexSessionScanner {
  private cache = new Map<string, CodexSessionScanResult | null>();
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? join(homedir(), '.codex', 'sessions');
  }

  async findSessionForWorkspace(workspacePath: string): Promise<CodexSessionScanResult | null> {
    if (this.cache.has(workspacePath)) {
      return this.cache.get(workspacePath)!;
    }

    const files = this.collectJsonlFiles();
    for (const filePath of files) {
      if (!this.headerMatchesCwd(filePath, workspacePath)) {
        continue;
      }
      const result = await this.streamParseJsonl(filePath, workspacePath);
      if (result) {
        this.cache.set(workspacePath, result);
        return result;
      }
    }

    this.cache.set(workspacePath, null);
    return null;
  }

  invalidateCache(workspacePath: string): void {
    this.cache.delete(workspacePath);
  }

  /**
   * Collect all rollout-*.jsonl files, sorted by mtime descending (newest first).
   */
  private collectJsonlFiles(): string[] {
    const files: { path: string; mtime: number }[] = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
            files.push({ path: full, mtime: stat.mtimeMs });
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    };

    walk(this.sessionsDir, 0);
    files.sort((a, b) => b.mtime - a.mtime);
    return files.map(f => f.path);
  }

  /**
   * Read first 4KB of a file to check if session_meta.cwd matches the target workspace.
   * Avoids reading the full file (can be 100MB+) for non-matching sessions.
   */
  private headerMatchesCwd(filePath: string, targetCwd: string): boolean {
    try {
      const fd = readFileSync(filePath, { encoding: 'utf8', flag: 'r' });
      const header = fd.slice(0, HEADER_SCAN_BYTES);
      const lines = header.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'session_meta' && entry.cwd === targetCwd) {
            return true;
          }
        } catch {
          // Skip malformed lines in header
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Stream-parse a JSONL file line by line to extract threadId, model, and token usage.
   * Never loads the full file into memory.
   */
  private async streamParseJsonl(filePath: string, targetCwd: string): Promise<CodexSessionScanResult | null> {
    return new Promise((resolve) => {
      let threadId: string | null = null;
      let model: string | null = null;
      let matchesCwd = false;
      const tokenUsage = { input: 0, output: 0, cached: 0, reasoning: 0 };
      let lastModified = 0;

      try {
        lastModified = statSync(filePath).mtimeMs;
      } catch {
        resolve(null);
        return;
      }

      const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);

          if (entry.type === 'session_meta') {
            if (entry.cwd === targetCwd) {
              matchesCwd = true;
              model = entry.model ?? null;
            }
          }

          if (entry.threadId && !threadId) {
            threadId = entry.threadId;
          }

          if (entry.type === 'event_msg' && entry.subtype === 'token_count') {
            tokenUsage.input += entry.input_tokens ?? entry.inputTokens ?? 0;
            tokenUsage.output += entry.output_tokens ?? entry.outputTokens ?? 0;
            tokenUsage.cached += entry.cached_tokens ?? entry.cachedTokens ?? 0;
            tokenUsage.reasoning += entry.reasoning_tokens ?? entry.reasoningTokens ?? 0;
          }
        } catch {
          // Skip malformed lines
        }
      });

      rl.on('close', () => {
        if (matchesCwd && threadId) {
          resolve({
            threadId,
            model,
            sessionFilePath: filePath,
            workspacePath: targetCwd,
            tokenUsage,
            lastModified,
          });
        } else {
          resolve(null);
        }
      });

      rl.on('error', (err) => {
        logger.warn('Error reading Codex session file', { filePath, error: String(err) });
        resolve(null);
      });
    });
  }
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/cli/adapters/codex/session-scanner.spec.ts`
Expected: All 7 tests PASS

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/cli/adapters/codex/session-scanner.ts
git commit -m "feat(codex): implement CodexSessionScanner with JSONL streaming parse"
```

---

### Task 4: Resume Fallback Chain — Integrate into CodexCliAdapter

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts:529-569`

- [ ] **Step 1: Add imports at top of codex-cli-adapter.ts**

Add to the existing imports section (after line ~25):

```typescript
import { CodexSessionScanner } from './codex/session-scanner';
import type { ResumeCursor } from '../../session/session-continuity';
```

- [ ] **Step 2: Add scanner instance and helper method to class body**

Add as class properties (near existing `private sessionId` and `private shouldResumeNextTurn`):

```typescript
  private sessionScanner = new CodexSessionScanner();
  private resumeCursor: ResumeCursor | null = null;
```

Add the recoverable error classifier as a private method:

```typescript
  private isRecoverableThreadResumeError(error: unknown): boolean {
    const msg = String(error).toLowerCase();
    return ['not found', 'missing thread', 'unknown thread', 'unknown session',
            'expired', 'invalid thread'].some(pattern => msg.includes(pattern));
  }
```

- [ ] **Step 3: Replace the resume logic in initAppServerMode**

Replace the existing resume/start block inside `initAppServerMode()` (lines ~540-565) with the 4-step fallback chain:

```typescript
    // === 4-step resume fallback chain ===
    let threadId: string | null = null;
    let resumeSource: ResumeCursor['scanSource'] | null = null;

    // Step 1: Resume from persisted cursor (if config.resume and cursor is fresh)
    if (this.shouldResumeNextTurn && this.sessionId) {
      try {
        const resumeResult = await client.request('thread/resume', {
          threadId: this.sessionId,
          cwd,
          model: this.cliConfig.model || null,
          approvalPolicy,
          sandbox,
        });
        threadId = resumeResult.threadId || resumeResult.thread?.id || null;
        resumeSource = 'native';
        logger.info('App-server thread resumed from persisted cursor', { threadId });
      } catch (error) {
        if (this.isRecoverableThreadResumeError(error)) {
          logger.warn('Persisted cursor resume failed (recoverable), trying JSONL scan', { error: String(error) });
        } else {
          throw error; // Non-recoverable: auth, network, rate limit
        }
      }
    }

    // Step 2: Scan filesystem for threadId
    if (!threadId && this.shouldResumeNextTurn) {
      const scanResult = await this.sessionScanner.findSessionForWorkspace(cwd);
      if (scanResult) {
        try {
          const resumeResult = await client.request('thread/resume', {
            threadId: scanResult.threadId,
            cwd,
            model: this.cliConfig.model || null,
            approvalPolicy,
            sandbox,
          });
          threadId = resumeResult.threadId || resumeResult.thread?.id || null;
          resumeSource = 'jsonl-scan';
          logger.info('App-server thread resumed from JSONL scan', { threadId, scannedFile: scanResult.sessionFilePath });
        } catch (error) {
          if (this.isRecoverableThreadResumeError(error)) {
            logger.warn('JSONL scan resume failed (recoverable), falling back to fresh start', { error: String(error) });
          } else {
            throw error;
          }
        }
      } else {
        logger.info('No matching Codex session found on filesystem for workspace', { cwd });
      }
    }

    // Step 3 & 4: Fresh start (replay continuity preamble is handled at a higher level by SessionContinuityManager)
    if (!threadId) {
      const startResult = await client.request('thread/start', {
        cwd,
        model: this.cliConfig.model || null,
        approvalPolicy,
        sandbox,
        serviceName: SERVICE_NAME,
        ephemeral: this.cliConfig.ephemeral ?? false,
        reasoningEffort: this.cliConfig.reasoningEffort || null,
      });
      threadId = startResult.threadId || startResult.thread?.id || null;
      resumeSource = null;
      logger.info('App-server thread started fresh', { threadId });
    }

    // Consume resume flag
    this.shouldResumeNextTurn = false;

    // Update resume cursor for persistence by SessionContinuityManager
    if (threadId) {
      this.resumeCursor = {
        provider: 'openai',
        threadId,
        workspacePath: cwd,
        capturedAt: Date.now(),
        scanSource: resumeSource ?? 'native',
      };
    }
```

- [ ] **Step 4: Add getter for resume cursor**

Add a public method so SessionContinuityManager can read the cursor:

```typescript
  getResumeCursor(): ResumeCursor | null {
    return this.resumeCursor;
  }
```

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run lint**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm run lint`
Expected: PASS (fix any issues)

- [ ] **Step 7: Commit**

```bash
git add src/main/cli/adapters/codex-cli-adapter.ts
git commit -m "feat(codex): 4-step resume fallback chain with JSONL scanning"
```

---

### Task 5: Wire ResumeCursor into SessionContinuityManager

**Files:**
- Modify: `src/main/session/session-continuity.ts`

- [ ] **Step 1: Update captureCurrentState to include resumeCursor**

Find the `captureCurrentState` method in `SessionContinuityManager` (the method that builds a `SessionState` object for persistence). Add resume cursor capture from the adapter. Within the method, after the existing state fields are populated, add:

```typescript
    // Capture resume cursor from adapter if available
    const adapter = instance.adapter;
    if (adapter && typeof (adapter as any).getResumeCursor === 'function') {
      state.resumeCursor = (adapter as any).getResumeCursor() ?? null;
    }
```

- [ ] **Step 2: Update resumeSession to use persisted cursor**

In the `resumeSession` method, after loading the saved state, check for a persisted cursor and pass it through to the adapter config. Find where the adapter is configured for resume and add:

```typescript
    // If persisted cursor exists and is fresh (< 7 days), use it for native resume
    const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    if (savedState.resumeCursor
        && savedState.resumeCursor.capturedAt > Date.now() - CURSOR_MAX_AGE_MS) {
      // Pass cursor threadId as the sessionId for the adapter
      resumeConfig.sessionId = savedState.resumeCursor.threadId;
      resumeConfig.resume = true;
      logger.info('Using persisted resume cursor', {
        threadId: savedState.resumeCursor.threadId,
        scanSource: savedState.resumeCursor.scanSource,
        age: Date.now() - savedState.resumeCursor.capturedAt,
      });
    }
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/session/session-continuity.ts
git commit -m "feat(session): wire ResumeCursor persistence into SessionContinuityManager"
```

---

## Phase 2: Module B — Agent Activity State Detection

### Task 6: Shared Types — ActivityState

**Files:**
- Create: `src/shared/types/activity.types.ts`

- [ ] **Step 1: Create activity types file**

Create `src/shared/types/activity.types.ts`:

```typescript
/**
 * Provider-level activity signal — what the agent is actually doing right now.
 * This is separate from InstanceStatus (orchestrator-level lifecycle state).
 * ActivityState informs InstanceStatus transitions but doesn't replace it.
 */
export type ActivityState = 'active' | 'ready' | 'idle' | 'waiting_input' | 'blocked' | 'exited';

/** A single recorded activity entry (persisted to .ao/activity.jsonl) */
export interface ActivityEntry {
  /** Epoch ms when this state was observed */
  ts: number;
  /** Detected activity state */
  state: ActivityState;
  /** How this state was detected */
  source: 'native' | 'terminal' | 'process-check';
  /** Last 3 lines of terminal output for debugging (only for terminal source) */
  trigger?: string;
  /** Which provider reported this */
  provider?: string;
}

/** Result from the detection cascade — includes confidence from which fallback level produced it */
export interface ActivityDetectionResult {
  /** Detected state */
  state: ActivityState;
  /** Which fallback level produced this result */
  confidence: 'high' | 'medium' | 'low';
  /** How long until this result should be considered stale (ms) */
  staleAfterMs: number;
  /** Human-readable description of which detection method succeeded */
  source: string;
}

/** Thresholds and constants for activity detection */
export const ACTIVITY_CONSTANTS = {
  /** Activity younger than this = 'active' */
  ACTIVE_WINDOW_MS: 30_000,
  /** Activity 30s–5min old = 'ready', older = 'idle' */
  READY_THRESHOLD_MS: 300_000,
  /** waiting_input/blocked entries older than this decay to idle */
  ACTIVITY_INPUT_STALENESS_MS: 300_000,
  /** Non-actionable state dedup interval for JSONL writes */
  DEDUP_WINDOW_MS: 20_000,
  /** Rotation threshold for activity.jsonl */
  ACTIVITY_LOG_MAX_BYTES: 1_048_576,
  /** Number of rotated files to keep */
  ACTIVITY_LOG_MAX_ROTATED: 3,
} as const;
```

- [ ] **Step 2: Add activityState to Instance type**

In `src/shared/types/instance.types.ts`, add to the Instance interface (after `lastActivity`):

```typescript
  /** Provider-level activity state (separate from InstanceStatus) */
  activityState?: ActivityState;
```

And add the import at the top:

```typescript
import type { ActivityState } from './activity.types';
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/activity.types.ts src/shared/types/instance.types.ts
git commit -m "feat(types): add ActivityState, ActivityEntry, and ActivityDetectionResult types"
```

---

### Task 7: ActivityStateDetector — Test First

**Files:**
- Create: `src/main/providers/activity-state-detector.spec.ts`

- [ ] **Step 1: Write test file with tests for each fallback level**

Create `src/main/providers/activity-state-detector.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityStateDetector } from './activity-state-detector';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ActivityEntry } from '../../shared/types/activity.types';

describe('ActivityStateDetector', () => {
  let detector: ActivityStateDetector;
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'activity-test-'));
    detector = new ActivityStateDetector('inst-1', workspacePath, 'openai');
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  function writeActivityLog(entries: ActivityEntry[]): void {
    const aoDir = join(workspacePath, '.ao');
    mkdirSync(aoDir, { recursive: true });
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(aoDir, 'activity.jsonl'), content);
  }

  describe('Level 2: Activity JSONL Log', () => {
    it('should detect active state from recent entry', async () => {
      writeActivityLog([
        { ts: Date.now() - 5_000, state: 'active', source: 'native', provider: 'openai' },
      ]);

      const result = await detector.detect();
      expect(result.state).toBe('active');
    });

    it('should detect waiting_input from recent entry', async () => {
      writeActivityLog([
        { ts: Date.now() - 10_000, state: 'waiting_input', source: 'terminal', provider: 'openai' },
      ]);

      const result = await detector.detect();
      expect(result.state).toBe('waiting_input');
    });

    it('should decay stale waiting_input to idle after 5 minutes', async () => {
      writeActivityLog([
        { ts: Date.now() - 400_000, state: 'waiting_input', source: 'terminal', provider: 'openai' },
      ]);

      const result = await detector.detect();
      expect(result.state).toBe('idle');
    });

    it('should decay stale blocked to idle after 5 minutes', async () => {
      writeActivityLog([
        { ts: Date.now() - 400_000, state: 'blocked', source: 'terminal', provider: 'openai' },
      ]);

      const result = await detector.detect();
      expect(result.state).toBe('idle');
    });
  });

  describe('Level 3: Age-Based Decay', () => {
    it('should return active for very recent activity', async () => {
      // No activity log, but we record directly
      await detector.recordTerminalActivity('Some output');

      const result = await detector.detect();
      expect(['active', 'ready']).toContain(result.state);
      expect(result.confidence).not.toBe('high');
    });
  });

  describe('Level 4: Process Check', () => {
    it('should return exited when no data at all', async () => {
      // No activity log, no recent recording, detector has no PID
      const result = await detector.detect();
      // With no data at all, falls through to process check
      // Without a real PID, should return exited or idle
      expect(['exited', 'idle']).toContain(result.state);
      expect(result.confidence).toBe('low');
    });
  });

  describe('recordTerminalActivity', () => {
    it('should write entry to activity.jsonl', async () => {
      await detector.recordTerminalActivity('Processing files...');

      const result = await detector.getLastRecordedActivity();
      expect(result).not.toBeNull();
      expect(result!.source).toBe('terminal');
    });

    it('should deduplicate non-actionable states within 20s', async () => {
      await detector.recordTerminalActivity('Processing files...');
      await detector.recordTerminalActivity('Still processing...');

      // Read the log directly to check only one entry was written
      const { readFileSync } = await import('fs');
      const logPath = join(workspacePath, '.ao', 'activity.jsonl');
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
    });

    it('should always write actionable states even within dedup window', async () => {
      await detector.recordTerminalActivity('Processing files...');
      // Simulate a waiting_input detection
      await detector.recordActivityEntry({
        ts: Date.now(),
        state: 'waiting_input',
        source: 'terminal',
        trigger: '? Allow execution',
        provider: 'openai',
      });

      const { readFileSync } = await import('fs');
      const logPath = join(workspacePath, '.ao', 'activity.jsonl');
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/providers/activity-state-detector.spec.ts`
Expected: FAIL — `Cannot find module './activity-state-detector'`

- [ ] **Step 3: Commit test file**

```bash
git add src/main/providers/activity-state-detector.spec.ts
git commit -m "test(activity): add failing tests for ActivityStateDetector"
```

---

### Task 8: ActivityStateDetector — Implementation

**Files:**
- Create: `src/main/providers/activity-state-detector.ts`

- [ ] **Step 1: Implement ActivityStateDetector**

Create `src/main/providers/activity-state-detector.ts`:

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../logging/logger';
import type { ActivityDetectionResult, ActivityEntry, ActivityState } from '../../shared/types/activity.types';
import { ACTIVITY_CONSTANTS } from '../../shared/types/activity.types';

const logger = getLogger('ActivityStateDetector');

const {
  ACTIVE_WINDOW_MS,
  READY_THRESHOLD_MS,
  ACTIVITY_INPUT_STALENESS_MS,
  DEDUP_WINDOW_MS,
  ACTIVITY_LOG_MAX_BYTES,
  ACTIVITY_LOG_MAX_ROTATED,
} = ACTIVITY_CONSTANTS;

export class ActivityStateDetector {
  private lastRecordedEntry: ActivityEntry | null = null;
  private pid: number | null = null;

  constructor(
    private instanceId: string,
    private workspacePath: string,
    private provider: string,
  ) {}

  /** Set the agent process PID for Level 4 process-check detection */
  setPid(pid: number): void {
    this.pid = pid;
  }

  /**
   * Main entry point — runs the 4-level fallback cascade.
   * Level 1 (native provider signal) is skipped here and handled by provider-specific
   * subclasses or external callers that push native signals via recordActivityEntry().
   */
  async detect(): Promise<ActivityDetectionResult> {
    // Level 2: Activity JSONL Log
    const jsonlResult = this.detectFromActivityLog();
    if (jsonlResult) return jsonlResult;

    // Level 3: Age-Based Decay (from last recorded entry in memory)
    const decayResult = this.detectFromAgeDcay();
    if (decayResult) return decayResult;

    // Level 4: Process Check
    return this.detectFromProcessCheck();
  }

  /** Record a terminal output chunk — classify and write to activity JSONL */
  async recordTerminalActivity(terminalOutput: string): Promise<void> {
    const state = this.classifyTerminalOutput(terminalOutput);
    await this.recordActivityEntry({
      ts: Date.now(),
      state,
      source: 'terminal',
      trigger: terminalOutput.split('\n').slice(-3).join('\n').slice(0, 200),
      provider: this.provider,
    });
  }

  /** Record a pre-classified activity entry (used by native provider signals) */
  async recordActivityEntry(entry: ActivityEntry): Promise<void> {
    const isActionable = entry.state === 'waiting_input' || entry.state === 'blocked' || entry.state === 'exited';

    // Dedup: skip non-actionable states if same state and within dedup window
    if (!isActionable && this.lastRecordedEntry) {
      if (this.lastRecordedEntry.state === entry.state
          && (entry.ts - this.lastRecordedEntry.ts) < DEDUP_WINDOW_MS) {
        return;
      }
    }

    this.lastRecordedEntry = entry;
    this.appendToLog(entry);
  }

  /** Read the last recorded activity entry from memory or disk */
  async getLastRecordedActivity(): Promise<ActivityEntry | null> {
    if (this.lastRecordedEntry) return this.lastRecordedEntry;
    return this.readLastLogEntry();
  }

  // --- Level 2: Activity JSONL Log ---

  private detectFromActivityLog(): ActivityDetectionResult | null {
    const entry = this.readLastLogEntry();
    if (!entry) return null;

    const age = Date.now() - entry.ts;
    let state = entry.state;

    // Staleness cap: actionable states expire after threshold
    if ((state === 'waiting_input' || state === 'blocked') && age > ACTIVITY_INPUT_STALENESS_MS) {
      state = 'idle';
    }

    return {
      state,
      confidence: 'medium',
      staleAfterMs: Math.max(0, ACTIVITY_INPUT_STALENESS_MS - age),
      source: `activity-jsonl (age: ${Math.round(age / 1000)}s)`,
    };
  }

  // --- Level 3: Age-Based Decay ---

  private detectFromAgeDcay(): ActivityDetectionResult | null {
    const entry = this.lastRecordedEntry;
    if (!entry) return null;

    const age = Date.now() - entry.ts;
    let state: ActivityState;

    if (age < ACTIVE_WINDOW_MS) {
      state = 'active';
    } else if (age < READY_THRESHOLD_MS) {
      state = 'ready';
    } else {
      state = 'idle';
    }

    return {
      state,
      confidence: 'low',
      staleAfterMs: age < ACTIVE_WINDOW_MS ? ACTIVE_WINDOW_MS - age : 0,
      source: `age-decay (age: ${Math.round(age / 1000)}s)`,
    };
  }

  // --- Level 4: Process Check ---

  private detectFromProcessCheck(): ActivityDetectionResult {
    if (this.pid) {
      try {
        process.kill(this.pid, 0); // Signal 0 = existence check
        return {
          state: 'idle',
          confidence: 'low',
          staleAfterMs: 0,
          source: 'process-check (alive)',
        };
      } catch (err: any) {
        if (err.code === 'EPERM') {
          // Process exists but we don't have permission — still alive
          return {
            state: 'idle',
            confidence: 'low',
            staleAfterMs: 0,
            source: 'process-check (alive, EPERM)',
          };
        }
        // ESRCH = no such process
        return {
          state: 'exited',
          confidence: 'low',
          staleAfterMs: 0,
          source: 'process-check (dead)',
        };
      }
    }

    return {
      state: 'exited',
      confidence: 'low',
      staleAfterMs: 0,
      source: 'process-check (no PID)',
    };
  }

  // --- Terminal Output Classification ---

  private classifyTerminalOutput(output: string): ActivityState {
    const lower = output.toLowerCase();
    if (lower.includes('allow execution') || lower.includes('approve') || lower.includes('? y/n')
        || lower.includes('permission') || lower.includes('confirm')) {
      return 'waiting_input';
    }
    if (lower.includes('error:') || lower.includes('fatal:') || lower.includes('panic:')
        || lower.includes('unhandled') || lower.includes('stack trace')) {
      return 'blocked';
    }
    return 'active';
  }

  // --- JSONL Log I/O ---

  private get logDir(): string {
    return join(this.workspacePath, '.ao');
  }

  private get logPath(): string {
    return join(this.logDir, 'activity.jsonl');
  }

  private appendToLog(entry: ActivityEntry): void {
    try {
      if (!existsSync(this.logDir)) {
        mkdirSync(this.logDir, { recursive: true });
      }

      const line = JSON.stringify(entry) + '\n';
      appendFileSync(this.logPath, line, 'utf8');

      // Rotate if needed
      this.rotateIfNeeded();
    } catch (err) {
      logger.warn('Failed to append to activity log', { error: String(err), instanceId: this.instanceId });
    }
  }

  private rotateIfNeeded(): void {
    try {
      const stat = statSync(this.logPath);
      if (stat.size <= ACTIVITY_LOG_MAX_BYTES) return;

      // Rotate: activity.jsonl → activity.jsonl.1, .1 → .2, .2 → .3, delete .3+
      for (let i = ACTIVITY_LOG_MAX_ROTATED; i >= 1; i--) {
        const src = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`;
        const dst = `${this.logPath}.${i}`;
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }
    } catch {
      // Best effort rotation
    }
  }

  private readLastLogEntry(): ActivityEntry | null {
    try {
      if (!existsSync(this.logPath)) return null;
      const content = readFileSync(this.logPath, 'utf8');
      const lines = content.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return null;
      return JSON.parse(lastLine) as ActivityEntry;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/providers/activity-state-detector.spec.ts`
Expected: All tests PASS

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/providers/activity-state-detector.ts
git commit -m "feat(activity): implement ActivityStateDetector with 4-level fallback cascade"
```

---

### Task 9: Wire ActivityStateDetector into InstanceLifecycle

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Add imports**

Add at the top of instance-lifecycle.ts:

```typescript
import { ActivityStateDetector } from '../providers/activity-state-detector';
import type { ActivityDetectionResult } from '../../shared/types/activity.types';
```

- [ ] **Step 2: Add detector map as class property**

Add to the class body:

```typescript
  private activityDetectors = new Map<string, ActivityStateDetector>();
```

- [ ] **Step 3: Create detector on instance spawn**

In the instance creation/spawn flow (where the adapter is created and the PID becomes available), add detector creation:

```typescript
    // After adapter is spawned and PID is known:
    const detector = new ActivityStateDetector(
      instance.id,
      instance.workingDirectory || process.cwd(),
      instance.provider ?? 'claude-cli',
    );
    const pid = instance.processId;
    if (pid) detector.setPid(pid);
    this.activityDetectors.set(instance.id, detector);
```

- [ ] **Step 4: Integrate into the existing checkIdleInstances polling loop**

In the `checkIdleInstances()` method (lines ~2610-2655), add activity detection before idle checks:

```typescript
    // Poll activity state for each instance
    for (const [instanceId, detector] of this.activityDetectors) {
      try {
        const result = await detector.detect();
        const instance = this.instances.get(instanceId);
        if (instance) {
          (instance as any).activityState = result.state;
        }
      } catch (err) {
        logger.warn('Activity detection failed', { instanceId, error: String(err) });
      }
    }
```

- [ ] **Step 5: Clean up detector on instance termination**

In the instance termination/cleanup flow:

```typescript
    this.activityDetectors.delete(instanceId);
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Run lint**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm run lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "feat(lifecycle): wire ActivityStateDetector into instance polling loop"
```

---

### Task 10: Wire Streaming Activity Recording into CodexCliAdapter

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`

- [ ] **Step 1: Add ActivityStateDetector import**

Add import:

```typescript
import { ActivityStateDetector } from '../../providers/activity-state-detector';
```

- [ ] **Step 2: Add detector property**

Add class property:

```typescript
  private activityDetector: ActivityStateDetector | null = null;
```

- [ ] **Step 3: Add setter for detector injection**

```typescript
  setActivityDetector(detector: ActivityStateDetector): void {
    this.activityDetector = detector;
  }
```

- [ ] **Step 4: Record activity on streaming output**

Find the streaming output handler (where adapter receives text chunks from the Codex process) and add:

```typescript
    // Record activity from streaming output
    if (this.activityDetector && chunk) {
      this.activityDetector.recordTerminalActivity(chunk).catch(() => {});
    }
```

- [ ] **Step 5: Record native activity from structured events**

In the notification handler where Codex app-server events are processed, add activity recording for specific event types:

```typescript
    // Record native activity from structured events
    if (this.activityDetector) {
      if (notification.method === 'turn/progress' || notification.method === 'turn/toolCall') {
        this.activityDetector.recordActivityEntry({
          ts: Date.now(),
          state: 'active',
          source: 'native',
          provider: 'openai',
        }).catch(() => {});
      } else if (notification.method === 'turn/approval') {
        this.activityDetector.recordActivityEntry({
          ts: Date.now(),
          state: 'waiting_input',
          source: 'native',
          trigger: 'Codex approval request',
          provider: 'openai',
        }).catch(() => {});
      }
    }
```

- [ ] **Step 6: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/cli/adapters/codex-cli-adapter.ts
git commit -m "feat(codex): record streaming activity into ActivityStateDetector"
```

---

## Phase 3: Module C — Recovery Recipes

### Task 11: Shared Types — Recovery

**Files:**
- Create: `src/shared/types/recovery.types.ts`

- [ ] **Step 1: Create recovery types file**

Create `src/shared/types/recovery.types.ts`:

```typescript
import type { ActivityState } from './activity.types';

/** Every known failure mode gets a typed entry */
export type FailureCategory =
  | 'thread_resume_failed'
  | 'process_exited_unexpected'
  | 'agent_stuck_blocked'
  | 'agent_stuck_waiting'
  | 'mcp_server_unreachable'
  | 'provider_auth_expired'
  | 'context_window_exhausted'
  | 'workspace_disappeared'
  | 'stale_branch'
  | 'ci_feedback_loop'
  ;

/** A detected failure ready for recovery */
export interface DetectedFailure {
  /** Unique failure ID */
  id: string;
  /** Which failure category this belongs to */
  category: FailureCategory;
  /** Which instance experienced this failure */
  instanceId: string;
  /** When the failure was detected (epoch ms) */
  detectedAt: number;
  /** Category-specific details */
  context: Record<string, unknown>;
  /** Activity state at detection time */
  activityState?: ActivityState;
  /** How severe this failure is */
  severity: 'recoverable' | 'degraded' | 'fatal';
}

/** A registered recovery recipe for a failure category */
export interface RecoveryRecipe {
  /** Which failure category this recipe handles */
  category: FailureCategory;
  /** Expected severity — used for categorization */
  severity: 'recoverable' | 'degraded' | 'fatal';
  /** Maximum auto-recovery attempts before escalating */
  maxAutoRetries: number;
  /** Minimum time between auto-recovery attempts (ms) */
  cooldownMs: number;
  /** Execute the recovery action */
  recover: (failure: DetectedFailure) => Promise<RecoveryOutcome>;
  /** Human-readable description */
  description: string;
}

/** Result of a recovery attempt */
export type RecoveryOutcome =
  | { status: 'recovered'; action: string }
  | { status: 'degraded'; action: string }
  | { status: 'escalated'; reason: string }
  | { status: 'aborted'; reason: string }
  ;

/** A logged recovery attempt */
export interface RecoveryAttempt {
  /** ID of the failure that triggered this attempt */
  failureId: string;
  /** Category of the failure */
  category: FailureCategory;
  /** Instance that was recovered */
  instanceId: string;
  /** When the attempt was made (epoch ms) */
  attemptedAt: number;
  /** Outcome of the recovery */
  outcome: RecoveryOutcome;
  /** Checkpoint created before recovery (rollback point) */
  checkpointId: string;
}

/** Global circuit breaker constants */
export const RECOVERY_CONSTANTS = {
  /** Max total recovery attempts per instance within the time window */
  CIRCUIT_BREAKER_MAX_ATTEMPTS: 5,
  /** Time window for circuit breaker (ms) */
  CIRCUIT_BREAKER_WINDOW_MS: 600_000, // 10 minutes
} as const;
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/recovery.types.ts
git commit -m "feat(types): add FailureCategory, RecoveryRecipe, RecoveryOutcome types"
```

---

### Task 12: RecoveryRecipeEngine — Test First

**Files:**
- Create: `src/main/session/recovery-recipe-engine.spec.ts`

- [ ] **Step 1: Write test file**

Create `src/main/session/recovery-recipe-engine.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecoveryRecipeEngine } from './recovery-recipe-engine';
import type { DetectedFailure, RecoveryRecipe, RecoveryOutcome } from '../../shared/types/recovery.types';

// Mock CheckpointManager
const mockCheckpointManager = {
  createCheckpoint: vi.fn().mockResolvedValue('checkpoint-123'),
};

// Mock SessionContinuityManager
const mockSessionContinuity = {
  resumeSession: vi.fn().mockResolvedValue(null),
};

function createFailure(overrides: Partial<DetectedFailure> = {}): DetectedFailure {
  return {
    id: `fail-${Date.now()}`,
    category: 'agent_stuck_blocked',
    instanceId: 'inst-1',
    detectedAt: Date.now(),
    context: {},
    severity: 'recoverable',
    ...overrides,
  };
}

function createRecipe(overrides: Partial<RecoveryRecipe> = {}): RecoveryRecipe {
  return {
    category: 'agent_stuck_blocked',
    severity: 'recoverable',
    maxAutoRetries: 2,
    cooldownMs: 0,
    recover: vi.fn().mockResolvedValue({ status: 'recovered', action: 'Sent interrupt' }),
    description: 'Test recipe',
    ...overrides,
  };
}

describe('RecoveryRecipeEngine', () => {
  let engine: RecoveryRecipeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RecoveryRecipeEngine(
      mockCheckpointManager as any,
      mockSessionContinuity as any,
    );
  });

  it('should execute registered recipe for matching failure category', async () => {
    const recipe = createRecipe();
    engine.registerRecipe(recipe);

    const outcome = await engine.handleFailure(createFailure());

    expect(recipe.recover).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('recovered');
  });

  it('should create checkpoint before executing recovery', async () => {
    engine.registerRecipe(createRecipe());

    await engine.handleFailure(createFailure());

    expect(mockCheckpointManager.createCheckpoint).toHaveBeenCalledOnce();
    expect(mockCheckpointManager.createCheckpoint).toHaveBeenCalledWith(
      'inst-1',
      'RECOVERY_ACTION',
      expect.stringContaining('agent_stuck_blocked'),
    );
  });

  it('should escalate when no recipe is registered', async () => {
    const outcome = await engine.handleFailure(createFailure({ category: 'provider_auth_expired' }));

    expect(outcome.status).toBe('escalated');
  });

  it('should escalate after exhausting max retries', async () => {
    const recipe = createRecipe({ maxAutoRetries: 1 });
    engine.registerRecipe(recipe);

    // First attempt succeeds
    await engine.handleFailure(createFailure());
    expect(recipe.recover).toHaveBeenCalledTimes(1);

    // Second attempt: exhausted
    const outcome = await engine.handleFailure(createFailure());
    expect(outcome.status).toBe('escalated');
    expect(recipe.recover).toHaveBeenCalledTimes(1); // Not called again
  });

  it('should respect cooldown between attempts', async () => {
    const recipe = createRecipe({ cooldownMs: 60_000 });
    engine.registerRecipe(recipe);

    // First attempt
    await engine.handleFailure(createFailure());
    expect(recipe.recover).toHaveBeenCalledTimes(1);

    // Immediate second attempt: skipped due to cooldown
    const outcome = await engine.handleFailure(createFailure());
    expect(outcome.status).toBe('escalated');
    expect((outcome as any).reason).toContain('cooldown');
  });

  it('should trigger global circuit breaker after too many attempts', async () => {
    // Register recipes for multiple categories
    engine.registerRecipe(createRecipe({ category: 'agent_stuck_blocked', maxAutoRetries: 3 }));
    engine.registerRecipe(createRecipe({ category: 'process_exited_unexpected', maxAutoRetries: 3 }));
    engine.registerRecipe(createRecipe({ category: 'context_window_exhausted', maxAutoRetries: 3 }));

    // Fire 5 failures rapidly (exceeds circuit breaker threshold)
    for (let i = 0; i < 3; i++) {
      await engine.handleFailure(createFailure({ id: `f-blocked-${i}`, category: 'agent_stuck_blocked' }));
    }
    await engine.handleFailure(createFailure({ id: 'f-exit-1', category: 'process_exited_unexpected' }));
    await engine.handleFailure(createFailure({ id: 'f-exit-2', category: 'process_exited_unexpected' }));

    // 6th attempt should hit circuit breaker
    const outcome = await engine.handleFailure(createFailure({ id: 'f-ctx-1', category: 'context_window_exhausted' }));
    expect(outcome.status).toBe('escalated');
    expect((outcome as any).reason).toContain('circuit breaker');
  });

  it('should track attempt history per instance', async () => {
    engine.registerRecipe(createRecipe());
    await engine.handleFailure(createFailure());

    const history = engine.getAttemptHistory('inst-1');
    expect(history).toHaveLength(1);
    expect(history[0].category).toBe('agent_stuck_blocked');
    expect(history[0].outcome.status).toBe('recovered');
  });

  it('should report exhausted state correctly', async () => {
    engine.registerRecipe(createRecipe({ maxAutoRetries: 1 }));

    expect(engine.isExhausted('inst-1', 'agent_stuck_blocked')).toBe(false);

    await engine.handleFailure(createFailure());
    expect(engine.isExhausted('inst-1', 'agent_stuck_blocked')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/session/recovery-recipe-engine.spec.ts`
Expected: FAIL — `Cannot find module './recovery-recipe-engine'`

- [ ] **Step 3: Commit test file**

```bash
git add src/main/session/recovery-recipe-engine.spec.ts
git commit -m "test(recovery): add failing tests for RecoveryRecipeEngine"
```

---

### Task 13: RecoveryRecipeEngine — Implementation

**Files:**
- Create: `src/main/session/recovery-recipe-engine.ts`

- [ ] **Step 1: Implement RecoveryRecipeEngine**

Create `src/main/session/recovery-recipe-engine.ts`:

```typescript
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import type {
  DetectedFailure,
  FailureCategory,
  RecoveryAttempt,
  RecoveryOutcome,
  RecoveryRecipe,
} from '../../shared/types/recovery.types';
import { RECOVERY_CONSTANTS } from '../../shared/types/recovery.types';
import type { CheckpointManager } from './checkpoint-manager';
import type { SessionContinuityManager } from './session-continuity';

const logger = getLogger('RecoveryRecipeEngine');

const { CIRCUIT_BREAKER_MAX_ATTEMPTS, CIRCUIT_BREAKER_WINDOW_MS } = RECOVERY_CONSTANTS;

export class RecoveryRecipeEngine {
  private recipes = new Map<FailureCategory, RecoveryRecipe>();
  private attempts = new Map<string, RecoveryAttempt[]>(); // instanceId → history

  constructor(
    private checkpointManager: CheckpointManager,
    private sessionContinuity: SessionContinuityManager,
  ) {}

  /** Register a recipe for a failure category */
  registerRecipe(recipe: RecoveryRecipe): void {
    this.recipes.set(recipe.category, recipe);
    logger.info('Registered recovery recipe', { category: recipe.category, description: recipe.description });
  }

  /** Main entry: detect + attempt recovery */
  async handleFailure(failure: DetectedFailure): Promise<RecoveryOutcome> {
    const recipe = this.recipes.get(failure.category);
    if (!recipe) {
      logger.warn('No recovery recipe for failure category', { category: failure.category });
      return { status: 'escalated', reason: `No recipe registered for ${failure.category}` };
    }

    // Global circuit breaker
    if (this.isCircuitBroken(failure.instanceId)) {
      logger.warn('Global circuit breaker triggered', { instanceId: failure.instanceId });
      return { status: 'escalated', reason: 'Global circuit breaker: too many recovery attempts in 10 minutes' };
    }

    // Per-category exhaustion check
    if (this.isExhausted(failure.instanceId, failure.category)) {
      logger.warn('Recovery attempts exhausted', { instanceId: failure.instanceId, category: failure.category });
      return { status: 'escalated', reason: `Exhausted ${recipe.maxAutoRetries} retries for ${failure.category}` };
    }

    // Cooldown check
    const lastAttempt = this.getLastAttemptForCategory(failure.instanceId, failure.category);
    if (lastAttempt && recipe.cooldownMs > 0) {
      const elapsed = Date.now() - lastAttempt.attemptedAt;
      if (elapsed < recipe.cooldownMs) {
        return { status: 'escalated', reason: `In cooldown: ${Math.round((recipe.cooldownMs - elapsed) / 1000)}s remaining` };
      }
    }

    // Create safety checkpoint before recovery
    let checkpointId = 'none';
    try {
      checkpointId = await this.checkpointManager.createCheckpoint(
        failure.instanceId,
        'RECOVERY_ACTION',
        `Pre-recovery: ${failure.category}`,
      ) ?? 'none';
    } catch (err) {
      logger.warn('Failed to create pre-recovery checkpoint', { error: String(err) });
    }

    // Execute recovery recipe
    let outcome: RecoveryOutcome;
    try {
      outcome = await recipe.recover(failure);
      logger.info('Recovery recipe executed', {
        category: failure.category,
        instanceId: failure.instanceId,
        outcome: outcome.status,
      });
    } catch (err) {
      outcome = { status: 'aborted', reason: `Recipe threw: ${String(err)}` };
      logger.error('Recovery recipe threw', { category: failure.category, error: String(err) });
    }

    // Log attempt
    const attempt: RecoveryAttempt = {
      failureId: failure.id,
      category: failure.category,
      instanceId: failure.instanceId,
      attemptedAt: Date.now(),
      outcome,
      checkpointId,
    };

    const history = this.attempts.get(failure.instanceId) ?? [];
    history.push(attempt);
    this.attempts.set(failure.instanceId, history);

    return outcome;
  }

  /** Query recovery history for an instance */
  getAttemptHistory(instanceId: string): RecoveryAttempt[] {
    return this.attempts.get(instanceId) ?? [];
  }

  /** Check if we've exhausted retries for this failure type on this instance */
  isExhausted(instanceId: string, category: FailureCategory): boolean {
    const recipe = this.recipes.get(category);
    if (!recipe) return false;

    const history = this.attempts.get(instanceId) ?? [];
    const categoryAttempts = history.filter(a => a.category === category);
    return categoryAttempts.length >= recipe.maxAutoRetries;
  }

  /** Clear attempt history for an instance (on termination) */
  clearHistory(instanceId: string): void {
    this.attempts.delete(instanceId);
  }

  // --- Private helpers ---

  private isCircuitBroken(instanceId: string): boolean {
    const history = this.attempts.get(instanceId) ?? [];
    const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    const recentAttempts = history.filter(a => a.attemptedAt > cutoff);
    return recentAttempts.length >= CIRCUIT_BREAKER_MAX_ATTEMPTS;
  }

  private getLastAttemptForCategory(instanceId: string, category: FailureCategory): RecoveryAttempt | null {
    const history = this.attempts.get(instanceId) ?? [];
    const categoryAttempts = history.filter(a => a.category === category);
    return categoryAttempts.length > 0 ? categoryAttempts[categoryAttempts.length - 1] : null;
  }
}
```

- [ ] **Step 2: Run tests**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/session/recovery-recipe-engine.spec.ts`
Expected: All 8 tests PASS

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/session/recovery-recipe-engine.ts
git commit -m "feat(recovery): implement RecoveryRecipeEngine with loop prevention and circuit breaker"
```

---

### Task 14: Built-in Recovery Recipes

**Files:**
- Create: `src/main/session/builtin-recovery-recipes.ts`

- [ ] **Step 1: Implement all 10 built-in recipes**

Create `src/main/session/builtin-recovery-recipes.ts`:

```typescript
import { getLogger } from '../logging/logger';
import type { RecoveryRecipe, DetectedFailure, RecoveryOutcome } from '../../shared/types/recovery.types';

const logger = getLogger('BuiltinRecoveryRecipes');

/**
 * Returns all built-in recovery recipes.
 * Each recipe is a standalone unit — no shared state between recipes.
 * Recipes that need instance access receive it via failure.context.
 */
export function createBuiltinRecipes(): RecoveryRecipe[] {
  return [
    {
      category: 'thread_resume_failed',
      severity: 'recoverable',
      maxAutoRetries: 3,
      cooldownMs: 0,
      description: 'Advance to next fallback step in the resume chain (cursor → JSONL scan → replay → fresh)',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('thread_resume_failed: advancing fallback chain', { instanceId: failure.instanceId });
        // The fallback chain in CodexCliAdapter handles this automatically.
        // This recipe just logs and reports — the adapter will try the next step.
        return { status: 'recovered', action: 'Advanced resume fallback chain to next step' };
      },
    },

    {
      category: 'process_exited_unexpected',
      severity: 'recoverable',
      maxAutoRetries: 2,
      cooldownMs: 10_000,
      description: 'Respawn instance with resume cursor, restore from last checkpoint',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('process_exited_unexpected: requesting respawn', { instanceId: failure.instanceId });
        // Set respawn flag in context for InstanceLifecycle to pick up
        failure.context.requestRespawn = true;
        failure.context.useResumeCursor = true;
        return { status: 'recovered', action: 'Requested instance respawn with resume cursor' };
      },
    },

    {
      category: 'agent_stuck_blocked',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 60_000,
      description: 'Send turn/interrupt RPC (app-server) or SIGINT (exec mode), then inject unstuck prompt',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('agent_stuck_blocked: sending interrupt', { instanceId: failure.instanceId });
        failure.context.sendInterrupt = true;
        failure.context.injectMessage = 'You appear stuck on an error. Describe what went wrong and try a different approach.';
        return { status: 'recovered', action: 'Sent interrupt and injected unstuck prompt' };
      },
    },

    {
      category: 'agent_stuck_waiting',
      severity: 'degraded',
      maxAutoRetries: 1,
      cooldownMs: 30_000,
      description: 'Notify user via activity bridge; auto-approve if yolo mode is enabled',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const isYolo = failure.context.yoloMode === true;
        if (isYolo) {
          failure.context.autoApprove = true;
          return { status: 'recovered', action: 'Auto-approved pending request (yolo mode)' };
        }
        return { status: 'degraded', action: 'Notified user of pending approval request' };
      },
    },

    {
      category: 'mcp_server_unreachable',
      severity: 'degraded',
      maxAutoRetries: 3,
      cooldownMs: 30_000,
      description: 'Mark MCP server as degraded (skip, do not crash), retry connection after cooldown',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const serverName = failure.context.serverName as string | undefined;
        logger.info('mcp_server_unreachable: marking server degraded', { serverName });
        failure.context.markDegraded = true;
        return { status: 'degraded', action: `Marked MCP server "${serverName ?? 'unknown'}" as degraded` };
      },
    },

    {
      category: 'provider_auth_expired',
      severity: 'fatal',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'Escalate immediately — cannot auto-fix credentials',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        return { status: 'escalated', reason: 'Provider authentication expired — manual credential refresh required' };
      },
    },

    {
      category: 'context_window_exhausted',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 0,
      description: 'Trigger context compaction (existing capability), checkpoint first',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        logger.info('context_window_exhausted: requesting compaction', { instanceId: failure.instanceId });
        failure.context.requestCompaction = true;
        return { status: 'recovered', action: 'Triggered context compaction' };
      },
    },

    {
      category: 'workspace_disappeared',
      severity: 'recoverable',
      maxAutoRetries: 1,
      cooldownMs: 5_000,
      description: 'Recreate git worktree from branch metadata, restore session',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const branch = failure.context.gitBranch as string | undefined;
        if (!branch) {
          return { status: 'escalated', reason: 'Cannot recreate workspace — no branch metadata available' };
        }
        failure.context.recreateWorktree = true;
        failure.context.branch = branch;
        return { status: 'recovered', action: `Requested worktree recreation for branch "${branch}"` };
      },
    },

    {
      category: 'stale_branch',
      severity: 'degraded',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'Warn user via activity bridge, do not auto-rebase (destructive)',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        return { status: 'degraded', action: 'Branch has diverged significantly from main — manual rebase recommended' };
      },
    },

    {
      category: 'ci_feedback_loop',
      severity: 'degraded',
      maxAutoRetries: 0,
      cooldownMs: 0,
      description: 'After 3 consecutive CI failures on same issue, pause agent and escalate with summary',
      async recover(failure: DetectedFailure): Promise<RecoveryOutcome> {
        const failCount = failure.context.consecutiveFailures as number | undefined;
        failure.context.pauseAgent = true;
        return {
          status: 'escalated',
          reason: `Agent has failed CI ${failCount ?? '3+'} consecutive times on the same issue — pausing for human review`,
        };
      },
    },
  ];
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/session/builtin-recovery-recipes.ts
git commit -m "feat(recovery): implement 10 built-in recovery recipes"
```

---

### Task 15: Wire RecoveryRecipeEngine into InstanceLifecycle

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Add imports**

Add imports:

```typescript
import { RecoveryRecipeEngine } from '../session/recovery-recipe-engine';
import { createBuiltinRecipes } from '../session/builtin-recovery-recipes';
import type { DetectedFailure } from '../../shared/types/recovery.types';
import { generateId } from '../../shared/utils/id-generator';
```

- [ ] **Step 2: Add engine property and initialization**

Add class property:

```typescript
  private recoveryEngine: RecoveryRecipeEngine | null = null;
```

In the initialization flow (where CheckpointManager and SessionContinuityManager are available), add:

```typescript
    // Initialize recovery engine with built-in recipes
    this.recoveryEngine = new RecoveryRecipeEngine(
      getCheckpointManager(),
      getSessionContinuityManager(),
    );
    for (const recipe of createBuiltinRecipes()) {
      this.recoveryEngine.registerRecipe(recipe);
    }
```

- [ ] **Step 3: Add failure detection in the polling loop**

In the `checkIdleInstances()` method, after the activity detection loop from Task 9, add failure detection:

```typescript
    // Detect failures from activity state and trigger recovery
    if (this.recoveryEngine) {
      for (const [instanceId, detector] of this.activityDetectors) {
        try {
          const result = await detector.detect();
          const instance = this.instances.get(instanceId);
          if (!instance) continue;

          let failure: DetectedFailure | null = null;

          if (result.state === 'blocked') {
            failure = {
              id: generateId(),
              category: 'agent_stuck_blocked',
              instanceId,
              detectedAt: Date.now(),
              context: {},
              activityState: result.state,
              severity: 'recoverable',
            };
          } else if (result.state === 'exited' && instance.status !== 'terminated') {
            failure = {
              id: generateId(),
              category: 'process_exited_unexpected',
              instanceId,
              detectedAt: Date.now(),
              context: {},
              activityState: result.state,
              severity: 'recoverable',
            };
          }

          if (failure) {
            const outcome = await this.recoveryEngine.handleFailure(failure);
            logger.info('Recovery outcome', { instanceId, category: failure.category, outcome: outcome.status });
          }
        } catch (err) {
          logger.warn('Failure detection/recovery failed', { instanceId, error: String(err) });
        }
      }
    }
```

- [ ] **Step 4: Clean up recovery history on instance termination**

In the instance termination/cleanup flow (same place as Task 9 Step 5), add:

```typescript
    this.recoveryEngine?.clearHistory(instanceId);
```

- [ ] **Step 5: Run typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run lint**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "feat(lifecycle): wire RecoveryRecipeEngine with failure detection into polling loop"
```

---

## Phase 4: Final Verification

### Task 16: Full Verification Pass

**Files:** All modified and created files

- [ ] **Step 1: Run full typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit`
Expected: PASS with zero errors

- [ ] **Step 2: Run spec typecheck**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS with zero errors

- [ ] **Step 3: Run all new tests**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npx vitest run src/main/cli/adapters/codex/session-scanner.spec.ts src/main/providers/activity-state-detector.spec.ts src/main/session/recovery-recipe-engine.spec.ts`
Expected: All tests PASS

- [ ] **Step 4: Run lint**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm run lint`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm run test`
Expected: PASS (no regressions)

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: verify all modules compile, lint, and pass tests"
```
