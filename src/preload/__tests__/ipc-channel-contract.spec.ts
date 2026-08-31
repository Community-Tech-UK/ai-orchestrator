/**
 * IPC Channel Contract Test
 *
 * Ensures the preload IPC_CHANNELS block (generated from the contracts package)
 * stays in exact sync with the contract definitions. The legacy shim is covered
 * separately by the contracts identity test.
 */
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS } from '../generated/channels';
import { createSessionDomain } from '../domains/session.preload';

const ROOT = path.resolve(__dirname, '../../..');

const CONTRACTS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');
const GENERATED_PRELOAD_CHANNELS_PATH = path.join(
  ROOT,
  'src/preload/generated/channels.ts',
);

function getContractsChannelFiles(indexPath: string): string[] {
  const content = fs.readFileSync(indexPath, 'utf-8');
  const files: string[] = [];
  const importPattern = /^import\s+\{\s*[A-Z0-9_]+\s*\}\s+from\s+['"](\.\/[^'"]+\.channels)['"];?$/;

  for (const line of content.split('\n')) {
    const match = line.match(importPattern);
    if (match) {
      files.push(path.resolve(path.dirname(indexPath), `${match[1]}.ts`));
    }
  }

  return files;
}

function extractContractsChannels(indexPath: string): Map<string, string> {
  const channels = new Map<string, string>();
  const channelPattern = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;

  for (const filePath of getContractsChannelFiles(indexPath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let capturing = false;
    let braceDepth = 0;

    for (const line of lines) {
      if (!capturing && line.includes('export const') && line.includes('= {')) {
        capturing = true;
        braceDepth = 1;
        continue;
      }

      if (!capturing) {
        continue;
      }

      for (const ch of line) {
        if (ch === '{') braceDepth += 1;
        if (ch === '}') braceDepth -= 1;
      }

      if (braceDepth <= 0) {
        break;
      }

      const match = line.match(channelPattern);
      if (match) {
        channels.set(match[1], match[2]);
      }
    }
  }

  return channels;
}

/**
 * Extract channel name→value pairs from a generated TypeScript file containing
 * the preload IPC_CHANNELS object. Uses the same IPC object parsing approach as
 * the verify script.
 */
function extractChannels(filePath: string): Map<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const channels = new Map<string, string>();
  const objectStart = content.indexOf('IPC_CHANNELS');
  const openBrace = content.indexOf('{', objectStart);
  const closeBrace = content.lastIndexOf('} as const');
  const body = openBrace >= 0 && closeBrace > openBrace
    ? content.slice(openBrace + 1, closeBrace)
    : '';

  const channelPattern = /([A-Z0-9_]+):\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = channelPattern.exec(body)) !== null) {
    channels.set(match[1], match[2]);
  }

  return channels;
}

