/**
 * IPC surface for Claude/Codex account pools.
 *
 * ============================ RESPONSE CONTRACT ============================
 * Nothing that leaves this module may contain a filesystem path, a credential
 * body or token material. Responses carry profile IDs, labels, verified
 * identities, plan labels, policy values, binding STATES and typed routing
 * outcomes, and `assertNoAccountPathOrSecret` enforces that on every response
 * (success and error) rather than trusting each handler.
 *
 * A profile home is derived in main from a validated profile ID. The renderer
 * never sends one and never receives one.
 * ===========================================================================
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  ProviderAccountAcknowledgePayloadSchema,
  ProviderAccountCreatePayloadSchema,
  ProviderAccountDoctorPayloadSchema,
  ProviderAccountPoolUpdatePayloadSchema,
  ProviderAccountProviderPayloadSchema,
  ProviderAccountRefPayloadSchema,
  ProviderAccountResolvePreviewPayloadSchema,
  ProviderAccountSetPriorityOrderPayloadSchema,
  ProviderAccountSwitchSessionPayloadSchema,
  ProviderAccountUpdatePayloadSchema,
} from '@contracts/schemas/provider-account';
import type {
  AccountBindingStatus,
  PooledProvider,
  ProviderAccountProfile,
} from '../../../shared/types/provider-account.types';
import { POOLED_PROVIDERS, isPooledProvider } from '../../../shared/types/provider-account.types';
import type { Instance, RuntimeChangeRequest } from '../../../shared/types/instance.types';
import {
  CLAUDE_PROFILES_ROOT_DIR,
  CODEX_PROFILES_ROOT_DIR,
  resolveAccountProfileHome,
} from '../../cli/adapters/account-pool/provider-account-home-resolver';
import { getLogger } from '../../logging/logger';
import { probeCodexAccount } from '../../providers/account-pool/codex-account-probe';
import { buildProviderAccountDoctorReport } from '../../providers/account-pool/provider-account-doctor';
import { getProviderAccountBindingService } from '../../providers/account-pool/provider-account-binding-service';
import { getProviderAccountRoutingService } from '../../providers/account-pool/provider-account-routing-service';
import { getProviderAccountStore, type ProviderAccountStore } from '../../providers/account-pool/provider-account-store';
import { launchProviderLogin } from '../../providers/provider-login-launcher';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const logger = getLogger('ProviderAccountHandlers');

export interface RegisterProviderAccountHandlersDeps {
  ensureTrustedSender?: (event: IpcMainInvokeEvent, channel: string) => IpcResponse | null;
  store?: ProviderAccountStore;
  /** Live instances, for the in-use guard and the explicit session switch. */
  getInstances?: () => Pick<Instance, 'id' | 'provider' | 'accountProfileId' | 'status'>[];
  requestRuntimeChange?: (instanceId: string, request: RuntimeChangeRequest) => Promise<unknown>;
}

/**
 * Profile-home directory names, credential file names and token shapes. Any
 * response containing one is a leak: no label or identity legitimately does.
 */
const ACCOUNT_HOME_MARKERS = [CLAUDE_PROFILES_ROOT_DIR, CODEX_PROFILES_ROOT_DIR, '.credentials.json', 'auth.json'];
const SECRET_SHAPE = /(sk-ant-|refresh_token|access_token|id_token|Bearer\s)/i;

