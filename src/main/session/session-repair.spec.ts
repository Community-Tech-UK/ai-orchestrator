import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanupContinuityOrphanedTmpFiles,
  cleanupOrphanedTmpFiles,
  repairFile,
  validateTranscript,
} from './session-repair';
import type { ConversationEntry } from './session-continuity';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { FileHandle } from 'fs/promises';
import { readContinuityPayloadHandleReadOnly } from './continuity-recovery-metadata';

describe('validateTranscript', () => {
  function entry(overrides: Partial<ConversationEntry> & { role: ConversationEntry['role'] }): ConversationEntry {
    return {
      id: `test-${Math.random().toString(36).slice(2)}`,
      content: 'test content',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  it('returns ok for a valid transcript', () => {
    const history = [
      entry({ role: 'user', content: 'hello' }),
      entry({ role: 'assistant', content: 'hi' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('ok');
    expect(result.repairs).toHaveLength(0);
    expect(result.entries).toHaveLength(2);
  });

  it('inserts synthetic tool_result for orphaned tool_use', () => {
    const history = [
      entry({ role: 'user', content: 'do something' }),
      entry({
        role: 'assistant',
        content: 'calling tool',
        toolUse: { toolName: 'bash', input: { cmd: 'ls' } },
      }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(3);
    expect(result.entries[2].role).toBe('tool');
    expect(result.entries[2].content).toContain('interrupted');
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('orphaned')])
    );
  });

  it('does not insert synthetic result when tool_result follows', () => {
    const history = [
      entry({
        role: 'assistant',
        content: 'calling tool',
        toolUse: { toolName: 'bash', input: { cmd: 'ls' } },
      }),
      entry({ role: 'tool', content: 'file1.ts\nfile2.ts' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('ok');
    expect(result.entries).toHaveLength(2);
  });

  it('removes empty entries with no tool_use', () => {
    const history = [
      entry({ role: 'user', content: 'hello' }),
      entry({ role: 'assistant', content: '' }),
      entry({ role: 'assistant', content: 'real response' }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(2);
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('empty')])
    );
  });

  it('keeps entries with tool_use even if content is empty', () => {
    const history = [
      entry({
        role: 'assistant',
        content: '',
        toolUse: { toolName: 'read', input: { path: '/foo' } },
      }),
      entry({ role: 'tool', content: 'file contents' }),
    ];
    const result = validateTranscript(history);
    expect(result.entries).toHaveLength(2);
  });

  it('warns on non-monotonic timestamps without removing', () => {
    const now = Date.now();
    const history = [
      entry({ role: 'user', content: 'a', timestamp: now }),
      entry({ role: 'assistant', content: 'b', timestamp: now - 5000 }),
    ];
    const result = validateTranscript(history);
    expect(result.status).toBe('repaired');
    expect(result.entries).toHaveLength(2);
    expect(result.repairs).toEqual(
      expect.arrayContaining([expect.stringContaining('Non-monotonic')])
    );
  });

  it('does not mutate the input array', () => {
    const history = [
      entry({
        role: 'assistant',
        content: 'tool call',
        toolUse: { toolName: 'bash', input: {} },
      }),
    ];
    const originalLength = history.length;
    validateTranscript(history);
    expect(history).toHaveLength(originalLength);
  });

  it('handles empty history', () => {
    const result = validateTranscript([]);
    expect(result.status).toBe('ok');
    expect(result.entries).toHaveLength(0);
  });
});

describe('cleanupOrphanedTmpFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repair-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('deletes .tmp when corresponding .json exists', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'state.json'), '{"valid": true}');
    await fs.promises.writeFile(path.join(tmpDir, 'state.json.tmp'), '{"partial": true}');

    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.deleted).toHaveLength(1);
    expect(result.recovered).toHaveLength(0);

    const files = await fs.promises.readdir(tmpDir);
    expect(files).toEqual(['state.json']);
  });

  it('promotes .tmp to .json when .json is missing', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'orphan.json.tmp'), '{"recovered": true}');

    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.recovered).toHaveLength(1);
    expect(result.deleted).toHaveLength(0);

    const files = await fs.promises.readdir(tmpDir);
    expect(files).toEqual(['orphan.json']);
  });

  it('deletes a unique staging file without overwriting an existing final file', async () => {
    const finalPath = path.join(tmpDir, 'state.json');
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    await fs.promises.writeFile(finalPath, '{"version":"committed"}');
    await fs.promises.writeFile(stagingPath, '{"version":"stale"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true);

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"committed"}');
    await expect(fs.promises.access(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.recovered).toEqual([]);
    expect(result.deleted).toEqual([stagingPath]);
  });

  it('promotes the newest valid unique staging file and deletes every leftover', async () => {
    const oldest = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const newestValid = path.join(tmpDir, 'state.json.101-2000-2.tmp');
    const newestInvalid = path.join(tmpDir, 'state.json.101-2000-3.tmp');
    await fs.promises.writeFile(oldest, '{"complete":true,"version":"oldest"}');
    await fs.promises.writeFile(newestValid, '{"complete":true,"version":"newest-valid"}');
    await fs.promises.writeFile(newestInvalid, '{"complete":false,"version":"newest-invalid"}');
    await fs.promises.utimes(oldest, new Date(1_000), new Date(1_000));
    await fs.promises.utimes(newestValid, new Date(2_000), new Date(2_000));
    await fs.promises.utimes(newestInvalid, new Date(3_000), new Date(3_000));

    const result = await cleanupOrphanedTmpFiles(tmpDir, async (candidatePath) => {
      const candidate = JSON.parse(await fs.promises.readFile(candidatePath, 'utf8')) as {
        complete?: boolean;
      };
      return candidate.complete === true;
    });

    await expect(fs.promises.readFile(path.join(tmpDir, 'state.json'), 'utf8'))
      .resolves.toBe('{"complete":true,"version":"newest-valid"}');
    expect((await fs.promises.readdir(tmpDir)).sort()).toEqual(['state.json']);
    expect(result.recovered).toEqual([path.join(tmpDir, 'state.json')]);
    expect(new Set(result.deleted)).toEqual(new Set([oldest, newestInvalid]));
  });

  it('uses the numeric writer sequence to break equal-mtime staging ties', async () => {
    const sequenceNine = path.join(tmpDir, 'state.json.101-2000-9.tmp');
    const sequenceTen = path.join(tmpDir, 'state.json.101-2000-10.tmp');
    await fs.promises.writeFile(sequenceNine, '{"version":9}');
    await fs.promises.writeFile(sequenceTen, '{"version":10}');
    const sameMtime = new Date(2_000);
    await fs.promises.utimes(sequenceNine, sameMtime, sameMtime);
    await fs.promises.utimes(sequenceTen, sameMtime, sameMtime);

    await cleanupOrphanedTmpFiles(tmpDir, async () => true);

    await expect(fs.promises.readFile(path.join(tmpDir, 'state.json'), 'utf8'))
      .resolves.toBe('{"version":10}');
  });

  it('promotes the validated inode when the original staging path is replaced', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const replacementPath = path.join(tmpDir, 'replacement.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');
    await fs.promises.writeFile(replacementPath, '{"version":"replacement"}');

    await cleanupOrphanedTmpFiles(tmpDir, async (candidatePath) => {
      const candidate = await fs.promises.readFile(candidatePath, 'utf8');
      await fs.promises.unlink(stagingPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.promises.symlink(replacementPath, stagingPath);
      return candidate === '{"version":"validated"}';
    });

    const finalPath = path.join(tmpDir, 'state.json');
    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"validated"}');
    expect((await fs.promises.lstat(finalPath)).isSymbolicLink()).toBe(false);
  });

  it('rejects a final file linked from a swapped private claim at promotion without unlink authority', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const displacedValidatedPath = path.join(tmpDir, 'validated-displaced.json');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');
    const linkSync = fs.linkSync.bind(fs);

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, finalPath): fs.Stats => {
        fs.renameSync(claimedPath, displacedValidatedPath);
        fs.writeFileSync(claimedPath, '{"version":"unvalidated"}');
        linkSync(claimedPath, finalPath);
        return fs.lstatSync(finalPath);
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"unvalidated"}');
    await expect(fs.promises.readFile(displacedValidatedPath, 'utf8'))
      .resolves.toBe('{"version":"validated"}');
    expect(result.recovered).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.deleted).not.toContain(stagingPath);
  });

  it('preserves a legitimate final that replaces the promotion link before identity validation', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        fs.linkSync(claimedPath, destinationPath);
        const linkedGeneration = fs.lstatSync(destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
        return linkedGeneration;
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('preserves a legitimate final when a link hook returns replacement stats before mismatch validation', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        fs.linkSync(claimedPath, destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
        return fs.lstatSync(destinationPath);
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('preserves a legitimate final when an untyped void link hook replaces it before mismatch validation', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath: string, destinationPath: string): void => {
        fs.linkSync(claimedPath, destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
      },
    } as unknown as NonNullable<Parameters<typeof cleanupOrphanedTmpFiles>[2]>);

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('preserves a legitimate final when an exception follows replacement of the promotion link', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        fs.linkSync(claimedPath, destinationPath);
        const linkedGeneration = fs.lstatSync(destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
        return linkedGeneration;
      },
      afterLink: (): void => {
        throw new Error('fixture post-link failure');
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('preserves a legitimate final when a link hook returns replacement stats before cleanup catch', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        fs.linkSync(claimedPath, destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
        return fs.lstatSync(destinationPath);
      },
      afterLink: (): void => {
        throw new Error('fixture post-link failure');
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('preserves a legitimate final when an untyped void link hook replacement is followed by cleanup catch', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath: string, destinationPath: string): void => {
        fs.linkSync(claimedPath, destinationPath);
        fs.unlinkSync(destinationPath);
        fs.writeFileSync(destinationPath, '{"version":"legitimate-final"}');
      },
      afterLink: (): void => {
        throw new Error('fixture post-link failure');
      },
    } as unknown as NonNullable<Parameters<typeof cleanupOrphanedTmpFiles>[2]>);

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"legitimate-final"}');
    expect(result.recovered).toEqual([]);
  });

  it('rejects same-size in-place mutation of the validated descriptor at promotion', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    const validated = '{"version":"validated-A"}';
    const mutated = '{"version":"mutated---B"}';
    expect(mutated).toHaveLength(validated.length);
    await fs.promises.writeFile(stagingPath, validated);
    const originalTimes = await fs.promises.stat(stagingPath);
    const linkSync = fs.linkSync.bind(fs);

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        fs.writeFileSync(claimedPath, mutated);
        fs.utimesSync(claimedPath, originalTimes.atime, originalTimes.mtime);
        linkSync(claimedPath, destinationPath);
        return fs.lstatSync(destinationPath);
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8')).resolves.toBe(mutated);
    expect(result.recovered).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it('rejects an external hard-link race during promotion', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const finalPath = path.join(tmpDir, 'state.json');
    const externalPath = path.join(tmpDir, 'external-link.json');
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');
    const linkSync = fs.linkSync.bind(fs);

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        linkSync(claimedPath, externalPath);
        linkSync(claimedPath, destinationPath);
        return fs.lstatSync(destinationPath);
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"validated"}');
    await expect(fs.promises.readFile(externalPath, 'utf8'))
      .resolves.toBe('{"version":"validated"}');
    expect(result.recovered).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it('does not delete a replacement installed at a stale private claim path', async () => {
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    const displacedValidatedPath = path.join(tmpDir, 'validated-displaced.json');
    const finalPath = path.join(tmpDir, 'state.json');
    let replacementClaimPath: string | undefined;
    await fs.promises.writeFile(stagingPath, '{"version":"validated"}');
    const linkSync = fs.linkSync.bind(fs);

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true, {
      linkNoOverwrite: (claimedPath, destinationPath): fs.Stats => {
        replacementClaimPath = claimedPath;
        fs.renameSync(claimedPath, displacedValidatedPath);
        fs.writeFileSync(claimedPath, '{"version":"replacement"}');
        linkSync(displacedValidatedPath, destinationPath);
        return fs.lstatSync(destinationPath);
      },
    });

    await expect(fs.promises.readFile(finalPath, 'utf8'))
      .resolves.toBe('{"version":"validated"}');
    expect(replacementClaimPath).toBeDefined();
    await expect(fs.promises.readFile(replacementClaimPath!, 'utf8'))
      .resolves.toBe('{"version":"replacement"}');
    expect(result.deleted).not.toContain(stagingPath);
  });

  it('rejects a staging candidate that already has another hard link', async () => {
    const externalPath = path.join(tmpDir, 'external.json');
    const stagingPath = path.join(tmpDir, 'state.json.101-2000-1.tmp');
    await fs.promises.writeFile(externalPath, '{"version":"externally-mutable"}');
    await fs.promises.link(externalPath, stagingPath);

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true);

    await expect(fs.promises.access(path.join(tmpDir, 'state.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.readFile(externalPath, 'utf8'))
      .resolves.toBe('{"version":"externally-mutable"}');
    expect(result.recovered).toEqual([]);
    expect(result.deleted).toEqual([stagingPath]);
  });

  it('does not derive a final path from names outside the legacy and unique formats', async () => {
    const unrelated = path.join(tmpDir, 'state.json.writer.tmp');
    await fs.promises.writeFile(unrelated, '{"complete":true}');

    const result = await cleanupOrphanedTmpFiles(tmpDir, async () => true);

    expect(await fs.promises.readdir(tmpDir)).toEqual(['state.json.writer.tmp']);
    expect(result).toEqual({ recovered: [], deleted: [], failed: [] });
  });

  it('handles empty directory', async () => {
    const result = await cleanupOrphanedTmpFiles(tmpDir);
    expect(result.recovered).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('rejects recovery metadata when its state is replaced during the awaited sidecar read', async () => {
    const stateDir = path.join(tmpDir, 'states');
    const snapshotDir = path.join(tmpDir, 'snapshots');
    const recoveryMetadataDir = path.join(tmpDir, 'recovery-metadata');
    await Promise.all([stateDir, snapshotDir, recoveryMetadataDir]
      .map((dir) => fs.promises.mkdir(dir)));
    const statePath = path.join(stateDir, 'instance-1.json');
    const replacementStatePath = path.join(stateDir, 'replacement.tmp');
    const metadataStagingPath = path.join(
      recoveryMetadataDir,
      'instance-1.json.101-2000-1.tmp',
    );
    await fs.promises.writeFile(statePath, '{"version":"before"}');
    const stateStat = await fs.promises.stat(statePath);
    await fs.promises.writeFile(metadataStagingPath, JSON.stringify({
      encrypted: false,
      data: JSON.stringify({
        recoveryKey: 'history:claude:fixture',
        sourceInstanceId: 'instance-1',
        provider: 'claude',
        lastActivityAt: 100,
        modifiedAt: 100,
        messageCount: 1,
        hasUserPrompt: true,
        hasAssistantOutput: false,
        nativeResumeAvailable: false,
        stateFileGeneration: {
          size: stateStat.size,
          mtimeMs: stateStat.mtimeMs,
          ctimeMs: stateStat.ctimeMs,
          ino: stateStat.ino,
        },
      }),
    }));
    let markReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const canRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });

    const cleanup = cleanupContinuityOrphanedTmpFiles({
      stateDir,
      snapshotDir,
      recoveryMetadataDir,
      readPayload: async (handle: FileHandle): Promise<unknown> => {
        markReadStarted?.();
        await canRead;
        return readContinuityPayloadHandleReadOnly(handle);
      },
    });
    const firstBoundary = await Promise.race([
      readStarted.then(() => 'read-started' as const),
      cleanup.then(() => 'cleanup-finished' as const),
    ]);
    expect(firstBoundary).toBe('read-started');
    await fs.promises.writeFile(replacementStatePath, '{"version":"after"}');
    await fs.promises.rename(replacementStatePath, statePath);
    releaseRead?.();
    const result = await cleanup;

    await expect(fs.promises.access(path.join(recoveryMetadataDir, 'instance-1.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.recoveryMetadata.recovered).toEqual([]);
    expect(result.recoveryMetadata.deleted).toEqual([metadataStagingPath]);
  });
});

describe('repairFile', () => {
  let tmpDir: string;
  let quarantineDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repair-file-'));
    quarantineDir = path.join(tmpDir, 'quarantine');
    await fs.promises.mkdir(quarantineDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns ok for valid JSON file', () => {
    const filePath = path.join(tmpDir, 'good.json');
    fs.writeFileSync(filePath, JSON.stringify({ encrypted: false, data: '{"valid":true}' }));
    const result = repairFile(filePath, quarantineDir);
    expect(result.status).toBe('ok');
  });

  it('repairs outer JSON with trailing garbage', () => {
    const filePath = path.join(tmpDir, 'outer-truncated.json');
    const payload = JSON.stringify({ encrypted: false, data: '{"valid":true}' });
    fs.writeFileSync(filePath, `${payload} trailing`);

    const result = repairFile(filePath, quarantineDir);

    expect(result.status).toBe('repaired');
    const repaired = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { data: string };
    expect(JSON.parse(repaired.data)).toEqual({ valid: true });
  });

  it('repairs truncated inner JSON data', () => {
    const filePath = path.join(tmpDir, 'inner-truncated.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ encrypted: false, data: '{"valid":true' })
    );

    const result = repairFile(filePath, quarantineDir);

    expect(result.status).toBe('repaired');
    const repaired = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { data: string };
    expect(JSON.parse(repaired.data)).toEqual({ valid: true });
  });

  it('returns ok for encrypted envelope without quarantining the file', () => {
    const filePath = path.join(tmpDir, 'encrypted.json');
    fs.writeFileSync(filePath, JSON.stringify({ encrypted: true, data: 'ZmFrZS1lbmNyeXB0ZWQtZGF0YQ==' }));
    const result = repairFile(filePath, quarantineDir);
    expect(result.status).toBe('ok');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('quarantines unrecoverable file', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'this is not json at all {{{{');
    const result = repairFile(filePath, quarantineDir);
    expect(result.status).toBe('quarantined');
    expect(result.quarantinedPath).toBeTruthy();
    expect(path.basename(result.quarantinedPath!)).toMatch(/^bad\.json\.\d+\.corrupt$/);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.existsSync(result.quarantinedPath!)).toBe(true);
  });

  it('quarantines file with valid envelope but corrupt inner data', () => {
    const filePath = path.join(tmpDir, 'partial.json');
    fs.writeFileSync(filePath, JSON.stringify({ encrypted: false, data: '{invalid json' }));
    const result = repairFile(filePath, quarantineDir);
    expect(['quarantined', 'unrecoverable']).toContain(result.status);
  });
});
