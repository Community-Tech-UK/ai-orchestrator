import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCostAttribution,
  recordInstanceTurnAttribution,
  getCostAttributionFilePath,
  isCostAttributionEnabled,
  _resetCostAttributionForTesting,
} from './cost-attribution';

describe('cost-attribution', () => {
  let dir: string;
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup['AIO_COST_ATTRIBUTION'] = process.env['AIO_COST_ATTRIBUTION'];
    envBackup['AIO_COST_ATTRIBUTION_DIR'] = process.env['AIO_COST_ATTRIBUTION_DIR'];
    dir = mkdtempSync(join(tmpdir(), 'cost-attr-'));
    process.env['AIO_COST_ATTRIBUTION_DIR'] = dir;
    _resetCostAttributionForTesting();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCostAttributionForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a no-op when the flag is unset', () => {
    delete process.env['AIO_COST_ATTRIBUTION'];
    expect(isCostAttributionEnabled()).toBe(false);
    expect(getCostAttributionFilePath()).toBeNull();
    recordCostAttribution({ source: 'one-shot', taskType: 'verify-orchestration' });
    // Nothing written anywhere in the temp dir.
    expect(existsSync(join(dir, `cost-attribution-${new Date().toISOString().slice(0, 10)}.jsonl`))).toBe(false);
  });

  it('appends one JSON line per record when enabled', () => {
    process.env['AIO_COST_ATTRIBUTION'] = '1';
    recordCostAttribution({
      source: 'one-shot',
      taskType: 'loop-orchestration:claude',
      correlationId: 'corr-1',
      provider: 'claude',
      model: 'claude-opus-4-8',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.42 },
      costKnown: true,
    });
    recordCostAttribution({ source: 'one-shot', taskType: 'verify-orchestration' });

    const file = getCostAttributionFilePath();
    expect(file).not.toBeNull();
    const lines = readFileSync(file!, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(first['taskType']).toBe('loop-orchestration:claude');
    expect(first['ts']).toBeTypeOf('number');
    expect((first['usage'] as Record<string, unknown>)['cost']).toBe(0.42);
    const second = JSON.parse(lines[1]) as Record<string, unknown>;
    expect(second['taskType']).toBe('verify-orchestration');
  });

  it('derives chat/child task-types for instance turns', () => {
    process.env['AIO_COST_ATTRIBUTION'] = '1';
    recordInstanceTurnAttribution({
      instanceId: 'inst-1',
      parentId: null,
      agentId: 'build',
      provider: 'claude',
      model: 'claude-opus-4-8',
      usage: { inputTokens: 10, outputTokens: 5 },
      costKnown: false,
    });
    recordInstanceTurnAttribution({
      instanceId: 'inst-2',
      parentId: 'inst-1',
      agentId: 'review',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 20, outputTokens: 8 },
      costKnown: true,
    });

    const lines = readFileSync(getCostAttributionFilePath()!, 'utf8').trim().split('\n');
    const [chat, child] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(chat['taskType']).toBe('chat:build');
    expect(chat['source']).toBe('instance-turn');
    expect(child['taskType']).toBe('child:review');
    expect(child['parentId']).toBe('inst-1');
  });

  it('never throws when the directory is not writable', () => {
    process.env['AIO_COST_ATTRIBUTION'] = '1';
    process.env['AIO_COST_ATTRIBUTION_DIR'] = join(dir, 'nope', '\0bad');
    _resetCostAttributionForTesting();
    expect(() =>
      recordCostAttribution({ source: 'one-shot', taskType: 'verify-orchestration' }),
    ).not.toThrow();
  });
});
