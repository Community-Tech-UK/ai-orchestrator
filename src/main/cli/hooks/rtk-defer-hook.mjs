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
 *
 * REWRITE-ONLY MODE (A13, Step 18b; ORCHESTRATOR_RTK_REWRITE_ONLY=1): for
 * auto-approve sessions the hook may rewrite but never ask and never deny.
 * RTK 0.49+ (RTK_MIN_REWRITE_VERSION) treats exit 3 as "no rule matched, text
 * rewritten", so exits 0 and 3 both allow with the rewrite; exits 1 and 2,
 * timeouts, a missing binary and any thrown error print nothing and exit 0
 * (Claude's own deny rules still apply). The decision directory is never read.
 *
 * Both modes append one JSON line per Bash call to
 * $ORCHESTRATOR_RTK_LOG_DIR/<YYYY-MM-DD>.jsonl (Harness's own coverage log,
 * independent of RTK's own tracking DB), keeping 60 days.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const AUTO_APPROVE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill',
  'NotebookEdit', 'TodoWrite', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch',
]);

const LOG_RETENTION_DAYS = 60;

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
 * Harness's own coverage log: one JSON line per Bash call, one file per day,
 * 60 days of retention. Best-effort — a logging failure must never break the
 * hook contract, so everything here swallows its errors.
 */
function logDecision(input, decision, rtkExit, elapsedMs, mode) {
  const dir = process.env.ORCHESTRATOR_RTK_LOG_DIR;
  if (!dir) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `${day}.jsonl`);
    const isNewDay = !existsSync(file);
    mkdirSync(dir, { recursive: true });
    if (isNewDay) {
      // First write of the day: drop files older than the retention window.
      const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        try {
          if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name));
        } catch { /* ignore */ }
      }
    }
    appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(),
      session_id: input.session_id || null,
      tool_use_id: input.tool_use_id || null,
      decision,
      rtkExit,
      elapsedMs,
      mode,
    }) + '\n', 'utf8');
  } catch { /* ignore */ }
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
      return { kind: 'unavailable', exit: null };
    }
    if (result.status === null) {
      return { kind: 'error', exit: null, reason: `rtk rewrite terminated by signal ${result.signal ?? 'unknown'}` };
    }
    const stdout = (result.stdout || '').toString().trim();
    switch (result.status) {
      case 0:
        if (!stdout) return { kind: 'error', exit: 0, reason: 'rtk rewrite exit 0 with empty stdout' };
        return { kind: 'allow', exit: 0, rewritten: stdout };
      case 1:
        return { kind: 'passthrough', exit: 1 };
      case 2:
        return { kind: 'deny', exit: 2 };
      case 3:
        if (!stdout) return { kind: 'error', exit: 3, reason: 'rtk rewrite exit 3 with empty stdout' };
        return { kind: 'ask', exit: 3, rewritten: stdout };
      default:
        return { kind: 'error', exit: result.status, reason: `rtk rewrite unexpected exit ${result.status}` };
    }
  } catch (err) {
    return { kind: 'error', exit: null, reason: err && err.message ? err.message : String(err) };
  }
}

/**
 * Rewrite-only mode for auto-approve sessions (A13, Step 18b). May rewrite,
 * never asks, never denies; the decision directory is never read; every path
 * exits 0 so a broken hook can never block a command.
 */
function runRewriteOnly(input) {
  try {
    const started = Date.now();
    if (input.tool_name !== 'Bash') {
      process.exit(0);
    }
    const command = input.tool_input?.command;
    if (typeof command !== 'string' || command.length === 0) {
      process.exit(0);
    }
    const result = runRtkRewrite(command);
    let decision = 'error';
    let rewritten = null;
    switch (result.kind) {
      case 'allow':
        if (result.rewritten === command) {
          decision = 'passthrough';
        } else {
          decision = 'rewritten';
          rewritten = result.rewritten;
        }
        break;
      // Exit 3 on RTK 0.49+ is "no rule matched, text rewritten" — allow it.
      case 'ask':
        decision = result.rewritten === command ? 'passthrough' : 'rewritten';
        rewritten = result.rewritten;
        break;
      case 'passthrough':
        decision = 'passthrough';
        break;
      case 'deny':
        decision = 'ignored-deny';
        break;
      default:
        decision = 'error';
        break;
    }
    logDecision(input, decision, typeof result.exit === 'number' ? result.exit : null, Date.now() - started, 'rewrite-only');
    if (rewritten && rewritten !== command) {
      process.stdout.write(buildReply({
        decision: 'allow',
        updatedInput: { ...input.tool_input, command: rewritten },
      }));
    }
    process.exit(0);
  } catch {
    process.exit(0);
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
  const exit = typeof result.exit === 'number' ? result.exit : null;
  switch (result.kind) {
    case 'allow':
      // No-op rewrite (already starts with `rtk`) → don't bother emitting updatedInput
      if (result.rewritten === command) {
        return { forceDefer: false, rewriteDecision: 'passthrough', rewriteExit: exit };
      }
      return {
        updatedInput: { ...input.tool_input, command: result.rewritten },
        forceDefer: false,
        rewriteDecision: 'rewritten',
        rewriteExit: exit,
      };
    case 'ask':
      return {
        updatedInput: { ...input.tool_input, command: result.rewritten },
        forceDefer: true,
        rewriteDecision: result.rewritten === command ? 'passthrough' : 'rewritten',
        rewriteExit: exit,
      };
    case 'passthrough':
      return { forceDefer: false, rewriteDecision: 'passthrough', rewriteExit: exit };
    case 'deny':
      return { forceDefer: false, rewriteDecision: 'ignored-deny', rewriteExit: exit };
    case 'unavailable':
    case 'error':
    default:
      // Failures degrade to "no rewrite, normal flow". rtk error reasons are
      // already logged by spawnSync; we don't surface them in hook output to
      // avoid corrupting the JSON contract Claude Code expects.
      return { forceDefer: false, rewriteDecision: 'error', rewriteExit: exit };
  }
}

const rawInput = readFileSync(0, 'utf8');

// Auto-approve path (A13, Step 18b): rewrite-only, never ask or deny, never
// read the decision directory, and never let a hook failure block a command —
// not even unparseable input.
if (process.env.ORCHESTRATOR_RTK_REWRITE_ONLY === '1') {
  try {
    runRewriteOnly(JSON.parse(rawInput));
  } catch {
    process.exit(0);
  }
}

const input = JSON.parse(rawInput);
const toolName = input.tool_name || '';
const toolUseId = input.tool_use_id || '';

const rewriteStarted = Date.now();
const { updatedInput, forceDefer, rewriteDecision, rewriteExit } = maybeRewriteBashCommand(input);
if (process.env.ORCHESTRATOR_RTK_ENABLED === '1' && toolName === 'Bash' && rewriteDecision) {
  logDecision(input, rewriteDecision, rewriteExit, Date.now() - rewriteStarted, 'defer');
}

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
