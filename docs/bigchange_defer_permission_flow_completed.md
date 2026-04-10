# Bigchange: Defer-Based Permission Flow for Claude CLI

## Overview

Replace the broken permission approval system in the AI Orchestrator's Claude CLI adapter with a working `defer`-based flow. Currently, when Claude CLI denies a tool use (e.g., Bash in `acceptEdits` mode), the orchestrator surfaces a permission dialog to the user, but the "Allow" button does nothing -- the CLI process has already moved on. The only functional escape hatch is the YOLO button, which restarts the entire session with `--dangerously-skip-permissions`, granting blanket approval for all tools.

Claude Code (2.1.98+) supports a `defer` permission decision in PreToolUse hooks. When a hook returns `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "defer"}}`, the CLI pauses execution, emits a `result` message with `stop_reason: "tool_deferred"` and a `deferred_tool_use` object containing the tool name/input/id, then exits with code 0. The orchestrator can detect this, surface the request to the user, and resume the session with `-p --resume` — at which point the hook is re-invoked with the same `tool_use_id`, allowing it to read a decision file and return `allow` or `deny`.

### Primary Use Case

- User creates a non-YOLO Claude instance (the default)
- Claude wants to run a Bash command
- Instead of silently denying and continuing, the CLI pauses
- The orchestrator shows a permission dialog with the tool name, arguments, and context
- User clicks "Allow" or "Deny"
- The orchestrator resumes the CLI session, and execution continues with the decision applied

### Design Principles

1. **Fix what's broken** -- the existing permission UI is fully wired but non-functional; this change makes it work
2. **Minimal disruption** -- reuse the existing `input_required` event pipeline, permission UI component, and resume infrastructure
3. **Backward compatible** -- YOLO mode continues to work unchanged; the defer flow only activates in non-YOLO mode
4. **Progressive** -- the hook script is a small standalone file; if Claude CLI doesn't support defer yet, the adapter falls back to the current behavior
5. **Security-aware** -- the hook script only defers tools that actually need approval; file operations remain auto-approved

---

## Phase 1: Hook Script and Adapter Configuration

### 1.1 Create Permission Hook Script

Create a Node.js hook script that serves as the Claude CLI PreToolUse hook. This script is invoked by Claude CLI before each tool use and must return a JSON decision.

**New file: `src/main/cli/hooks/defer-permission-hook.mjs`**

```javascript
#!/usr/bin/env node
// Claude CLI PreToolUse hook for defer-based permission flow.
//
// VALIDATED: The hook receives JSON on stdin with these fields:
//   { session_id, transcript_path, cwd, permission_mode, hook_event_name,
//     tool_name, tool_input, tool_use_id }
//
// VALIDATED: The hook must return JSON with this structure (NOT top-level "decision"):
//   { "hookSpecificOutput": {
//       "hookEventName": "PreToolUse",
//       "permissionDecision": "allow" | "deny" | "ask" | "defer",
//       "permissionDecisionReason": "string (optional)"
//     }
//   }
//
// VALIDATED: On resume after defer, the hook is re-invoked with the SAME
// tool_use_id and tool_input. We check for a decision file first.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const AUTO_APPROVE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
  'NotebookEdit', 'TodoWrite', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch',
]);

const reply = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      ...(reason ? { permissionDecisionReason: reason } : {}),
    }
  }));
};

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
const toolName = input.tool_name || '';
const toolUseId = input.tool_use_id || '';

// Check for a pre-existing decision from the orchestrator (used on resume)
const DECISION_DIR = process.env.ORCHESTRATOR_DECISION_DIR;
if (DECISION_DIR && toolUseId) {
  const decisionFile = join(DECISION_DIR, `${toolUseId}.json`);
  if (existsSync(decisionFile)) {
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    reply(decision.permissionDecision, decision.reason);
    process.exit(0);
  }
}

// Auto-approve safe tools, defer everything else for user approval
if (AUTO_APPROVE_TOOLS.has(toolName)) {
  reply('allow');
} else {
  reply('defer', 'Orchestrator: awaiting user approval');
}
```

### 1.2 Add Hook Path Resolution Utility

**New file: `src/main/cli/hooks/hook-path-resolver.ts`**