export function assertNoAccountPathOrSecret(response: IpcResponse): IpcResponse {
  const serialized = JSON.stringify({ data: response.data ?? null, error: response.error ?? null });
  if (ACCOUNT_HOME_MARKERS.some((marker) => serialized.includes(marker)) || SECRET_SHAPE.test(serialized)) {
    logger.error('Refusing to return an account-pool response containing a path or secret-shaped value');
    return {
      success: false,
      error: {
        code: 'PROVIDER_ACCOUNT_UNSAFE_RESPONSE',
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

function toSafeProfile(profile: ProviderAccountProfile, binding?: AccountBindingStatus): Record<string, unknown> {
  return {
    id: profile.id,
    provider: profile.provider,
    label: profile.label,
    expectedIdentity: profile.expectedIdentity,
    expectedAccountKey: profile.expectedAccountKey,
    planLabel: profile.planLabel,
    priority: profile.priority,
    enabled: profile.enabled,
    automationPolicy: profile.automationPolicy,
    isLegacy: profile.isLegacy,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    ...(binding
      ? {
          binding: {
            nodeId: binding.nodeId,
            state: binding.state,
            ...(binding.observedIdentity ? { observedIdentity: binding.observedIdentity } : {}),
            ...(binding.observedPlan ? { observedPlan: binding.observedPlan } : {}),
            ...(binding.errorCode ? { errorCode: binding.errorCode } : {}),
            checkedAt: binding.checkedAt,
          },
        }
      : {}),
  };
}

export function registerProviderAccountHandlers(deps: RegisterProviderAccountHandlersDeps = {}): void {
  const store = (): ProviderAccountStore => deps.store ?? getProviderAccountStore();
  const bindings = getProviderAccountBindingService();

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
        async (payload) => {
          try {
            return assertNoAccountPathOrSecret(await fn(payload));
          } catch (error) {
            return assertNoAccountPathOrSecret(failure(errorCode, error instanceof Error ? error.message : String(error)));
          }
        },
        { ensureTrustedSender: deps.ensureTrustedSender, errorCode },
      ),
    );
  };

  const requireProfile = (provider: PooledProvider, profileId: string): ProviderAccountProfile => {
    const profile = store().getProfile(provider, profileId);
    if (!profile) throw new Error('That account no longer exists.');
    return profile;
  };

  /** Verify a profile; for Codex, also refresh the observed identity over app-server. */
  const verify = async (profile: ProviderAccountProfile): Promise<AccountBindingStatus> => {
    if (profile.provider === 'codex' && !profile.isLegacy) {
      const resolved = resolveAccountProfileHome({ provider: 'codex', profileId: profile.id }, { createIfMissing: false });
      if (resolved.kind === 'derived') {
        try {
          const result = await probeCodexAccount(resolved.home);
          if (result.identity.email) {
            bindings.rememberObservedIdentity('codex', profile.id, {
              identity: result.identity.email,
              accountKey: result.identity.accountId,
              planLabel: result.identity.planType,
            });
          }
        } catch {
          // Identity is best-effort; the auth.json health check below still runs.
        }
      }
    }
    const status = await bindings.checkBinding(profile, undefined, { force: true });
    // The first verified sign-in adopts the identity (spec §6.1: null until verified).
    if (status.state === 'authenticated' && profile.expectedIdentity === null && status.observedIdentity) {
      store().adoptObservedIdentity(profile.provider, profile.id, {
        identity: status.observedIdentity,
        accountKey: status.observedAccountKey ?? null,
        planLabel: status.observedPlan ?? null,
      });
    }
    return status;
  };

  const inUse = (provider: PooledProvider): string[] =>
    (deps.getInstances?.() ?? [])
      .filter((instance) => instance.provider === provider && instance.status !== 'terminated')
      .map((instance) => instance.accountProfileId ?? 'legacy');

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_LIST,
    ProviderAccountProviderPayloadSchema,
    async (payload) => {
      const providers = payload?.provider ? [payload.provider] : [...POOLED_PROVIDERS];
      const profiles = await Promise.all(providers.flatMap((provider) => store().listProfiles(provider))
        .map(async (profile) => toSafeProfile(profile, await bindings.checkBinding(profile))));
      return { success: true, data: { profiles, pools: store().getPools() } };
    },
    'PROVIDER_ACCOUNT_LIST_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_CREATE,
    ProviderAccountCreatePayloadSchema,
    (payload) => ({ success: true, data: toSafeProfile(store().createProfile(payload)) }),
    'PROVIDER_ACCOUNT_CREATE_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_UPDATE,
    ProviderAccountUpdatePayloadSchema,
    async (payload) => {
      let profile = requireProfile(payload.provider, payload.profileId);
      if (payload.label !== undefined || payload.enabled !== undefined || payload.automationPolicy !== undefined) {
        profile = store().updateProfile(payload.provider, payload.profileId, {
          ...(payload.label !== undefined ? { label: payload.label } : {}),
          ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
          ...(payload.automationPolicy !== undefined ? { automationPolicy: payload.automationPolicy } : {}),
        });
      }
      if (payload.adoptObservedIdentity) {
        const status = await bindings.checkBinding(profile, undefined, { force: true });
        if (!status.observedIdentity) {
          return failure('PROVIDER_ACCOUNT_NO_IDENTITY', 'No signed-in identity was observed for that account. Verify it first.');
        }
        profile = store().adoptObservedIdentity(payload.provider, payload.profileId, {
          identity: status.observedIdentity,
          accountKey: status.observedAccountKey ?? null,
          planLabel: status.observedPlan ?? null,
        });
      }
      return { success: true, data: toSafeProfile(profile) };
    },
    'PROVIDER_ACCOUNT_UPDATE_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_SET_PRIORITY_ORDER,
    ProviderAccountSetPriorityOrderPayloadSchema,
    (payload) => ({
      success: true,
      data: { profiles: store().setPriorityOrder(payload.provider, payload.profileIds).map((profile) => toSafeProfile(profile)) },
    }),
    'PROVIDER_ACCOUNT_SET_PRIORITY_ORDER_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_REMOVE,
    ProviderAccountRefPayloadSchema,
    (payload) => {
      store().removeProfile(payload.provider, payload.profileId, inUse(payload.provider));
      bindings.invalidate(payload.provider, payload.profileId);
      return { success: true, data: { provider: payload.provider, profileId: payload.profileId } };
    },
    'PROVIDER_ACCOUNT_REMOVE_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_VERIFY,
    ProviderAccountRefPayloadSchema,
    async (payload) => {
      const profile = requireProfile(payload.provider, payload.profileId);
      const status = await verify(profile);
      return { success: true, data: toSafeProfile(requireProfile(payload.provider, payload.profileId), status) };
    },
    'PROVIDER_ACCOUNT_VERIFY_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_LAUNCH_LOGIN,
    ProviderAccountRefPayloadSchema,
    async (payload) => {
      requireProfile(payload.provider, payload.profileId);
      const result = await launchProviderLogin(payload.provider, undefined, {
        provider: payload.provider,
        profileId: payload.profileId,
      });
      bindings.invalidate(payload.provider, payload.profileId);
      // The command embeds the derived home; only the terminal name and hint cross IPC.
      return { success: true, data: { terminal: result.terminal, ...(result.hint ? { hint: result.hint } : {}) } };
    },
    'PROVIDER_ACCOUNT_LAUNCH_LOGIN_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_POOL_READ,
    ProviderAccountProviderPayloadSchema,
    () => ({ success: true, data: store().getPools() }),
    'PROVIDER_ACCOUNT_POOL_READ_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_POOL_UPDATE,
    ProviderAccountPoolUpdatePayloadSchema,
    (payload) => {
      const { provider, ipcAuthToken: _token, ...patch } = payload;
      return { success: true, data: store().setPoolPolicy(provider, patch) };
    },
    'PROVIDER_ACCOUNT_POOL_UPDATE_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP,
    ProviderAccountAcknowledgePayloadSchema,
    (payload) => ({ success: true, data: store().acknowledgeOwnership(payload.provider) }),
    'PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_DOCTOR,
    ProviderAccountDoctorPayloadSchema,
    async (payload) => ({ success: true, data: await buildProviderAccountDoctorReport(payload.provider) }),
    'PROVIDER_ACCOUNT_DOCTOR_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_RESOLVE_PREVIEW,
    ProviderAccountResolvePreviewPayloadSchema,
    async (payload) => {
      const preview = await getProviderAccountRoutingService().preview({
        provider: payload.provider,
        model: payload.model ?? null,
        ...(payload.explicitProfileId ? { explicitProfileId: payload.explicitProfileId } : {}),
        ...(payload.executionNodeId ? { executionNodeId: payload.executionNodeId } : {}),
        origin: 'interactive',
      });
      return { success: true, data: preview };
    },
    'PROVIDER_ACCOUNT_RESOLVE_PREVIEW_FAILED',
  );

  handle(
    IPC_CHANNELS.PROVIDER_ACCOUNT_SWITCH_SESSION,
    ProviderAccountSwitchSessionPayloadSchema,
    async (payload) => {
      const instance = (deps.getInstances?.() ?? []).find((candidate) => candidate.id === payload.instanceId);
      if (!instance || !deps.requestRuntimeChange) {
        return failure('PROVIDER_ACCOUNT_SESSION_NOT_FOUND', 'That session is not available.');
      }
      if (!isPooledProvider(instance.provider)) {
        return failure('PROVIDER_ACCOUNT_NOT_POOLED', 'Account switching is available for Claude and Codex sessions only.');
      }
      const target = requireProfile(instance.provider, payload.profileId);
      if (!target.enabled) {
        return failure('PROVIDER_ACCOUNT_DISABLED', `The ${target.label} account is disabled.`);
      }
      await deps.requestRuntimeChange(payload.instanceId, {
        provider: instance.provider,
        accountProfileId: payload.profileId,
        accountHandoffKind: 'explicit',
        accountHandoffConfirmed: true,
      });
      return { success: true, data: { instanceId: payload.instanceId, profileId: payload.profileId } };
    },
    'PROVIDER_ACCOUNT_SWITCH_SESSION_FAILED',
  );
}
