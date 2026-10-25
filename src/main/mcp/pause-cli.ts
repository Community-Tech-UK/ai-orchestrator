import { z } from 'zod';
import { OrchestratorToolsRpcClient, type OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

/** Deliberately excludes notes and session identities from agent-visible status. */
export const PauseCliStatusSchema = z.object({
  phase: z.enum(['none', 'holding', 'collecting', 'ready', 'resuming']),
  since: z.number().nullable(),
  reason: z.string().nullable(),
});
export const PAUSE_CLI_METHODS = {
  status: 'orchestrator_tools.pause.status',
  hold: 'orchestrator_tools.pause.hold',
  release: 'orchestrator_tools.pause.release',
} as const;

export async function runPauseCli(argv: readonly string[], deps: {
  client?: OrchestratorToolsRpcClientLike; stdout?: (text: string) => void;
} = {}): Promise<void> {
  const stdout = deps.stdout ?? (text => { process.stdout.write(text); });
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    stdout('Usage: aio-mcp pause status|hold|release [--json]\nPause for restart, Resume and Discard are available in Harness.\n');
    return;
  }
  if (command !== 'status' && command !== 'hold' && command !== 'release') {
    throw new Error('Use pause status, hold or release. Pause for restart, Resume and Discard stay with James in Harness.');
  }
  if (argv.slice(1).some(arg => arg !== '--json')) throw new Error('The only pause option is --json.');
  const client = deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: 10_000 });
  const result = PauseCliStatusSchema.parse(await client.call(PAUSE_CLI_METHODS[command], {}));
  stdout(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n`
    : `${result.phase === 'none' ? 'New work may start.' : result.phase === 'holding' ? 'Holding new work.' : 'Paused for restart. Resume in Harness.'}${result.reason ? ` ${result.reason}` : ''}\n`);
}
