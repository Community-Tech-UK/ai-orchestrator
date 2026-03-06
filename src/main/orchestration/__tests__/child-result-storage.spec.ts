import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputMessage } from '../../../shared/types/instance.types';

vi.mock('electron', () => ({
  app: {
    getPath: () => os.tmpdir(),
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../rlm/llm-service', () => ({
  LLMService: {
    getInstance: () => ({
      countTokens: (content: string) => content.length,
    }),
  },
}));

describe('ChildResultStorage', () => {
  const tempDirs: string[] = [];

  beforeEach(async () => {
    vi.resetModules();
    const { ChildResultStorage } = await import('../child-result-storage');
    ChildResultStorage._resetForTesting();
  });

  afterEach(async () => {
    const { ChildResultStorage } = await import('../child-result-storage');
    ChildResultStorage._resetForTesting();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('indexes results by parent and can rebuild the mapping from disk', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-result-storage-'));
    tempDirs.push(storageDir);

    const { ChildResultStorage } = await import('../child-result-storage');
    const storage = ChildResultStorage.getInstance({ storagePath: storageDir });

    const output: OutputMessage[] = [
      {
        id: 'm1',
        timestamp: Date.now(),
        type: 'assistant',
        content: 'done',
      },
    ];

    await storage.storeResult(
      'child-1',
      'parent-1',
      'Task one',
      {
        action: 'report_result',
        summary: 'first',
        artifacts: [{ type: 'finding', content: 'first finding' }],
      },
      output,
      Date.now() - 100,
    );

    await storage.storeResult(
      'child-2',
      'parent-1',
      'Task two',
      {
        action: 'report_result',
        summary: 'second',
        artifacts: [{ type: 'warning', content: 'second warning' }],
      },
      output,
      Date.now() - 50,
    );

    const indexPath = path.join(storageDir, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      childToResult: Record<string, string>;
      parentToResults?: Record<string, string[]>;
    };
    delete index.parentToResults;
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

    ChildResultStorage._resetForTesting();
    const rebuiltStorage = ChildResultStorage.getInstance({ storagePath: storageDir });
    const results = await rebuiltStorage.getResultsForParent('parent-1');

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.childId).sort()).toEqual(['child-1', 'child-2']);

    const rebuiltIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      parentToResults: Record<string, string[]>;
    };
    expect(rebuiltIndex.parentToResults['parent-1']).toHaveLength(2);
  });

  it('extracts browser evidence artifacts from output buffers', async () => {
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'child-result-storage-'));
    tempDirs.push(storageDir);

    const screenshotPath = path.join(storageDir, 'evidence', 'page.png');
    const consolePath = path.join(storageDir, 'evidence', 'console.log');
    const networkPath = path.join(storageDir, 'evidence', 'network.har');
    const tracePath = path.join(storageDir, 'evidence', 'trace.zip');
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, 'png');
    fs.writeFileSync(consolePath, 'console');
    fs.writeFileSync(networkPath, '{}');
    fs.writeFileSync(tracePath, 'zip');

    const { ChildResultStorage } = await import('../child-result-storage');
    const storage = ChildResultStorage.getInstance({ storagePath: storageDir });

    const output: OutputMessage[] = [
      {
        id: 'assistant-1',
        timestamp: Date.now(),
        type: 'assistant',
        content: `Saved screenshot ${screenshotPath}`,
      },
      {
        id: 'assistant-2',
        timestamp: Date.now(),
        type: 'assistant',
        content: `Console excerpt available at ${consolePath}`,
      },
      {
        id: 'assistant-3',
        timestamp: Date.now(),
        type: 'assistant',
        content: `Network errors recorded in ${networkPath}`,
      },
      {
        id: 'assistant-4',
        timestamp: Date.now(),
        type: 'assistant',
        content: `Trace bundle stored at ${tracePath}`,
      },
    ];

    const result = await storage.storeFromOutputBuffer(
      'child-browser',
      'parent-browser',
      'Collect browser evidence',
      'Captured evidence',
      true,
      output,
      Date.now() - 100,
    );

    expect(result.artifacts.map((artifact) => artifact.type)).toEqual([
      'screenshot',
      'console_log_excerpt',
      'network_error_summary',
      'trace_reference',
    ]);
    expect(result.artifacts[0].metadata?.['screenshotPath']).toBe(screenshotPath);
    expect(result.artifacts[1].metadata?.['consolePath']).toBe(consolePath);
    expect(result.artifacts[2].metadata?.['networkPath']).toBe(networkPath);
    expect(result.artifacts[3].metadata?.['tracePath']).toBe(tracePath);
  });
});
