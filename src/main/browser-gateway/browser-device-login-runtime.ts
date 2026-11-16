import type { EventEmitter } from 'node:events';
import type { ExecutionLocation, WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import type { CodexDeviceTransferRegistry } from '../remote-node/codex-device-transfer';
import { CodexDeviceLoginPolicySchema } from '../remote-node/codex-device-login-rpc';
import { getProviderAccountStore, type ProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { getSettingsManager } from '../core/config/settings-manager';
import { registerCleanup } from '../util/cleanup-registry';
import { BrowserDeviceLoginCapability, setBrowserDeviceLoginCapabilityProvider } from './browser-device-login-capability';
import { BrowserDeviceLoginOperationController, type BrowserDeviceLoginOperationDependencies,
  type BrowserDeviceLoginOwnerSnapshot } from './browser-device-login-operation';
import { getBrowserExtensionTabStore, type BrowserExtensionTabStore } from './browser-extension-tab-store';
import { getBrowserExtensionContactState } from './browser-extension-contact-state';
import { getBrowserExtensionCommandStore } from './browser-extension-command-store';
import { getBrowserApprovalStore } from './browser-approval-store';
import { getBrowserGatewayService } from './browser-gateway-service';
import { supportsBrowserExtensionCodexDeviceHandoff, supportsBrowserExtensionSessionClaims } from './browser-extension-credential-compatibility';
import { getBrowserTargetRegistry, type BrowserTargetRegistry } from './browser-target-registry';
import { credentialScopeForProfile } from './browser-grant-scope';
import { isOriginAllowed } from './browser-origin-policy';

export interface BrowserDeviceLoginRuntimeOwner {
  restartEpoch: number;
  adapterGeneration?: number;
  status: string;
  supersededBy?: string;
  cancelledForEdit?: boolean;
  executionLocation: ExecutionLocation;
}
type Events = Pick<EventEmitter, 'on' | 'off'>;
type RuntimeNode = Pick<WorkerNodeInfo, 'id' | 'name' | 'status'> & {
  capabilities: Pick<WorkerNodeInfo['capabilities'], 'codexDeviceLogin'>;
};
export interface BrowserDeviceLoginRuntimeDependencies extends Pick<BrowserDeviceLoginOperationDependencies,
  'commands' | 'contacts' | 'ledger' | 'approvals' | 'transfers'> {
  instances: Events & {
    getInstance(id: string): BrowserDeviceLoginRuntimeOwner | undefined;
    hasRuntimeInstance(id: string): boolean;
  };
  nodes: Events & { getNode(id: string): RuntimeNode | undefined };
  connection: Pick<WorkerNodeConnectionServer, 'captureConfidentialConnection'> & {
    sendRpc(nodeId: string, method: string, params?: unknown, timeoutMs?: number, scope?: 'service'): Promise<unknown>;
  };
  profiles: Pick<ProviderAccountStore, 'getProfile'>;
  settings(): { browserAllowSharedTabCredentialFill?: boolean; browserSecretObservationProtectionEnabled?: boolean };
  tabs: Pick<BrowserExtensionTabStore, 'getTab'>;
  targets: Pick<BrowserTargetRegistry, 'listTargets'>;
}
const refused = () => new Error('device_login_request_refused');

/** Coordinator-owned bindings only. Worker reports prove availability, never the expected account identity. */
export function createBrowserDeviceLoginRuntime(deps: BrowserDeviceLoginRuntimeDependencies) {
  let closed = false;
  const owners = new Map<string, BrowserDeviceLoginOwnerSnapshot & { generation: string }>();
  const capabilities = new BrowserDeviceLoginCapability(id => !closed && deps.instances.hasRuntimeInstance(id)
    && deps.instances.getInstance(id)?.executionLocation.type !== 'remote');
  setBrowserDeviceLoginCapabilityProvider(capabilities);
  const protectionEnabled = () => !closed && deps.settings().browserSecretObservationProtectionEnabled !== false;
  const snapshot = (id: string): BrowserDeviceLoginOwnerSnapshot | null => {
    const instance = deps.instances.getInstance(id);
    if (closed || !instance || instance.executionLocation.type !== 'local'
      || ['terminated', 'failed', 'hibernated', 'superseded'].includes(instance.status)
      || !!instance.supersededBy || instance.cancelledForEdit === true
      || !Number.isSafeInteger(instance.restartEpoch) || !Number.isSafeInteger(instance.adapterGeneration)) return null;
    return { object: instance, restartEpoch: instance.restartEpoch, adapterGeneration: instance.adapterGeneration! };
  };
  const controller = new BrowserDeviceLoginOperationController({
    ...deps,
    protectionEnabled,
    captureConfidentialConnection: nodeId => deps.connection.captureConfidentialConnection(nodeId),
    worker: { request: (nodeId, method, params) => deps.connection.sendRpc(nodeId, method, params, 300_000, 'service') },
    resolveOwner: owner => {
      if (!capabilities.isCurrent(owner.sessionId, owner.generation)) return null;
      const current = snapshot(owner.sessionId);
      if (current && owners.get(owner.sessionId)?.generation !== owner.generation) owners.set(owner.sessionId, { ...current, generation: owner.generation });
      return current;
    },
    resolveNative: input => {
      const node = deps.nodes.getNode(input.nodeId);
      const profile = deps.profiles.getProfile('codex', input.profileId);
      if (!node || node.status !== 'connected' || node.capabilities.codexDeviceLogin !== 1
        || !profile || profile.provider !== 'codex' || profile.id !== input.profileId || profile.isLegacy
        || !profile.enabled || profile.automationPolicy !== 'allow-routed') return null;
      const policy = CodexDeviceLoginPolicySchema.safeParse({ enabled: true, expectedIdentity: profile.expectedIdentity });
      return policy.success ? { ...input, computerName: node.name, expectedIdentity: policy.data.expectedIdentity } : null;
    },
    resolveTarget: async input => {
      const tab = deps.tabs.getTab(input.profileId, input.targetId);
      if (!tab?.nodeId || !tab.extensionInstanceId) throw refused();
      const { nodeId, extensionInstanceId, tabId, windowId, attachedAt } = tab;
      const runtime = deps.contacts.getExtensionRuntime?.(nodeId, extensionInstanceId);
      const generation = String(runtime?.extensionStartedAt);
      const node = deps.nodes.getNode(nodeId);
      const isCurrent = () => {
        const current = deps.tabs.getTab(input.profileId, input.targetId);
        const currentNode = deps.nodes.getNode(nodeId);
        const target = deps.targets.listTargets(input.profileId).find(candidate => candidate.id === input.targetId);
        return !closed && protectionEnabled() && deps.settings().browserAllowSharedTabCredentialFill === true
          && currentNode?.status === 'connected' && credentialScopeForProfile(input.profileId) === nodeId
          && !!target && target.profileId === input.profileId && target.nodeId === nodeId && target.driver === 'extension'
          && target.mode === 'existing-tab' && target.status !== 'closed' && !target.stale && target.pageId === String(tabId)
          && !!current && current.nodeId === nodeId
          && current.extensionInstanceId === extensionInstanceId && current.tabId === tabId && current.windowId === windowId
          && current.attachedAt === attachedAt && current.suspendedAt === undefined
          && current.origin === 'https://auth.openai.com' && new URL(current.url).origin === 'https://auth.openai.com'
          && isOriginAllowed(current.url, current.allowedOrigins).allowed
          && supportsBrowserExtensionSessionClaims(deps.contacts.getExtensionRuntime?.(nodeId, extensionInstanceId))
          && supportsBrowserExtensionCodexDeviceHandoff(deps.contacts, nodeId, extensionInstanceId, generation);
      };
      if (!node || !isCurrent()) throw refused();
      return { browserNodeId: nodeId, browserProfileId: input.profileId, targetId: input.targetId, tabId,
        extensionInstanceId, extensionGeneration: generation, computerName: node.name, isCurrent };
    },
  });
  const removeOwner = (id: string) => { controller.invalidateOwner(id); capabilities.revoke(id); owners.delete(id); };
  const recheckOwners = () => {
    for (const [id, previous] of owners) {
      const current = snapshot(id);
      if (!current || current.object !== previous.object || current.restartEpoch !== previous.restartEpoch
        || current.adapterGeneration !== previous.adapterGeneration || !capabilities.isCurrent(id, previous.generation)) {
        controller.invalidateOwner(id);
        if (capabilities.isCurrent(id, previous.generation)) capabilities.revoke(id);
        owners.delete(id);
      }
    }
  };
  const invalidateNode = (node: string | { id: string }) => controller.invalidateNode(typeof node === 'string' ? node : node.id);
  const ownerEvents = ['instance:state-update', 'instance:batch-update', 'instance:agent-changed'];
  for (const event of ownerEvents) deps.instances.on(event, recheckOwners);
  deps.instances.on('instance:removed', removeOwner);
  deps.nodes.on('node:disconnected', invalidateNode);
  deps.nodes.on('node:worker-restarted', invalidateNode);
  return { controller, stop: () => {
    if (closed) return;
    controller.shutdown(); closed = true;
    setBrowserDeviceLoginCapabilityProvider(null); owners.clear();
    for (const event of ownerEvents) deps.instances.off(event, recheckOwners);
    deps.instances.off('instance:removed', removeOwner);
    deps.nodes.off('node:disconnected', invalidateNode);
    deps.nodes.off('node:worker-restarted', invalidateNode);
  } };
}

let active: ReturnType<typeof createBrowserDeviceLoginRuntime> | undefined;
let unregisterCleanup: (() => void) | undefined;
export function initializeBrowserDeviceLoginRuntime(input: {
  instanceManager: InstanceManager; registry: WorkerNodeRegistry; connection: WorkerNodeConnectionServer; transfers: CodexDeviceTransferRegistry;
}): void {
  unregisterCleanup?.(); active?.stop();
  active = createBrowserDeviceLoginRuntime({ instances: input.instanceManager, nodes: input.registry, connection: input.connection,
    transfers: input.transfers, profiles: getProviderAccountStore(), settings: () => getSettingsManager().getAll(),
    tabs: getBrowserExtensionTabStore(), targets: getBrowserTargetRegistry(), contacts: getBrowserExtensionContactState(), commands: getBrowserExtensionCommandStore(),
    approvals: getBrowserApprovalStore(), ledger: getBrowserGatewayService().getDeviceLoginLedger() });
  const runtime = active;
  unregisterCleanup = registerCleanup(() => { runtime.stop(); if (active === runtime) active = undefined; });
}
export function getBrowserDeviceLoginController(): BrowserDeviceLoginOperationController | undefined { return active?.controller; }
