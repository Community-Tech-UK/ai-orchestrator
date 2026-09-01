/**
 * IPC surface for GitHub Copilot account profiles and routing rules.
 *
 * ============================ RESPONSE CONTRACT ============================
 * Nothing that leaves this module may contain a filesystem path, a Copilot
 * config body, or credential material. Responses carry profile IDs, labels,
 * verified logins, normalized hosts, policy names, binding STATES, and typed
 * routing outcomes — and `assertNoPathOrSecret` below enforces that on every
 * response rather than trusting each handler to remember.
 *
 * A Copilot profile home is derived in main from a validated profile ID. The
 * renderer never sends one and never receives one; that is what stops a
 * compromised renderer from pointing a Copilot spawn at an arbitrary directory.
 * ===========================================================================
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  CopilotAccountAdoptIdentityPayloadSchema,
  CopilotAccountCreatePayloadSchema,
  CopilotAccountEmptyPayloadSchema,
  CopilotAccountIdPayloadSchema,
  CopilotAccountPreviewRoutePayloadSchema,
  CopilotAccountRenamePayloadSchema,
  CopilotAccountRuleCreatePayloadSchema,
  CopilotAccountRuleIdPayloadSchema,
  CopilotAccountSuggestRulesPayloadSchema,
  CopilotAccountUpdatePolicyPayloadSchema,
} from '@contracts/schemas/copilot-account';
import type {
  CopilotAccountBindingStatus,
  CopilotAccountProfile,
} from '../../../shared/types/copilot-account.types';
import { normalizeCopilotHost } from '../../../shared/types/copilot-account.types';
import { COPILOT_ORCHESTRATOR_HOME_DIR } from '../../cli/adapters/adapter-spawn-helpers';
import { COPILOT_PROFILES_ROOT_DIR } from '../../cli/adapters/copilot/copilot-account-home-resolver';
import { getLogger } from '../../logging/logger';
import {
  LOCAL_COPILOT_NODE_ID,
  getCopilotAccountBindingService,
} from '../../providers/copilot/copilot-account-binding-service';
import { buildCopilotAccountDoctorReport } from '../../providers/copilot/copilot-account-doctor';
import { seedCopilotProfileIdentity } from '../../providers/copilot/copilot-account-seed';
import { getCopilotAccountRoutingService } from '../../providers/copilot/copilot-account-routing-service';
import {
  CopilotAccountStore,
  getCopilotAccountStore,
} from '../../providers/copilot/copilot-account-store';
import { discoverCopilotAccounts } from '../../providers/copilot/copilot-account-discovery';
import { collectFetchRemoteIdentities } from '../../vcs/remotes/github-remote-identity';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const logger = getLogger('CopilotAccountHandlers');

export interface RegisterCopilotAccountHandlersDeps {
  ensureTrustedSender?: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
  store?: CopilotAccountStore;
  /** Profile IDs held by live sessions; used to guard removal. */
  profilesInUse?: () => string[];
  /** Nodes to include in the profile-by-node matrix. Local is always included. */
  listNodeIds?: () => string[];
}

/**
 * Absolute-path and secret shapes, checked against every serialized response.
 *
 * This is deliberately a structural gate rather than a review convention: the
 * set of handlers here will grow, and "remember not to include the home path"
 * is exactly the kind of rule that survives review once and then doesn't.
 */
/**
 * A Copilot profile home is the ONE main-derived value that must never reach
 * the renderer, so the gate looks for exactly that rather than for "anything
 * path-shaped".
 *
 * It used to be a generic absolute-path heuristic. That was wrong in both
 * directions, and repeatedly: a `path-prefix` rule matcher legitimately holds a
 * workspace path, and a free-text account label may legitimately contain
 * slashes — which then surfaced again through `profileLabel`, `detail` and
 * `warnings`, each carrying the same label into a different field. Maintaining
 * a mask list of "fields allowed to contain slashes" meant chasing every new
 * field forever, and each miss broke a legitimate account rather than catching
 * a leak.
 *
 * Matching the home directory names instead is precise: every profile home is
 * `<userData>/copilot-cli-home` or `<userData>/copilot-cli-profiles/<id>`, so
 * any string containing either marker is a real leak, and no ordinary user text
 * contains them by accident.
 */
