/**
 * Orchestrator-Tools MCP Forwarder (stdio side, runs inside the `aio-mcp` SEA).
 *
 * Replaces the old `orchestrator-tools-mcp-server.ts` that opened the
 * operator database directly. The forwarder registers a parallel set of MCP
 * tools whose handlers serialize the args, hand them to
 * `OrchestratorToolsRpcClient.call()`, and return whatever the parent
 * process produces.
 *
 * No `better-sqlite3` import path means no native-module ABI dependency,
 * which is the whole reason the SEA dispatcher exists and the reason the
 * `RunAsNode` Electron fuse can go back to `false` for packaged builds.
 */

import type { McpServerToolDefinition } from './mcp-server-tools';
import { runStdioMcpForwarder } from './mcp-stdio-forwarder';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import { RELEASE_TOOL_SPECS, type ReleaseToolName } from './orchestrator-release-tools';
import { createFileTransferForwarderTools } from './orchestrator-file-transfer-forwarder-tools';
import { createOrchestratorEvidenceToolDefinitions } from './orchestrator-evidence-tools';

const REMOTE_NODE_DISCOVERY_HINT =
  'Harness can use connected remote worker nodes, including Windows PCs, laptops, desktops, named machines, remote machines, other machines, and another computer, through list_remote_nodes, run_on_node, read_node_output, and terminate_node_instance. If the user names a machine or asks for work on another computer, for example "Noah\'s laptop", check list_remote_nodes before local filesystem or shell work. For browser or Android/mobile testing, inspect node capabilities and pass requiresBrowser or requiresAndroid to run_on_node so the worker receives the right testing tools. Terminate finished run_on_node instances when you are done with them — idle agents hold a capacity slot on the node until terminated.';

const RELEASE_TOOL_NAMES = Object.keys(RELEASE_TOOL_SPECS) as ReleaseToolName[];

/**
 * Build the MCP tool definitions that proxy back to the parent process.
 * Kept as a factory taking an `OrchestratorToolsRpcClient` so tests can
 * drive it with a stub client without spinning up a real socket.
 */