```typescript
/**
 * Resolves the path to the defer permission hook script.
 * Handles both development (src/) and production (packaged app) paths.
 */
export function getDeferPermissionHookPath(): string;

/**
 * Ensures the hook script exists and is executable.
 * Called once at adapter startup.
 */
export async function ensureHookScript(): Promise<string>;
```

This utility checks `app.isPackaged` to determine whether to look in the source tree or the packaged resources directory, and ensures the script has execute permissions on macOS/Linux.

### 1.3 Add Defer Hook Configuration to Spawn Options

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts`**

```typescript
export interface ClaudeCliSpawnOptions {
  // ... existing fields ...
  /** Path to a PreToolUse hook script for defer-based permission approval.
   *  When set, the adapter generates a settings overlay and passes it via --settings. */
  permissionHookPath?: string;
}
```

### 1.4 Modify `buildArgs()` to Inject Hook via `--settings`

**VALIDATED:** Hooks are configured via `settings.json`, NOT a CLI flag. The `--settings` flag accepts
inline JSON or a file path, and is merged with existing settings. Hooks work alongside `--permission-mode`.

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts` -- `buildArgs()` method**

The existing `--permission-mode acceptEdits` stays (it handles file operations). The defer hook
is layered on top via `--settings` to handle Bash and other dangerous tools:

```typescript
// Keep acceptEdits for file operations
args.push('--permission-mode', 'acceptEdits');

// Layer defer hook on top for tools that acceptEdits doesn't auto-approve
if (this.spawnOptions.permissionHookPath) {
  const hookSettings = JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: this.spawnOptions.permissionHookPath
        }]
      }]
    }
  });
  args.push('--settings', hookSettings);
}
```

**Key insight:** `--permission-mode acceptEdits` and the PreToolUse hook are complementary.
The mode auto-approves file operations. The hook intercepts Bash (and any other tool matched)
and returns `defer` to pause execution. Both work simultaneously — validated experimentally.

### 1.5 Update Adapter Factory

**Modify: `src/main/cli/adapters/adapter-factory.ts`**

Add `permissionHookPath` to `UnifiedSpawnOptions` and pass through in `createClaudeAdapter()`.

### 1.6 Wire Hook Path in Instance Lifecycle

**Modify: `src/main/instance/instance-lifecycle.ts`**

In every place where `UnifiedSpawnOptions` is constructed for non-YOLO Claude instances (`createInstance`, `toggleYoloMode`, `respawnAfterInterrupt`, `respawnAfterUnexpectedExit`, `changeModel`), add:

```typescript
permissionHookPath: !instance.yoloMode
  ? getDeferPermissionHookPath()
  : undefined,
```

---

## Phase 2: Defer Event Detection and Process Lifecycle

### 2.1 The Defer Signal (VALIDATED)

**Experimentally confirmed on Claude CLI 2.1.98.** When a PreToolUse hook returns
`{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "defer"}}`,
Claude CLI:

1. Emits a `system` hook_response message with `outcome: "success"` (the hook ran correctly)
2. Emits a **`result`** message with these key fields:
   - `stop_reason: "tool_deferred"` — **the primary detection field**
   - `terminal_reason: "tool_deferred"` — redundant confirmation
   - `deferred_tool_use: { id, name, input }` — **structured tool details**
   - `result: ""` — empty string (no text result since execution paused)
   - `session_id` — the session ID needed for `--resume`
   - `subtype: "success"` — not an error, just a pause
3. Process exits with **code 0**
4. Session state is persisted to disk (required for `--resume`)

**On resume (`-p --resume <session_id>`):**
1. `SessionStart:resume` hook fires (not `SessionStart:startup`)
2. The **same PreToolUse hook is re-invoked** with the **same `tool_use_id` and `tool_input`**
3. If hook returns `allow`, the tool executes normally; Claude sees the output and responds
4. If hook returns `deny`, a `tool_result` with `is_error: true` is injected and Claude sees the denial reason
5. `--no-session-persistence` is **incompatible** with defer (no session file to resume from)

### 2.2 Add New Instance Status: `waiting_for_permission`

**Modify: `src/shared/types/instance.types.ts`**

```typescript
export type InstanceStatus =
  | /* ... existing statuses ... */
  | 'waiting_for_permission'  // Paused on deferred tool use, awaiting user approval
```

