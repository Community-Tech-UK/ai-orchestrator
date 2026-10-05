import {
  BROWSER_CREDENTIALS_CLI_METHODS,
  BrowserCredentialsCliAuthorizationListSchema,
  BrowserCredentialsCliAuthorizationSchema,
  BrowserCredentialsCliAuthorizePayloadSchema,
  BrowserCredentialsCliEnrolPayloadSchema,
  BrowserCredentialsCliEnrolResultSchema,
  BrowserCredentialsCliListPayloadSchema,
  BrowserCredentialsCliRevokePayloadSchema,
  BrowserCredentialsCliRevokeResultSchema,
  BrowserCredentialsCliAccessResultSchema,
  BrowserCredentialsCliLookupPayloadSchema,
  BrowserCredentialsCliRequestPayloadSchema,
  type BrowserCredentialsCliMethod,
  type BrowserCredentialsCliOperations,
} from './browser-credentials-cli-contracts';
import type { BrowserGatewayContext } from '../browser-gateway/browser-gateway-service-types';

export type { BrowserCredentialsCliOperations } from './browser-credentials-cli-contracts';

export function isBrowserCredentialsCliRpcMethod(
  method: string,
): method is BrowserCredentialsCliMethod {
  return Object.values(BROWSER_CREDENTIALS_CLI_METHODS).includes(
    method as BrowserCredentialsCliMethod,
  );
}

/**
 * `operations` is injectable for tests; in the app it defaults to the live
 * services. Defaulting here rather than threading another constructor option
 * through `orchestrator-tools-rpc-server.ts` keeps that file inside its LOC
 * ceiling, which the ratchet does not allow to grow.
 */
export async function dispatchBrowserCredentialsCliRpc(
  method: BrowserCredentialsCliMethod,
  payload: Record<string, unknown>,
  injected?: BrowserCredentialsCliOperations | null,
  context?: BrowserGatewayContext,
): Promise<unknown> {
  // A valid transport capability identifies the session, never operator consent.
  // Runtime RPC always supplies trusted context; operator IPC/bootstrap retain
  // their own service routes and are not exposed through these agent commands.
  if (context?.instanceId && (method === BROWSER_CREDENTIALS_CLI_METHODS.enrol
    || method === BROWSER_CREDENTIALS_CLI_METHODS.authorize)) {
    throw new Error('operator_credential_approval_required: use browser.request_credential_access or aio-mcp browser-credentials request and wait for James to approve in Harness');
  }
  if (method === BROWSER_CREDENTIALS_CLI_METHODS.request
    || method === BROWSER_CREDENTIALS_CLI_METHODS.status
    || method === BROWSER_CREDENTIALS_CLI_METHODS.cancel) {
    if (!context?.instanceId) throw new Error('Credential access requires an authenticated requesting session');
    const access = (await import('../browser-gateway/browser-credential-access-service')).getBrowserCredentialAccessService();
    const result = method === BROWSER_CREDENTIALS_CLI_METHODS.request
      ? await access.request(BrowserCredentialsCliRequestPayloadSchema.parse(payload), context)
      : method === BROWSER_CREDENTIALS_CLI_METHODS.status
        ? await access.status(BrowserCredentialsCliLookupPayloadSchema.parse(payload).requestId, context)
        : await access.cancel(BrowserCredentialsCliLookupPayloadSchema.parse(payload).requestId, context);
    return BrowserCredentialsCliAccessResultSchema.parse(result);
  }
  // Imported lazily and only when this method is actually dispatched. A static
  // import would pull the vault, the SQLite stores and the node roster into the
  // RPC server's module graph, which is the very thing the sibling Local AI
  // Guard wiring injects operations to avoid.
  const operations = injected === undefined
    ? (await import('../browser-gateway/default-browser-credentials-operations'))
      .createDefaultBrowserCredentialsOperations()
    : injected;
  if (!operations) {
    throw new Error('Browser credential CLI operations unavailable');
  }
  switch (method) {
    case BROWSER_CREDENTIALS_CLI_METHODS.enrol: {
      const input = BrowserCredentialsCliEnrolPayloadSchema.parse(payload);
      return BrowserCredentialsCliEnrolResultSchema.parse(await operations.enrol(input));
    }
    case BROWSER_CREDENTIALS_CLI_METHODS.authorize: {
      const input = BrowserCredentialsCliAuthorizePayloadSchema.parse(payload);
      return BrowserCredentialsCliAuthorizationSchema.parse(await operations.authorize(input));
    }
    case BROWSER_CREDENTIALS_CLI_METHODS.list: {
      const input = BrowserCredentialsCliListPayloadSchema.parse(payload);
      return BrowserCredentialsCliAuthorizationListSchema.parse(
        await operations.list(input.profileId),
      );
    }
    case BROWSER_CREDENTIALS_CLI_METHODS.revoke: {
      const input = BrowserCredentialsCliRevokePayloadSchema.parse(payload);
      return BrowserCredentialsCliRevokeResultSchema.parse(
        await operations.revoke(input.authorizationId),
      );
    }
  }
}
