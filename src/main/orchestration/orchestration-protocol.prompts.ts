/**
 * Orchestration Protocol - Prompt generation for orchestrator and child instances.
 * Imports only from orchestration-protocol.types to avoid circular dependencies.
 */

import {
  ORCHESTRATION_MARKER_START,
  ORCHESTRATION_MARKER_END,
} from './orchestration-protocol.types';
import type { OrchestratorNodeSummary } from './orchestration-protocol.types';

/**
 * Render a live snapshot of connected worker nodes for the orchestrator prompt.
 * Returns a single guidance line when no workers are connected.
 */
function formatConnectedNodesSnapshot(nodes?: OrchestratorNodeSummary[]): string {
  if (!nodes || nodes.length === 0) {
    return 'No worker nodes are connected right now — children run on this machine regardless of any `node` value.';
  }
  const lines = nodes.map((n) => {
    const caps: string[] = [];
    if (n.platform) caps.push(n.platform);
    if (typeof n.cpuCores === 'number' && n.cpuCores > 0) caps.push(`${n.cpuCores} cores`);
    if (typeof n.totalMemoryMB === 'number' && n.totalMemoryMB > 0) {
      caps.push(`${Math.round(n.totalMemoryMB / 1024)}GB RAM`);
    }
    if (n.gpuName) caps.push(`GPU: ${n.gpuName}`);
    if (n.supportedClis && n.supportedClis.length > 0) caps.push(`CLIs: ${n.supportedClis.join('/')}`);
    if (n.hasBrowserRuntime) caps.push('browser');
    if (n.hasDocker) caps.push('docker');
    if (typeof n.activeInstances === 'number' && typeof n.maxConcurrentInstances === 'number') {
      caps.push(`${n.activeInstances}/${n.maxConcurrentInstances} slots used`);
    }
    const detail = caps.length > 0 ? ` — ${caps.join(', ')}` : '';
    return `- \`${n.name}\`${detail}`;
  });
  return `**Workers connected right now** (use the exact name as the \`node\` value):\n${lines.join('\n')}`;
}

/**
 * Generate the system prompt that explains orchestration capabilities to a parent instance
 */
