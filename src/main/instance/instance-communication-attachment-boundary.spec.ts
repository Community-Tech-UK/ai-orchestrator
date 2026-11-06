import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { CopilotCliAdapter } from '../cli/adapters/copilot-cli-adapter';
import { InstanceCommunicationManager } from './instance-communication';
const receipts = vi.hoisted(() => ({ record: vi.fn(() => ({ admissionId: 'disposable-attachment-admission' })), delivered: vi.fn(), failed: vi.fn() }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ recordUserSend: receipts.record, markDelivered: receipts.delivered, markFailed: receipts.failed }) }));
vi.mock('../cli/adapters/copilot/copilot-account-home-resolver', () => ({ resolveCopilotProfileHome: () => '/disposable-copilot-home' }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));
// A provider capability report can precede an older executable's rejection.
class AdvertisedAttachmentCopilot extends CopilotCliAdapter {
  override getCapabilities() { return { ...super.getCapabilities(), vision: true, fileAccess: true }; }
}
describe('actual attachment fallback native boundary', () => {
  it('claims and terminalizes attachment-only queued input before its unsupported warning, without a provider write', async () => {
    receipts.record.mockClear(); receipts.delivered.mockClear(); receipts.failed.mockClear();
    const adapter = new AdvertisedAttachmentCopilot({ accountProfileId: 'disposable-profile' });
    Object.assign(adapter, { isSpawned: true });
    const instance = { id: 'queued-attachment-only', provider: 'copilot', status: 'idle', sessionId: 'attachment-session',
      adapterGeneration: 1, requestCount: 3, lastActivity: 0, outputBuffer: [] } as unknown as Instance;
    const spawn = vi.fn();
    (adapter as unknown as { spawnProcess: typeof spawn }).spawnProcess = spawn;
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
      processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
      ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    const warning = vi.fn(() => { expect(receipts.record).toHaveBeenCalledOnce(); expect(receipts.failed).toHaveBeenCalledOnce(); });
    manager.on('output', warning);
    await manager.sendInput(instance.id, '', [{ name: 'queued.png', type: 'image/png', size: 1, data: 'eA==' }], undefined,
      { queuedAdmissionId: 'queued-attachment-admission' });
    expect(spawn).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(receipts.record).toHaveBeenCalledExactlyOnceWith(instance.id, '', expect.any(Array), undefined, 'queued-attachment-admission');
    expect(receipts.failed).toHaveBeenCalledWith('disposable-attachment-admission', expect.stringContaining('attachment'));
    expect(receipts.delivered).not.toHaveBeenCalled();
  });

  it.each(['success', 'success-observer-failure', 'queued-success', 'queued-success-observer-failure', 'stop', 'new-input', 'auto-stop', 'auto-new-input'] as const)('retains one admission and receipt through %s', async mode => {
    const queuedAdmissionId = mode.startsWith('queued-') ? 'queued-attachment-admission' : undefined;
    const success = mode.includes('success');
    const observed = vi.fn(() => { if (mode.endsWith('observer-failure')) throw new Error('inert observer failure'); });
    receipts.record.mockClear(); receipts.delivered.mockClear(); receipts.failed.mockClear();
    const adapter = new AdvertisedAttachmentCopilot({ accountProfileId: 'disposable-profile' }); Object.assign(adapter, { isSpawned: true });
    const instance = { id: 'attachment-boundary', provider: 'copilot', status: 'idle', sessionId: 'attachment-session', adapterGeneration: 1, requestCount: 3, lastActivity: 0, outputBuffer: [] } as unknown as Instance;
    const nativeArgs: string[][] = []; const admission = vi.fn(); const controller = new AbortController();
    (adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }).spawnProcess = args => {
      nativeArgs.push(args); const child = new EventEmitter() as unknown as ChildProcess;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      queueMicrotask(() => child.emit('close', 0, null)); return child;
    };
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    manager.on('output', () => { if (mode === 'stop' || mode === 'auto-stop') { instance.status = 'interrupting'; controller.abort(); } if (mode === 'new-input' || mode === 'auto-new-input') { instance.status = 'busy'; instance.requestCount++; } });
    const pending = manager.sendInput(instance.id, 'synthetic request', [{ name: 'synthetic.png', type: 'image/png', size: 1, data: 'eA==' }], undefined, {
      queuedAdmissionId, signal: controller.signal, autoContinuation: mode.startsWith('auto-'), beforeProviderDispatch: admission, onProviderInputDelivered: observed,
      assertProviderDispatchCurrent: () => { if (instance.requestCount !== 3) { const error = new Error('request changed'); error.name = 'AbortError'; throw error; } },
    });
    if (success || mode.startsWith('auto-')) await pending; else await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(nativeArgs).toHaveLength(success ? 1 : 0); expect(admission).toHaveBeenCalledTimes(success ? 1 : 0);
    expect(receipts.record).toHaveBeenCalledTimes(success ? 1 : 0); expect(receipts.delivered).toHaveBeenCalledTimes(success ? 1 : 0); expect(receipts.failed).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(success ? 1 : 0);
    if (queuedAdmissionId) expect(receipts.record).toHaveBeenCalledExactlyOnceWith(instance.id, 'synthetic request', undefined, undefined, queuedAdmissionId);
    if (success) expect(nativeArgs[0]).toContain('synthetic request');
    if (mode === 'stop' || mode === 'auto-stop') expect(instance.status).toBe('interrupting');
    if (mode === 'new-input' || mode === 'auto-new-input') expect(instance.status).toBe('busy');
  });
});
