import { z } from 'zod';
import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';
import { connectorAccessRegistry, type ConnectorAccessRegistry } from './connector-access';
import type { ConnectorAuthService } from './connector-auth-service';
import type { GraphConnectorService } from '../graph/graph-connector-service';
import type { GraphRequestContext } from '../graph/graph-client';
import type { PermissionRegistry } from '../orchestration/permission-registry';
import { getLogger } from '../logging/logger';

const logger = getLogger('ConnectorRpc');

const PayloadSchema = z
  .object({
    name: z.string().min(1).max(64),
    forceRefresh: z.boolean().optional(),
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
interface ConnectorRpcDependencies {
  access: ConnectorAccessRegistry;
  repo: {
    list(): {
      record: Pick<OrchestratorMcpServer, 'id' | 'name' | 'autoConnect'> &
        Partial<OrchestratorMcpServer>;
    }[];
  };
  auth: Pick<ConnectorAuthService, 'getAccessToken'>;
  graph?: Pick<GraphConnectorService, 'listTools' | 'callTool'>;
  authorizeMutation?: (
    instanceId: string,
    request: {
      accountKey: string;
      toolName: string;
      args: Record<string, unknown>;
      connectorName: string;
    },
  ) => Promise<boolean>;
}
async function dependencies(): Promise<ConnectorRpcDependencies> {
  const [
    { getOrchestratorMcpRepository },
    { getConnectorAuthService },
    { getGraphConnectorService },
    { getPermissionRegistry },
  ] = await Promise.all([
    import('./mcp-multi-provider-singletons'),
    import('./connector-auth-service'),
    import('../graph/graph-connector-service'),
    import('../orchestration/permission-registry'),
  ]);
  return {
    access: connectorAccessRegistry,
    repo: getOrchestratorMcpRepository(),
    auth: getConnectorAuthService(),
    graph: {
      listTools: (...args) => getGraphConnectorService().listTools(...args),
      callTool: (...args) => getGraphConnectorService().callTool(...args),
    },
    authorizeMutation: (instanceId, request) =>
      authorizeConnectorMutation(getPermissionRegistry(), getGraphConnectorService(), instanceId, request),
  };
}

/**
 * Asks James to approve one Microsoft 365 change, unless he already chose
 * "Always allow" for this kind of change on this account. Only a person's yes
 * counts; auto-approval and timeouts never send mail or change a calendar.
 */
export async function authorizeConnectorMutation(
  registry: Pick<PermissionRegistry, 'requestPermission' | 'listPending' | 'resolve'>,
  standing: Pick<GraphConnectorService, 'accountEmail' | 'isAlwaysAllowed' | 'allowAlways'>,
  instanceId: string,
  { accountKey, toolName, args, connectorName }: { accountKey: string; toolName: string; args: Record<string, unknown>; connectorName: string },
): Promise<boolean> {
  if (standing.isAlwaysAllowed(accountKey, toolName)) {
    logger.info('Microsoft 365 change allowed by a standing approval', { instanceId, connectorName, toolName });
    return true;
  }
  const { randomUUID } = await import('node:crypto');
  const email = standing.accountEmail(accountKey);
  const decision = await registry.requestPermission({
    id: `connector_${randomUUID()}`,
    instanceId,
    action: 'microsoft365_mutation',
    toolName,
    ...buildConnectorMutationApproval(connectorName, accountKey, toolName, args),
    ...(email ? { alwaysAllowCovers: `Always allow means no session asks again before it ${ALWAYS_ALLOW_PHRASES[toolName] ?? `does ${describeChange(toolName)} on`} ${email}. You can take it back in Settings → MCP Servers → Connectors.` } : {}),
    createdAt: Date.now(),
    timeoutMs: 5 * 60_000,
  });
  const approved = decision.granted && decision.decidedBy === 'user';
  if (approved && decision.always) {
    standing.allowAlways(accountKey, toolName);
    // Cards already waiting for the same change on this account are covered by that answer too.
    for (const waiting of registry.listPending()) {
      if (waiting.action === 'microsoft365_mutation' && waiting.toolName === toolName && waiting.details?.['accountKey'] === accountKey) {
        registry.resolve(waiting.id, true, 'user');
      }
    }
  }
  return approved;
}

/** Reads between "before it" and the account email, for the line that says what "Always allow" covers. */
const ALWAYS_ALLOW_PHRASES: Record<string, string> = {
  graph_mail_send: 'sends mail from',
  graph_calendar_create_event: 'creates calendar events on',
  graph_calendar_update_event: 'changes calendar events on',
  graph_calendar_delete_event: 'deletes calendar events on',
};

function describeChange(toolName: string): string {
  return toolName.replace(/^graph_/, '').replaceAll('_', ' ');
}
export async function dispatchConnectorRpc(
  method: string,
  instanceId: string,
  payload: unknown,
  deps?: ConnectorRpcDependencies,
  context: GraphRequestContext = {},
): Promise<unknown> {
  const input = PayloadSchema.parse(payload);
  const runtime = deps ?? (await dependencies());
  const record = runtime.repo.list().find((entry) => entry.record.name === input.name)?.record;
  if (!record) throw new Error('Connector no longer exists.');
  runtime.access.assert(instanceId, record.id);
  if (!record.autoConnect) throw new Error('This connector is turned off.');
  // Capture primitives, since a repository/test record can be mutated while awaiting approval.
  const original = { ...record };
  const assertActive = (): void => {
    context.signal?.throwIfAborted();
    context.assertActive?.();
    runtime.access.assert(instanceId, original.id);
    const current = runtime.repo.list().find((entry) => entry.record.id === original.id)?.record;
    if (!current || !current.autoConnect ||
      current.name !== original.name || current.kind !== original.kind ||
      current.accountId !== original.accountId || current.mailEnabled !== original.mailEnabled ||
      current.updatedAt !== original.updatedAt) {
      throw new Error('This connector changed while the request was pending. Try again with its current settings.');
    }
  };
  assertActive();
  if (method === 'connectors.before_tool_call' && record.kind !== 'microsoft365') {
    // The remote connector owns its tool semantics. Any tool dispatch may mutate;
    // record intent before handing control to it, even when its reply is lost.
    context.beforeMutation?.();
    return { recorded: true };
  }
  if (method === 'connectors.connection') {
    if (record.kind === 'microsoft365') return { kind: 'microsoft365' };
    if (!record.url) throw new Error('This connector is a local program.');
    const accessToken = await runtime.auth.getAccessToken(record.id, input.forceRefresh);
    assertActive();
    return {
      kind: 'remote',
      url: record.url,
      transport: record.transport,
      headers: record.headers,
      accessToken,
    };
  }
  if (
    method !== 'connectors.graph' ||
    record.kind !== 'microsoft365' ||
    !record.accountId ||
    !runtime.graph
  )
    throw new Error('Connector operation is unavailable.');
  switch (input.method) {
    case 'tools/list':
      return {
        tools: runtime.graph
          .listTools(record.accountId, record.mailEnabled)
          .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      };
    case 'tools/call': {
      // Not strict: MCP clients add protocol fields such as _meta beside these two.
      // They are dropped here, and each tool strictly validates its own arguments.
      const args = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
        .parse(input.params);
      const result = await runtime.graph.callTool(
        record.accountId,
        args.name,
        args.arguments ?? {},
        record.mailEnabled,
        async (request) => {
          assertActive();
          const approved = await waitForActiveApproval(
            runtime.authorizeMutation?.(instanceId, { ...request, connectorName: original.name }) ?? Promise.resolve(false),
            context.signal,
          );
          assertActive();
          return approved;
        },
        { signal: context.signal, assertActive, beforeMutation: context.beforeMutation },
      );
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }
    case 'resources/list':
      return { resources: [] };
    case 'prompts/list':
      return { prompts: [] };
    default:
      throw new Error('This Microsoft 365 connector provides tools only.');
  }
}

async function waitForActiveApproval(approval: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return approval;
  signal.throwIfAborted();
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([approval, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function buildConnectorMutationApproval(
  connectorName: string,
  accountKey: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const label = (value: unknown) =>
    String(value ?? '')
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 200);
  const attendeeCount = Array.isArray(args['attendees']) ? args['attendees'].length : 0;
  const recipientCount = ['toRecipients', 'ccRecipients', 'bccRecipients'].reduce(
    (total, key) => total + (Array.isArray(args[key]) ? args[key].length : 0),
    0,
  );
  const warning =
    toolName === 'graph_calendar_create_event' && attendeeCount > 0
      ? ' This may send attendee invitations.'
      : toolName === 'graph_calendar_update_event'
        ? ' This may send attendee updates.'
        : toolName === 'graph_calendar_delete_event'
          ? ' This may send attendee cancellation notices.'
          : toolName === 'graph_mail_send'
            ? ' This sends the draft to its recipients.'
            : '';
  const subject = label(args['subject']);
  return {
    description: `Allow ${describeChange(toolName)} through ${connectorName}${subject ? `, subject ${subject}` : ''}?${warning}`,
    details: {
      accountKey,
      connectorName,
      operation: toolName,
      subject,
      eventId: label(args['eventId']),
      messageId: label(args['messageId']),
      attendeeCount,
      recipientCount,
    },
  };
}