### 2.3 Add Deferred Tool Use State to Adapter

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts`**

```typescript
interface DeferredToolUse {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
  deferredAt: number;
}

// Add to ClaudeCliAdapter class:
private deferredToolUse: DeferredToolUse | null = null;

getDeferredToolUse(): DeferredToolUse | null {
  return this.deferredToolUse;
}
```

### 2.4 Detect Defer Signal in `processCliMessage()`

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts` -- `processCliMessage()`**

Add detection in the `result` case for deferred sessions. **The exact field names below are validated
against real Claude CLI 2.1.98 output:**

```typescript
case 'result': {
  const resultMsg = raw;
  
  // VALIDATED: Check for tool_deferred stop reason
  if (resultMsg.stop_reason === 'tool_deferred' && resultMsg.deferred_tool_use) {
    const deferred = resultMsg.deferred_tool_use;
    // deferred_tool_use shape (validated):
    //   { id: "toolu_01Xxx...", name: "Bash", input: { command: "...", description: "..." } }
    this.deferredToolUse = {
      toolName: deferred.name,
      toolInput: deferred.input || {},
      toolUseId: deferred.id,
      sessionId: resultMsg.session_id || this.sessionId || '',
      deferredAt: Date.now(),
    };
    
    // Build a human-readable prompt with the actual command
    const toolSummary = deferred.name === 'Bash' && deferred.input?.command
      ? `Bash: \`${deferred.input.command}\``
      : deferred.name;
    
    this.emit('status', 'waiting_for_permission' as InstanceStatus);
    this.emit('input_required', {
      id: generateId(),
      prompt: `Permission required: Claude wants to run ${toolSummary}`,
      timestamp: Date.now(),
      metadata: {
        type: 'deferred_permission',
        tool_name: deferred.name,
        tool_input: deferred.input,
        tool_use_id: deferred.id,
        session_id: resultMsg.session_id,
      },
    });
    
    // Don't process further — the instance is paused, awaiting user decision
    break;
  }
  // ... existing result handling ...
}
```

### 2.5 Handle Process Exit After Defer

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts` -- `handleExit()`**

If the process exits while a deferred tool use is pending, don't treat it as an error:

```typescript
if (this.deferredToolUse) {
  logger.info('Process exited with deferred tool use pending', {
    toolName: this.deferredToolUse.toolName,
    sessionId: this.deferredToolUse.sessionId,
  });
  // Don't trigger respawn -- the resume flow handles this
  this.emit('exit', code, signal);
  return;
}
```

### 2.6 Update `AdapterRuntimeCapabilities`

**Modify: `src/main/cli/adapters/base-cli-adapter.ts`**

```typescript
export interface AdapterRuntimeCapabilities {
  // ... existing fields ...
  supportsDeferPermission: boolean;
}
```

---

## Phase 3: Resume Flow After User Decision

### 3.1 Permission Decision Persistence

**New file: `src/main/cli/hooks/defer-decision-store.ts`**

**VALIDATED:** The hook IS re-invoked on resume with the same `tool_use_id`. The decision-file
approach works: write a JSON file keyed by `tool_use_id` before resuming; the hook checks for it
and returns the pre-recorded decision instead of `defer`.

```typescript
export class DeferDecisionStore {
  private static instance: DeferDecisionStore;
  static getInstance(): DeferDecisionStore;
  static _resetForTesting(): void;
  
  /**
   * Write a decision file for a specific deferred tool use.
   * File is written to: <decisionDir>/<toolUseId>.json
   * Content: { permissionDecision: "allow"|"deny", reason: "..." }
   *
   * VALIDATED: The hook receives tool_use_id on both initial invocation and resume.
   * Using tool_use_id as the filename ensures exact matching on resume.
   */
  async writeDecision(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string
  ): Promise<void>;
  
  /** Clean up all decision files in the decision directory */
  async cleanup(): Promise<void>;
  
  /** Get the decision directory path (set as ORCHESTRATOR_DECISION_DIR env var) */
  getDecisionDir(): string;
}
```

The resumed process receives `ORCHESTRATOR_DECISION_DIR` as an environment variable pointing to
the directory where decision files are stored. The hook script reads this to locate decision files.

