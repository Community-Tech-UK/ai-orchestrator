/**
 * `aio-mcp plan-queue` — see who owns each Plan Queue run and move one to another session.
 *
 * `move` acts with James's authority, like Move on the Plan Queue page, so a session can take
 * over a run whose owner is asleep or will not answer a handover request. The MCP
 * `plan_queue_control` handover stays owner-only. Kept free of coordinator imports for the SEA.
 */
import { z } from 'zod';
import { OrchestratorToolsRpcClient, type OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';
import path from 'node:path';
import { planQueueIsDiscarded } from '../../shared/utils/plan-queue-discarded';
import { planQueueRunCanMove } from '../../shared/utils/plan-queue-run-movable';
import { PLAN_QUEUE_CLI_METHODS, PlanQueueCliMovePayloadSchema, PlanQueueCliMoveResultSchema } from './plan-queue-cli-contracts';

/** `list` reads the existing status tool rather than a second listing of the same runs. */
const STATUS_METHOD = 'orchestrator_tools.plan_queue_status';

const StatusSchema = z.object({
  runs: z.array(z.object({
    runId: z.string(),
    parentInstanceId: z.string(),
    kind: z.string(),
    status: z.enum(['running', 'paused', 'completed', 'cancelled']),
    workspace: z.string(),
    items: z.array(z.object({ state: z.string(), branch: z.string().optional(), detail: z.string().optional() })),
  })),
});

export async function runPlanQueueCli(argv: readonly string[], deps: {
  client?: OrchestratorToolsRpcClientLike; stdout?: (text: string) => void; env?: Record<string, string | undefined>; cwd?: string;
} = {}): Promise<void> {
  const stdout = deps.stdout ?? (text => { process.stdout.write(text); });
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    stdout(HELP);
    return;
  }
  const json = rest.includes('--json');
  const args = rest.filter(arg => arg !== '--json');
  const client = () => deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 30_000 });
  if (command === 'list') {
    if (args.some(arg => arg !== '--all')) throw new Error('The list options are --all and --json.');
    const self = (deps.env ?? process.env)['AI_ORCHESTRATOR_INSTANCE_ID'];
    const movable = StatusSchema.parse(await client().call(STATUS_METHOD, {})).runs.flatMap(run => {
      const items = run.items.map(item => ({ state: item.state, branchName: item.branch ?? null, worktreePath: null, detail: item.detail ?? null }));
      if (!planQueueRunCanMove({ status: run.status, items })) return [];
      return [{ runId: run.runId, kind: run.kind, status: run.status, workspace: run.workspace, documents: run.items.length,
        setAside: items.filter(item => item.state === 'parked' && !planQueueIsDiscarded(item)).length,
        ownedByThisSession: run.parentInstanceId === self, ownerInstanceId: run.parentInstanceId === self ? null : run.parentInstanceId }];
    });
    // Finished runs keep their set-aside jobs indefinitely; elsewhere they are noise for this session.
    const cwd = deps.cwd ?? process.cwd();
    const shown = args.includes('--all') ? movable
      : movable.filter(run => run.status === 'running' || run.status === 'paused' || sameFolderTree(run.workspace, cwd));
    const hidden = movable.length - shown.length;
    stdout(json ? `${JSON.stringify({ runs: shown, hiddenElsewhere: hidden }, null, 2)}\n` : formatList(shown, hidden));
    return;
  }
  if (command === 'move') {
    const payload = PlanQueueCliMovePayloadSchema.parse(parseMoveArgs(args));
    const result = PlanQueueCliMoveResultSchema.parse(await client().call(PLAN_QUEUE_CLI_METHODS.move, payload));
    stdout(json ? `${JSON.stringify(result, null, 2)}\n`
      : `Moved Plan Queue run ${result.runId} to ${sessionName(result.ownerInstanceId)}.\n`);
    return;
  }
  throw new Error(`Unknown plan-queue command: ${command}. Use list or move.`);
}

function parseMoveArgs(args: readonly string[]): { runId?: string; targetInstanceId?: string } {
  let runId: string | undefined;
  let targetInstanceId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--to') { targetInstanceId = args[index + 1] ?? ''; index += 1; }
    else if (arg.startsWith('--to=')) targetInstanceId = arg.slice('--to='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown plan-queue move option: ${arg}`);
    else if (runId === undefined) runId = arg;
    else throw new Error(`Unexpected plan-queue move argument: ${arg}`);
  }
  if (!runId) throw new Error('plan-queue move requires <run-id>; run `aio-mcp plan-queue list` to find it.');
  if (targetInstanceId !== undefined && !targetInstanceId.trim()) throw new Error('--to needs a session id.');
  return { runId, ...(targetInstanceId !== undefined ? { targetInstanceId } : {}) };
}

function sessionName(id: string | null): string {
  return id === null ? 'this session' : `session ${id}`;
}

/** The run's folder is this folder, inside it, or contains it. */
function sameFolderTree(workspace: string, cwd: string): boolean {
  const inside = (child: string, parent: string) => {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return inside(workspace, cwd) || inside(cwd, workspace);
}

function formatList(runs: readonly { runId: string; kind: string; status: string; workspace: string; documents: number; setAside: number; ownedByThisSession: boolean; ownerInstanceId: string | null }[], hidden: number): string {
  const more = hidden > 0 ? `${hidden} finished run(s) in other folders still hold set-aside jobs; add --all to list them.\n` : '';
  if (runs.length === 0) return `No Plan Queue runs to move here.\n${more}`;
  return `${runs.map(run => [
    `${run.runId} | ${run.status} | ${run.kind} | ${run.documents} document(s)${run.setAside ? `, ${run.setAside} set aside` : ''} | owner: ${sessionName(run.ownerInstanceId)}`,
    `  workspace: ${run.workspace}`,
    ...(run.ownedByThisSession ? [] : [`  take over: aio-mcp plan-queue move ${run.runId}`]),
  ].join('\n')).join('\n\n')}\n${more ? `\n${more}` : ''}`;
}

const HELP = [
  'Usage:',
  '  aio-mcp plan-queue list [--all] [--json]',
  '  aio-mcp plan-queue move <run-id> [--to <session-id>] [--json]',
  '',
  'list  Plan Queue runs that can be moved, and the session that owns each: every',
  '      running and paused run, and finished runs in this folder that still hold',
  '      set-aside jobs. --all adds finished runs in other folders.',
  'move  Make another session the owner of a run: this session, or --to <session-id>.',
  '      It acts for James, like Move on the Plan Queue page, so the current owner does',
  '      not have to agree. Use it only for work James has asked you to do, and say',
  '      which run you moved and why.',
  '      No document may be being worked on or checked; pause the run first if one is.',
  '      The new owner gets the run\'s questions and summary, and is woken if it is',
  '      asleep. The previous owner is told, unless it is asleep. A session the queue',
  '      started cannot move a run, and a finished run with no set-aside jobs left',
  '      cannot be moved.',
  '',
].join('\n');
