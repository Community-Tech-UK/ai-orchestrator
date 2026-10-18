import { describe, expect, it } from 'vitest';
import { buildWorkerArgs } from './cli-adapter-worker-args';
import { buildClaudeCliArgs } from '../adapters/claude-cli-argv-builder';

describe('worker Claude turn caps', () => {
  it.each([1, 8, 50])('forwards the positive integer cap %s', maxTurns => {
    const args = buildWorkerArgs('claude', { maxTurns, maxBudgetUsd: 1 }, 'fixture', { role: 'user', content: 'review' });
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', String(maxTurns)]);
    expect(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '1']);
  });

  it.each([undefined, 0, -1, 0.5, NaN, Infinity, -Infinity])('omits invalid or absent cap %s', maxTurns => {
    const args = buildWorkerArgs('claude', { maxTurns }, 'fixture', { role: 'user', content: 'review' });
    expect(args).not.toContain('--max-turns');
  });

  it('retains a turn cap on resume while omitting the fresh-session budget', () => {
    const args = buildWorkerArgs('claude', { resume: true, maxTurns: 8, maxBudgetUsd: 1 }, 'fixture', { role: 'user', content: 'review' });
    expect(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2)).toEqual(['--max-turns', '8']);
    expect(args).toContain('--resume');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('keeps Gemini free of unsupported Claude caps', () => {
    const args = buildWorkerArgs('gemini', { maxTurns: 8, maxBudgetUsd: 1 }, null, { role: 'user', content: 'review' });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('matches the existing direct Claude eight-turn and fresh-budget behavior', () => {
    const options = { maxTurns: 8, maxBudgetUsd: 1 };
    const direct = buildClaudeCliArgs({ spawnOptions: options, sessionId: null,
      excludeDynamicSectionsSupported: null, cliVersion: null, disallowedToolsOverride: null,
      shouldUseNativeResume: false, shouldUsePermissionHook: false, materializeInlineJsonArg: value => value });
    const worker = buildWorkerArgs('claude', options, null, { role: 'user', content: 'review' });
    for (const flag of ['--max-turns', '--max-budget-usd']) {
      expect(worker.slice(worker.indexOf(flag), worker.indexOf(flag) + 2))
        .toEqual(direct.slice(direct.indexOf(flag), direct.indexOf(flag) + 2));
    }
  });
});