### 3.2 Resume Method on Adapter

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts`**

```typescript
/**
 * Resume a deferred session after user approves or denies a tool use.
 * Spawns a new process with --resume to continue from the pause point.
 */
async resumeAfterDeferredPermission(approved: boolean): Promise<number>;
```

This method:
1. Reads the deferred tool use state
2. Writes the decision to the decision store
3. Sets `ORCHESTRATOR_DECISION_DIR` in the resumed process's environment
4. Spawns a new process with `--resume <sessionId>`
5. Re-wires event handlers

### 3.3 Add Resume Logic to Instance Lifecycle

**Modify: `src/main/instance/instance-lifecycle.ts`**

Add `resumeAfterDeferredPermission()` following the pattern of `respawnAfterInterrupt()` and `toggleYoloMode()`:

```typescript
async resumeAfterDeferredPermission(
  instanceId: string,
  approved: boolean
): Promise<void>;
```

This method:
1. Acquires the session mutex
2. Gets the deferred tool use from the adapter
3. Writes the permission decision
4. Terminates the old adapter
5. Builds spawn options with `resume: true`
6. Creates and spawns a new adapter
7. Waits for health stabilization

### 3.4 Update IPC Handler

**Modify: `src/main/ipc/handlers/instance-handlers.ts` -- `INPUT_REQUIRED_RESPOND`**

Route `deferred_permission` responses to the resume flow instead of the stdin flow:

```typescript
if (validatedPayload.metadata?.type === 'deferred_permission') {
  const approved = validatedPayload.decisionAction === 'allow';
  await instanceManager.resumeAfterDeferredPermission(
    validatedPayload.instanceId, approved
  );
} else {
  // Existing flow
  await instanceManager.sendInputResponse(/* ... */);
}
```

### 3.5 Update Exit Handler

**Modify: `src/main/instance/instance-communication.ts` -- adapter `exit` event**

When a process exits with a deferred tool use pending, don't trigger `respawnAfterInterrupt()`:

```typescript
const claudeAdapter = adapter as ClaudeCliAdapter;
if (claudeAdapter.getDeferredToolUse()) {
  // Defer-pause exit -- don't trigger respawn
  return;
}
```

---

## Phase 4: UI Updates, Integration, and Testing

### 4.1 Update Permission Dialog

**Modify: `src/renderer/app/features/instance-detail/user-action-request.component.ts`**

- Detect `deferred_permission` type in metadata
- Show richer tool context: tool name + argument summary (e.g., "Bash: `npm run build`")
- Remove the misleading "enable YOLO mode to allow this action" message since Allow now works

### 4.2 Update Instance Status Display

**Modify: `src/renderer/app/features/instance-list/instance-row.component.ts`**

Handle `waiting_for_permission` status:

```typescript
case 'waiting_for_permission':
  return { label: 'Needs Approval', icon: 'shield', color: 'warning' };
```

### 4.3 PermissionManager Auto-Decisions

**Modify: `src/main/instance/instance-manager.ts` -- `handleInputRequired()`**

Check PermissionManager rules for deferred permissions:
- If a rule matches with `action: 'allow'`, auto-resume without UI prompt
- If a rule matches with `action: 'deny'`, auto-resume with denial
- If no rule matches, surface to UI

### 4.4 Graceful Degradation / Feature Detection

**Modify: `src/main/cli/adapters/claude-cli-adapter.ts`**

Add version checking to determine if the installed Claude CLI supports defer.
**VALIDATED:** Defer works in CLI 2.1.98. The hook schema error message explicitly lists `"defer"`
as a valid `permissionDecision` value, confirming it's a supported feature.

```typescript
/** Minimum Claude CLI version that supports defer permission decision */
const DEFER_MIN_VERSION = '2.1.90'; // Conservative estimate

