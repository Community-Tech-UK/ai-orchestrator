import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ActivityStateDetector } from './activity-state-detector';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ActivityEntry } from '../../shared/types/activity.types';

describe('ActivityStateDetector', () => {
  let detector: ActivityStateDetector;
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), 'activity-test-'));
    detector = new ActivityStateDetector('inst-1', workspacePath, 'openai');
  });

  afterEach(() => {
    rmSync(workspacePath, { recursive: true, force: true });
  });

  function writeActivityLog(entries: ActivityEntry[]): void {
    const aoDir = join(workspacePath, '.ao');
    mkdirSync(aoDir, { recursive: true });
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(aoDir, 'activity.jsonl'), content);
  }

  describe('Level 2: Activity JSONL Log', () => {
    it('should detect active state from recent entry', async () => {
      writeActivityLog([
        { ts: Date.now() - 5_000, state: 'active', source: 'native', provider: 'openai' },
      ]);
      const result = await detector.detect();
      expect(result.state).toBe('active');
    });

    it('should detect waiting_input from recent entry', async () => {
      writeActivityLog([
        { ts: Date.now() - 10_000, state: 'waiting_input', source: 'terminal', provider: 'openai' },
      ]);
      const result = await detector.detect();
      expect(result.state).toBe('waiting_input');
    });

    it('should decay stale waiting_input to idle after 5 minutes', async () => {
      writeActivityLog([
        { ts: Date.now() - 400_000, state: 'waiting_input', source: 'terminal', provider: 'openai' },
      ]);
      const result = await detector.detect();
      expect(result.state).toBe('idle');
    });

    it('should decay stale blocked to idle after 5 minutes', async () => {
      writeActivityLog([
        { ts: Date.now() - 400_000, state: 'blocked', source: 'terminal', provider: 'openai' },
      ]);
      const result = await detector.detect();
      expect(result.state).toBe('idle');
    });

    it('should decay stale exited to idle after 5 minutes', async () => {
      writeActivityLog([
        { ts: Date.now() - 400_000, state: 'exited', source: 'process-check', provider: 'openai' },
      ]);
      const result = await detector.detect();
      expect(result.state).toBe('idle');
    });
  });

  describe('Level 3: Age-Based Decay', () => {
    it('should return active for very recent activity', async () => {
      await detector.recordTerminalActivity('Some output');
      const result = await detector.detect();
      expect(['active', 'ready']).toContain(result.state);
      expect(result.confidence).not.toBe('high');
    });
  });

  describe('Level 4: Process Check', () => {
    it('should return exited when no data at all', async () => {
      const result = await detector.detect();
      expect(['exited', 'idle']).toContain(result.state);
      expect(result.confidence).toBe('low');
    });
  });

  describe('recordTerminalActivity', () => {
    it('should write entry to activity.jsonl', async () => {
      await detector.recordTerminalActivity('Processing files...');
      const result = await detector.getLastRecordedActivity();
      expect(result).not.toBeNull();
      expect(result!.source).toBe('terminal');
    });

    it('should deduplicate non-actionable states within 20s', async () => {
      await detector.recordTerminalActivity('Processing files...');
      await detector.recordTerminalActivity('Still processing...');
      const { readFileSync } = await import('fs');
      const logPath = join(workspacePath, '.ao', 'activity.jsonl');
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(1);
    });

    it('should always write actionable states even within dedup window', async () => {
      await detector.recordTerminalActivity('Processing files...');
      await detector.recordActivityEntry({
        ts: Date.now(),
        state: 'waiting_input',
        source: 'terminal',
        trigger: '? Allow execution',
        provider: 'openai',
      });
      const { readFileSync } = await import('fs');
      const logPath = join(workspacePath, '.ao', 'activity.jsonl');
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      expect(lines.length).toBe(2);
    });
  });
});
