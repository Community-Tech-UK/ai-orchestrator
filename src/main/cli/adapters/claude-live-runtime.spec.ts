/**
 * Claude live runtime switch (A8.3, Step 14d): model-id normalising and the
 * `get_settings` verification that guards every live switch.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ClaudeControlChannel, type ClaudeControlWriter } from './claude-control-channel';
import { applyClaudeLiveRuntime, cleanModelId, type LiveRuntimeHost } from './claude-live-runtime';

/** The pre-fix normaliser, kept verbatim as the equivalence oracle. */
const legacyCleanModelId = (value: string): string =>
  value.trim().toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '');

// Deterministic generator so a failure reproduces.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('cleanModelId', () => {
  it.each([
    ['  Claude-Opus-4-8[1M]  ', 'claude-opus-4-8'],
    ['claude-opus-4-8-20260401', 'claude-opus-4-8'],
    ['claude-opus-4-8-20260401[1m]', 'claude-opus-4-8'],
    ['claude-opus-4-8[1m]-20260401', 'claude-opus-4-8[1m]'],
    ['opus[1m]', 'opus'],
    ['claude-opus-4-8', 'claude-opus-4-8'],
    ['a[b]c]', 'a'],
    ['a[b[c]', 'a'],
    ['a[b\nc]', 'a[b\nc]'],
    ['a[b\n[c]', 'a[b\n'],
    ['', ''],
  ])('normalises %j to %j', (input, expected) => {
    expect(cleanModelId(input)).toBe(expected);
  });

  describe('equivalence with the original regex', () => {
    const edgeCases = [
      '', '[', ']', '[]', '][', '[[', ']]', '[]]', '[[]]', '[ ]', ' [] ', 'a[', 'a]', 'a[]', 'a[b]', 'a[b', 'a]b',
      'a[b]]', 'a[[b]]', 'a[b][c]', 'a[b]c', 'a[b]c[d]', '[a]b]', '\n', '[\n]', '[\n', '\n]', 'a[\n]', 'a[\nb]',
      'a[b\n]', 'a\n[b]', 'a[\n[b]', 'a[b\n[c]', 'a[b\n[c]\n', 'a[\r]', 'a[\rb]', 'a\r[b]', 'a[ ]',
      'a[ b]', 'a [b]', 'a [b]', 'a[\u0085]', 'a[\u000b]', 'a[\u000c]', 'a[ ]', 'A[B]',
      'İ[x]', 'İ[1M]', 'claude-opus-4-8[1m]', 'claude-opus-4-8[1m]\n', '\nclaude-opus-4-8[1m]',
      'claude-opus-4-8-20260401', 'claude-opus-4-8-2026040', 'claude-opus-4-8-202604011', '-20260401',
      '-20260401[1m]', '[1m]-20260401', 'x-20260401-20260401', 'x[-20260401]', '[-20260401]', ']-20260401',
    ];

    it('matches on hand-picked edge inputs', () => {
      for (const input of edgeCases) {
        expect(cleanModelId(input), JSON.stringify(input)).toBe(legacyCleanModelId(input));
      }
    });

    it('matches on every string up to length 6 over a bracket/newline/date alphabet', () => {
      const alphabet = ['[', ']', '\n', '\r', ' ', 'a', '-', '1'];
      const walk = (prefix: string, depth: number): void => {
        expect(cleanModelId(prefix), JSON.stringify(prefix)).toBe(legacyCleanModelId(prefix));
        if (depth === 0) return;
        for (const char of alphabet) walk(prefix + char, depth - 1);
      };
      walk('', 6);
    });

    it('matches on 30,000 random strings that include dates, spaces and unicode', () => {
      const alphabet = ['[', ']', '[', ']', '\n', '\r', ' ', ' ', ' ', '\t', 'a', 'B', 'o', 'p', 'u',
        's', '-', '-', '0', '1', '2', '8', 'İ', 'é', '\u{1F600}'];
      const random = makeRandom(20261020);
      for (let i = 0; i < 30_000; i++) {
        const length = Math.floor(random() * 24);
        let input = '';
        for (let j = 0; j < length; j++) input += alphabet[Math.floor(random() * alphabet.length)];
        // Half the time end it like a real id so the suffix branches run.
        const roll = random();
        if (roll < 0.25) input += '-20260401';
        else if (roll < 0.5) input += '[1m]';
        else if (roll < 0.6) input += '-20260401[1m]';
        expect(cleanModelId(input), JSON.stringify(input)).toBe(legacyCleanModelId(input));
      }
    });
  });

  describe('timing guard (the old regex was quadratic on many "[")', () => {
    const N = 200_000;
    const budgetMs = 750;

    it.each([
      ['an opening bracket flood', 'x' + '['.repeat(N)],
      ['an opening bracket flood that closes', 'x' + '['.repeat(N) + ']'],
      ['an opening bracket flood closed after a line break', 'x' + '['.repeat(N) + '\n]'],
      ['alternating brackets', '[]'.repeat(N / 2)],
      ['brackets split by line breaks', ('[' + '\n').repeat(N / 2) + ']'],
      ['a long run of dated segments', '-12345678'.repeat(N / 9)],
      ['only closing brackets', ']'.repeat(N)],
    ])('cleans %s in linear time', (_label, input) => {
      const started = performance.now();
      cleanModelId(input);
      expect(performance.now() - started).toBeLessThan(budgetMs);
    });

    it('survives the same flood when it arrives as the CLI\'s applied model', async () => {
      const commit = vi.fn();
      const flood = 'x' + '['.repeat(N);
      const started = performance.now();
      const result = await applyClaudeLiveRuntime({
        requestControl: async () => ({ ok: true, payload: { applied: { model: flood } } }),
        commit,
      }, { model: 'claude-opus-4-8' });
      expect(performance.now() - started).toBeLessThan(budgetMs);
      expect(result.ok).toBe(false);
      expect(commit).not.toHaveBeenCalled();
    });
  });
});

