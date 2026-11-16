import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import type { BrowserApprovalRequestInput } from './browser-approval-store';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { BrowserExtensionTabStore } from './browser-extension-tab-store';
import { BrowserTargetRegistry } from './browser-target-registry';
import { BrowserOneTimeCodeFillLedger } from './browser-one-time-code-submit';
import { CodexDeviceTransferRegistry } from '../remote-node/codex-device-transfer';
import type { CodexDeviceLoginHandoffParams } from '../remote-node/codex-device-login-rpc';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-delivery';
import { mintBrowserDeviceLoginCapability, verifyBrowserDeviceLoginCapability } from './browser-device-login-capability';
import { createBrowserDeviceLoginRuntime, type BrowserDeviceLoginRuntimeOwner } from './browser-device-login-runtime';

const handle = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const stops: (() => void)[] = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  let instance: BrowserDeviceLoginRuntimeOwner | undefined = { restartEpoch: 1, adapterGeneration: 1,
    status: 'busy', executionLocation: { type: 'local' } };
  let pending = false;
  const instances = Object.assign(new EventEmitter(), { getInstance: () => instance, hasRuntimeInstance: () => !!instance || pending });
  const node = { id: 'native', name: 'Native', status: 'connected' as const, capabilities: { codexDeviceLogin: 1 as const } };
  const browser = { ...node, id: 'browser', name: 'Browser' };
  const nodes = Object.assign(new EventEmitter(), { getNode: (id: string) => id === 'native' ? node : id === 'browser' ? browser : undefined });
  const profile: ProviderAccountProfile = { id: 'test-profile', provider: 'codex', label: 'Test', enabled: true,
    isLegacy: false, automationPolicy: 'allow-routed', expectedIdentity: 'account@example.test', expectedAccountKey: null,
    planLabel: null, priority: 0, createdAt: 1, updatedAt: 1 };
  const settings = { browserAllowSharedTabCredentialFill: true, browserSecretObservationProtectionEnabled: true };
  const contacts = new BrowserExtensionContactState();
  contacts.markExtensionContact('browser');
  contacts.markExtensionRuntime('browser', { extensionInstanceId: 'test-install', extensionStartedAt: 100, extensionVersion: '0.2.54' });
  const targets = new BrowserTargetRegistry();
  const tabs = new BrowserExtensionTabStore({ targetRegistry: targets, reliabilityEvents: { record: vi.fn() } });
  const tab = tabs.attachTab({ tabId: 1, windowId: 2, url: 'https://auth.openai.com/codex/device' }, { nodeId: 'browser', extensionInstanceId: 'test-install' });
  const requests = new Map<string, BrowserApprovalRequest>();
  const approvals = { createRequest: vi.fn((input: BrowserApprovalRequestInput) => {
    const value: BrowserApprovalRequest = { ...input, id: 'approval', requestId: 'approval', status: 'pending', createdAt: Date.now() };
    requests.set('approval', value); return value;
  }), findDeviceLoginRequest: vi.fn(() => requests.get('approval') ?? null),
  invalidateDeviceLoginRequests: vi.fn(() => { for (const request of requests.values()) request.status = 'expired'; }) };
  const commands = { sendCommand: vi.fn(async (request: BrowserExtensionSendCommandRequest): Promise<unknown> => {
    request.beforeDelivery?.();
    if (request.command === 'codex_device_context') return { documentId, identityMatches: true, extensionInstanceId: 'test-install', extensionGeneration: '100' };
    if (request.command === 'codex_device_attest') return { completed: true, deviceDocumentId: documentId };
    if (request.command === 'codex_device_cancel') return { completed: true };
    return { completed: true, observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' };
  }), cancelCommand: vi.fn(() => true) };
  const transfers = new CodexDeviceTransferRegistry();
  const view = { handle, nodeId: 'native', profileId: profile.id, provider: 'codex', expectedIdentity: profile.expectedIdentity,
    expiresAt: 61000, state: 'awaiting_handoff' };
  let confidential = true;
  const connection = { captureConfidentialConnection: vi.fn(() => confidential ? () => confidential : null),
    sendRpc: vi.fn(async (_node: string, method: string, params?: unknown) => {
      if (method.endsWith('.handoff')) {
        const handoff = params as CodexDeviceLoginHandoffParams;
        await transfers.receive('native', { ...handoff, expiresAt: view.expiresAt, code: 'TESTCODEX' }, () => true);
        return { ...view, state: 'awaiting_login' };
      }
      return { ...view };
    }) };
  const ledger = new BrowserOneTimeCodeFillLedger();
  const runtime = createBrowserDeviceLoginRuntime({ instances, nodes, connection, transfers, profiles: { getProfile: () => profile },
    settings: () => settings, tabs, targets, contacts, commands, approvals, ledger });
  stops.push(runtime.stop);
  const token = mintBrowserDeviceLoginCapability('owner')!;
  const owner = { sessionId: 'owner', generation: verifyBrowserDeviceLoginCapability('owner', token)! };
  const start = () => runtime.controller.start({ nodeId: 'native', profileId: profile.id }, owner);
  const fill = () => runtime.controller.fill({ loginHandle: handle, profileId: tab.profileId, targetId: tab.targetId }, owner);
  return { runtime, instances, nodes, profile, settings, tabs, targets, tab, contacts, commands, approvals, requests, connection, ledger,
    owner, token, start, fill, setInstance: (next: BrowserDeviceLoginRuntimeOwner | undefined) => { instance = next; },
    instance: instance!, setPending: () => { pending = true; instance = undefined; }, loseTls: () => { confidential = false; } };
}
describe('device login runtime composition', () => {
  it('uses service scope, trusted account identity, exact transfer registry and mandatory approval', async () => {
    const s = setup(); await s.start();
    expect(s.connection.sendRpc).toHaveBeenCalledWith('native', 'provider.codexDevice.start',
      { profileId: s.profile.id, owner: s.owner }, 300000, 'service');
    expect(await s.fill()).toMatchObject({ status: 'requires_approval' });
    expect(s.requests.get('approval')?.deviceLogin?.expectedIdentity).toBe(s.profile.expectedIdentity);
    expect(s.commands.sendCommand.mock.calls.map(([request]) => request.command)).toEqual(['codex_device_context']);
    s.requests.get('approval')!.status = 'approved';
    expect(await s.fill()).toMatchObject({ status: 'submitted' });
    expect(s.commands.sendCommand.mock.calls.map(([request]) => request.command)).toContain('codex_device_submit');
  });
  it.each(['disabled', 'legacy', 'manual', 'identity'] as const)('refuses untrusted native account policy: %s', async kind => {
    const s = setup();
    if (kind === 'disabled') s.profile.enabled = false;
    if (kind === 'legacy') s.profile.isLegacy = true;
    if (kind === 'manual') s.profile.automationPolicy = 'manual-only';
    if (kind === 'identity') s.profile.expectedIdentity = null;
    await expect(s.start()).rejects.toThrow('device_login_request_refused');
    expect(s.connection.sendRpc).not.toHaveBeenCalled();
  });
  it.each(['optout', 'protection', 'suspended', 'closed', 'origin', 'runtime', 'tls'] as const)('refuses invalid browser authority: %s', async kind => {
    const s = setup(); await s.start();
    if (kind === 'optout') s.settings.browserAllowSharedTabCredentialFill = false;
    if (kind === 'protection') s.settings.browserSecretObservationProtectionEnabled = false;
    if (kind === 'suspended') s.tabs.suspendNode('browser');
    if (kind === 'closed') s.targets.markClosed(s.tab.targetId);
    if (kind === 'origin') s.tabs.attachTab({ tabId: 1, windowId: 2, url: 'https://example.test/' }, { nodeId: 'browser', extensionInstanceId: 'test-install' });
    if (kind === 'runtime') s.contacts.markExtensionDisconnect('browser', 'test');
    if (kind === 'tls') s.loseTls();
    await expect(s.fill()).rejects.toThrow('device_login_request_refused');
    expect(s.commands.sendCommand).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'identity'] as const)('rechecks trusted native policy after approval: %s', async kind => {
    const s = setup(); await s.start(); await s.fill();
    s.requests.get('approval')!.status = 'approved';
    if (kind === 'disabled') s.profile.enabled = false;
    else s.profile.expectedIdentity = 'replacement@example.test';
    await expect(s.fill()).rejects.toThrow('device_login_request_refused');
    expect(s.connection.sendRpc.mock.calls.some(([, method]) => method.endsWith('.handoff'))).toBe(false);
    expect(s.commands.sendCommand.mock.calls.map(([request]) => request.command)).not.toContain('codex_device_fill');
  });
  it.each(['status', 'replacement'] as const)('refuses superseded owners identified by %s', async kind => {
    const s = setup();
    if (kind === 'status') s.instance.status = 'superseded';
    else Object.assign(s.instance, { supersededBy: 'replacement-instance' });
    await expect(s.start()).rejects.toThrow('device_login_request_refused');
    expect(s.connection.sendRpc).not.toHaveBeenCalled();
  });
  it('uses the shared ledger to burn ordinary OTP submission when a device code is filled', async () => {
    const s = setup(); await s.start(); await s.fill();
    const ordinary = { instanceId: 'owner', profileId: s.tab.profileId, targetId: s.tab.targetId, origin: s.tab.origin };
    s.ledger.record(ordinary); expect(s.ledger.has(ordinary)).toBe(true);
    s.requests.get('approval')!.status = 'approved'; await s.fill();
    expect(s.ledger.has(ordinary)).toBe(false);
  });
  it('invalidates owner snapshots and denies stale forwarders after respawn', async () => {
    const s = setup(); await s.start(); await s.fill();
    s.instance.adapterGeneration = 2;
    s.instances.emit('instance:state-update', { instanceId: 'owner' });
    expect(s.requests.get('approval')?.status).toBe('expired');
    mintBrowserDeviceLoginCapability('owner');
    expect(verifyBrowserDeviceLoginCapability('owner', s.token)).toBeNull();
    await expect(s.runtime.controller.read(handle, s.owner)).rejects.toThrow('device_login_request_refused');
  });
  it('mints unpublished recovery spawns but refuses operations until published', async () => {
    const s = setup(); s.setPending();
    const token = mintBrowserDeviceLoginCapability('owner'); expect(token).not.toBeNull();
    const owner = { sessionId: 'owner', generation: verifyBrowserDeviceLoginCapability('owner', token)! };
    await expect(s.runtime.controller.start({ nodeId: 'native', profileId: s.profile.id }, owner)).rejects.toThrow();
    s.setInstance(s.instance);
    await expect(s.runtime.controller.start({ nodeId: 'native', profileId: s.profile.id }, owner)).resolves.toMatchObject({ handle });
  });
  it('cleans node/owner operations, listeners and caller capabilities on stop', async () => {
    const s = setup(); await s.start(); await s.fill();
    s.nodes.emit('node:disconnected', { id: 'browser' });
    expect(s.requests.get('approval')?.status).toBe('expired');
    s.instances.emit('instance:removed', 'owner');
    expect(verifyBrowserDeviceLoginCapability('owner', s.token)).toBeNull();
    s.runtime.stop();
    expect(s.instances.eventNames()).toEqual([]); expect(s.nodes.eventNames()).toEqual([]);
    expect(mintBrowserDeviceLoginCapability('owner')).toBeNull();
  });
});
