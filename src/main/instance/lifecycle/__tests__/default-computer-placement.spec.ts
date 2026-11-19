import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const pool = vi.hoisted(() => ({ peek: vi.fn(), request: undefined as unknown }));
vi.mock('../../../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => ({
    peekNewSessionProfileId: (request: unknown) => { pool.request = request; return pool.peek(request); },
  }),
}));

import { WorkerNodeRegistry } from '../../../remote-node/worker-node-registry';
import { resolveNewSessionPlacement, stayedHereMessage } from '../default-computer-placement';
import type { InstanceCreateConfig } from '../../../../shared/types/instance.types';
import type { WorkerNodeCapabilities, WorkerNodeInfo } from '../../../../shared/types/worker-node.types';

const PC_FOLDER = 'C:\\Users\\shutu\\Documents\\Work';

function node(id: string, caps: Partial<WorkerNodeCapabilities> = {}, info: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id, name: id, address: '10.0.0.1', status: 'connected', activeInstances: 0, latencyMs: 20,
    capabilities: {
      platform: 'win32', arch: 'x64', cpuCores: 8, totalMemoryMB: 16384, availableMemoryMB: 8192,
      supportedClis: ['claude', 'codex'], hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false,
      hasDocker: false, maxConcurrentInstances: 4, workingDirectories: [PC_FOLDER], browsableRoots: [], discoveredProjects: [],
      signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-in' }, { provider: 'codex', profileId: 'legacy', state: 'signed-out' }],
      ...caps,
    },
    ...info,
  };
}

