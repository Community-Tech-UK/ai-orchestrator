import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LegacyOutputCacheReconciler,
  type LegacyOutputCacheMarkerRecord,
} from './legacy-output-cache-reconciler';

describe('LegacyOutputCacheReconciler', () => {
  let userDataPath: string;
  let cacheDir: string;
  let filePath: string;
  let marker: string;
  let row: LegacyOutputCacheMarkerRecord;
  let remaining: LegacyOutputCacheMarkerRecord[];
  let ledger: {
    listLegacyOutputCacheMarkers: ReturnType<typeof vi.fn>;
    compareAndSwapLegacyOutputMarker: ReturnType<typeof vi.fn>;
  };
  let coordinator: {
    capture: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(tmpdir(), 'aio-legacy-cache-'));
    cacheDir = path.join(userDataPath, 'output-cache');
    await mkdir(cacheDir);
    filePath = path.join(cacheDir, 'a'.repeat(64) + '.txt');
    await writeFile(filePath, 'legacy full output', 'utf8');
    marker = `[Full output saved: ${filePath}] (18 chars)`;
    row = {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      content: `head\n${marker}\ntail`,
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
    };
    remaining = [row];
    ledger = {
      listLegacyOutputCacheMarkers: vi.fn(async () => remaining),
      compareAndSwapLegacyOutputMarker: vi.fn(async () => {
        remaining = [];
        return true;
      }),
    };
    coordinator = {
      capture: vi.fn(async () => ({
        capture: {
          status: 'captured',
          record: { id: 'evidence-1', byteCount: 18 },
        },
      })),
      read: vi.fn(async () => ({
        citation: {
          evidenceId: 'evidence-1',
          startByte: 0,
          endByte: 18,
          contentDigest: 'b'.repeat(64),
        },
      })),
    };
  });

  afterEach(() => vi.restoreAllMocks());

  function reconciler() {
    return new LegacyOutputCacheReconciler({ userDataPath, ledger, coordinator });
  }

  it('captures an exact owned marker as legacy-unverified, swaps it with disclosure, then deletes', async () => {
    const report = await reconciler().reconcile();

    expect(coordinator.capture).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      provider: 'orchestrator',
      sourceKind: 'file',
      provenanceTrust: 'legacy-unverified',
      captureMode: 'observed-only',
      captureCompleteness: 'complete',
    }));
    expect(ArrayBuffer.isView(coordinator.capture.mock.calls[0]?.[0].content)).toBe(true);
    expect(ledger.compareAndSwapLegacyOutputMarker).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-1',
      messageId: 'message-1',
      expectedMarker: marker,
      evidenceCitation: `[evidence:evidence-1@0-18#${'b'.repeat(64)}]`,
      replacementText: expect.stringContaining('legacy-unverified'),
    }));
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(report).toEqual({ scanned: 1, migrated: 1, deleted: 1, failures: [] });
  });

  it('rejects traversal, symlinks, unknown marker formats, and ownerless messages without deleting', async () => {
    const outside = path.join(userDataPath, 'outside.txt');
    await writeFile(outside, 'outside', 'utf8');
    const link = path.join(cacheDir, 'link.txt');
    await symlink(outside, link);
    remaining = [
      { ...row, messageId: 'traversal', content: `[Full output saved: ${outside}] (7 chars)` },
      { ...row, messageId: 'symlink', content: `[Full output saved: ${link}] (7 chars)` },
      { ...row, messageId: 'unknown', content: `[Output cached at: ${filePath}] (18 chars)` },
      { ...row, messageId: 'ownerless', provider: 'codex', sourceKind: 'provider-native' },
    ];

    const report = await reconciler().reconcile();

    expect(coordinator.capture).not.toHaveBeenCalled();
    expect(ledger.compareAndSwapLegacyOutputMarker).not.toHaveBeenCalled();
    await expect(readFile(filePath, 'utf8')).resolves.toBe('legacy full output');
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside');
    expect(report.failures.map((failure) => failure.code)).toEqual([
      'LEGACY_CACHE_PATH_OUTSIDE_ROOT',
      'LEGACY_CACHE_SYMLINK_REJECTED',
      'LEGACY_CACHE_MARKER_UNKNOWN',
      'LEGACY_CACHE_OWNER_UNRESOLVED',
    ]);
    expect(JSON.stringify(report)).not.toContain('legacy full output');
  });

  it.each(['capture', 'cas'] as const)('preserves the marker and file when %s fails', async (failure) => {
    if (failure === 'capture') {
      coordinator.capture.mockResolvedValue({
        capture: { status: 'failed', errorCode: 'CAPTURE_FAILED', disclosure: 'failed' },
      });
    } else {
      ledger.compareAndSwapLegacyOutputMarker.mockResolvedValue(false);
    }

    const report = await reconciler().reconcile();

    await expect(readFile(filePath, 'utf8')).resolves.toBe('legacy full output');
    expect(remaining).toEqual([row]);
    expect(report.migrated).toBe(0);
    expect(report.deleted).toBe(0);
    expect(report.failures).toEqual([
      expect.objectContaining({
        messageId: 'message-1',
        code: failure === 'capture' ? 'CAPTURE_FAILED' : 'LEGACY_CACHE_MARKER_CHANGED',
      }),
    ]);
  });

  it('does not delete a migrated file while another exact ledger marker still references it', async () => {
    const second = { ...row, messageId: 'message-2' };
    remaining = [row, second];
    ledger.compareAndSwapLegacyOutputMarker.mockImplementation(async (input: { messageId: string }) => {
      if (input.messageId === 'message-1') remaining = [second];
      else return false;
      return true;
    });

    const report = await reconciler().reconcile();

    await expect(readFile(filePath, 'utf8')).resolves.toBe('legacy full output');
    expect(report.deleted).toBe(0);
  });
});
