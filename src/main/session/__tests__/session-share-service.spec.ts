import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildResult } from '../../../shared/types/child-result.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

const childResultsMock = vi.fn<() => Promise<ChildResult[]>>();
const listSnapshotsMock = vi.fn();
const getSessionsForInstanceMock = vi.fn();

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../orchestration/child-result-storage', () => ({
  getChildResultStorage: () => ({
    getResultsForParent: childResultsMock,
  }),
}));

vi.mock('../../persistence/snapshot-manager', () => ({
  getSnapshotManager: () => ({
    getSessionsForInstance: getSessionsForInstanceMock,
  }),
}));

vi.mock('../session-continuity', () => ({
  getSessionContinuityManager: () => ({
    listSnapshots: listSnapshotsMock,
  }),
}));

describe('SessionShareService', () => {
  const tempDirs: string[] = [];
  const token = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';

  beforeEach(() => {
    vi.resetModules();
    childResultsMock.mockReset();
    listSnapshotsMock.mockReset();
    getSessionsForInstanceMock.mockReset();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates a redacted bundle with sanitized paths and embedded evidence', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-share-'));
    tempDirs.push(tempDir);

    const evidenceLogPath = path.join(tempDir, 'artifacts', 'console.log');
    const evidenceImagePath = path.join(tempDir, 'artifacts', 'page.png');
    fs.mkdirSync(path.dirname(evidenceLogPath), { recursive: true });
    fs.writeFileSync(evidenceLogPath, `Authorization: Bearer ${token}`);
    fs.writeFileSync(evidenceImagePath, Buffer.from('fake-png-data'));

    childResultsMock.mockResolvedValue([
      {
        id: 'result-1',
        childId: 'child-1',
        parentId: 'instance-1',
        taskDescription: 'Review with browser automation',
        summary: 'done',
        summaryTokens: 4,
        artifacts: [
          {
            id: 'artifact-1',
            type: 'finding',
            severity: 'medium',
            title: 'Visual mismatch',
            content: `See screenshot at ${evidenceImagePath} and token ${token}`,
            file: path.join(tempDir, 'src', 'app.ts'),
            metadata: {
              screenshotPath: evidenceImagePath,
            },
            timestamp: Date.now(),
          },
        ],
        artifactCount: 1,
        conclusions: [],
        keyDecisions: [],
        fullTranscriptRef: '',
        fullTranscriptTokens: 0,
        success: true,
        completedAt: Date.now(),
        duration: 10,
        tokensUsed: 20,
      },
    ]);
    listSnapshotsMock.mockReturnValue([
      {
        id: 'snap-1',
        timestamp: Date.now(),
        name: 'Manual',
        description: 'Checkpoint',
        metadata: {
          messageCount: 4,
          tokensUsed: 20,
          duration: 100,
          trigger: 'manual',
        },
      },
    ]);
    getSessionsForInstanceMock.mockReturnValue([
      {
        id: 'fs-1',
        startedAt: Date.now(),
        endedAt: Date.now(),
        description: 'Repo job',
        fileCount: 2,
        snapshots: ['a', 'b'],
      },
    ]);

    const message: OutputMessage = {
      id: 'message-1',
      timestamp: Date.now(),
      type: 'assistant',
      content: `Captured console log ${evidenceLogPath} with token ${token}`,
    };

    const instance = {
      id: 'instance-1',
      displayName: 'Browser Review',
      createdAt: Date.now(),
      status: 'idle',
      workingDirectory: tempDir,
      outputBuffer: [message],
    } as Instance;

    const { getSessionShareService } = await import('../session-share-service');
    const bundle = await getSessionShareService().createBundle({ instance });

    expect(bundle.redacted).toBe(true);
    expect(bundle.source.workingDirectoryLabel).toBe('<workspace>');
    expect(bundle.messages[0].content).toContain('<workspace>');
    expect(bundle.messages[0].content).toContain('[REDACTED]');
    expect(bundle.messages[0].content).not.toContain(tempDir);
    expect(bundle.artifacts[0].fileLabel).toBe('<workspace>/src/app.ts');
    expect(bundle.attachments.some((attachment) => attachment.kind === 'text' && attachment.embeddedText?.includes('[REDACTED]'))).toBe(true);
    expect(bundle.attachments.some((attachment) => attachment.kind === 'image' && Boolean(attachment.embeddedBase64))).toBe(true);
    expect(bundle.summary.continuitySnapshotCount).toBe(1);
    expect(bundle.summary.fileSnapshotSessionCount).toBe(1);
  });
});