/**
 * Drives `applyClaudeLiveRuntime` through the REAL control channel, answering
 * in the wire shape Claude Code 2.1.303 sends:
 * `{type:'control_response', response:{subtype, request_id, response:<data>}}`.
 * `set_model` and `apply_flag_settings` succeed with no data; `get_settings`
 * carries `applied` one level inside the envelope.
 */
function realWireHost(applied: Record<string, unknown>) {
  const channel = new ClaudeControlChannel();
  const sent: string[] = [];
  const writer: ClaudeControlWriter = {
    sendControlRequest: async (subtype, requestId) => {
      sent.push(subtype);
      queueMicrotask(() => {
        channel.handleResponse({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            ...(subtype === 'get_settings' ? { response: { applied } } : {}),
          },
        });
      });
    },
  };
  const commit = vi.fn<LiveRuntimeHost['commit']>();
  const host: LiveRuntimeHost = {
    requestControl: (subtype, fields, timeoutMs) => channel.request(writer, subtype, fields, { timeoutMs }),
    commit,
  };
  return { host, commit, sent };
}

describe('applyClaudeLiveRuntime effort verification (real wire shape)', () => {
  it('commits when the CLI reports the requested effort, ignoring case and spacing', async () => {
    const { host, commit, sent } = realWireHost({ effort: ' HIGH ' });
    await expect(applyClaudeLiveRuntime(host, { effort: 'high' })).resolves.toEqual({ ok: true });
    expect(sent).toEqual(['apply_flag_settings', 'get_settings']);
    expect(commit).toHaveBeenCalledWith(undefined, 'high');
  });

  it.each([
    ['the old effort is still applied', 'low', { effort: 'high' }],
    ['the CLI drops an unsupported effort and reports none', 'minimal', { effort: null }],
    ['the CLI drops an unsupported effort and the old one stays', 'minimal', { effort: 'high' }],
    ['the reply carries no effort at all', 'low', {}],
    ['the reply carries a non-string effort', 'low', { effort: 3 }],
    ['the reply has no applied block', 'low', undefined],
  ] as const)('fails and commits nothing when %s', async (_label, requested, applied) => {
    const { host, commit, sent } = realWireHost(applied as Record<string, unknown>);
    const result = await applyClaudeLiveRuntime(host, { effort: requested });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining(`switching to ${requested}`) });
    // The effort was sent and read back; only the read-back disagreed.
    expect(sent).toEqual(['apply_flag_settings', 'get_settings']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('fails a combined switch when the model took but the effort did not', async () => {
    const { host, commit, sent } = realWireHost({ model: 'claude-opus-4-8', effort: 'high' });
    const result = await applyClaudeLiveRuntime(host, { model: 'claude-opus-4-8', effort: 'minimal' });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('effort high') });
    expect(sent).toEqual(['set_model', 'apply_flag_settings', 'get_settings']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('still commits a combined switch when both read back correctly', async () => {
    const { host, commit } = realWireHost({ model: 'claude-opus-4-8', effort: 'low' });
    await expect(applyClaudeLiveRuntime(host, { model: 'claude-opus-4-8', effort: 'low' })).resolves.toEqual({ ok: true });
    expect(commit).toHaveBeenCalledWith('claude-opus-4-8', 'low');
  });
});
