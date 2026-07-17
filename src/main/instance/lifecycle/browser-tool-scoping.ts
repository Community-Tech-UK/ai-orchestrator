/**
 * WS9 per-instance browser-tool scoping.
 *
 * An instance can override the global `browserMcpToolDeferral` posture at
 * create time: `eager` (all schemas upfront), `deferred` (core set +
 * search/describe), or `off` (no browser-gateway MCP injected at all — the
 * heavy group disabled entirely for this instance).
 *
 * The registry exists because `SpawnConfigBuilder` deliberately holds no
 * instance state ("pure code paths only" — functions of ids plus singletons):
 * `buildInstanceRecord` writes the mode here at creation, every spawn/respawn
 * path reads it back by instance id, and `InstanceManager` clears it on
 * removal. Bounded as a safety net against missed removals.
 */

import type { BrowserToolsMode } from '../../../shared/types/instance.types';

const MAX_ENTRIES = 1000;

const modesByInstance = new Map<string, BrowserToolsMode>();

export function setInstanceBrowserToolsMode(
  instanceId: string,
  mode: BrowserToolsMode | undefined,
): void {
  if (mode === undefined) {
    modesByInstance.delete(instanceId);
    return;
  }
  // Re-insert to keep LRU-ish eviction order.
  modesByInstance.delete(instanceId);
  modesByInstance.set(instanceId, mode);
  if (modesByInstance.size > MAX_ENTRIES) {
    const oldest = modesByInstance.keys().next().value;
    if (oldest !== undefined) modesByInstance.delete(oldest);
  }
}

export function getInstanceBrowserToolsMode(instanceId: string): BrowserToolsMode | undefined {
  return modesByInstance.get(instanceId);
}

export function removeInstanceBrowserToolsMode(instanceId: string): void {
  modesByInstance.delete(instanceId);
}

export function _resetBrowserToolScopingForTesting(): void {
  modesByInstance.clear();
}

/**
 * Effective mode for a spawn: the per-instance override wins; otherwise the
 * global deferral setting decides between deferred and eager.
 */
export function resolveBrowserToolsMode(
  perInstance: BrowserToolsMode | undefined,
  globalDeferralEnabled: boolean,
): BrowserToolsMode {
  if (perInstance) return perInstance;
  return globalDeferralEnabled ? 'deferred' : 'eager';
}