export function createOrchestratorToolsForwarderTools(
  client: OrchestratorToolsRpcClientLike,
): McpServerToolDefinition[] {
  return [
    {
      name: 'git_batch_pull',
      description:
        'Discover Git repositories below a root path and safely fetch plus fast-forward pull clean tracking branches. Dirty, detached, divergent, no-upstream, and no-remote repositories are skipped with reasons.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string', description: 'Root directory to scan for Git repositories.' },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ignore patterns passed to repository discovery.',
          },
          concurrency: {
            type: 'integer',
            minimum: 1,
            maximum: 16,
            description: 'Maximum repositories to process concurrently. Defaults to 6.',
          },
        },
        required: ['root'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('git_batch_pull args must be an object');
        }
        return client.call('orchestrator_tools.git_batch_pull', args as Record<string, unknown>);
      },
    },
    {
      name: 'list_remote_nodes',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Lists currently registered remote worker nodes with status, platform, supported CLIs, browser/GPU/Docker capabilities, active capacity, working directories, heartbeat, and latency. Read-only; does not spawn work.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('list_remote_nodes args must be an object');
        }
        return client.call('orchestrator_tools.list_remote_nodes', args as Record<string, unknown>);
      },
    },
    {
      name: 'run_on_node',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Run a task on a connected remote worker node, such as a Windows PC, other machine, remote machine, or another computer, by spawning an AI agent there with the given prompt. The agent runs project-lessly using the node's default working directory unless one is provided. Returns immediately with the spawned instance id; output streams asynchronously and can be inspected from the app or read with read_node_output.`,
      inputSchema: {
        type: 'object',
        properties: {
          node: {
            type: 'string',
            description:
              'Target worker node by name (e.g. "windows-pc") or node id (UUID). Optional: when omitted and exactly one node is connected, that node is used.',
          },
          prompt: {
            type: 'string',
            description: 'Natural-language task / instruction for the agent on the node.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Working directory on the node. Optional — defaults to the node's first advertised working directory (project-less spawn).",
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok'],
            description: 'CLI provider to use on the node (defaults to the node/app default).',
          },
          model: {
            type: 'string',
            description: 'Optional model override.',
          },
          requiresBrowser: {
            type: 'boolean',
            description:
              'Require browser automation on the worker and inject chrome-devtools tools. Use for remote browser evidence, screenshots, viewport sweeps, or UI audits.',
          },
          requiresAndroid: {
            type: 'boolean',
            description:
              'Require Android automation on the worker and inject mobile-mcp tools. Use for emulator, physical device, adb, APK, phone, or native app testing. If omitted, clearly Android-focused prompts may be inferred.',
          },
          androidDeviceKind: {
            type: 'string',
            enum: ['emulator', 'physical', 'any'],
            description:
              'Android device preference when requiresAndroid is true. Defaults to any.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('run_on_node args must be an object');
        }
        return client.call('orchestrator_tools.run_on_node', args as Record<string, unknown>);
      },
    },
    {
      name: 'read_node_output',
      description:
        'Read the output produced by an instance previously started with run_on_node. Returns the most recent messages (assistant text, tool calls/results, errors), the instance status, and a `done` flag indicating whether the turn has completed. Optionally waits a bounded time for the turn to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: {
            type: 'string',
            description: 'Instance id returned by run_on_node.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Max number of most-recent messages to return (default 100).',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 120000,
            description:
              'Optionally block up to this many milliseconds, polling until the turn completes. 0/omitted returns immediately.',
          },
        },
        required: ['instanceId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('read_node_output args must be an object');
        }
        return client.call('orchestrator_tools.read_node_output', args as Record<string, unknown>);
      },
    },
    {
      name: 'terminate_node_instance',
      description:
        'Terminate agent instances previously spawned with run_on_node, freeing the worker node\'s capacity. Two modes: pass instanceId to terminate one specific instance (even if still working), or pass allIdle: true (optionally with node) to clean up every finished run_on_node instance. Idle one-shot agents otherwise stay alive and count against the node\'s maxConcurrentInstances until terminated. Only run_on_node-spawned instances can be terminated; interactive user sessions are never touched.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: {
            type: 'string',
            description: 'Instance id returned by run_on_node. Mutually exclusive with allIdle.',
          },
          node: {
            type: 'string',
            description: 'Optional node name or id to scope the allIdle sweep to one worker node.',
          },
          allIdle: {
            type: 'boolean',
            description:
              'Terminate every finished run_on_node instance (optionally scoped to node). Mutually exclusive with instanceId.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('terminate_node_instance args must be an object');
        }
        return client.call('orchestrator_tools.terminate_node_instance', args as Record<string, unknown>);
      },
    },
    ...createFileTransferForwarderTools(client),
    {
      name: 'list_settings',
      description:
        'List Harness app settings available through the programmatic settings surface. Secret values are redacted, read-only settings are marked unwritable, and restart-required settings are flagged.',
      inputSchema: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description:
              'Optional category filter such as general, display, orchestration, memory, advanced, review, network, mcp, rtk, remote-nodes, mobile, or auxiliary-llm.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('list_settings args must be an object');
        }
        return client.call('orchestrator_tools.settings.list', args as Record<string, unknown>);
      },
    },
    {
      name: 'get_setting',
      description:
        'Read one Harness app setting by key. Secret-tier settings are refused; call list_settings first to inspect readability and writability.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Setting key from list_settings.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('get_setting args must be an object');
        }
        return client.call('orchestrator_tools.settings.get', args as Record<string, unknown>);
      },
    },
    {
      name: 'set_setting',
      description:
        'Set one writable Harness app setting. Refuses read-only and secret keys; JSON-backed settings accept real objects and are stringified by the parent process.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Writable setting key from list_settings.' },
          value: { description: 'New setting value. Type must match the setting.' },
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('set_setting args must be an object');
        }
        return client.call('orchestrator_tools.settings.set', args as Record<string, unknown>);
      },
    },
    {
      name: 'reset_setting',
      description:
        'Reset one writable Harness app setting to its built-in default. Refuses read-only and secret keys for the same policy reasons as set_setting.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Writable setting key from list_settings.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('reset_setting args must be an object');
        }
        return client.call('orchestrator_tools.settings.reset', args as Record<string, unknown>);
      },
    },
    {
      name: 'update_node_config',
      description:
        'Push a sensitive per-node worker config.update to a connected remote node using the same service-scoped path as the Settings UI. Supports browserAutomation, androidAutomation, extensionRelay, and fileTransfer blocks; call list_remote_nodes first.',
      inputSchema: {
        type: 'object',
        properties: {
          nodeId: {
            type: 'string',
            description: 'Connected worker node id or exact node name, for example "windows-pc".',
          },
          browserAutomation: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              profileDir: { type: 'string' },
              headless: { type: 'boolean' },
              chromePath: { type: 'string' },
              remoteDebuggingPort: { type: 'integer', minimum: 1, maximum: 65535 },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
          androidAutomation: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              sdkPath: { type: 'string' },
              defaultAvd: { type: 'string' },
              headlessEmulator: { type: 'boolean' },
              maxEmulators: { type: 'integer', minimum: 1, maximum: 4 },
              bootTimeoutMs: { type: 'integer', minimum: 10000, maximum: 600000 },
              allowPhysicalDevices: { type: 'boolean' },
              injectMaestroMcp: { type: 'boolean' },
              appiumMcp: { type: 'boolean' },
              mobileMcpVersion: { type: 'string' },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
          extensionRelay: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
          fileTransfer: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              roots: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                    path: { type: 'string' },
                    read: { type: 'boolean' },
                    write: { type: 'boolean' },
                    approvalRequired: { type: 'boolean' },
                  },
                  required: ['id', 'label', 'path', 'read', 'write'],
                  additionalProperties: false,
                },
                maxItems: 64,
              },
              maxFileBytes: { type: 'integer', minimum: 1, maximum: 50 * 1024 * 1024 },
            },
            required: ['enabled'],
            additionalProperties: false,
          },
        },
        required: ['nodeId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('update_node_config args must be an object');
        }
        return client.call(
          'orchestrator_tools.node_config.update',
          args as Record<string, unknown>,
        );
      },
    },
    {
      name: 'create_automation',
      description:
        'Create a scheduled automation in Harness: a recurring (cron) or one-time prompt that runs an autonomous agent on a schedule. Use this when the user asks to "set up an automation", "run this every day/week", "schedule this", or "remind me to…". Provide a 5-field cron expression for recurring schedules, or an ISO-8601 runAt for a one-time run. The working directory defaults to the current chat\'s project. Returns the created automation\'s id, schedule summary, and next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short title for the automation.' },
          prompt: {
            type: 'string',
            description: 'The instruction the scheduled agent runs each time it fires.',
          },
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression for a recurring schedule (minute hour day-of-month month day-of-week). Provide this OR runAt. E.g. daily at 8pm = "0 20 * * *"; weekdays at 9am = "0 9 * * 1-5".',
          },
          runAt: {
            type: 'string',
            description: 'ISO-8601 timestamp for a one-time automation. Provide this OR cron.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone (e.g. "America/New_York"). Defaults to the app timezone.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Absolute working directory the automation runs in. Optional — defaults to the calling chat's project folder.",
          },
          description: { type: 'string', description: 'Optional human-readable description.' },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok'],
            description: 'CLI provider to run with (defaults to the app default).',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the automation is active immediately. Defaults to true.',
          },
        },
        required: ['name', 'prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('create_automation args must be an object');
        }
        return client.call('orchestrator_tools.create_automation', args as Record<string, unknown>);
      },
    },
    {
      name: 'list_automations',
      description:
        'List the scheduled automations configured in Harness, with their schedule, enabled state, next/last run times, and working directory. Read-only. Use this to check what automations already exist before creating or describing them.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('list_automations args must be an object');
        }
        return client.call('orchestrator_tools.list_automations', args as Record<string, unknown>);
      },
    },
    {
      name: 'delete_automation',
      description:
        'Permanently delete a scheduled automation in Harness by its id. Use this when the user asks to "delete", "remove", or "get rid of" an automation. This cannot be undone — the automation and its schedule are removed. Any run currently in flight keeps running but is detached. To temporarily stop an automation without deleting it, use update_automation with enabled:false instead. Call list_automations first to find the id. Returns the deleted automation\'s id and name.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Id of the automation to delete (from list_automations).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('delete_automation args must be an object');
        }
        return client.call('orchestrator_tools.delete_automation', args as Record<string, unknown>);
      },
    },
    {
      name: 'update_automation',
      description:
        'Update an existing Harness automation by its id. Use this to change an automation\'s prompt, name, description, schedule (cron or one-time runAt), timezone, working directory, provider, or to pause/resume it (enabled:false disables without deleting, enabled:true resumes). Only the fields you provide change; omit the rest. Provide cron OR runAt (not both) to change the schedule. Call list_automations first to find the id. Returns the updated automation\'s schedule summary and next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the automation to update (from list_automations).' },
          name: { type: 'string', description: 'New title. Omit to leave unchanged.' },
          prompt: {
            type: 'string',
            description: 'New instruction the scheduled agent runs each fire. Omit to leave unchanged.',
          },
          description: { type: 'string', description: 'New human-readable description. Omit to leave unchanged.' },
          cron: {
            type: 'string',
            description:
              'New 5-field cron expression for a recurring schedule. Provide this OR runAt. Omit both to leave the schedule unchanged.',
          },
          runAt: {
            type: 'string',
            description: 'New ISO-8601 timestamp for a one-time schedule. Provide this OR cron.',
          },
          timezone: {
            type: 'string',
            description: 'New IANA timezone (e.g. "America/New_York"). Omit to keep the existing timezone.',
          },
          workingDirectory: {
            type: 'string',
            description: 'New absolute working directory. Omit to leave unchanged.',
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok'],
            description: 'New CLI provider. Omit to leave unchanged.',
          },
          model: {
            type: 'string',
            description: 'New model override for the spawned agent. Omit to leave unchanged.',
          },
          reasoningEffort: {
            type: 'string',
            enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow'],
            description: 'New reasoning-effort level for the spawned agent. Omit to leave unchanged.',
          },
          yoloMode: {
            type: 'boolean',
            description:
              'Whether each run executes with auto-approval (yolo) mode. Omit to leave unchanged.',
          },
          missedRunPolicy: {
            type: 'string',
            enum: ['skip', 'notify', 'runOnce'],
            description:
              'What to do when a scheduled fire was missed (app/machine asleep). Omit to leave unchanged.',
          },
          concurrencyPolicy: {
            type: 'string',
            enum: ['skip', 'queue'],
            description:
              'What to do when a previous run is still in flight at the next fire. Omit to leave unchanged.',
          },
          enabled: {
            type: 'boolean',
            description:
              'Enable (resume) or disable (pause) the automation without deleting it. Omit to leave unchanged.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('update_automation args must be an object');
        }
        return client.call('orchestrator_tools.update_automation', args as Record<string, unknown>);
      },
    },
    {
      name: 'postpone_automation',
      description:
        'Postpone (delay/snooze) a Harness automation\'s next run to a later time. Use this when the user asks to "postpone", "delay", "snooze", or "push back" an automation. For a one-time automation this reschedules its single run; for a recurring automation it skips ahead to the new time once and then resumes its normal cadence. Provide exactly one of untilIso (an absolute ISO-8601 time) or delayMinutes (relative push). Call list_automations first to find the id. Returns the new next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the automation to postpone (from list_automations).' },
          untilIso: {
            type: 'string',
            description: 'Absolute new next-run time (ISO-8601). Provide this OR delayMinutes.',
          },
          delayMinutes: {
            type: 'integer',
            minimum: 1,
            maximum: 525600,
            description:
              'Push the next run this many minutes later than its current scheduled time (or later than now). Provide this OR untilIso.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('postpone_automation args must be an object');
        }
        return client.call('orchestrator_tools.postpone_automation', args as Record<string, unknown>);
      },
    },
    {
      name: 'request_doc_review',
      description:
        'Ask James to review a plan, spec, audit, or decision doc. First write a self-contained HTML review artifact into the workspace\'s .aio-review/ directory (use the doc-review-artifact skill), then call this with its path. James reviews it in-app and his decisions arrive back here as a user message — the canonical "Document review feedback" block. Apply agreed changes to the Markdown source and re-render.',
      inputSchema: {
        type: 'object',
        properties: {
          artifact_path: {
            type: 'string',
            description:
              'Path to the review artifact HTML, inside the workspace .aio-review/ directory. Absolute or workspace-relative.',
          },
          title: {
            type: 'string',
            description: 'Short human title for the review (shown in the review pane).',
          },
          source_path: {
            type: 'string',
            description: 'Optional repo-relative path of the Markdown source the artifact renders.',
          },
        },
        required: ['artifact_path', 'title'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('request_doc_review args must be an object');
        }
        return client.call('orchestrator_tools.request_doc_review', args as Record<string, unknown>);
      },
    },
    {
      name: 'get_doc_review_result',
      description:
        'Poll the status of a review created with request_doc_review. Returns pending until James decides, then the overall verdict, per-item decisions, and durable delivery outcome. A delivered result also arrives as a user message; queued, failed, or interrupted delivery remains visible here.',
      inputSchema: {
        type: 'object',
        properties: {
          review_id: {
            type: 'string',
            description: 'The reviewId returned by request_doc_review.',
          },
        },
        required: ['review_id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error('get_doc_review_result args must be an object');
        }
        return client.call('orchestrator_tools.get_doc_review_result', args as Record<string, unknown>);
      },
    },
    ...RELEASE_TOOL_NAMES.map((name): McpServerToolDefinition => ({
      name,
      description: RELEASE_TOOL_SPECS[name].description,
      inputSchema: RELEASE_TOOL_SPECS[name].inputSchema,
      handler: async (args) => {
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          throw new Error(`${name} args must be an object`);
        }
        return client.call(`orchestrator_tools.${name}`, args as Record<string, unknown>);
      },
    })),
    ...createOrchestratorEvidenceToolDefinitions({
      instanceId: 'rpc-injected',
      conversationId: 'rpc-injected',
      coordinator: {
        list: (payload) => client.call('orchestrator_tools.evidence_list', stripInjected(payload)),
        search: (payload) => client.call('orchestrator_tools.evidence_search', stripInjected(payload)),
        read: (payload) => client.call('orchestrator_tools.evidence_read', stripInjected(payload)),
        compare: (payload) => client.call('orchestrator_tools.evidence_compare', stripInjected(payload)),
        verify: (payload) => client.call('orchestrator_tools.evidence_verify', stripInjected(payload)),
      },
    }),
  ];
}

export async function runOrchestratorToolsForwarder(
  client: OrchestratorToolsRpcClientLike = new OrchestratorToolsRpcClient(),
): Promise<void> {
  await runStdioMcpForwarder({
    loggerName: 'OrchestratorToolsMcpForwarder',
    tools: createOrchestratorToolsForwarderTools(client),
  });
}

function stripInjected(input: object): Record<string, unknown> {
  const payload = { ...input } as Record<string, unknown>;
  delete payload['requester'];
  delete payload['conversationId'];
  return payload;
}
