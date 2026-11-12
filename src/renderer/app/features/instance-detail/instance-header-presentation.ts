/** Pure wording for the session header and the composer toolbar, kept out of the components. */

import { accountFamilyName, providerName } from '../../../../shared/display-names';
import type { InstanceWaitReason } from '../../../../shared/types/instance-wait-reason.types';
import type { InstanceRuntimeSummary } from '../../../../shared/types/local-model-runtime.types';
import { getModelShortName, type ModelDisplayInfo } from '../../../../shared/types/provider.types';
import type { Instance } from '../../core/state/instance.store';
import { formatWaitReasonData } from './instance-header-wait-reason-data';

export function resolveHeaderProviderDisplayName(
  provider: string,
  runtimeSummary?: InstanceRuntimeSummary,
  model?: string | null,
): string {
  return providerName(runtimeSummary?.kind === 'local-model' ? 'local-model' : provider, { model });
}

export function resolveHeaderModelDisplayName(options: {
  runtimeSummary?: InstanceRuntimeSummary;
  currentModel?: string;
  availableModels: ModelDisplayInfo[];
  provider: string;
}): string {
  if (options.runtimeSummary?.kind === 'local-model') {
    return options.runtimeSummary.label;
  }

  const modelId = options.currentModel || options.availableModels[0]?.id || '';
  const match = options.availableModels.find(m => m.id === modelId);
  if (match) return match.name;
  return getModelShortName(modelId, options.provider);
}

export function agentModeName(agentId?: string): 'Build' | 'Plan' | 'Review' {
  return agentId === 'plan' ? 'Plan' : agentId === 'review' ? 'Review' : 'Build';
}

/** The short line beside the title while the session waits on something. `null` when there is nothing to say here. */
export function waitReasonLabel(wr: InstanceWaitReason | undefined, now = Date.now()): string | null {
  if (!wr) return null;
  switch (wr.kind) {
    case 'respawning':
      return wr.strategy === 'native-resume' ? 'Resuming session…' : 'Restarting session…';
    case 'interrupt-ack':
      return 'Waiting for interrupt…';
    case 'backoff': {
      const secsLeft = Math.max(0, Math.round((wr.retryAt - now) / 1000));
      return secsLeft > 0 ? `Backing off — retry in ${secsLeft}s` : 'Retrying…';
    }
    // 'quota-park' and 'auth-required' render as banners above the composer
    // (input-panel), not here.
    case 'quota-park':
    case 'auth-required':
      return null;
    case 'provider-slot':
      return `Waiting for another ${providerName(wr.provider)} session to finish…`;
    case 'resume-proof':
      return 'Verifying session resume…';
    case 'remote-heartbeat':
      return 'Waiting for its computer to reconnect…';
    case 'mutex':
      return 'Finishing the previous action…';
    case 'terminating':
      return wr.force ? 'Force terminating…' : 'Terminating…';
    default:
      return null;
  }
}

/** The hover text for the waiting line. Runtime values come from `formatWaitReasonData`; the words stay here. */
export function waitReasonDetail(wr: InstanceWaitReason | undefined): string {
  if (!wr) return '';
  const data = formatWaitReasonData(wr);
  switch (wr.kind) {
    case 'respawning':
      return `Strategy: ${wr.strategy}`;
    case 'interrupt-ack':
      return `Attempt ${wr.attempt}`;
    case 'backoff':
      return `Attempt ${wr.attempt}, retry at ${data.time}`;
    case 'quota-park':
      return `${accountFamilyName(wr.provider)} allowance resets at ${data.time}`;
    case 'auth-required':
      return `Signed out of ${accountFamilyName(wr.provider)} since ${data.time}`;
    case 'provider-slot':
      return `Waiting on ${providerName(wr.provider)}`;
    case 'resume-proof':
      return wr.sessionId ? `Session: ${data.sessionId}…` : `Checking ${providerName(wr.provider)}`;
    case 'remote-heartbeat':
      return `No reply for ${data.staleSeconds}s`;
    case 'mutex':
      return wr.owner ? `Owner: ${wr.owner}` : wr.operation;
    case 'terminating':
      return wr.force ? 'Force kill' : 'Graceful shutdown';
    default:
      return '';
  }
}

/**
 * The GitHub Copilot account this session was STAMPED with at creation.
 *
 * Read from the instance record rather than re-resolved: the session is
 * already pinned, and re-running the rules here would show what a NEW
 * session would get, which is exactly the confusion this badge exists to
 * prevent when rules change mid-conversation.
 */
export function copilotAccountBadgeFor(
  instance: Pick<Instance, 'provider' | 'copilotAccountProfileId' | 'copilotRoutingSource'>,
): { label: string; title: string } | null {
  if (instance.provider !== 'copilot' || !instance.copilotAccountProfileId) return null;
  const reason = (() => {
    switch (instance.copilotRoutingSource) {
      case 'repository':
        return 'matched this repository';
      case 'owner':
        return 'matched this GitHub owner';
      case 'path-prefix':
        return 'matched this folder';
      case 'explicit':
        return 'you chose this account';
      case 'persisted':
        return 'carried over from when this conversation started';
      case 'legacy':
        return 'your existing Copilot sign-in';
      default:
        return 'the default account';
    }
  })();
  return {
    label: instance.copilotAccountProfileId,
    title: `GitHub Copilot account: ${instance.copilotAccountProfileId} — ${reason}`,
  };
}

interface RemoteNodeFacts {
  name: string;
  status: string;
  latencyMs?: number | null;
  activeInstances: number;
  capabilities: {
    platform: string;
    arch: string;
    cpuCores: number;
    availableMemoryMB?: number | null;
    totalMemoryMB: number;
    gpuName?: string | null;
    gpuMemoryMB?: number | null;
    supportedClis: readonly string[];
  };
}

/** The hover text for the remote-computer chip. A missing node is described by `displayName`, never a raw id. */
export function remoteNodeTooltip(node: RemoteNodeFacts | null, displayName: string): string {
  if (!node) return `${displayName} is no longer registered`;
  const caps = node.capabilities;
  const platform = caps.platform === 'win32' ? 'Windows' : caps.platform === 'darwin' ? 'macOS' : 'Linux';
  const lines = [
    node.name,
    `Platform: ${platform} (${caps.arch})`,
    `Latency: ${node.latencyMs !== null && node.latencyMs !== undefined ? node.latencyMs + 'ms' : 'unknown'}`,
    `CPU: ${caps.cpuCores} cores`,
    `Memory: ${caps.availableMemoryMB !== null && caps.availableMemoryMB !== undefined ? (caps.availableMemoryMB / 1024).toFixed(1) : '?'} / ${(caps.totalMemoryMB / 1024).toFixed(1)} GB`,
  ];
  if (caps.gpuName) lines.push(`GPU: ${caps.gpuName}${caps.gpuMemoryMB ? ' (' + (caps.gpuMemoryMB / 1024).toFixed(0) + ' GB)' : ''}`);
  lines.push(`CLIs: ${caps.supportedClis.join(', ')}`);
  lines.push(`Sessions: ${node.activeInstances} active`);
  lines.push(`Status: ${node.status}`);
  return lines.join('\n');
}