async checkDeferSupport(): Promise<boolean> {
  const status = await this.checkStatus();
  if (!status.version) return false;
  return semverGte(status.version, DEFER_MIN_VERSION);
}
```

If not supported, fall back to `--permission-mode acceptEdits` only (current behavior).
The adapter factory checks this at instance creation time.

---

## Files Summary

### New Files

| File | Description |
|------|-------------|
| `src/main/cli/hooks/defer-permission-hook.mjs` | PreToolUse hook script that returns `defer` for dangerous tools |
| `src/main/cli/hooks/hook-path-resolver.ts` | Resolves hook script path for dev/production |
| `src/main/cli/hooks/defer-decision-store.ts` | Manages permission decision files for hook/resume communication |
| `src/main/cli/hooks/__tests__/defer-decision-store.spec.ts` | Unit tests for decision store |
| `src/main/cli/hooks/__tests__/hook-path-resolver.spec.ts` | Unit tests for path resolution |

### Modified Files

| File | Changes |
|------|---------|
| `src/main/cli/adapters/claude-cli-adapter.ts` | `permissionHookPath` option, `DeferredToolUse` state, defer detection, `resumeAfterDeferredPermission()`, `handleExit()` update, `getRuntimeCapabilities()` update |
| `src/main/cli/adapters/base-cli-adapter.ts` | `supportsDeferPermission` in `AdapterRuntimeCapabilities` |
| `src/main/cli/adapters/adapter-factory.ts` | `permissionHookPath` in `UnifiedSpawnOptions`, pass through in `createClaudeAdapter()` |
| `src/shared/types/instance.types.ts` | `'waiting_for_permission'` in `InstanceStatus` |
| `src/shared/types/cli.types.ts` | Defer-related fields on `CliResultMessage` or new `CliDeferredMessage` type |
| `src/main/instance/instance-lifecycle.ts` | `resumeAfterDeferredPermission()`, wire hook path in all spawn option constructions |
| `src/main/instance/instance-communication.ts` | `resumeAfterPermission()`, update exit handler for defer-pause |
| `src/main/instance/instance-manager.ts` | `resumeAfterDeferredPermission()` public method, `handleInputRequired()` auto-decisions |
| `src/main/ipc/handlers/instance-handlers.ts` | Route deferred permission responses to resume flow |
| `src/shared/validation/ipc-schemas.ts` | `metadata` field on `InputRequiredResponsePayloadSchema` |
| `src/renderer/app/features/instance-detail/user-action-request.component.ts` | Richer deferred permission UI, remove YOLO-only message |
| `src/renderer/app/features/instance-list/instance-row.component.ts` | `waiting_for_permission` status display |

---

## Risk Assessment

### ~~High Risk~~ Resolved (Previously Unknown, Now Validated)

1. ~~**Claude CLI defer output format is unknown.**~~ **RESOLVED.** Format fully validated.
   Detection: `resultMsg.stop_reason === 'tool_deferred'` with `deferred_tool_use` object.

2. ~~**Hook-to-resume communication.**~~ **RESOLVED.** Hook IS re-invoked on resume with same
   `tool_use_id`. Decision-file approach confirmed working.

### Medium Risk

3. **Process lifecycle race conditions.** The adapter's exit handler triggers `respawnAfterInterrupt()` for
   interrupted processes. A defer-pause exit (code 0 with `stop_reason: "tool_deferred"`) must not trigger
   this. **Mitigation:** Check `deferredToolUse` state in exit handler; use `processGeneration` counter.

4. **Session state corruption on resume.** If resume fails, the instance needs a fallback path.
   **Mitigation:** Reuse try/catch-fallback from `respawnAfterInterrupt()`.

5. **Multiple deferred tool uses per turn.** Claude may attempt multiple tools in one turn. Since defer
   pauses at the first deferred tool, subsequent tools are never reached. On resume, if Claude issues
   another deferred tool, another defer cycle occurs. **Mitigation:** Sequential queue — each resume may
   trigger another defer. Track with single `deferredToolUse` state.

6. **PermissionManager interaction.** Auto-decision rules must correctly interact with deferred permissions.
   **Mitigation:** Test auto-decision path explicitly.

7. **`--no-session-persistence` incompatibility.** Confirmed that `--no-session-persistence` prevents
   resume (no session file written). **Mitigation:** Never combine `--no-session-persistence` with
   defer hooks. Document this constraint.

### Low Risk

8. **Hook script path in packaged app.** **Mitigation:** Use `app.isPackaged` to select correct path.
9. **Cross-platform hook execution.** **Mitigation:** Use Node.js `.mjs` as default; add `.cmd` wrapper for Windows.
10. **Settings overlay conflict.** The `--settings` flag merges with user settings. Hook configs from
    `--settings` may conflict with user's own PreToolUse hooks. **Mitigation:** Use a unique `matcher`
    pattern and document that orchestrator hooks are layered on top.

---

## Validated Answers (Experimentally Confirmed on Claude CLI 2.1.98)

All five original open questions have been resolved through live testing:

### Q1: What is the exact NDJSON output when a PreToolUse hook returns `defer`?

**RESOLVED.** The CLI emits a `result` message with:
```json
{
  "type": "result",
  "subtype": "success",
  "stop_reason": "tool_deferred",
  "terminal_reason": "tool_deferred",
  "result": "",
  "session_id": "uuid",
  "deferred_tool_use": {
    "id": "toolu_01Xxx...",
    "name": "Bash",
    "input": { "command": "echo hello", "description": "..." }
  },
  "total_cost_usd": 0.095,
  "usage": { ... },
  "modelUsage": { ... }
}
```
Process exits with code 0. Detection: check `resultMsg.stop_reason === 'tool_deferred'`.

### Q2: Does Claude CLI re-invoke the hook when resuming a deferred session?

**YES.** The hook is called again with the **exact same `tool_use_id` and `tool_input`**. The
decision-file approach works perfectly: write a file keyed by `tool_use_id` before resuming, and
the hook reads it to return `allow` or `deny` instead of `defer`.

On deny, Claude receives a `tool_result` with `is_error: true` and adapts its behavior.
On allow, the tool executes normally and Claude sees the output.

### Q3: What Claude CLI version introduced defer support?

**Confirmed working in 2.1.98.** The hook output schema validation error message explicitly lists
`"defer"` as a valid value for `hookSpecificOutput.permissionDecision`. Minimum version detection
should check for `>= 2.1.90` (approximate; the exact release can be narrowed if needed).

### Q4: Is the hook configured via CLI flag or `~/.claude/settings.json`?

**Settings.json via `--settings` flag.** Hooks are NOT configured via a dedicated CLI flag.
Use `--settings '<inline-json>'` to overlay hook configuration without modifying the user's
`~/.claude/settings.json`. Format:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "/path/to/hook.mjs" }]
    }]
  }
}
```

