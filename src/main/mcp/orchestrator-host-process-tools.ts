import type { McpServerToolDefinition } from './mcp-server-tools';
import type { OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import type {
  ListHostProcessesInput,
  ListHostProcessesResult,
  StopLeftoverInput,
  StopLeftoverResult,
} from '../process/host-process-inspector';
import { z } from 'zod/v4';

export const LIST_HOST_PROCESSES_TOOL = 'list_host_processes';
export const STOP_LEFTOVER_PROCESSES_TOOL = 'stop_leftover_processes';

const LIST_HOST_PROCESSES_DESCRIPTION =
  'List the busiest programs running on this Mac, with CPU and memory use, so you can see what is slowing it down. '
  + 'Harness reads this for you because your own sandbox cannot run ps or top. Read-only: it never stops anything. '
  + 'Returns up to `limit` programs (default 20, max 100) sorted by CPU, plus the total count, CPU count and load average. '
  + 'cpuPercent is the ps figure, a short decaying average, so a program that only just started spinning may rank low; '
  + 'list again a few seconds later if in doubt. '
  + 'Each row has a short sanitised label (never the full command line), cpuPercent, memoryMb, runningFor and parentPid. '
  + 'ownedByYou means the program runs under the same Mac user as Harness. leftover means an orphaned program that a Harness session '
  + 'started. stoppable means stop_leftover_processes would accept it from you right now; when false, stopRefusal says why '
  + '(for example it belongs to another session that is still running). Use nameFilter to match part of the label, '
  + 'and leftoverOnly: true to list only leftovers whatever their CPU use (useful before stop_leftover_processes). '
  + 'Liveness is judged by this Harness app only: sessions in another Harness app on the same Mac look finished.';

const STOP_LEFTOVER_PROCESSES_DESCRIPTION =
  'Stop leftover programs that a Harness session started and abandoned (for example test servers you left running). '
  + 'Pass pids from list_host_processes. Harness re-checks every pid at call time and only stops one that is owned by you, '
  + 'orphaned (no parent program), started by a Harness session, not owned by another live session, and not a live '
  + 'session\'s own program. Anything else is refused with a plain-English reason and is left alone. '
  + 'Child programs started by the same session are stopped with it. Sends a polite stop by default; set force to true '
  + 'only if a program is still running after a first attempt. Max 100 pids per call.';

export const ListHostProcessesArgsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  nameFilter: z.string().trim().min(1).max(200).optional(),
  leftoverOnly: z.boolean().optional(),
}).strict();

export const StopLeftoverProcessesArgsSchema = z.object({
  pids: z.array(z.number().int().min(2).max(Number.MAX_SAFE_INTEGER)).min(1).max(100)
    .refine((pids) => new Set(pids).size === pids.length, { message: 'pids must be unique' }),
  force: z.boolean().optional(),
}).strict();

export type ListHostProcessesArgs = z.infer<typeof ListHostProcessesArgsSchema>;
export type StopLeftoverProcessesArgs = z.infer<typeof StopLeftoverProcessesArgsSchema>;

export type ListHostProcessesFn = (args: ListHostProcessesInput) => Promise<ListHostProcessesResult>;
export type StopLeftoverProcessesFn = (args: StopLeftoverInput) => Promise<StopLeftoverResult>;

export interface HostProcessToolContext {
  instanceId?: string | null;
  listHostProcesses?: ListHostProcessesFn | null;
  stopLeftoverProcesses?: StopLeftoverProcessesFn | null;
}

const listInputSchema = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many programs to return (default 20).' },
    nameFilter: { type: 'string', description: 'Only programs whose short label contains this text (case-insensitive).' },
    leftoverOnly: { type: 'boolean', description: 'Only orphaned programs a Harness session started. Default false.' },
  },
  required: [],
  additionalProperties: false,
};

const stopInputSchema = {
  type: 'object',
  properties: {
    pids: {
      type: 'array',
      items: { type: 'integer', minimum: 2 },
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      description: 'Program numbers (pid) from list_host_processes.',
    },
    force: { type: 'boolean', description: 'Use a hard kill instead of a polite stop. Default false.' },
  },
  required: ['pids'],
  additionalProperties: false,
};

function requireCaller(context: HostProcessToolContext, tool: string): string {
  if (!context.instanceId) {
    throw new Error(`${tool} is unavailable: the calling session could not be identified`);
  }
  return context.instanceId;
}

export function createHostProcessToolDefinitions(context: HostProcessToolContext): McpServerToolDefinition[] {
  return [
    {
      name: LIST_HOST_PROCESSES_TOOL,
      description: LIST_HOST_PROCESSES_DESCRIPTION,
      inputSchema: listInputSchema,
      handler: async (args) => {
        const parsed = ListHostProcessesArgsSchema.parse(args);
        if (!context.listHostProcesses) {
          throw new Error('list_host_processes is unavailable: host process inspection is not wired in this process');
        }
        const callerInstanceId = requireCaller(context, LIST_HOST_PROCESSES_TOOL);
        return context.listHostProcesses({ ...parsed, callerInstanceId });
      },
    },
    {
      name: STOP_LEFTOVER_PROCESSES_TOOL,
      description: STOP_LEFTOVER_PROCESSES_DESCRIPTION,
      inputSchema: stopInputSchema,
      handler: async (args) => {
        const parsed = StopLeftoverProcessesArgsSchema.parse(args);
        if (!context.stopLeftoverProcesses) {
          throw new Error('stop_leftover_processes is unavailable: host process control is not wired in this process');
        }
        const callerInstanceId = requireCaller(context, STOP_LEFTOVER_PROCESSES_TOOL);
        return context.stopLeftoverProcesses({ ...parsed, callerInstanceId });
      },
    },
  ];
}

function forwarder(
  client: OrchestratorToolsRpcClientLike,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
): McpServerToolDefinition {
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => {
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error(`${name} args must be an object`);
      }
      return client.call(`orchestrator_tools.${name}`, args as Record<string, unknown>);
    },
  };
}

export function createHostProcessForwarderTools(client: OrchestratorToolsRpcClientLike): McpServerToolDefinition[] {
  return [
    forwarder(client, LIST_HOST_PROCESSES_TOOL, LIST_HOST_PROCESSES_DESCRIPTION, listInputSchema),
    forwarder(client, STOP_LEFTOVER_PROCESSES_TOOL, STOP_LEFTOVER_PROCESSES_DESCRIPTION, stopInputSchema),
  ];
}
