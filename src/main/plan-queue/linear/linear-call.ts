/**
 * The one function the Plan Queue uses to call a Linear connector tool from the main process.
 *
 * - The connector is chosen by the saved Linear connection (`planQueueLinearConnection`), and its record is read live
 *   on every call and checked against Linear's own address each time the token is asked for. A connector edited to
 *   point elsewhere is refused before any request is made.
 * - The token is attached only by `connectRemoteConnector`, which refuses other origins and never follows redirects.
 *   This file never reads, copies, logs or stores it: it passes `getAccessToken` straight through.
 * - Only reads are in the tool list. No agent can reach this: nothing registers it as an MCP tool, `aio-mcp` command
 *   or session RPC method.
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { PlanQueueLinearConnection } from '@contracts/schemas/plan-queue';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { getLogger } from '../../logging/logger';
import { redactLogOutput } from '../../security/secret-redaction';
import type { ConnectorAuthService } from '../../mcp/connector-auth-service';
import { connectRemoteConnector, type RemoteConnectorConnection } from '../../mcp/connector-remote-client';
import { checkLinearConnectorRecord, type LinearRecordCheck } from './linear-connector-address';
import { LinearCallError, type LinearConnectorProblem } from './linear-errors';

const logger = getLogger('PlanQueueLinear');

/** Every tool Harness calls on Linear's connector. All reads; writes arrive with the write-back phase. */
export const LINEAR_TOOLS = [
  'whoami',
  'list_teams',
  'list_issue_statuses',
  'list_issue_labels',
  'list_projects',
  'list_users',
  'list_issues',
  'get_issue',
  'list_comments',
] as const;
export type LinearTool = (typeof LINEAR_TOOLS)[number];

export const LINEAR_CALL_TIMEOUT_MS = 30_000;
const DETAIL_LIMIT = 500;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

export interface LinearCallDependencies {
  /** The saved connection, read live. */
  readConnection(): PlanQueueLinearConnection;
  /** The connector record, read live. Null when it is gone. */
  getConnector(id: string): OrchestratorMcpServer | null;
  auth: Pick<ConnectorAuthService, 'getAccessToken' | 'status'>;
  /** Tests accept a local fake's address here; the real rule is `checkLinearConnectorRecord`. */
  checkRecord: (record: OrchestratorMcpServer) => LinearRecordCheck;
  timeoutMs: number;
}

async function defaultDependencies(): Promise<LinearCallDependencies> {
  const [{ getSettingsManager }, { getOrchestratorMcpRepository }, { getConnectorAuthService }] = await Promise.all([
    import('../../core/config/settings-manager'),
    import('../../mcp/mcp-multi-provider-singletons'),
    import('../../mcp/connector-auth-service'),
  ]);
  return {
    readConnection: () => getSettingsManager().getAll().planQueueLinearConnection ?? null,
    getConnector: (id) => getOrchestratorMcpRepository().get(id)?.record ?? null,
    auth: getConnectorAuthService(),
    checkRecord: checkLinearConnectorRecord,
    timeoutMs: LINEAR_CALL_TIMEOUT_MS,
  };
}

/** Calls a tool on the connector in the saved Linear connection. */
export async function callLinearTool<T>(
  tool: LinearTool,
  args: Record<string, unknown>,
  resultSchema: z.ZodType<T>,
  dependencies?: LinearCallDependencies,
): Promise<T> {
  const deps = dependencies ?? (await defaultDependencies());
  const connection = deps.readConnection();
  if (!connection) throw new LinearCallError('not-set-up', 'No Linear connection has been set up.');
  return callLinearToolOnConnector(connection.connectorId, tool, args, resultSchema, deps);
}

/**
 * Calls a tool on a named connector, for choosing and confirming a connection before anything is saved. It passes the
 * same address check as a saved connection.
 */
export async function callLinearToolOnConnector<T>(
  connectorId: string,
  tool: LinearTool,
  args: Record<string, unknown>,
  resultSchema: z.ZodType<T>,
  dependencies?: LinearCallDependencies,
): Promise<T> {
  if (!LINEAR_TOOLS.includes(tool)) throw new Error(`Harness does not call the Linear tool "${String(tool)}".`);
  const deps = dependencies ?? (await defaultDependencies());
  const started = Date.now();
  try {
    const result = await runCall(deps, connectorId, tool, args, resultSchema);
    logger.info('Linear tool call', { tool, durationMs: Date.now() - started, outcome: 'ok' });
    return result;
  } catch (error) {
    const failure = await classifyFailure(error, deps, connectorId);
    logger.warn('Linear tool call', { tool, durationMs: Date.now() - started, outcome: failure.code });
    throw failure;
  }
}

function liveRecord(deps: LinearCallDependencies, connectorId: string): OrchestratorMcpServer {
  const record = deps.getConnector(connectorId);
  if (!record) throw connectorUnavailable('gone');
  const check = deps.checkRecord(record);
  if (!check.ok) throw connectorUnavailable(check.problem);
  return record;
}

const PROBLEM_MESSAGES: Record<LinearConnectorProblem, string> = {
  gone: 'The Linear connector no longer exists.',
  off: 'The Linear connector is turned off.',
  'not-linear': 'The connector is no longer at Linear\'s own address.',
  'read-only': 'The connector uses Linear\'s read-only address, and Harness needs the read and write one.',
};

