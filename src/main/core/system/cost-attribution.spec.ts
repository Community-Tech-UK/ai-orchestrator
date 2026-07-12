import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordAuxiliaryAttribution,
  recordCostAttribution,
  recordInstanceTurnAttribution,
  getCostAttributionFilePath,
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

  it('is enabled by default when the flag is unset', () => {
    delete process.env['AIO_COST_ATTRIBUTION'];
    expect(getCostAttributionFilePath()).not.toBeNull();
    recordCostAttribution({ source: 'one-shot', taskType: 'verify-orchestration' });
    expect(existsSync(join(dir, `cost-attribution-${new Date().toISOString().slice(0, 10)}.jsonl`))).toBe(true);
  });

  it.each(['0', 'false'])('is a no-op when the flag opts out (%s)', (optOut) => {
    process.env['AIO_COST_ATTRIBUTION'] = optOut;
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

  describe('auxiliary seam', () => {
    const readRecords = (): Record<string, unknown>[] =>
      readFileSync(getCostAttributionFilePath()!, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);

    it('records a local offload with token counts and no dollar cost', () => {
      recordAuxiliaryAttribution({
        slot: 'compression',
        provider: 'ollama',
        endpointId: 'ep-5090',
        model: 'gemma4',
        routedTo: 'local',
        escalatedToFrontier: false,
        usage: { inputTokens: 4000, outputTokens: 500 },
      });

      const [rec] = readRecords();
      expect(rec['source']).toBe('auxiliary');
      expect(rec['taskType']).toBe('aux:compression');
      expect(rec['auxRoutedTo']).toBe('local');
      expect(rec['auxEscalatedToFrontier']).toBe(false);
      expect(rec['auxEndpointId']).toBe('ep-5090');
      // Local models report no dollars — the token counts are the signal.
      expect(rec['costKnown']).toBe(false);
      expect(rec['usage']).toEqual({ inputTokens: 4000, outputTokens: 500 });
    });

    it('flags the silent frontier escalation when no local endpoint is healthy', () => {
      // This is the case that was completely invisible: compaction runs on
      // every long session, and with allowFrontierFallback:true the caller
      // quietly re-runs the prompt against a paid model.
      recordAuxiliaryAttribution({
        slot: 'compression',
        routedTo: 'fallback',
        escalatedToFrontier: true,
        reason: 'No healthy auxiliary endpoint/model available',
      });

      const [rec] = readRecords();
      expect(rec['auxRoutedTo']).toBe('fallback');
      expect(rec['auxEscalatedToFrontier']).toBe(true);
      expect(rec['auxReason']).toBe('No healthy auxiliary endpoint/model available');
    });

    it('distinguishes a fallback that degrades to a heuristic from one that escalates', () => {
      // Slots with allowFrontierFallback:false (titleGeneration, loopScoring,
      // ...) fall back to a deterministic heuristic and cost nothing. They must
      // not be counted as cloud spend.
      recordAuxiliaryAttribution({
        slot: 'titleGeneration',
        routedTo: 'fallback',
        escalatedToFrontier: false,
        reason: 'No healthy auxiliary endpoint/model available',
      });

      const [rec] = readRecords();
      expect(rec['taskType']).toBe('aux:titleGeneration');
      expect(rec['auxEscalatedToFrontier']).toBe(false);
    });

    it('is silenced by the same opt-out flag as the other seams', () => {
      process.env['AIO_COST_ATTRIBUTION'] = '0';
      _resetCostAttributionForTesting();
      recordAuxiliaryAttribution({ slot: 'compression', routedTo: 'local', escalatedToFrontier: false });
      expect(getCostAttributionFilePath()).toBeNull();
    });
  });
});
