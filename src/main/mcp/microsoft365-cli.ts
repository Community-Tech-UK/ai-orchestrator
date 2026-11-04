import { z } from 'zod';
import { OrchestratorToolsRpcClient, type OrchestratorToolsRpcClientLike } from './orchestrator-tools-rpc-client';

export const MICROSOFT365_CLI_METHODS = {
  add: 'orchestrator_tools.microsoft365.add',
} as const;

export const Microsoft365CliAddPayloadSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use up to 64 letters, numbers or hyphens for the connector name.'),
  mailEnabled: z.boolean(),
}).strict();

export const Microsoft365CliAddResultSchema = z.object({
  name: z.string(),
  username: z.string(),
  mailEnabled: z.boolean(),
  agentsMayWrite: z.boolean(),
}).strict();

/**
 * Approval (5 min, which James can extend), browser sign-in (5 min), then the
 * sign-in code fallback (Microsoft keeps codes for about 15 min). Sign-in is
 * not cancelled when this command stops waiting, so a late finish still adds
 * the connector; the timeout message says so.
 */
const ADD_TIMEOUT_MS = 30 * 60_000;
const TIMEOUT_MESSAGE = 'Stopped waiting after 30 minutes. If James is still finishing the Microsoft sign-in, '
  + 'the connector appears once he does. Check with him, or the Connectors screen, before trying again.';

const USAGE = [
  'Usage: aio-mcp microsoft365 add <connector-name> [--mail] [--json]',
  '',
  'Asks James in Harness to approve adding a Microsoft 365 account as a connector.',
  'After approval, Microsoft sign-in opens in his browser; he completes it himself.',
  'Use a name such as m365-fortitude. --mail adds email reading and drafting.',
  'It waits until James approves and finishes signing in (up to 30 minutes), so run it in the',
  'background or with your longest command timeout. Stopped before he approves, the request',
  'disappears from Harness; stopped after, a sign-in he finishes still adds the connector.',
  'Whether agents may write (calendar changes, sending mail) stays James\'s choice on the connector.',
  '',
].join('\n');

export async function runMicrosoft365Cli(argv: readonly string[], deps: {
  client?: OrchestratorToolsRpcClientLike; stdout?: (text: string) => void; deadline?: AbortSignal;
} = {}): Promise<void> {
  const stdout = deps.stdout ?? (text => { process.stdout.write(text); });
  const [command, name, ...options] = argv;
  if (!command || command === '--help' || command === '-h') {
    stdout(USAGE);
    return;
  }
  if (command !== 'add') throw new Error(`Unknown command "${command}".\n${USAGE}`);
  if (!name || name.startsWith('-')) throw new Error(`Give the connector a name.\n${USAGE}`);
  const unknown = options.filter(option => option !== '--mail' && option !== '--json');
  if (unknown.length > 0) throw new Error(`Unknown option ${unknown.join(', ')}.\n${USAGE}`);
  const parsed = Microsoft365CliAddPayloadSchema.safeParse({ name, mailEnabled: options.includes('--mail') });
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid connector name.');
  const payload = parsed.data;
  // The client's own limit sits beyond the deadline so the plain timeout message always wins.
  const client = deps.client ?? new OrchestratorToolsRpcClient({ timeoutMs: ADD_TIMEOUT_MS + 60_000 });
  const deadline = deps.deadline ?? AbortSignal.timeout(ADD_TIMEOUT_MS);
  let response: unknown;
  try {
    response = await client.call(MICROSOFT365_CLI_METHODS.add, payload, { signal: deadline });
  } catch (error) {
    if (deadline.aborted) throw new Error(TIMEOUT_MESSAGE, { cause: error });
    throw error;
  }
  const result = Microsoft365CliAddResultSchema.parse(response);
  if (options.includes('--json')) {
    stdout(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  stdout(`Added ${result.name} for ${result.username}${result.mailEnabled ? ' with email' : ''}. `
    + (result.agentsMayWrite
      ? 'Agents may write to this account; each change still needs James\'s approval.\n'
      : 'Agents can read only, until James allows writing on the connector.\n')
    + 'New sessions get the connector; sessions already running do not.\n');
}
