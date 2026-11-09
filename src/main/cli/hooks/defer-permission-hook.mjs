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

// PermissionRequest is wired only for sessions Harness started itself (no live
// prompt channel). It fires only for calls Claude would have to ask about, and
// refuses them with text that tells the model whether a person was asked and
// what would allow the call. Both constants must equal their TypeScript twins
// (HARNESS_UNASKED_PREFIX in src/main/cli/adapters/claude-permission-response.ts,
// CLAUDE_ALLOW_RULE_TOOLS in src/shared/permissions/claude-allow-rule-tools.ts);
// a spec checks them.
const HARNESS_UNASKED_PREFIX = 'Harness: nobody was asked about this call. ';
const CLAUDE_ALLOW_RULE_TOOLS = ['Write', 'Edit', 'Read', 'Bash'];
function permissionRequestRefusal(toolName) {
  const tool = toolName || 'this tool';
  // Harness raises its "Always allow" card for these tools from Claude's own
  // wording, so the text keeps that first sentence and adds what is true here.
  if (CLAUDE_ALLOW_RULE_TOOLS.includes(toolName)) {
    return `Claude requested permissions to use ${tool}, but you haven't granted it yet. `
      + 'Harness is showing the user a card for this call that can allow it; if they allow it, Harness restarts this session '
      + 'and trying again will then work. Until then nothing will let it through, so say in your reply what you could not do.';
  }
  return HARNESS_UNASKED_PREFIX
    + `Claude Code needs approval to run ${tool} here, and Harness cannot ask for it while this session runs on its own, `
    + 'so nothing the user clicks now can let this call through. Do not ask them to approve a prompt. Carry on without it if you can; '
    + 'when you report, name the tool and say it can be allowed by switching on Auto-approve for this session or scheduled job, '
    + 'or by adding a Claude allow rule for it.';
}

// NOTE — updatedInput caveat:
// Whether the installed Claude CLI honors an `updatedInput` field in a PreToolUse
// hook reply is version-dependent and cannot be validated headlessly here.
// We emit it under hookSpecificOutput.updatedInput AND at the top level so the
// plumbing is in place for whichever shape a future CLI version expects.
// When the CLI does not support it, the call degrades to a plain 'allow' with the
// original tool input unchanged.  Do NOT assume end-to-end modify works until it
// has been validated against a live Claude CLI build that documents this feature.
const reply = (decision, reason, updatedInput) => {
  const hookSpecificOutput = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    ...(reason ? { permissionDecisionReason: reason } : {}),
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  };
  const response = {
    hookSpecificOutput,
    ...(updatedInput !== undefined ? { updatedInput } : {}),
  };
  process.stdout.write(JSON.stringify(response));
};

const input = JSON.parse(readFileSync(0, 'utf8'));
const toolName = input.tool_name || '';
const toolUseId = input.tool_use_id || '';

if (input.hook_event_name === 'PermissionRequest') {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: permissionRequestRefusal(input.tool_name) } } }));
  process.exit(0);
}

// Check for a pre-existing decision from the orchestrator (used on resume)
const DECISION_DIR = process.env.ORCHESTRATOR_DECISION_DIR;
if (DECISION_DIR && toolUseId) {
  const decisionFile = join(DECISION_DIR, `${toolUseId}.json`);
  if (existsSync(decisionFile)) {
    const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
    reply(decision.permissionDecision, decision.reason, decision.updatedInput);
    process.exit(0);
  }
}

// Auto-approve safe tools, defer everything else for user approval
if (AUTO_APPROVE_TOOLS.has(toolName)) {
  reply('allow');
} else {
  reply('defer', 'Orchestrator: awaiting user approval');
}
