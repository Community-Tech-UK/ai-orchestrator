// src/main/context/__tests__/output-persistence.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test-app-data') },
}));

const mockMkdir = vi.fn().mockResolvedValue(undefined);
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn();
const mockReaddir = vi.fn().mockResolvedValue([]);
const mockStat = vi.fn();
const mockUnlink = vi.fn().mockResolvedValue(undefined);

vi.mock('fs/promises', () => ({
  mkdir: (...args: unknown[]) => mockMkdir(...args),
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
  readdir: (...args: unknown[]) => mockReaddir(...args),
  stat: (...args: unknown[]) => mockStat(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

import {
  OutputPersistenceManager,
  getOutputPersistenceManager,
  type OutputPersistenceCaptureContext,
} from '../output-persistence';

function captureContext(
  overrides: Partial<OutputPersistenceCaptureContext> = {},
): OutputPersistenceCaptureContext {
  return {
    provider: 'codex',
    conversationId: 'conversation-1',
    turnRef: 'loop-1:iteration:3',
    logicalCallId: 'loop-1:iteration:3:output',
    sourceKind: 'other',
    captureMode: 'post-retention',
    captureCompleteness: 'complete',
    observedBoundary: 'after-provider-retention',
    ...overrides,
  };
}

function evidenceRecord(byteCount: number) {
  return {
    id: 'evidence-1',
    conversationId: 'conversation-1',
    provider: 'codex',
    turnRef: 'loop-1:iteration:3',
    toolCallRef: 'loop-1:iteration:3:output',
    toolName: 'loop-iteration-output',
    sourceKind: 'other' as const,
    status: 'complete' as const,
    keyedContentId: 'a'.repeat(64),
    byteCount,
    mimeType: 'text/plain',
    sensitivity: 'normal' as const,
    provenanceTrust: 'runtime-authenticated' as const,
    createdAt: 1,
    completedAt: 2,
    keyVersion: 1,
    captureMode: 'post-retention' as const,
    captureCompleteness: 'complete' as const,
  };
}

function createModeAwareManager(mode: 'off' | 'shadow' | 'enforce') {
  const capture = vi.fn();
  const read = vi.fn();
  const recordMigrationError = vi.fn();
  return {
    manager: new OutputPersistenceManager({
      getMode: () => mode,
      getCoordinator: () => ({ capture, read }),
      recordMigrationError,
    } as never),
    capture,
    read,
    recordMigrationError,
  };
}

describe('OutputPersistenceManager', () => {
  beforeEach(() => {
    OutputPersistenceManager._resetForTesting();
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
    mockReadFile.mockClear();
    mockReaddir.mockClear();
    mockStat.mockClear();
    mockUnlink.mockClear();
  });

  describe('singleton', () => {
    it('returns the same instance on repeated calls', () => {
      const a = OutputPersistenceManager.getInstance();
      const b = OutputPersistenceManager.getInstance();
      expect(a).toBe(b);
    });

    it('getOutputPersistenceManager() convenience getter returns the singleton', () => {
      const manager = getOutputPersistenceManager();
      expect(manager).toBe(OutputPersistenceManager.getInstance());
    });
  });

  describe('maybeExternalize — small output (below threshold)', () => {
    it('returns content unchanged when below default threshold', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const small = 'x'.repeat(1000);
      const result = await manager.maybeExternalize('default', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('returns content unchanged when below per-tool grep threshold (20K)', async () => {
      const manager = OutputPersistenceManager.getInstance();
      const output = 'a'.repeat(19_999);
      const result = await manager.maybeExternalize('grep', output);
      expect(result).toBe(output);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('maybeExternalize — explicit off mode', () => {
    it.each([
      ['default', 51_000],
      ['grep', 20_001],
      ['web_fetch', 100_001],
    ])('preserves provider-visible %s output inline without plaintext fallback', async (toolName, size) => {
      const { manager, capture } = createModeAwareManager('off');
      const output = 'z'.repeat(size);

      await expect(manager.maybeExternalize(toolName, output, {
        captureContext: captureContext(),
      })).resolves.toBe(output);

      expect(capture).not.toHaveBeenCalled();
      expect(mockMkdir).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('evidence-backed compatibility facade', () => {
    it('preserves the only full output when capture context is missing instead of writing plaintext', async () => {
      const { manager, recordMigrationError } = createModeAwareManager('off');
      const output = 'legacy caller output '.repeat(4_000);

      await expect(manager.maybeExternalize('loop-iteration-output', output)).resolves.toBe(output);
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(recordMigrationError).toHaveBeenCalledWith(expect.objectContaining({
        code: 'OUTPUT_PERSISTENCE_CAPTURE_CONTEXT_MISSING',
      }));
    });

    it.each(['shadow', 'enforce'] as const)(
      '%s mode never creates a plaintext output-cache file',
      async (mode) => {
        const { manager, capture, read } = createModeAwareManager(mode);
        const output = 'captured output '.repeat(4_000);
        capture.mockResolvedValue({
          capture: { status: 'captured', record: evidenceRecord(Buffer.byteLength(output)) },
        });
        read.mockResolvedValue({
          evidenceId: 'evidence-1', startByte: 0, endByte: 16,
          content: '[BEGIN UNTRUSTED EVIDENCE evidence-1]\npreview\n[END UNTRUSTED EVIDENCE evidence-1]',
          tokenCount: 20, tokenLimit: 1024, truncated: true,
          citation: { evidenceId: 'evidence-1', startByte: 0, endByte: 16, contentDigest: 'b'.repeat(64) },
          captureCompleteness: 'complete',
        });

        await manager.maybeExternalize('loop-iteration-output', output, {
          captureContext: captureContext(),
        });

        expect(mockMkdir).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
      },
    );

    it('shadow mode captures the full bytes but leaves provider-visible output unchanged', async () => {
      const { manager, capture, read } = createModeAwareManager('shadow');
      const output = 'shadow output '.repeat(5_000);
      let capturedContent = '';
      capture.mockImplementation(async (input: { content: Uint8Array }) => {
        capturedContent = Buffer.from(input.content).toString('utf8');
        return {
          capture: { status: 'captured', record: evidenceRecord(Buffer.byteLength(output)) },
        };
      });

      await expect(manager.maybeExternalize('loop-iteration-output', output, {
        captureContext: captureContext(),
      })).resolves.toBe(output);

      expect(capture).toHaveBeenCalledWith(expect.objectContaining({
        conversationId: 'conversation-1',
        turnRef: 'loop-1:iteration:3',
        toolCallRef: 'loop-1:iteration:3:output',
        provider: 'codex',
        sourceKind: 'other',
        captureMode: 'post-retention',
        captureCompleteness: 'complete',
        observedBoundary: 'after-provider-retention',
      }));
      expect(capturedContent).toBe(output);
      expect(read).not.toHaveBeenCalled();
    });

    it('enforce mode returns bounded authenticated head/tail citations without a cache path', async () => {
      const { manager, capture, read } = createModeAwareManager('enforce');
      const completion = '<promise>DONE</promise>';
      const output = `${'large result\n'.repeat(5_000)}${completion}`;
      capture.mockResolvedValue({
        capture: { status: 'captured', record: evidenceRecord(Buffer.byteLength(output)) },
      });
      read
        .mockResolvedValueOnce({
          evidenceId: 'evidence-1', startByte: 0, endByte: 32,
          content: '[BEGIN UNTRUSTED EVIDENCE evidence-1]\nlarge result\n[END UNTRUSTED EVIDENCE evidence-1]',
          tokenCount: 20, tokenLimit: 1024, truncated: false,
          citation: { evidenceId: 'evidence-1', startByte: 0, endByte: 32, contentDigest: 'b'.repeat(64) },
          captureCompleteness: 'complete',
        })
        .mockResolvedValueOnce({
          evidenceId: 'evidence-1', startByte: Buffer.byteLength(output) - Buffer.byteLength(completion),
          endByte: Buffer.byteLength(output),
          content: `[BEGIN UNTRUSTED EVIDENCE evidence-1]\n${completion}\n[END UNTRUSTED EVIDENCE evidence-1]`,
          tokenCount: 20, tokenLimit: 1024, truncated: false,
          citation: {
            evidenceId: 'evidence-1',
            startByte: Buffer.byteLength(output) - Buffer.byteLength(completion),
            endByte: Buffer.byteLength(output),
            contentDigest: 'c'.repeat(64),
          },
          captureCompleteness: 'complete',
        });

      const result = await manager.maybeExternalize('loop-iteration-output', output, {
        captureContext: captureContext(),
      });

      expect(result).toContain('[evidence:evidence-1@0-32#');
      expect(result).toContain(completion);
      expect(result).not.toContain('/tmp/test-app-data/output-cache');
      expect(result.length).toBeLessThan(output.length);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it.each(['shadow', 'enforce'] as const)(
      '%s mode preserves the only full output when canonical ownership is unresolved',
      async (mode) => {
        const { manager, capture, recordMigrationError } = createModeAwareManager(mode);
        const output = 'ownerless output '.repeat(4_000);

        await expect(manager.maybeExternalize('loop-iteration-output', output, {
          captureContext: captureContext({ conversationId: undefined }),
        })).resolves.toBe(output);

        expect(capture).not.toHaveBeenCalled();
        expect(mockWriteFile).not.toHaveBeenCalled();
        expect(recordMigrationError).toHaveBeenCalledWith(expect.objectContaining({
          code: 'OUTPUT_PERSISTENCE_OWNERSHIP_UNRESOLVED',
          provider: 'codex',
          toolName: 'loop-iteration-output',
        }));
        expect(JSON.stringify(recordMigrationError.mock.calls)).not.toContain(output.slice(0, 100));
      },
    );

    it('enforce mode preserves full output when durable capture fails', async () => {
      const { manager, capture, recordMigrationError } = createModeAwareManager('enforce');
      const output = 'capture failure output '.repeat(3_000);
      capture.mockResolvedValue({
        capture: {
          status: 'failed',
          errorCode: 'CAPTURE_BLOB_WRITE_FAILED',
          disclosure: 'Encrypted evidence storage failed.',
        },
      });

      await expect(manager.maybeExternalize('loop-iteration-output', output, {
        captureContext: captureContext(),
      })).resolves.toBe(output);

      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(recordMigrationError).toHaveBeenCalledWith(expect.objectContaining({
        code: 'CAPTURE_BLOB_WRITE_FAILED',
      }));
    });
  });

  describe('configureThreshold', () => {
    it('respects custom per-tool threshold set via configure()', async () => {
      const { manager } = createModeAwareManager('off');
      manager.configure({ thresholds: { custom_tool: 5000 } });

      const small = 'f'.repeat(4999);
      const result = await manager.maybeExternalize('custom_tool', small);
      expect(result).toBe(small);
      expect(mockWriteFile).not.toHaveBeenCalled();

      mockWriteFile.mockClear();

      const large = 'f'.repeat(5001);
      const resultLarge = await manager.maybeExternalize('custom_tool', large, {
        captureContext: captureContext(),
      });
      expect(resultLarge).toBe(large);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