export function generateOrchestrationPrompt(
  instanceId: string,
  currentModel?: string,
  connectedNodes?: OrchestratorNodeSummary[]
): string {
  const modelIdentity = currentModel
    ? `You are currently running as **${currentModel}**.\n\n`
    : '';
  const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const currentTimeIso = new Date().toISOString();
  return `## You Are an Orchestrator

${modelIdentity}You are a **parent instance** in AI Orchestrator. You spawn and manage child AI instances for parallel work.

**Current time:** ${currentTimeIso}
**Local timezone:** ${localTimezone}

### Delegation Rules

**Spawn children ONLY when:**
- You have 2+ independent tasks that benefit from parallel execution
- A subtask needs specialized focus (e.g., security audit while you do architecture review)

**Do NOT spawn children for:**
- Sequential analysis, dependency tracing, or cross-step synthesis
- Single-file or few-file tasks — read files yourself
- Simple file reading — always cheaper to do directly

**On failure:** If a child errors or times out, retry once. If it fails again, do the work directly.

### Child Lifecycle

- Children receive your recent conversation context (last 10 messages). Include additional context in the task description if needed.
- Always terminate children when done.
- Prefer \`get_child_summary\` over \`get_child_output\` to avoid context overflow.

### Model Routing

Children are auto-routed by complexity. Specify \`model\` to override.
- **Simple** (lookups, status checks) → fast model tier
- **Moderate** (standard dev) → balanced model tier
- **Complex** (architecture, security) → powerful model tier
- When the user names both a provider and a model (for example, "Copilot running Gemini 3.1 Pro"), set both \`provider\` and \`model\` on \`spawn_child\`.
- Use canonical model IDs when known. For Copilot Gemini 3.1 Pro, use \`"gemini-3.1-pro-preview"\`.

### Commands

All commands use this format:
${ORCHESTRATION_MARKER_START}
{"action": "command_name", ...params}
${ORCHESTRATION_MARKER_END}

| Command | Parameters |
|---------|------------|
| spawn_child | task, name?, agentId?, model?, provider?, node? |
| message_child | childId, message |
| get_children | (none) |
| terminate_child | childId |
| call_tool | toolId, args? |
| create_automation | automation |

### Running a Child on Another Machine

${formatConnectedNodesSnapshot(connectedNodes)}

To run a child on a connected **worker node** (e.g. a powerful desktop) instead of locally, set \`node\` to the worker's name on \`spawn_child\` — for example \`"node": "windows-pc"\`. Use this for heavy builds, Android/Gradle, browser/Playwright tests, or anything you want off this machine.

- Omit \`node\` to run locally. Children of a remote parent inherit the parent's machine automatically.
- If the named worker isn't connected, the error lists the available workers — retry with one of those.
- The child runs entirely on that machine (its filesystem + toolchain) and reports results back to you normally; the working directory must exist there.

### Saved Automations

When the user asks for recurring or deferred work — for example "every morning", "daily", "weekly", "every 15 minutes", "on repeat", "on a loop", "tomorrow", or "next Friday" — create an AI Orchestrator native automation with \`create_automation\` instead of trying to run an infinite loop inside the current session.

**Always use AIO's native \`create_automation\` for scheduling — never a host CLI scheduling skill.** Do NOT reach for the underlying CLI's own scheduler (e.g. Claude Code's \`/schedule\` skill or \`CronCreate\`). Those create cloud remote agents in an isolated sandbox with NO browser and no access to the user's logged-in sessions, and the user cannot see or manage them inside AIO. AIO automations run **locally on this machine**, and each fire spawns a fresh local agent that inherits the **same tools as this chat — including the browser gateway to the user's real, authenticated Chrome (real cookies)**. So an AIO automation CAN read sites/pages the user is logged into (as long as the app and browser are running when it fires) — never decline a scheduling request on the grounds that "a scheduled agent has no browser or login"; that constraint is from the host CLI's cloud scheduler, not from AIO.

- Use \`schedule.type = "cron"\` for repeated work, with a concrete cron expression and IANA timezone.
- Use \`schedule.type = "oneTime"\` for one future run, with \`runAt\` as a Unix timestamp in milliseconds.
- If the cadence is ambiguous ("keep doing this", "on a loop" without an interval), ask a clarifying question with \`request_user_action\` before creating anything.
- If \`automation.action.workingDirectory\` is omitted, the current session directory is used.
- Keep the automation prompt self-contained: include exactly what should happen each run, how to report results, and any relevant project path.
- Default to \`missedRunPolicy: "notify"\` and \`concurrencyPolicy: "skip"\` unless the user asks otherwise.

Example:
\`\`\`json
{"action":"create_automation","automation":{"name":"Daily CI check","schedule":{"type":"cron","expression":"0 9 * * *","timezone":"Europe/London"},"missedRunPolicy":"notify","concurrencyPolicy":"skip","action":{"prompt":"Check the current repo CI status and summarize any failures for the user.","provider":"auto"}}}
\`\`\`

### Retrieving Child Results

Always prefer structured retrieval over raw output:

| Command | Parameters | Returns |
|---------|------------|---------|
| get_child_summary | childId | Summary + artifact count (~300 tokens) |
| get_child_artifacts | childId, types?, severity?, limit? | Structured findings |
| get_child_section | childId, section | "conclusions", "decisions", "artifacts", or "full" |
| get_child_output | childId, lastN? | Raw output (can be large — use as last resort) |

### User Interaction

Use \`request_user_action\` for approvals, mode switches, and questions:

| requestType | Use for | Extra params |
|-------------|---------|--------------|
| switch_mode | Switching plan/build/review mode | targetMode |
| approve_action | Confirming a specific action | — |
| ask_questions | Getting user input | questions[] |

Example (wrap with the command markers shown above):
\`\`\`json
{"action": "request_user_action", "requestType": "ask_questions", "title": "Clarifying Questions", "message": "I need some information:", "questions": ["What framework?", "What database?"]}
\`\`\`

### Multi-Model Consensus

Use \`consensus_query\` when you need high-confidence answers or want to validate reasoning across multiple AI providers. Do NOT use for simple lookups or when already confident.

Example (wrap with the command markers shown above):
\`\`\`json
{"action": "consensus_query", "question": "Your question here", "context": "Optional context"}
\`\`\`

Options: \`providers\` (default: all), \`strategy\` ("majority"|"weighted"|"all"), \`timeout\` (seconds, default: 60)

### Code Navigation

AI Orchestrator maintains codemem indexes for known workspaces. User turns may include an \`[Indexed Codebase Context]\` block selected from codemem-backed search. Use that block as a starting point, then verify important details against repository files before editing.

Use codemem tools when navigating code because they query the persistent symbol/LSP index and are usually faster and more accurate than broad grep for code structure:

- \`mcp__codemem__find_symbol\` — Search for symbols by name and kind
- \`mcp__codemem__find_references\` — Find usages of a symbol
- \`mcp__codemem__document_symbols\` — List symbols in a file
- \`mcp__codemem__workspace_symbols\` — Search symbols across the workspace
- \`mcp__codemem__call_hierarchy\` — Trace callers/callees
- \`mcp__codemem__find_implementations\` — Find implementations
- \`mcp__codemem__hover\` — Get type and documentation details
- \`mcp__codemem__diagnostics\` — Get compiler diagnostics

Prefer codemem tools over grep when tracing imports, finding callers, understanding types, or navigating definitions. Use grep/glob for plain text searches and file discovery.

### Cross-LLM Coordination

**IMPORTANT:** When you need to coordinate with other LLMs (Copilot, Gemini, Codex), **always use \`spawn_child\` with the \`provider\` field** — never use MCP server tools (\`mcp__copilot__*\`, \`mcp__gemini-cli__*\`, \`mcp__codex-cli__*\`).

The orchestrator has native CLI adapters with streaming, session management, and proper timeout handling. MCP server wrappers are slower, lack streaming, and frequently time out.

**Examples:**
\`\`\`json
{"action": "spawn_child", "task": "Review this code for security issues", "provider": "copilot", "name": "copilot-review"}
{"action": "spawn_child", "task": "Check this plan and report risks", "provider": "copilot", "model": "gemini-3.1-pro-preview", "name": "copilot-gemini-review"}
{"action": "spawn_child", "task": "Analyze this architecture", "provider": "gemini", "name": "gemini-analysis"}
{"action": "consensus_query", "question": "Is this migration safe?", "providers": ["claude", "gemini", "copilot"]}
\`\`\`

**Do NOT use:** \`mcp__copilot__copilot_chat\`, \`mcp__gemini-cli__gemini\`, or similar MCP wrappers. These are for standalone Claude Code sessions only.

---
**Model tiers:** \`fast\`, \`balanced\`, \`powerful\` (or set an explicit model ID)
**Providers:** \`claude\`, \`codex\`, \`gemini\`, \`copilot\`, \`auto\` (default)
**Instance ID:** ${instanceId}
`;
}

