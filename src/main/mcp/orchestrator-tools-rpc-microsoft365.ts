import { randomUUID } from 'node:crypto';
import {
  MICROSOFT365_CLI_METHODS,
  Microsoft365CliAddPayloadSchema,
  Microsoft365CliAddResultSchema,
} from './microsoft365-cli';
import type { AddedMicrosoft365Connector, AddMicrosoft365ConnectorInput } from './microsoft365-connector-add';

const APPROVAL_TIMEOUT_MS = 5 * 60_000;

export interface Microsoft365CliOperations {
  assertNameAvailable(name: string): void;
  /** Resolves true only when the operator approved it in Harness; auto-approval never counts. */
  requestApproval(instanceId: string, input: AddMicrosoft365ConnectorInput, signal?: AbortSignal): Promise<boolean>;
  add(input: AddMicrosoft365ConnectorInput): Promise<AddedMicrosoft365Connector>;
}

export function isMicrosoft365CliRpcMethod(method: string): boolean {
  return Object.values(MICROSOFT365_CLI_METHODS).some(value => value === method);
}

/**
 * Agents may start adding an account, but the operator approves it before any
 * browser opens, and Microsoft sign-in itself stays with the operator. Agents
 * cannot change sign-in settings or which accounts they may write to.
 */
export async function dispatchMicrosoft365CliRpc(
  method: string,
  instanceId: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  injected?: Microsoft365CliOperations,
): Promise<unknown> {
  if (method !== MICROSOFT365_CLI_METHODS.add) throw new Error('Unknown microsoft365 command');
  const input = Microsoft365CliAddPayloadSchema.parse(payload);
  const operations = injected ?? (await defaultOperations());
  operations.assertNameAvailable(input.name);
  if (!(await operations.requestApproval(instanceId, input, signal))) {
    throw new Error('The Microsoft 365 account was not added: the request was not approved in Harness.');
  }
  signal?.throwIfAborted();
  return Microsoft365CliAddResultSchema.parse(await operations.add(input));
}

async function defaultOperations(): Promise<Microsoft365CliOperations> {
  // Lazy: keeps the Graph, SQLite and connector stores out of the RPC server's module graph.
  const [{ addMicrosoft365Connector, assertMicrosoft365ConnectorNameAvailable }, { getPermissionRegistry }] = await Promise.all([
    import('./microsoft365-connector-add'),
    import('../orchestration/permission-registry'),
  ]);
  return {
    assertNameAvailable: assertMicrosoft365ConnectorNameAvailable,
    add: addMicrosoft365Connector,
    requestApproval: async (instanceId, input, signal) => {
      signal?.throwIfAborted();
      const registry = getPermissionRegistry();
      const id = `microsoft365_add_${randomUUID()}`;
      const cancel = (): void => { registry.resolve(id, false, 'cancelled'); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const decision = await registry.requestPermission({
          id,
          instanceId,
          action: 'microsoft365_add_account',
          description: `Add a Microsoft 365 account as the connector ${input.name}${input.mailEnabled ? ', with email' : ''}? `
            + 'Microsoft sign-in opens in your browser after you approve. Whether agents may write to it stays your choice on the connector.',
          details: { connectorName: input.name, mailEnabled: input.mailEnabled },
          createdAt: Date.now(),
          timeoutMs: APPROVAL_TIMEOUT_MS,
        });
        return decision.granted && decision.decidedBy === 'user';
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
