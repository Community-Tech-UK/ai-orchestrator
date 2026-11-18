import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { InstanceCommunicationManager } from './instance-communication';
import { getInputTurnRegistry, InputTurnRegistry } from './input-turn-registry';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));

beforeEach(() => InputTurnRegistry._resetForTesting());

/** A Codex adapter only knows it is resident (`reportsTurnStarts`) once it has spawned, which is after it is attached. */
describe('InstanceCommunicationManager attaches an adapter before it has spawned', () => {
  it('reads whether the adapter reports turn starts when the call is checked, not when it was attached', () => {
    let resident = false;
    const adapter = Object.assign(new EventEmitter(), {
      getAdapterCapabilities: () => ({ reportsTurnStarts: resident }),
      getName: () => 'codex',
    }) as unknown as CliAdapter;
    const manager = new InstanceCommunicationManager({
      getInstance: () => undefined, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false,
      queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
      ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined, emitProviderRuntimeEvent: () => undefined,
      compactContext: async () => undefined,
    } as never);
    manager.setupAdapterEvents('codex-1', adapter);

    const registry = getInputTurnRegistry();
    registry.noteInput('codex-1', { messageId: 'm1', personTypedAt: 5_000 });
    registry.noteTurnStarted('codex-1', 'harness-send');
    expect(registry.checkPersonTurn('codex-1')).toEqual({ ok: false, reason: 'provider-cannot-report' }); // not spawned yet

    resident = true; // spawn() finished in app-server mode
    expect(registry.checkPersonTurn('codex-1')).toEqual({ ok: true, messageId: 'm1', typedAt: 5_000 });
  });
});
