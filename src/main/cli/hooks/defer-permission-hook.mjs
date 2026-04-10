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
