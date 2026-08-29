import { generateId } from '../../shared/utils/id-generator';
import { getRemoteNodeRosterService } from '../remote-node/remote-node-roster-service';
import type {
  BrowserCredentialsCliAuthorization,
  BrowserCredentialsCliAuthorizeInput,
  BrowserCredentialsCliEnrolInput,
  BrowserCredentialsCliEnrolResult,
  BrowserCredentialsCliOperations,
} from '../mcp/browser-credentials-cli-contracts';
import { assertAuthorizationExpiry } from './browser-credential-authorization-store';
import { normaliseAuthorizationOrigin, normaliseBindableOrigin } from './browser-credential-origin';
import { getBrowserProfileStore } from './browser-profile-store';
import {
  getBrowserCredentialAuthorizationService,
  getBrowserCredentialVault,
} from './browser-unattended-services';

/**
 * Live wiring for `aio-mcp browser-credentials`.
 *
 * Deliberately calls the SAME services as the renderer IPC handlers in
 * `src/main/ipc/handlers/browser-unattended-handlers.ts`, including the shared
 * `assertAuthorizationExpiry` cap, the shared scope resolution and the shared
 * origin rules, so the CLI door and the panel door cannot grant different
 * things. A third writer, `browser-autonomy-config.ts`, applies the operator's
 * boot-time file and shares the origin rules only. See the widening note in
 * `browser-credentials-cli-contracts.ts`.
 *
 * Every guard here is main-side on purpose. The CLI binary is not the only
 * thing that can reach the RPC socket, so a check that lived only in the CLI
 * process would be advisory.
 */

/**
 * An authorization's `profileId` is the scope the FILL will look up, and that
 * is not always a browser profile id.
 * `credentialAuthorizationProfileScope` in `browser-gateway-service.ts` resolves
 * a shared existing tab to its node scope (`local`, or the worker node id),
 * because a shared tab's own profileId is per-tab and ephemeral. A managed
 * profile authorizes by its own id.
 *
 * So a plausible-looking value can be silently unmatchable forever: the grant
 * is created, the CLI reports success, and the failure appears much later as
 * `credential_not_authorized:no_authorization_for_profile`. Refusing an unknown
 * scope up front is the difference between a typo and a lost afternoon.
 */
export function resolveCredentialScope(scope: string): string {
  if (scope === 'local') return 'local';

  const nodes = getRemoteNodeRosterService().list();
  // Accept the node NAME as well as its id. The roster keys on a UUID, but every
  // other surface the operator and agents touch (`browser_list_targets`,
  // `run_on_node`) takes the friendly name, so demanding the UUID here would
  // make the documented command fail and teach nobody anything. Resolve the
  // name to the id, because the id is what the fill-time scope actually is.
  const byId = nodes.find((node) => node.id === scope);
  if (byId) return byId.id;

  // Names are not unique, ids are. Picking the first match would bind the grant
  // to whichever machine happened to sort first, silently and for a year, which
  // is the exact failure this function exists to stop. Make the operator
  // disambiguate instead.
  const byName = nodes.filter((node) => node.name === scope);
  if (byName.length > 1) {
    throw new Error(
      `Node name '${scope}' is ambiguous: ${byName.map((node) => node.id).join(', ')}. `
        + 'Pass the node id instead.',
    );
  }
  if (byName.length === 1) return byName[0]!.id;

  const profileIds = getBrowserProfileStore().listProfiles().map((profile) => profile.id);
  if (profileIds.includes(scope)) return scope;

  const known = [
    "'local' (a shared tab on this machine)",
    ...nodes.map((node) => `'${node.name}' (worker node, id ${node.id})`),
    ...profileIds.map((id) => `'${id}' (managed browser profile)`),
  ];
  throw new Error(
    `Unknown credential scope '${scope}'. A grant on an unknown scope can never match. `
      + `Known scopes: ${known.join(', ')}.`,
  );
}

/**
 * Read-path counterpart to `resolveCredentialScope`. `authorize --node
 * windows-pc` stores the node id, so filtering a list by the same friendly name
 * returned nothing at all. Lenient on purpose: an unmatched filter is a legal
 * empty result, not an error.
 */
export function resolveCredentialScopeForFilter(scope: string): string {
  try {
    return resolveCredentialScope(scope);
  } catch {
    return scope;
  }
}

export function createDefaultBrowserCredentialsOperations(): BrowserCredentialsCliOperations {
  return {
    async enrol(input: BrowserCredentialsCliEnrolInput): Promise<BrowserCredentialsCliEnrolResult> {
      // Normalise here as well as in the CLI, so a direct RPC caller cannot
      // bind an origin the authorization matcher could never meet.
      const origin = normaliseBindableOrigin(input.origin);
      return getBrowserCredentialVault().enrolExistingCredential({
        item: input.item,
        origin,
        ...(input.moveIntoFolder !== undefined
          ? { moveIntoFolder: input.moveIntoFolder }
          : {}),
      });
    },

    async authorize(
      input: BrowserCredentialsCliAuthorizeInput,
    ): Promise<BrowserCredentialsCliAuthorization> {
      const profileId = resolveCredentialScope(input.profileId);
      const allowedOrigins = input.allowedOrigins.map(normaliseAuthorizationOrigin);
      assertAuthorizationExpiry(input.expiresAt, Date.now());
      return getBrowserCredentialAuthorizationService().create(
        {
          profileId,
          allowedOrigins,
          purposes: input.purposes,
          vaultFolder: input.vaultFolder,
          expiresAt: input.expiresAt,
          ...(input.note ? { note: input.note } : {}),
          ...(input.allowedSenderDomains && input.allowedSenderDomains.length > 0
            ? { allowedSenderDomains: input.allowedSenderDomains }
            : {}),
        },
        generateId(),
      );
    },

    async list(profileId?: string): Promise<BrowserCredentialsCliAuthorization[]> {
      return getBrowserCredentialAuthorizationService().list(
        profileId === undefined ? undefined : resolveCredentialScopeForFilter(profileId),
      );
    },

    async revoke(authorizationId: string): Promise<{ revoked: boolean }> {
      getBrowserCredentialAuthorizationService().revoke(authorizationId);
      return { revoked: true };
    },
  };
}
