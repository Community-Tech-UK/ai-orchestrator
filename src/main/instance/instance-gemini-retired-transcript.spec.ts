/**
 * Google's retirement message from a local Gemini run, through the real adapter and the real instance communication:
 * the transcript gets exactly one error line, in plain words, with Google's text kept for Details.
 */

import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { Instance } from '../../shared/types/instance.types';
import { GeminiCliAdapter } from '../cli/adapters/gemini-cli-adapter';
import { InstanceCommunicationManager } from './instance-communication';
import { ProviderRuntimeEventBus } from '../providers/provider-runtime-event-bus';
import { _resetSessionAdmissionServiceForTesting } from '../session/session-admission-service';
import { SessionAdmissionStore } from '../session/session-admission-store';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn(), deleteInstance: vi.fn() }) }));
let db: Database.Database;
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => db as unknown as SqliteDriver }) }));

const GOOGLE = 'An unexpected critical error occurred: This client is no longer supported for Gemini Code Assist for individuals. '
  + 'To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google';

beforeEach(() => { db = new Database(':memory:'); SessionAdmissionStore._resetForTesting(); _resetSessionAdmissionServiceForTesting(); });
afterEach(() => { _resetSessionAdmissionServiceForTesting(); SessionAdmissionStore._resetForTesting(); db.close(); vi.restoreAllMocks(); });

describe('a local Gemini session after Google retired the sign-in', () => {
  it('shows one plain error line and nothing raw', async () => {
    const adapter = new GeminiCliAdapter({ timeout: 1000 });
    Object.assign(adapter, { isSpawned: true });
    const instance = {
      id: 'gemini-retired', parentId: null, launchMode: 'orchestrated', provider: 'gemini', sessionId: adapter.getSessionId(),
      adapterGeneration: 0, restartEpoch: 0, status: 'idle', requestCount: 1, lastActivity: 0, outputBuffer: [],
      executionLocation: { type: 'local' },
    } as unknown as Instance;
    (adapter as unknown as { spawnProcess: (args: string[]) => ChildProcess }).spawnProcess = () => {
      const child = new EventEmitter() as unknown as ChildProcess;
      const stderr = new PassThrough();
      child.stdout = new PassThrough(); child.stderr = stderr; child.stdin = new PassThrough();
      Object.defineProperties(child, { pid: { value: 424243 }, killed: { value: false }, exitCode: { value: null, configurable: true } });
      queueMicrotask(() => {
        stderr.emit('data', Buffer.from(GOOGLE));
        Object.defineProperty(child, 'exitCode', { value: 1 });
        child.emit('close', 1, null);
      });
      return child;
    };
    const events = new EventEmitter();
    const bus = new ProviderRuntimeEventBus((envelope) => events.emit('provider:normalized-event', envelope));
    const communicationAdapter = adapter as unknown as CliAdapter;
    const communication = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => communicationAdapter, setAdapter: () => undefined, deleteAdapter: () => false,
      queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
      ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined,
      emitProviderRuntimeEvent: (instanceId, event, opts) => bus.enqueue({ instanceId, event, provider: 'gemini', timestamp: Date.now(), sessionId: instance.sessionId, ...opts }),
    });
    communication.setupAdapterEvents(instance.id, communicationAdapter);

    await communication.sendInput(instance.id, 'Review the plan').catch(() => undefined);
    await vi.waitFor(() => expect(instance.outputBuffer.some((message) => message.type === 'error')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.removeInstance(instance.id);
    await adapter.terminate(false);

    const errorLines = instance.outputBuffer.filter((message) => message.type === 'error');
    expect(errorLines.map((message) => message.content)).toEqual([
      "Google has retired Gemini for personal Google accounts, so it can't run here any more. What to do: Start a new session with Antigravity, Google's replacement.",
    ]);
    expect(errorLines[0]?.metadata?.['errorPresentation']).toMatchObject({ category: 'gemini-retired', rawDetail: GOOGLE });
    expect(instance.outputBuffer.some((message) => message.content.includes('no longer supported') && message.type !== 'error')).toBe(false);
  });
});