const COPILOT_HOME_MARKERS = [COPILOT_ORCHESTRATOR_HOME_DIR, COPILOT_PROFILES_ROOT_DIR];
const SECRET_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|copilotTokens|oauth_token|Bearer\s)/i;

export function assertNoPathOrSecret(response: IpcResponse): IpcResponse {
  // Both halves, not just `data`. An error MESSAGE is the likeliest carrier of
  // a real path — a raw Node fs failure reads
  // `EACCES: permission denied, mkdir '/…/copilot-cli-profiles/personal'` —
  // and gating only the success payload left that wide open.
  const serialized = JSON.stringify({ data: response.data ?? null, error: response.error ?? null });
  const leaksHome = COPILOT_HOME_MARKERS.some((marker) => serialized.includes(marker));
  if (leaksHome || SECRET_SHAPE.test(serialized)) {
    logger.error(
      'Refusing to return a Copilot account response containing a path or secret-shaped value',
    );
    return {
      success: false,
      error: {
        code: 'COPILOT_ACCOUNT_UNSAFE_RESPONSE',
        message: 'Internal error: the response contained data that must not cross IPC.',
        timestamp: Date.now(),
      },
    };
  }
  return response;
}

function failure(code: string, message: string): IpcResponse {
  return { success: false, error: { code, message, timestamp: Date.now() } };
}

/** Bounded view of a profile. Identical to the stored record — it holds no path. */
function toSafeProfile(
  profile: CopilotAccountProfile,
  binding?: CopilotAccountBindingStatus,
): Record<string, unknown> {
  return {
    id: profile.id,
    label: profile.label,
    expectedLogin: profile.expectedLogin,
    host: normalizeCopilotHost(profile.host),
    accountKind: profile.accountKind,
    scopePolicy: profile.scopePolicy,
    automationPolicy: profile.automationPolicy,
    isDefault: profile.isDefault,
    isLegacy: profile.isLegacy ?? false,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(binding
      ? {
          binding: {
            nodeId: binding.nodeId,
            state: binding.state,
            observedLogin: binding.observedLogin,
            observedHost: binding.observedHost,
            checkedAt: binding.checkedAt,
            errorCode: binding.errorCode,
            storesTokenPlaintext: binding.storesTokenPlaintext,
          },
        }
      : {}),
  };
}

