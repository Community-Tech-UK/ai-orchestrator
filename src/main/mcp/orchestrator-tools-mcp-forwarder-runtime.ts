/**
 * Stdio entry for the orchestrator-tools MCP forwarder. Kept out of the
 * tool-table module so that file stays under the 700-line hard cap.
 */

import { getLogger } from '../logging/logger';
import { runStdioMcpForwarder } from './mcp-stdio-forwarder';
import {
  createDeferredOrchestratorTools,
  ORCHESTRATOR_TOOL_DEFERRAL_ENV,
  type RemoteWorkerListing,
} from './orchestrator-mcp-deferral';
import { TOOL_REVEAL_RPC_METHODS } from './orchestrator-tools-rpc-tool-reveal';
import { restoreRevealedToolNames } from './tool-reveal-restore';
import { createStableOrchestratorTools, ORCHESTRATOR_TOOL_STABLE_ENV } from './orchestrator-mcp-stable-tools';
import {
  OrchestratorToolsRpcClient,
  type OrchestratorToolsRpcClientLike,
} from './orchestrator-tools-rpc-client';
import {
  createOrchestratorToolsForwarderTools,
  resolveOrchestratorToolsForwarderOptions,
} from './orchestrator-tools-mcp-forwarder';

/** Longest startup waits for the worker roster; after that the remote-worker tools simply stay listed. */
export const WORKER_ROSTER_PROBE_TIMEOUT_MS = 1_500;

/**
 * Whether any remote worker is connected: `true`/`false` when the roster
 * answered, `undefined` when it could not be read (failure, timeout or an
 * unfamiliar answer), in which case nothing is hidden.
 */
export async function probeRemoteWorkersConnected(
  client: OrchestratorToolsRpcClientLike,
  timeoutMs = WORKER_ROSTER_PROBE_TIMEOUT_MS,
): Promise<boolean | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  // The rejection handler also covers a call that fails after the deadline.
  const answer = Promise.resolve().then(() => client.call('orchestrator_tools.list_remote_nodes', {}, { timeoutMs }))
    .then(connectedWorkers, () => undefined);
  try {
    return await Promise.race([answer, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function connectedWorkers(roster: unknown): boolean | undefined {
  if (!roster || typeof roster !== 'object') return undefined;
  const { connectedCount, nodes } = roster as { connectedCount?: unknown; nodes?: unknown };
  if (connectedCount !== undefined) {
    // A count that is present but not a usable number is an unfamiliar answer, not "zero".
    return typeof connectedCount === 'number' && Number.isInteger(connectedCount) && connectedCount >= 0
      ? connectedCount > 0
      : undefined;
  }
  if (!Array.isArray(nodes)) return undefined;
  const states = nodes.map((node: unknown): boolean | undefined => {
    if (!node || typeof node !== 'object') return undefined;
    const value = node as { connected?: unknown; status?: unknown };
    if (value.connected === true || value.status === 'connected') return true;
    if (value.connected === false || value.status === 'offline' || value.status === 'disconnected') return false;
    return undefined;
  });
  if (states.includes(true)) return true;
  return states.includes(undefined) ? undefined : false;
}

const FORWARDER_LOGGER_NAME = 'OrchestratorToolsMcpForwarder';
const REVEAL_RESTORE_CALL_TIMEOUT_MS = 2_000;
/**
 * One try, run beside the roster probe, so startup stays near 2 s. OpenCode
 * gives an MCP server about 5 s to list its tools; a missed restore costs one
 * more tool search, a missed startup costs every Harness tool.
 */
const REVEAL_RESTORE_ATTEMPTS = 1;

export async function runOrchestratorToolsForwarder(
  client: OrchestratorToolsRpcClientLike = new OrchestratorToolsRpcClient(),
): Promise<void> {
  // The eager surface lists everything, so only the compact modes need the roster.
  const compact = process.env[ORCHESTRATOR_TOOL_STABLE_ENV] === '1' || process.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV] === '1';
  const deferred = process.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV] === '1'
    && process.env['AI_ORCHESTRATOR_AUTOMATION_INVOCATION'] !== '1';
  const [remoteWorkersConnected, restore] = await Promise.all([
    compact ? probeRemoteWorkersConnected(client) : undefined,
    deferred
      ? restoreRevealedToolNames(
        () => client.call(TOOL_REVEAL_RPC_METHODS.get, {}, { timeoutMs: REVEAL_RESTORE_CALL_TIMEOUT_MS }),
        REVEAL_RESTORE_ATTEMPTS,
      )
      : undefined,
  ]);
  if (restore && !restore.restored) {
    getLogger(FORWARDER_LOGGER_NAME).warn(
      'Could not restore previously revealed orchestrator tools; they stay callable after a tool search',
      { attempts: restore.attempts },
    );
  }
  await runStdioMcpForwarder({
    loggerName: FORWARDER_LOGGER_NAME,
    tools: (server) => resolveOrchestratorForwarderTools(client, (names) => {
      server.revealTools(names);
      // Remembered by the parent so the next forwarder for this session lists them again.
      void client.call(TOOL_REVEAL_RPC_METHODS.record, { names }).catch(() => undefined);
    }, { remoteWorkersConnected, revealed: restore?.names }),
  });
}

export function resolveOrchestratorForwarderTools(
  client: OrchestratorToolsRpcClientLike,
  onReveal: (names: string[]) => void,
  options: RemoteWorkerListing & { revealed?: readonly string[] } = {},
) {
  const tools = createOrchestratorToolsForwarderTools(
    client,
    resolveOrchestratorToolsForwarderOptions(),
  );
  if (process.env['AI_ORCHESTRATOR_AUTOMATION_INVOCATION'] === '1') return tools.filter(tool => tool.name === 'automation_result');
  if (process.env[ORCHESTRATOR_TOOL_STABLE_ENV] === '1') {
    return createStableOrchestratorTools(tools, options);
  }
  if (process.env[ORCHESTRATOR_TOOL_DEFERRAL_ENV] === '1') {
    return createDeferredOrchestratorTools(tools, { onReveal, ...options });
  }
  return tools;
}
