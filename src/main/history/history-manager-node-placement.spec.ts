import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceCreatePayloadSchema } from '@contracts/schemas/instance';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { ConversationData } from '../../shared/types/history.types';
import type { Instance } from '../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';

vi.mock('../logging/logger', () => ({ getLogger: () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}) }));

describe('HistoryManager durable node placement', () => {
  let userData = '';
  const startups: Promise<void>[] = [];
  beforeEach(() => {
    vi.resetModules();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'history-placement-placeholder-'));
    vi.doMock('electron', () => ({ app: { getPath: (name: string) => {
      if (name !== 'userData') throw new Error('Unexpected application path');
      return userData;
    } } }));
  });
  afterEach(async () => {
    await Promise.allSettled(startups.splice(0));
    vi.doUnmock('electron');
    vi.resetModules();
    fs.rmSync(userData, { recursive: true, force: true });
  });
  async function manager() {
    const { HistoryManager } = await import('./history-manager');
    const value = new HistoryManager();
    startups.push(value.startupTasks);
    await value.startupTasks;
    return value;
  }
  function record(remote: boolean, major: 1 | 2 = 2): Instance {
    const payload = InstanceCreatePayloadSchema.parse({ provider: 'opencode',
      workingDirectory: '/tmp/placeholder-project', nodePlacement: { requiresOpenCodeMajor: major },
      ...(remote ? { forceNodeId: '00000000-0000-4000-8000-000000000000' } : {}),
    });
    const instance = buildInstanceRecord({ workingDirectory: payload.workingDirectory, provider: payload.provider,
      nodePlacement: payload.nodePlacement, forceNodeId: payload.forceNodeId }, getDefaultAgent(), {
      defaultYoloMode: false, getParent: () => undefined, now: () => 100,
    });
    instance.executionLocation = remote ? { type: 'remote', nodeId: '00000000-0000-4000-8000-000000000000' } : { type: 'local' };
    instance.status = 'idle';
    instance.outputBuffer.push({ id: 'placeholder-user', type: 'user', timestamp: 101, content: 'Placeholder request' });
    expect(instance.additionalDirectories).toBeUndefined();
    expect(instance.nodePlacement).toEqual({ requiresOpenCodeMajor: major });
    return instance;
  }
  function readGzip(entryId: string): ConversationData {
    return JSON.parse(gunzipSync(fs.readFileSync(path.join(userData, 'conversation-history', `${entryId}.json.gz`))).toString());
  }

  it.each([false, true])('retains a public major-only requirement through actual archive and gzip reload (remote=%s)', async remote => {
    const history = await manager();
    const instance = record(remote);
    await expect(history.archiveInstance(instance)).resolves.toBe('archived');
    const archived = history.getEntries()[0];
    expect(archived.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
    expect(archived.nodePlacement).not.toBe(instance.nodePlacement);
    instance.nodePlacement!.requiresOpenCodeMajor = 1;
    expect(archived.nodePlacement?.requiresOpenCodeMajor).toBe(2);
    expect(readGzip(archived.id).entry.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
    const restarted = await manager();
    const restored = await restarted.loadConversation(archived.id);
    expect(restored?.entry.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
    expect(restored?.entry.additionalDirectories).toBeUndefined();
    expect(restored?.messages).toEqual(instance.outputBuffer);
    expect(restored?.entry.executionLocation).toEqual(instance.executionLocation);
  });

  it('clones the original remote requirement when a local fallback rearchives the same thread', async () => {
    const history = await manager();
    const original = record(true);
    await history.archiveInstance(original);
    const previous = history.getEntries()[0];
    const fallback = record(false, 1);
    fallback.historyThreadId = original.historyThreadId;
    fallback.outputBuffer.push({ id: 'placeholder-new-reply', type: 'assistant', timestamp: 200, content: 'Placeholder reply' });
    await expect(history.archiveInstance(fallback)).resolves.toBe('archived');
    const current = history.getEntries()[0];
    expect(current.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
    expect(current.nodePlacement).not.toBe(previous.nodePlacement);
    expect(current.nodePlacement).not.toBe(fallback.nodePlacement);
    previous.nodePlacement!.requiresOpenCodeMajor = 1;
    expect(current.nodePlacement?.requiresOpenCodeMajor).toBe(2);
    const restored = await (await manager()).loadConversation(current.id);
    expect(restored?.entry.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
    expect(restored?.entry.executionLocation).toEqual({ type: 'remote', nodeId: '00000000-0000-4000-8000-000000000000' });
    expect(restored?.entry.workingDirectory).toBe(original.workingDirectory);
  });

  it('refuses malformed placement before writing an archive that would silently lose its constraint', async () => {
    const history = await manager();
    const instance = record(false);
    Reflect.set(instance, 'nodePlacement', { requiresOpenCodeMajor: 3 });
    await expect(history.archiveInstance(instance)).rejects.toThrow('Invalid recovery node placement');
    expect(history.getEntries()).toEqual([]);
    expect(fs.readdirSync(history.getStoragePath()).filter(file => file.endsWith('.json.gz'))).toEqual([]);
  });
});