export function registerCopilotAccountHandlers(
  deps: RegisterCopilotAccountHandlersDeps = {},
): void {
  const store = deps.store ?? getCopilotAccountStore();
  const bindings = getCopilotAccountBindingService();
  const routing = getCopilotAccountRoutingService();
  const options = (errorCode: string) => ({
    ensureTrustedSender: deps.ensureTrustedSender,
    errorCode,
  });

  const listWithBindings = async (): Promise<IpcResponse> => {
    const profiles = store.listProfiles();
    const withBindings = await Promise.all(
      profiles.map(async (profile) => toSafeProfile(profile, await bindings.checkBinding(profile))),
    );
    return { success: true, data: { profiles: withBindings } };
  };

  const handle = <T>(
    channel: string,
    schema: Parameters<typeof validatedHandler<T>>[1],
    fn: (payload: T) => Promise<IpcResponse> | IpcResponse,
    errorCode: string,
  ): void => {
    ipcMain.handle(
      channel,
      validatedHandler(
        channel,
        schema,
        // The gate has to run on BOTH exits. `validatedHandler` catches a throw
        // and returns `error.message` verbatim, so gating only the returned
        // value meant any exception bypassed it entirely — the gate could not
        // fire at all, rather than firing and being wrong.
        async (payload) => {
          try {
            return assertNoPathOrSecret(await fn(payload));
          } catch (error) {
            return assertNoPathOrSecret(
              failure(errorCode, error instanceof Error ? error.message : String(error)),
            );
          }
        },
        options(errorCode),
      ),
    );
  };

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_LIST,
    CopilotAccountEmptyPayloadSchema,
    () => listWithBindings(),
    'COPILOT_ACCOUNT_LIST_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_CREATE,
    CopilotAccountCreatePayloadSchema,
    async (payload) => {
      const profile = store.createProfile(payload);
      // Inherit an identity this machine is already signed in to, rather than
      // asking for a second login for the same account. Best-effort: a failure
      // just means the normal sign-in prompt.
      if (payload.expectedLogin) {
        await seedCopilotProfileIdentity(profile.id, payload.expectedLogin);
        getCopilotAccountBindingService().invalidate();
      }
      return { success: true, data: toSafeProfile(profile) };
    },
    'COPILOT_ACCOUNT_CREATE_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_RENAME,
    CopilotAccountRenamePayloadSchema,
    (payload) => ({
      success: true,
      data: toSafeProfile(store.renameProfile(payload.profileId, payload.label)),
    }),
    'COPILOT_ACCOUNT_RENAME_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_UPDATE_POLICY,
    CopilotAccountUpdatePolicyPayloadSchema,
    (payload) => ({
      success: true,
      data: toSafeProfile(
        store.updatePolicy(payload.profileId, {
          ...(payload.scopePolicy ? { scopePolicy: payload.scopePolicy } : {}),
          ...(payload.automationPolicy ? { automationPolicy: payload.automationPolicy } : {}),
        }),
      ),
    }),
    'COPILOT_ACCOUNT_UPDATE_POLICY_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_SET_DEFAULT,
    CopilotAccountIdPayloadSchema,
    (payload) => ({ success: true, data: toSafeProfile(store.setDefault(payload.profileId)) }),
    'COPILOT_ACCOUNT_SET_DEFAULT_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_REMOVE,
    CopilotAccountIdPayloadSchema,
    (payload) => {
      // Belt and braces with the store's own guard: the live-session list is
      // owned by the instance manager, which the store does not import.
      const inUse = deps.profilesInUse?.() ?? [];
      if (inUse.includes(payload.profileId)) {
        return failure(
          'COPILOT_ACCOUNT_IN_USE',
          'That Copilot account is in use by a running session. End or switch that session first.',
        );
      }
      store.removeProfile(payload.profileId);
      return { success: true, data: { profileId: payload.profileId } };
    },
    'COPILOT_ACCOUNT_REMOVE_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_VERIFY_BINDING,
    CopilotAccountIdPayloadSchema,
    async (payload) => {
      const profile = store.listProfiles().find((candidate) => candidate.id === payload.profileId);
      if (!profile) {
        return failure('COPILOT_ACCOUNT_NOT_FOUND', 'That Copilot account no longer exists.');
      }
      // Force a fresh read: the user pressed Verify precisely because they
      // just changed something outside the app.
      bindings.invalidate(profile.id);
      return { success: true, data: toSafeProfile(profile, await bindings.checkBinding(profile)) };
    },
    'COPILOT_ACCOUNT_VERIFY_BINDING_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_ADOPT_IDENTITY,
    CopilotAccountAdoptIdentityPayloadSchema,
    (payload) => {
      const updated = store.adoptObservedIdentity(payload.profileId, {
        login: payload.login,
        ...(payload.host ? { host: payload.host } : {}),
      });
      bindings.invalidate(payload.profileId);
      return { success: true, data: toSafeProfile(updated) };
    },
    'COPILOT_ACCOUNT_ADOPT_IDENTITY_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_RULE_LIST,
    CopilotAccountEmptyPayloadSchema,
    () => ({ success: true, data: { rules: store.listRules() } }),
    'COPILOT_ACCOUNT_RULE_LIST_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_RULE_CREATE,
    CopilotAccountRuleCreatePayloadSchema,
    (payload) => ({
      success: true,
      // `replaceExisting` is what the project menu's one-click swap needs:
      // clicking a different account for a project must MOVE the rule, not
      // collide with the one already there.
      data: payload.replaceExisting ? store.routeTarget(payload) : store.createRule(payload),
    }),
    'COPILOT_ACCOUNT_RULE_CREATE_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_RULE_REMOVE,
    CopilotAccountRuleIdPayloadSchema,
    (payload) => {
      store.removeRule(payload.ruleId);
      return { success: true, data: { ruleId: payload.ruleId } };
    },
    'COPILOT_ACCOUNT_RULE_REMOVE_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_PREVIEW_ROUTE,
    CopilotAccountPreviewRoutePayloadSchema,
    async (payload) => {
      const outcome = await routing.resolveRouteForSpawn({
        ...(payload.workingDirectory ? { workingDirectory: payload.workingDirectory } : {}),
        ...(payload.explicitProfileId ? { explicitProfileId: payload.explicitProfileId } : {}),
        ...(payload.confirmProtectedOverride
          ? { confirmProtectedOverride: payload.confirmProtectedOverride }
          : {}),
        origin: payload.origin ?? 'interactive',
      });
      return { success: true, data: outcome };
    },
    'COPILOT_ACCOUNT_PREVIEW_ROUTE_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_SUGGEST_RULES,
    CopilotAccountSuggestRulesPayloadSchema,
    (payload) => {
      const hosts = [...new Set(store.listProfiles().map((profile) => profile.host))];
      const remotes = collectFetchRemoteIdentities(
        payload.workingDirectory,
        hosts.length > 0 ? hosts : ['github.com'],
      );
      return {
        success: true,
        data: {
          remotes: remotes.map((remote) => ({
            remoteName: remote.remoteName,
            host: remote.host,
            owner: remote.owner,
            repo: remote.repo,
            displayPath: remote.displayPath,
          })),
        },
      };
    },
    'COPILOT_ACCOUNT_SUGGEST_RULES_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_NODE_MATRIX,
    CopilotAccountEmptyPayloadSchema,
    async () => {
      const nodeIds = [LOCAL_COPILOT_NODE_ID, ...(deps.listNodeIds?.() ?? [])];
      const profiles = store.listProfiles();
      const rows = await Promise.all(
        profiles.map(async (profile) => ({
          profileId: profile.id,
          label: profile.label,
          nodes: await Promise.all(
            nodeIds.map(async (nodeId) => {
              if (nodeId === LOCAL_COPILOT_NODE_ID) {
                const binding = await bindings.checkBinding(profile, nodeId);
                return { nodeId, state: binding.state };
              }
              // A worker's binding is node-local and only that worker can read
              // it; the controller reports "unknown until asked" rather than
              // guessing from its own state.
              return { nodeId, state: 'unavailable' as const };
            }),
          ),
        })),
      );
      return { success: true, data: { nodeIds, rows } };
    },
    'COPILOT_ACCOUNT_NODE_MATRIX_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_DISCOVER,
    CopilotAccountEmptyPayloadSchema,
    async () => {
      // Suggest accounts Copilot is already signed in to, minus the ones
      // Harness already has a profile for. Read-only: the shared Copilot home
      // is inspected, never routed through and never written.
      const existing = store.listProfiles().map((profile) => ({
        login: profile.expectedLogin,
        // Sent too, so a profile added before the login was recorded still
        // counts as taken — otherwise discovery re-offers it forever.
        label: profile.label,
        host: profile.host,
      }));
      return { success: true, data: { accounts: await discoverCopilotAccounts({ existing }) } };
    },
    'COPILOT_ACCOUNT_DISCOVER_FAILED',
  );

  handle(
    IPC_CHANNELS.COPILOT_ACCOUNT_DIAGNOSTICS,
    CopilotAccountEmptyPayloadSchema,
    async () => ({ success: true, data: await buildCopilotAccountDoctorReport() }),
    'COPILOT_ACCOUNT_DIAGNOSTICS_FAILED',
  );
}
