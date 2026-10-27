import { z } from 'zod';
import type { OrchestratorMcpServer } from '../../shared/types/mcp-orchestrator.types';
import { connectorAccessRegistry, type ConnectorAccessRegistry } from './connector-access';
import type { ConnectorAuthService } from './connector-auth-service';
import type { GraphConnectorService } from '../graph/graph-connector-service';
import type { GraphRequestContext } from '../graph/graph-client';

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
  ] = await Promise.all([
    import('./mcp-multi-provider-singletons'),
    import('./connector-auth-service'),
    import('../graph/graph-connector-service'),
  ]);
  return {
    access: connectorAccessRegistry,
    repo: getOrchestratorMcpRepository(),
    auth: getConnectorAuthService(),
    graph: {
      listTools: (...args) => getGraphConnectorService().listTools(...args),
      callTool: (...args) => getGraphConnectorService().callTool(...args),
    },
    authorizeMutation: async (instanceId, { accountKey, toolName, args, connectorName }) => {
      const { getPermissionRegistry } = await import('../orchestration/permission-registry');
      const { randomUUID } = await import('node:crypto');
      const decision = await getPermissionRegistry().requestPermission({
        id: `connector_${randomUUID()}`,
        instanceId,
        action: 'microsoft365_mutation',
        toolName,
        ...buildConnectorMutationApproval(connectorName, accountKey, toolName, args),
        createdAt: Date.now(),
        timeoutMs: 5 * 60_000,
      });
      return decision.granted && decision.decidedBy === 'user';
    },
  };
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
      const args = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
        .strict()
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
        { signal: context.signal, assertActive },
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
    description: `Allow ${toolName.replace(/^graph_/, '').replaceAll('_', ' ')} through ${connectorName}${subject ? `, subject ${subject}` : ''}?${warning}`,
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
