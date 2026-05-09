#!/usr/bin/env node
/**
 * Combined PreToolUse hook: RTK rewrite + defer-based permission flow.
 *
 * Strict superset of defer-permission-hook.mjs. When ORCHESTRATOR_RTK_ENABLED
 * is unset or not "1", behaves identically to defer-permission-hook.mjs.
 *
 * When the feature flag is on AND the tool is "Bash", calls
 * `rtk rewrite <command>` (where `rtk` is resolved from
 * ORCHESTRATOR_RTK_PATH, falling back to PATH) and mutates the
 * tool_input.command before applying the existing approval logic:
 *
 *   rtk exit 0 → rewrite command, run normal approval (allow/defer/decision-file)
 *   rtk exit 1 → no rewrite, run normal approval
 *   rtk exit 2 → no rewrite, run normal approval (Claude's deny rules will fire)
 *   rtk exit 3 → rewrite command, but force defer to surface our approval UI
 *                (orchestrator owns the UX, not Claude's TTY prompt)
 *
 * On resume after defer, the hook is re-invoked with the SAME tool_use_id and
 * tool_input. The orchestrator's decision file determines the final verdict;
 * the rewrite is re-applied idempotently (rtk is <10ms and stateless).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const AUTO_APPROVE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
  'NotebookEdit', 'TodoWrite', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch',
]);

/** Return the JSON payload Claude Code expects on stdout. */
function buildReply({ decision, reason, updatedInput }) {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
  };
  if (reason) hookSpecificOutput.permissionDecisionReason = reason;
  if (updatedInput) hookSpecificOutput.updatedInput = updatedInput;
  return JSON.stringify({ hookSpecificOutput });
}

/**
 * Run `rtk rewrite <command>` synchronously. Returns:
 *   { kind: 'allow', rewritten }      - rtk exit 0
 *   { kind: 'passthrough' }            - rtk exit 1
 *   { kind: 'deny' }                   - rtk exit 2
 *   { kind: 'ask', rewritten }         - rtk exit 3
 *   { kind: 'unavailable' }            - rtk binary not found / failed to launch
 *   { kind: 'error', reason }          - other (timeout, unexpected code)
 *
 * Designed to never throw — errors return a discriminated result instead.
 * Forces RTK_TELEMETRY_DISABLED=1 in the child env regardless of caller config.
 */
function runRtkRewrite(command) {
  const rtkPath = process.env.ORCHESTRATOR_RTK_PATH || 'rtk';
  try {
    const result = spawnSync(rtkPath, ['rewrite', command], {
      encoding: 'utf8',
      timeout: 2_000,
      env: { ...process.env, RTK_TELEMETRY_DISABLED: '1' },
    });
    if (result.error) {
      // ENOENT etc — rtk binary couldn't be launched at all
      return { kind: 'unavailable' };
    }
    if (result.status === null) {
      return { kind: 'error', reason: `rtk rewrite terminated by signal ${result.signal ?? 'unknown'}` };
    }
    const stdout = (result.stdout || '').toString().trim();
    switch (result.status) {
      case 0:
        if (!stdout) return { kind: 'error', reason: 'rtk rewrite exit 0 with empty stdout' };
        return { kind: 'allow', rewritten: stdout };
      case 1:
        return { kind: 'passthrough' };
      case 2:
        return { kind: 'deny' };
      case 3:
        if (!stdout) return { kind: 'error', reason: 'rtk rewrite exit 3 with empty stdout' };
        return { kind: 'ask', rewritten: stdout };
      default:
        return { kind: 'error', reason: `rtk rewrite unexpected exit ${result.status}` };
    }
  } catch (err) {
    return { kind: 'error', reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * Apply RTK rewrite to tool_input if applicable. Returns:
 *   { updatedInput?, forceDefer: boolean }
 * where forceDefer=true means the caller MUST emit a defer decision (rtk asked
 * for confirmation, so we can't auto-allow even if the tool is in the
 * AUTO_APPROVE list).
 */
function maybeRewriteBashCommand(input) {
  if (process.env.ORCHESTRATOR_RTK_ENABLED !== '1') {
    return { forceDefer: false };
  }
  if (input.tool_name !== 'Bash') {
    return { forceDefer: false };
  }
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) {
    return { forceDefer: false };
  }

  const result = runRtkRewrite(command);
  switch (result.kind) {
    case 'allow':
      // No-op rewrite (already starts with `rtk`) → don't bother emitting updatedInput
      if (result.rewritten === command) return { forceDefer: false };
      return {
        updatedInput: { ...input.tool_input, command: result.rewritten },
        forceDefer: false,
      };
    case 'ask':
      return {
        updatedInput: { ...input.tool_input, command: result.rewritten },
        forceDefer: true,
      };
    case 'passthrough':
    case 'deny':
    case 'unavailable':
    case 'error':
    default:
      // Failures degrade to "no rewrite, normal flow". rtk error reasons are
      // already logged by spawnSync; we don't surface them in hook output to
      // avoid corrupting the JSON contract Claude Code expects.
      return { forceDefer: false };
  }
}

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = input.tool_name || '';
const toolUseId = input.tool_use_id || '';

const { updatedInput, forceDefer } = maybeRewriteBashCommand(input);

// Resume path: orchestrator dropped a decision file while we were paused.
const DECISION_DIR = process.env.ORCHESTRATOR_DECISION_DIR;
if (DECISION_DIR && toolUseId) {
  const decisionFile = join(DECISION_DIR, `${toolUseId}.json`);
  if (existsSync(decisionFile)) {
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    process.stdout.write(buildReply({
      decision: decision.permissionDecision,
      reason: decision.reason,
      updatedInput,
    }));
    process.exit(0);
  }
}

// rtk asked → force defer regardless of the auto-approve list
if (forceDefer) {
  process.stdout.write(buildReply({
    decision: 'defer',
    reason: 'RTK ask rule — orchestrator approval required',
    updatedInput,
  }));
  process.exit(0);
}

// Auto-approve safe tools, defer everything else for user approval
if (AUTO_APPROVE_TOOLS.has(toolName)) {
  process.stdout.write(buildReply({ decision: 'allow', updatedInput }));
} else {
  process.stdout.write(buildReply({
    decision: 'defer',
    reason: 'Orchestrator: awaiting user approval',
    updatedInput,
  }));
}
