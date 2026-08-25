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
import { getLogger } from '../../logging/logger';
import {
  LOCAL_COPILOT_NODE_ID,
  getCopilotAccountBindingService,
} from '../../providers/copilot/copilot-account-binding-service';
import { buildCopilotAccountDoctorReport } from '../../providers/copilot/copilot-account-doctor';
import { getCopilotAccountRoutingService } from '../../providers/copilot/copilot-account-routing-service';
import {
  CopilotAccountStore,
  getCopilotAccountStore,
} from '../../providers/copilot/copilot-account-store';
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
const PATH_SHAPE = /(^|["\s:])(\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\)/;
const SECRET_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{16,}|copilotTokens|oauth_token|Bearer\s)/i;

export function assertNoPathOrSecret(response: IpcResponse): IpcResponse {
  const serialized = JSON.stringify(response.data ?? null);
  if (PATH_SHAPE.test(serialized) || SECRET_SHAPE.test(serialized)) {
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
    host: profile.host,
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
        async (payload) => assertNoPathOrSecret(await fn(payload)),
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
    (payload) => ({ success: true, data: toSafeProfile(store.createProfile(payload)) }),
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
    (payload) => ({ success: true, data: store.createRule(payload) }),
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
    IPC_CHANNELS.COPILOT_ACCOUNT_DIAGNOSTICS,
    CopilotAccountEmptyPayloadSchema,
    async () => ({ success: true, data: await buildCopilotAccountDoctorReport() }),
    'COPILOT_ACCOUNT_DIAGNOSTICS_FAILED',
  );
}