The hook receives JSON on stdin with: `session_id`, `transcript_path`, `cwd`, `permission_mode`,
`hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`.

**Critical:** The hook output must use `hookSpecificOutput.permissionDecision`, NOT a top-level
`decision` field. Top-level `decision` uses different values (`"approve"` | `"block"`) and is
for a different purpose. Using the wrong format causes a validation error and the tool executes anyway.

### Q5: How does defer interact with `--permission-mode`?

**They work simultaneously.** `--permission-mode acceptEdits` auto-approves file operations.
The PreToolUse hook intercepts matched tools (e.g., Bash) independently. The hook's
`permissionDecision` takes precedence for matched tools; unmatched tools fall through to
the permission mode. Both can be used together with no conflict.

---

## Testing Strategy

### Unit Tests

- `DeferDecisionStore` -- write/read/cleanup decision files, concurrent access
- `HookPathResolver` -- dev path, production path, missing file error
- `ClaudeCliAdapter.processCliMessage()` -- defer signal detection with mock NDJSON
- `ClaudeCliAdapter.resumeAfterDeferredPermission()` -- spawn with resume args
- `buildArgs()` -- hook path included when set, omitted in YOLO mode

### Integration Tests

- Full defer flow: spawn with hook -> simulate defer NDJSON -> verify `input_required` -> resume -> verify new process with `--resume`
- Auto-decision flow: PermissionManager "allow Bash" rule -> defer -> auto-resume
- Deny flow: defer -> user denies -> resume -> verify CLI receives denial
- Fallback flow: defer -> resume fails -> fallback to fresh session
- YOLO mode: verify hook is NOT used when YOLO is enabled
- `toggleYoloMode()` with pending deferred: cancel deferred, respawn with YOLO

### E2E Tests (Manual)

1. Create non-YOLO Claude instance
2. Send prompt requiring Bash execution
3. Verify permission dialog appears with tool details
4. Click "Allow" -> verify Bash executes and output appears
5. Repeat with "Deny" -> verify Claude adapts
6. Verify YOLO toggle still works as before
7. Test with older Claude CLI version -> verify graceful fallback
