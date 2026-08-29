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
  type BrowserCredentialsCliMethod,
  type BrowserCredentialsCliOperations,
} from './browser-credentials-cli-contracts';

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
): Promise<unknown> {
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
