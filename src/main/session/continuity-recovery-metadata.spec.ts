import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContinuityRecoveryMetadata } from './session-recovery-candidate-service';
import type { SessionState } from './session-continuity.types';
import {
  enumerateContinuityRecoveryMetadata,
  readContinuityPayloadReadOnly,
} from './continuity-recovery-metadata';

const tempDirs: string[] = [];

function envelope(data: unknown): string {
  return JSON.stringify({ encrypted: false, data: JSON.stringify(data) });
}

function metadata(index: number): ContinuityRecoveryMetadata {
  return {
    recoveryKey: `history:claude:thread-${index}`,
    sourceInstanceId: `instance-${index}`,
    historyThreadId: `thread-${index}`,
    provider: 'claude',
    lastActivityAt: 10_000 - index,
    modifiedAt: 20_000,
    messageCount: 2,
    hasUserPrompt: true,
    hasAssistantOutput: true,
    nativeResumeAvailable: true,
  };
}

function stateFileGeneration(stat: fs.Stats): Record<string, number> {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function state(instanceId: string, lastActivityAt: number): SessionState {
  return {
    instanceId, displayName: 'Fixture', agentId: 'agent', modelId: 'model',
    provider: 'claude', workingDirectory: '/workspace', lastWriteTimestamp: lastActivityAt,
    conversationHistory: [{ id: 'u', role: 'user', content: 'fixture', timestamp: lastActivityAt }],
    contextUsage: { used: 0, total: 1 }, pendingTasks: [], environmentVariables: {},
    activeFiles: [], skillsLoaded: [], hooksActive: [],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

describe('continuity recovery metadata index', () => {
  it('lists thousands of sidecars without reading or normalizing full state payloads', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-metadata-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);
    const count = 1_200;
    await Promise.all(Array.from({ length: count }, async (_, index) => {
      const stateFile = path.join(stateDir, `instance-${index}.json`);
      await fs.promises.writeFile(stateFile, '{full-state-not-readable');
      const stat = await fs.promises.stat(stateFile);
      await fs.promises.writeFile(path.join(metadataDir, `instance-${index}.json`), envelope({
        ...metadata(index), stateFileGeneration: stateFileGeneration(stat),
      }));
    }));
    const readFile = vi.spyOn(fs.promises, 'readFile');
    const normalizeState = vi.fn((value) => value);

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir,
      metadataDir,
      modifiedSince: 0,
      preferredInstanceIds: [],
      normalizeState,
    });

    expect(result.records).toHaveLength(count);
    expect(normalizeState).not.toHaveBeenCalled();
    expect(readFile.mock.calls.some(([file]) => String(file).startsWith(stateDir))).toBe(false);
  });

  it('falls back to the newer state when an older valid sidecar survived an interrupted write', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-stale-sidecar-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);
    const stateFile = path.join(stateDir, 'interrupted.json');
    await fs.promises.writeFile(stateFile, envelope(state('interrupted', 100)));
    const oldStat = await fs.promises.stat(stateFile);
    await fs.promises.writeFile(path.join(metadataDir, 'interrupted.json'), envelope({
      ...metadata(0), sourceInstanceId: 'interrupted', lastActivityAt: 100,
      stateFileGeneration: stateFileGeneration(oldStat),
    }));
    await fs.promises.writeFile(stateFile, envelope(state('interrupted', 900)));
    const newerTime = new Date(oldStat.mtimeMs + 10_000);
    await fs.promises.utimes(stateFile, newerTime, newerTime);
    const normalizeState = vi.fn((value) => value);

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir, metadataDir, modifiedSince: 0, preferredInstanceIds: [], normalizeState,
    });

    expect(result.records).toEqual([expect.objectContaining({
      sourceInstanceId: 'interrupted', lastActivityAt: 900,
    })]);
    expect(normalizeState).toHaveBeenCalledOnce();
  });

  it('rejects a sidecar when the state generation changes during the sidecar read', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-interleaved-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);
    const stateFile = path.join(stateDir, 'interleaved.json');
    const metadataFile = path.join(metadataDir, 'interleaved.json');
    await fs.promises.writeFile(stateFile, envelope(state('interleaved', 100)));
    const oldStat = await fs.promises.stat(stateFile);
    await fs.promises.writeFile(metadataFile, envelope({
      ...metadata(0), sourceInstanceId: 'interleaved', lastActivityAt: 100,
      stateFileGeneration: stateFileGeneration(oldStat),
    }));
    let interleaved = false;

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir, metadataDir, modifiedSince: 0, preferredInstanceIds: [],
      normalizeState: (value) => value,
      readMetadataPayload: async (filePath) => {
        if (!interleaved && filePath === metadataFile) {
          interleaved = true;
          await fs.promises.writeFile(stateFile, envelope(state('interleaved', 900)));
          const newerTime = new Date(oldStat.mtimeMs + 10_000);
          await fs.promises.utimes(stateFile, newerTime, newerTime);
        }
        return readContinuityPayloadReadOnly<ContinuityRecoveryMetadata>(filePath);
      },
    });

    expect(result.records).toEqual([expect.objectContaining({
      sourceInstanceId: 'interleaved', lastActivityAt: 900,
    })]);
  });

  it('falls back to a state whose sidecar is absent after persistence', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-absent-sidecar-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);
    await fs.promises.writeFile(path.join(stateDir, 'state-only.json'), envelope(state('state-only', 700)));

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir, metadataDir, modifiedSince: 0, preferredInstanceIds: [],
      normalizeState: (value) => value,
    });

    expect(result.records).toEqual([expect.objectContaining({
      sourceInstanceId: 'state-only', lastActivityAt: 700,
    })]);
  });

  it('isolates structurally corrupt legacy state projection from valid siblings', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-corrupt-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);
    await fs.promises.writeFile(path.join(stateDir, 'bad.json'), envelope({
      instanceId: 'bad', conversationHistory: [null], lastWriteTimestamp: 1,
    }));
    await fs.promises.writeFile(path.join(stateDir, 'good.json'), envelope({
      instanceId: 'good', displayName: 'Good', agentId: 'agent', modelId: 'model',
      provider: 'claude', workingDirectory: '/workspace', lastWriteTimestamp: 2,
      conversationHistory: [{ id: 'u', role: 'user', content: 'fixture', timestamp: 2 }],
      contextUsage: { used: 0, total: 1 }, pendingTasks: [], environmentVariables: {},
      activeFiles: [], skillsLoaded: [], hooksActive: [],
    }));
    const normalizeState = vi.fn((value: SessionState) => {
      if (value.conversationHistory.some((entry: unknown) => entry === null)) throw new Error('bad entry');
      return value;
    });

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir, metadataDir, modifiedSince: 0, preferredInstanceIds: [], normalizeState,
    });

    expect(result.records.map((record) => record.sourceInstanceId)).toEqual(['good']);
    expect(result.skippedCorrupt).toBe(1);
  });

  it('isolates semantically invalid sidecars while retaining a valid sibling', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'recovery-semantic-sidecars-'));
    tempDirs.push(root);
    const stateDir = path.join(root, 'states');
    const metadataDir = path.join(root, 'metadata');
    await fs.promises.mkdir(stateDir);
    await fs.promises.mkdir(metadataDir);

    const mutations: readonly Record<string, unknown>[] = [
      { recoveryKey: '' },
      { sourceInstanceId: '' },
      { historyThreadId: 42 },
      { sessionId: '' },
      { modelId: false },
      { provider: 'unsupported' },
      { lastActivityAt: -1 },
      { lastActivityAt: 1.5 },
      { modifiedAt: -1 },
      { modifiedAt: 1.5 },
      { messageCount: -1 },
      { messageCount: 1.5 },
      { hasUserPrompt: 'yes' },
      { nativeResumeAvailable: 'yes' },
    ];
    const fixtures = [
      { instanceId: 'valid-sibling', mutation: null },
      ...mutations.map((mutation, index) => ({
        instanceId: `invalid-${index}`,
        mutation,
      })),
    ];
    await Promise.all(fixtures.map(async ({ instanceId, mutation }, index) => {
      const stateFile = path.join(stateDir, `${instanceId}.json`);
      await fs.promises.writeFile(
        stateFile,
        mutation === null
          ? envelope(state(instanceId, 1_000))
          : envelope({ instanceId, conversationHistory: 'invalid-state' }),
      );
      const stat = await fs.promises.stat(stateFile);
      await fs.promises.writeFile(path.join(metadataDir, `${instanceId}.json`), envelope({
        ...metadata(index),
        recoveryKey: `history:claude:thread-${index}`,
        sourceInstanceId: instanceId,
        stateFileGeneration: stateFileGeneration(stat),
        ...(mutation ?? {}),
      }));
    }));

    const result = await enumerateContinuityRecoveryMetadata({
      stateDir,
      metadataDir,
      modifiedSince: 0,
      preferredInstanceIds: [],
      normalizeState: (value) => value,
    });

    expect(result.records.map((record) => record.sourceInstanceId)).toEqual(['valid-sibling']);
    expect(result.skippedCorrupt).toBeGreaterThanOrEqual(mutations.length);
  });
});