function connectorUnavailable(problem: LinearConnectorProblem): LinearCallError {
  return new LinearCallError('connector-unavailable', PROBLEM_MESSAGES[problem], { connectorProblem: problem });
}

async function runCall<T>(
  deps: LinearCallDependencies,
  connectorId: string,
  tool: LinearTool,
  args: Record<string, unknown>,
  resultSchema: z.ZodType<T>,
): Promise<T> {
  liveRecord(deps, connectorId);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deps.timeoutMs);
  const timedOut = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener('abort', () =>
      reject(new LinearCallError('unreachable', 'Linear did not answer in time.')),
    );
  });
  // It can only reject after an abort, which may come while nothing is racing it; never leave that unhandled.
  timedOut.catch(() => undefined);
  // Checked again on every token request, so an edit made mid-call cannot send the token elsewhere.
  const connecting = connectRemoteConnector(
    async (forceRefresh): Promise<RemoteConnectorConnection> => {
      const record = liveRecord(deps, connectorId);
      return {
        url: record.url!,
        headers: record.headers,
        transport: record.transport,
        accessToken: await deps.auth.getAccessToken(connectorId, forceRefresh),
      };
    },
  );
  let client: Client | undefined;
  try {
    const call = async () => {
      client = await connecting;
      return client.callTool({ name: tool, arguments: args }, undefined, { signal: deadline.signal });
    };
    const result = await Promise.race([call(), timedOut]);
    return parseResult(result, resultSchema);
  } finally {
    clearTimeout(timer);
    // A connect that is still pending must not leave a connection open when it finally finishes.
    if (client) await client.close();
    else void connecting.then((late) => late.close(), () => undefined);
  }
}

interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

function parseResult<T>(result: ToolResult, schema: z.ZodType<T>): T {
  const text = textOf(result);
  if (result.isError) {
    if (looksRateLimited(text))
      throw new LinearCallError('unreachable', 'Linear is limiting requests.', {
        rateLimited: true,
        retryAfterMs: parseRetryAfterMs(text),
        detail: safeDetail(text),
      });
    throw new LinearCallError('unexpected-result', 'Linear reported an error for the request.', {
      detail: safeDetail(text),
    });
  }
  let value: unknown;
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    value = result.structuredContent;
  } else {
    try {
      value = JSON.parse(text);
    } catch {
      throw new LinearCallError('unexpected-result', 'Linear\'s answer was not in the expected format.');
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(whole answer)'))];
    throw new LinearCallError('unexpected-result', 'Linear\'s answer did not have the expected fields.', {
      detail: `Fields: ${paths.slice(0, 10).join(', ')}`,
    });
  }
  return parsed.data;
}

function textOf(result: ToolResult): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((item: unknown) =>
      typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text'
        ? String((item as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** Connector text with secrets masked, cut to 500 characters. */
function safeDetail(text: string): string | undefined {
  return text ? redactLogOutput(text).slice(0, DETAIL_LIMIT) : undefined;
}

function looksRateLimited(text: string): boolean {
  return /rate[\s_-]?limit|too many requests/i.test(text);
}

/** The wait Linear asked for, from its own words; undefined when it did not say. */
function parseRetryAfterMs(text: string): number | undefined {
  const match = /retry[\s_-]*after\D{0,10}(\d+(?:\.\d+)?)\s*(ms|milliseconds?)?/i.exec(text);
  if (!match) return undefined;
  const wait = Number(match[1]) * (match[2] ? 1 : 1000);
  return Number.isFinite(wait) ? Math.min(wait, MAX_RETRY_AFTER_MS) : undefined;
}

async function classifyFailure(
  error: unknown,
  deps: LinearCallDependencies,
  connectorId: string,
): Promise<LinearCallError> {
  if (error instanceof LinearCallError) return error;
  // The sign-in question is answered by the connector's own state, not by the wording of the failure.
  try {
    if (!deps.getConnector(connectorId)) return connectorUnavailable('gone');
    const state = deps.auth.status(connectorId).state;
    if (state === 'signed-out' || state === 'expired')
      return new LinearCallError('needs-sign-in', 'The Linear connector needs to be signed in again.', { cause: error });
  } catch {
    return connectorUnavailable('gone');
  }
  const text = error instanceof Error ? error.message : String(error);
  const detail = safeDetail(text);
  const status =
    error instanceof StreamableHTTPError || error instanceof SseError ? error.code : undefined;
  if (status === 401)
    return new LinearCallError('needs-sign-in', 'The Linear connector needs to be signed in again.', { cause: error, detail });
  if (status === 429 || looksRateLimited(text))
    return new LinearCallError('unreachable', 'Linear is limiting requests.', {
      cause: error,
      detail,
      rateLimited: true,
      retryAfterMs: parseRetryAfterMs(text),
    });
  if (error instanceof McpError)
    return new LinearCallError('unexpected-result', 'Linear refused the request.', { cause: error, detail });
  return new LinearCallError('unreachable', 'Linear could not be reached.', { cause: error, detail });
}
