import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_DIR = path.join(os.tmpdir(), `feature-flag-evaluator-test-${process.pid}`);

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => TEST_DIR),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import { FeatureFlagEvaluator } from '../feature-flag-evaluator';

describe('FeatureFlagEvaluator', () => {
  let evaluator: FeatureFlagEvaluator;

  beforeEach(() => {
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    FeatureFlagEvaluator._resetForTesting();
    evaluator = FeatureFlagEvaluator.getInstance();
  });

  afterEach(() => {
    FeatureFlagEvaluator._resetForTesting();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('evaluates flags from runtime overrides', () => {
    evaluator.setFlag('mcp.enabled', true);
    expect(evaluator.isEnabled('mcp.enabled')).toBe(true);
    evaluator.setFlag('mcp.enabled', false);
    expect(evaluator.isEnabled('mcp.enabled')).toBe(false);
  });

  it('falls back to ORCHESTRATION_FEATURES for known flags', () => {
    expect(evaluator.isEnabled('DEBATE_SYSTEM')).toBe(true);
  });

  it('returns false for completely unknown flags', () => {
    expect(evaluator.isEnabled('nonexistent.flag')).toBe(false);
  });

  it('supports percentage rollout with deterministic seed', () => {
    evaluator.setFlag('experimental.feature', { enabled: true, rolloutPercent: 50 });
    const result1 = evaluator.isEnabled('experimental.feature', 'user-1');
    const result2 = evaluator.isEnabled('experimental.feature', 'user-1');
    expect(result1).toBe(result2);
  });

  it('persists flags to disk and reloads', () => {
    evaluator.setFlag('test.persist', true);
    evaluator.save();

    FeatureFlagEvaluator._resetForTesting();
    const reloaded = FeatureFlagEvaluator.getInstance();
    expect(reloaded.isEnabled('test.persist')).toBe(true);
  });

  it('returns the singleton instance', () => {
    const a = FeatureFlagEvaluator.getInstance();
    const b = FeatureFlagEvaluator.getInstance();
    expect(a).toBe(b);
  });

  it('removeFlag clears an override and falls back to default', () => {
    evaluator.setFlag('DEBATE_SYSTEM', false);
    expect(evaluator.isEnabled('DEBATE_SYSTEM')).toBe(false);
    evaluator.removeFlag('DEBATE_SYSTEM');
    expect(evaluator.isEnabled('DEBATE_SYSTEM')).toBe(true);
  });

  it('getAllFlags returns all current overrides', () => {
    evaluator.setFlag('flag.a', true);
    evaluator.setFlag('flag.b', false);
    const all = evaluator.getAllFlags();
    expect(all['flag.a']).toBe(true);
    expect(all['flag.b']).toBe(false);
  });

  it('rollout 0% always returns false', () => {
    evaluator.setFlag('off.feature', { enabled: true, rolloutPercent: 0 });
    expect(evaluator.isEnabled('off.feature', 'user-1')).toBe(false);
  });

  it('rollout 100% always returns true', () => {
    evaluator.setFlag('on.feature', { enabled: true, rolloutPercent: 100 });
    expect(evaluator.isEnabled('on.feature', 'user-1')).toBe(true);
  });

  it('disabled rollout flag returns false regardless of percent', () => {
    evaluator.setFlag('disabled.feature', { enabled: false, rolloutPercent: 100 });
    expect(evaluator.isEnabled('disabled.feature', 'user-1')).toBe(false);
  });
});
