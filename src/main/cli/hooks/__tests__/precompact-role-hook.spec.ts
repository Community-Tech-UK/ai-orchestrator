import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const HOOK = path.resolve(__dirname, '..', 'precompact-role-hook.mjs');
const INPUT = JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null });

function run(role: string | undefined, input = INPUT) {
  return spawnSync(process.execPath, role === undefined ? [HOOK] : [HOOK, role], { input, encoding: 'utf8', timeout: 10_000 });
}

describe('PreCompact role hook', () => {
  it.each([
    ['queue-worker', ['job', 'plan file path', 'files you changed', 'last check', 'next step']],
    ['loop', ['open task ids', 'state folder', 'next step']],
    ['automation', ['scheduled task', 'what is left', 'next step']],
  ])('prints a short %s preservation block and exits 0', (role, mustMention) => {
    const result = run(role);
    expect(result.status).toBe(0);
    for (const phrase of mustMention) expect(result.stdout.toLowerCase()).toContain(phrase);
    // House style: a numeric size budget for the summary, and a bounded block.
    expect(result.stdout).toMatch(/at most [\d,]+ characters/);
    expect(result.stdout.length).toBeLessThan(700);
    expect(result.stderr).toBe('');
  });

  it('prints nothing for an unknown or missing role, and never blocks compaction', () => {
    for (const role of ['child', 'review', 'nope', '__proto__', 'constructor', undefined]) {
      const result = run(role);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
  });

  it('copes with empty or malformed hook input', () => {
    for (const input of ['', '{not json']) {
      const result = run('loop', input);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('open task ids');
    }
  });
});