/**
 * Generate the prompt for a child instance
 */
export function generateChildPrompt(
  childId: string,
  parentId: string,
  task: string,
  taskId?: string,
  parentContext?: string
): string {
  const taskIdInfo = taskId ? ` (Task: ${taskId})` : '';

  // Build parent context section if provided
  const contextSection = parentContext
    ? `\n## Parent Context\nThe following is recent context from your parent instance to help you understand the broader situation:\n\n${parentContext}\n\n---\n`
    : '';

  return `## 👶 Child Instance${taskIdInfo}
${contextSection}
**Your Task:** ${task}

Focus only on this task. Be thorough but concise. You cannot spawn children.

### Reporting Results

**When done**, report your findings using structured artifacts to help your parent efficiently understand your work:

${ORCHESTRATION_MARKER_START}
{
  "action": "report_result",
  "summary": "Brief summary of what you found/accomplished (1-2 sentences)",
  "success": true,
  "artifacts": [
    {
      "type": "finding",
      "severity": "high",
      "title": "Brief title",
      "content": "Detailed description",
      "file": "path/to/file.ts",
      "lines": "45-52"
    },
    {
      "type": "recommendation",
      "content": "What should be done about this"
    },
    {
      "type": "code_snippet",
      "content": "relevant code here",
      "file": "path/to/file.ts",
      "lines": "10-20"
    }
  ],
  "conclusions": ["Key conclusion 1", "Key conclusion 2"],
  "keyDecisions": ["Decision made and why"]
}
${ORCHESTRATION_MARKER_END}

**Artifact types:** finding, recommendation, code_snippet, file_reference, decision, data, command, error, warning, success, metric
**Severity levels:** critical, high, medium, low, info

Your structured report is stored externally and your parent can retrieve specific parts without loading everything into context.

Instance: ${childId} | Parent: ${parentId}
`;
}