function config(overrides: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig {
  return { workingDirectory: `${PC_FOLDER}\\project`, provider: 'claude', preferOtherComputer: true, ...overrides };
}

describe('resolveNewSessionPlacement', () => {
  let registry: WorkerNodeRegistry;
  beforeEach(() => {
    WorkerNodeRegistry._resetForTesting();
    registry = WorkerNodeRegistry.getInstance();
    pool.peek.mockReset().mockReturnValue('legacy');
  });

  it('places a session that asks for another computer on one that can run it', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry))
      .toEqual({ location: { type: 'remote', nodeId: 'pc' }, accountProfileId: 'legacy' });
  });

  it('leaves a session that did not ask where it was, and says nothing', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ preferOtherComputer: undefined }), 'claude', undefined, registry)).toEqual({ location: { type: 'local' } });
  });

  it('uses the settings default tool when the session leaves the tool open', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ provider: 'auto' }), 'claude', undefined, registry).location).toEqual({ type: 'remote', nodeId: 'pc' });
    expect(resolveNewSessionPlacement(config({ provider: undefined }), 'gemini', undefined, registry).stayedHereBecause).toMatch(/only Claude and Codex/);
  });

  it('still obeys a named computer or a placement, which the default never overrides', () => {
    registry.registerNode(node('pc'));
    registry.registerNode(node('mac'));
    expect(resolveNewSessionPlacement(config({ forceNodeId: 'mac' }), 'claude', undefined, registry))
      .toEqual({ location: { type: 'remote', nodeId: 'mac' } });
    expect(resolveNewSessionPlacement(config({ nodePlacement: { preferNodeId: 'mac' } }), 'claude', undefined, registry).stayedHereBecause).toBeUndefined();
  });

  it.each([
    ['no other computer is connected', () => undefined, 'no other computer is connected'],
    ['every computer is paused', () => registry.setComputerChoices([{ id: 'pc', paused: true, sessions: true }]), 'no other computer is set to take agent sessions'],
    ['the sessions switch is off', () => registry.setComputerChoices([{ id: 'pc', paused: false, sessions: false }]), 'no other computer is set to take agent sessions'],
  ])('stays here and says why: %s', (_name, arrange, reason) => {
    if (_name !== 'no other computer is connected') registry.registerNode(node('pc'));
    arrange();
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry)).toEqual({ location: { type: 'local' }, stayedHereBecause: reason });
  });

  it('stays here when every computer that takes sessions is full', () => {
    registry.registerNode(node('pc', {}, { activeInstances: 4 }));
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).stayedHereBecause).toBe('every other computer that takes sessions is full');
  });

  it('stays here when the tool is not installed there', () => {
    registry.registerNode(node('pc', { supportedClis: ['codex'] }));
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).stayedHereBecause).toBe("Claude isn't installed on any other computer that has room");
  });

  it('stays here when the account is signed out there, naming the tool', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ provider: 'codex' }), 'claude', undefined, registry).stayedHereBecause)
      .toBe("Codex isn't signed in on any other computer that has room");
  });

  it('needs the sign-in for the account the session would use, not just any account', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ accountProfileId: 'work' }), 'claude', undefined, registry).stayedHereBecause)
      .toBe("Claude isn't signed in on any other computer that has room");
  });

  it("asks the pool about the model the session was given", () => {
    registry.registerNode(node('pc'));
    resolveNewSessionPlacement(config({ modelOverride: 'claude-opus-4' }), 'claude', undefined, registry);
    expect(pool.request).toMatchObject({ model: 'claude-opus-4' });
  });

  it("asks the pool about the model the session's agent pins, and lets the session's own model win", () => {
    registry.registerNode(node('pc'));
    resolveNewSessionPlacement(config(), 'claude', 'claude-sonnet-4', registry);
    expect(pool.request).toMatchObject({ model: 'claude-sonnet-4' });
    resolveNewSessionPlacement(config({ modelOverride: 'claude-opus-4' }), 'claude', 'claude-sonnet-4', registry);
    expect(pool.request).toMatchObject({ model: 'claude-opus-4' });
    resolveNewSessionPlacement(config(), 'claude', undefined, registry);
    expect(pool.request).toMatchObject({ model: null });
  });

  it('needs the sign-in for the pooled account the session would actually run on, not the legacy one', () => {
    registry.registerNode(node('pc'));
    pool.peek.mockReturnValue('work');
    expect(resolveNewSessionPlacement(config({ accountRouteOrigin: 'automation', accountPreferences: { avoid: ['a'], last: ['b'] } }), 'claude', undefined, registry).stayedHereBecause)
      .toBe("Claude isn't signed in on any other computer that has room");
    expect(pool.request).toMatchObject({ provider: 'claude', origin: 'automation', avoid: ['a'], useLast: ['b'] });
    registry.deregisterNode('pc');
    registry.registerNode(node('pc', { signIns: [{ provider: 'claude', profileId: 'work', state: 'signed-in' }] }));
    // The account the computer was checked for is handed back so the session is started on that account.
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry))
      .toEqual({ location: { type: 'remote', nodeId: 'pc' }, accountProfileId: 'work' });
  });

  it('stays here when no account can run the session', () => {
    registry.registerNode(node('pc'));
    pool.peek.mockReturnValue(null);
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).stayedHereBecause).toBe('no Claude account can run it');
  });

  it('does not treat a computer that has not reported sign-ins, or could not read them, as signed in', () => {
    registry.registerNode(node('old', { signIns: undefined }));
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).stayedHereBecause)
      .toBe("Harness can't tell yet whether Claude is signed in on the other computers");
    registry.deregisterNode('old');
    registry.registerNode(node('flaky', { signIns: [{ provider: 'claude', profileId: 'legacy', state: 'unknown' }] }));
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).location).toEqual({ type: 'local' });
  });

  it("stays here when the computer doesn't have the folder, whatever its slashes", () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ workingDirectory: '/Users/suas/work/app' }), 'claude', undefined, registry).stayedHereBecause)
      .toBe("no other computer that's signed in has this folder");
    expect(resolveNewSessionPlacement(config({ workingDirectory: 'c:/users/shutu/documents/work/app' }), 'claude', undefined, registry).location)
      .toEqual({ type: 'remote', nodeId: 'pc' });
    expect(resolveNewSessionPlacement(config({ workingDirectory: `${PC_FOLDER}-other` }), 'claude', undefined, registry).location).toEqual({ type: 'local' });
  });

  it('stays here for a session with extra folders', () => {
    registry.registerNode(node('pc'));
    expect(resolveNewSessionPlacement(config({ additionalDirectories: ['C:\\x'] }), 'claude', undefined, registry).stayedHereBecause).toBe('it uses extra folders');
  });

  it("follows the Computers page's order between two computers that can run it", () => {
    registry.registerNode(node('pc'));
    registry.registerNode(node('other'));
    registry.setComputerChoices([{ id: 'other', paused: false, sessions: true }, { id: 'pc', paused: false, sessions: true }]);
    expect(resolveNewSessionPlacement(config(), 'claude', undefined, registry).location).toEqual({ type: 'remote', nodeId: 'other' });
  });

  it('says why in one plain sentence', () => {
    expect(stayedHereMessage('no other computer is connected')).toBe('Running on this Mac: no other computer is connected.');
  });
});