describe('IPC Channel Contract', () => {
  const sharedChannels = extractContractsChannels(CONTRACTS_INDEX_PATH);
  const preloadChannels = extractChannels(GENERATED_PRELOAD_CHANNELS_PATH);

  it('should have channels defined in both files', () => {
    expect(sharedChannels.size).toBeGreaterThan(0);
    expect(preloadChannels.size).toBeGreaterThan(0);
  });

  it('should have the same number of channels in shared and preload', () => {
    expect(preloadChannels.size).toBe(sharedChannels.size);
  });

  it('should have every shared channel present in preload', () => {
    const missingInPreload: string[] = [];
    for (const [name] of sharedChannels) {
      if (!preloadChannels.has(name)) {
        missingInPreload.push(name);
      }
    }
    expect(missingInPreload).toEqual([]);
  });

  it('should have every preload channel present in shared', () => {
    const missingInShared: string[] = [];
    for (const [name] of preloadChannels) {
      if (!sharedChannels.has(name)) {
        missingInShared.push(name);
      }
    }
    expect(missingInShared).toEqual([]);
  });

  it('should have matching values for all channels', () => {
    const mismatches: string[] = [];
    for (const [name, sharedValue] of sharedChannels) {
      const preloadValue = preloadChannels.get(name);
      if (preloadValue !== undefined && preloadValue !== sharedValue) {
        mismatches.push(
          `${name}: shared='${sharedValue}' vs preload='${preloadValue}'`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('should have no duplicate channel values', () => {
    const valueToNames = new Map<string, string[]>();
    for (const [name, value] of sharedChannels) {
      const existing = valueToNames.get(value) || [];
      existing.push(name);
      valueToNames.set(value, existing);
    }

    const duplicates: string[] = [];
    for (const [value, names] of valueToNames) {
      if (names.length > 1) {
        duplicates.push(`'${value}' used by: ${names.join(', ')}`);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('exposes exact typed autosave recovery preload methods on canonical channels', async () => {
    const candidate = {
      recoveryKey: 'history:claude:thread-1',
      sourceInstanceId: 'inst-source',
      historyThreadId: 'thread-1',
      provider: 'claude',
      modelId: 'sonnet',
      displayName: 'Recovered session',
      workingDirectory: '/work/project',
      lastActivityAt: 1_735_000_000_000,
      historyCoveredThrough: 1_734_999_990_000,
      recoveredMessageCount: 3,
      reason: 'newer-than-history',
      nativeResumeAvailable: true,
    };
    const result = {
      instanceId: 'inst-recovered',
      recoveredMessageCount: 3,
      usedNativeResume: true,
    };
    const ipcRenderer = {
      invoke: vi.fn()
        .mockResolvedValueOnce({ success: true, data: [candidate] })
        .mockResolvedValueOnce({ success: true, data: result }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    type SessionRecoveryPreloadShape = Pick<
      ReturnType<typeof createSessionDomain>,
      'listRecoveryCandidates' | 'recoverSession'
    >;
    const typedDomain: SessionRecoveryPreloadShape = createSessionDomain(ipcRenderer, IPC_CHANNELS);
    const domain = createSessionDomain(ipcRenderer, IPC_CHANNELS) as Record<
      string,
      ((payload?: unknown) => Promise<unknown>) | unknown
    >;

    expect(typeof domain['listRecoveryCandidates']).toBe('function');
    expect(typeof domain['recoverSession']).toBe('function');
    expect(domain['sessionRecoveryList']).toBeUndefined();
    expect(domain['sessionRecoveryRestore']).toBeUndefined();
    if (
      typeof domain['listRecoveryCandidates'] !== 'function'
      || typeof domain['recoverSession'] !== 'function'
    ) {
      return;
    }

    await expect(typedDomain.listRecoveryCandidates()).resolves.toEqual([candidate]);
    await expect(typedDomain.recoverSession({ recoveryKey: 'history:claude:thread-1' })).resolves.toEqual(result);

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      1,
      (IPC_CHANNELS as unknown as Record<string, string>)['SESSION_RECOVERY_LIST'],
    );
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      (IPC_CHANNELS as unknown as Record<string, string>)['SESSION_RECOVERY_RESTORE'],
      { recoveryKey: 'history:claude:thread-1' },
    );
  });

  it('returns preserved shutdown-live overflow recovery candidates from the preload API unchanged', async () => {
    const candidates = [
      ...Array.from({ length: 50 }, (_, index) => {
        const suffix = String(index).padStart(3, '0');
        return {
          recoveryKey: `history:claude:thread-${suffix}`,
          sourceInstanceId: `source-${suffix}`,
          historyThreadId: `thread-${suffix}`,
          provider: 'claude',
          modelId: 'sonnet',
          displayName: `Recovered session ${suffix}`,
          workingDirectory: '/work/project',
          lastActivityAt: 1_735_000_000_000 - index,
          historyCoveredThrough: 1_734_999_990_000 - index,
          recoveredMessageCount: 3,
          reason: 'newer-than-history',
          nativeResumeAvailable: true,
        };
      }),
      {
        recoveryKey: 'history:claude:thread-shutdown-live',
        sourceInstanceId: 'shutdown-live',
        historyThreadId: 'thread-shutdown-live',
        provider: 'claude',
        modelId: 'sonnet',
        displayName: 'Preserved shutdown-live session',
        workingDirectory: '/work/project',
        lastActivityAt: 1_734_999_900_000,
        historyCoveredThrough: 1_734_999_890_000,
        recoveredMessageCount: 3,
        reason: 'newer-than-history',
        nativeResumeAvailable: true,
      },
    ];
    const ipcRenderer = {
      invoke: vi.fn().mockResolvedValue({ success: true, data: candidates }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createSessionDomain(ipcRenderer, IPC_CHANNELS);

    await expect(domain.listRecoveryCandidates()).resolves.toEqual(candidates);
    expect(candidates).toHaveLength(51);
    expect(candidates.at(-1)?.sourceInstanceId).toBe('shutdown-live');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(IPC_CHANNELS.SESSION_RECOVERY_LIST);
  });

  it('throws typed safe errors from failed recovery preload responses', async () => {
    const ipcRenderer = {
      invoke: vi.fn()
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'SESSION_RECOVERY_LIST_FAILED',
            message: 'Session recovery candidates could not be loaded',
            timestamp: 123,
          },
        })
        .mockResolvedValueOnce({
          success: false,
          error: {
            code: 'ORCHESTRATOR_PAUSED',
            message: 'Session recovery refused while orchestrator is paused',
            timestamp: 124,
          },
        }),
      on: vi.fn(),
      removeListener: vi.fn(),
    } as unknown as IpcRenderer;
    const domain = createSessionDomain(ipcRenderer, IPC_CHANNELS);

    await expect(domain.listRecoveryCandidates()).rejects.toMatchObject({
      code: 'SESSION_RECOVERY_LIST_FAILED',
      message: 'Session recovery candidates could not be loaded',
    });
    await expect(domain.recoverSession({ recoveryKey: 'history:claude:thread-1' }))
      .rejects.toMatchObject({
        code: 'ORCHESTRATOR_PAUSED',
        message: 'Session recovery refused while orchestrator is paused',
      });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, IPC_CHANNELS.SESSION_RECOVERY_LIST);
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.SESSION_RECOVERY_RESTORE,
      { recoveryKey: 'history:claude:thread-1' },
    );
  });
});
