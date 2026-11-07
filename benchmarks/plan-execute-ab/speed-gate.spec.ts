import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  appendSpeedGateRecord,
  applySpeedGate,
  buildProbePrompt,
  latestSpeedGateByModel,
  loadSpeedGateLog,
  measureSpeed,
  probeLocalSpeed,
  speedGateDecisionFromEntries,
  speedGateLogPath,
} from './speed-gate';
import type { LocalArmEndpoint, SpeedGateSample } from './types';

const endpoint: LocalArmEndpoint = {
  modelKey: 'qwen3.8-flash-next',
  servedModelName: 'qwen3.8-flash-next',
  baseUrl: 'http://pc:1234',
  apiKeyEnv: 'PLAN_EX_AB_LOCAL_KEY',
  configDir: '/tmp/cfg',
  apiStyle: 'openai',
};

describe('speed gate', () => {
  it('includes response-body generation time when a server sends headers early', async () => {
    let clock = 0;
    let call = 0;
    const fetchImpl = (async () => {
      clock += 1_000;
      const response = new Response(JSON.stringify({ usage: { prompt_tokens: 30_000, completion_tokens: 200 } }));
      const readText = response.text.bind(response);
      const bodyDelay = call++ === 0 ? 9_000 : 19_000;
      response.text = async () => { clock += bodyDelay; return readText(); };
      return response;
    }) as typeof fetch;
    const sample = await measureSpeed({ endpoint, apiKey: 'key', fetchImpl, now: () => clock });
    expect(sample.durationMs).toBe(30_000);
    expect(sample.promptTokensPerSec).toBe(3_000);
    expect(sample.writeTokensPerSec).toBe(20);
  });

  it('builds a probe prompt around the 30k-token mark', () => {
    const prompt = buildProbePrompt(30_000);
    expect(prompt.length).toBeGreaterThanOrEqual(30_000 * 3);
    expect(prompt).toContain('speed measurement');
  });

  it('sends a supplied real prompt verbatim instead of the synthetic filler', async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 });
    }) as typeof fetch;
    await measureSpeed({
      endpoint,
      apiKey: 'key',
      fetchImpl,
      promptText: 'REAL_PROMPT_MARKER from a benchmark run transcript',
    });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toContain('REAL_PROMPT_MARKER from a benchmark run transcript');
      expect(body).not.toContain('reconcileLedger');
    }
  });

  it('passes when the server reports both speeds above the floor', () => {
    const decision = applySpeedGate({
      promptTokensPerSec: 770,
      writeTokensPerSec: 32,
      promptTokens: 30_000,
      writeTokens: 256,
      durationMs: 39_000,
      measuredPromptSpeed: true,
    });
    expect(decision?.keepC2).toBe(true);
  });

  it('withholds the verdict on a short prompt — it is not proof of the 30k workload', () => {
    // Regression (verifier round): a 10-token prompt with fast speeds returned
    // keepC2=true, banking a gate verdict that never measured the plan's real
    // 30k-token workload. The decision is withheld (null) until one is measured.
    expect(applySpeedGate({
      promptTokensPerSec: 400,
      writeTokensPerSec: 20,
      promptTokens: 10,
      writeTokens: 20,
      durationMs: 1_000,
      measuredPromptSpeed: true,
    })).toBeNull();
    expect(applySpeedGate({
      promptTokensPerSec: 400,
      writeTokensPerSec: 20,
      promptTokens: 29_999,
      writeTokens: 20,
      durationMs: 1_000,
      measuredPromptSpeed: true,
    })).toBeNull();
    // The protocol size is the boundary that decides.
    expect(applySpeedGate({
      promptTokensPerSec: 400,
      writeTokensPerSec: 20,
      promptTokens: 30_000,
      writeTokens: 20,
      durationMs: 1_000,
      measuredPromptSpeed: true,
    })?.keepC2).toBe(true);
  });

  it('fails when prompt speed is below 300 tok/s', () => {
    const decision = applySpeedGate({
      promptTokensPerSec: 220,
      writeTokensPerSec: 30,
      promptTokens: 30_000,
      writeTokens: 256,
      durationMs: 39_000,
      measuredPromptSpeed: true,
    });
    expect(decision?.keepC2).toBe(false);
    expect(decision?.reasons.join(' ')).toContain('below the 300 tok/s gate');
  });

  it('fails when write speed is below 15 tok/s', () => {
    const decision = applySpeedGate({
      promptTokensPerSec: 500,
      writeTokensPerSec: 12,
      promptTokens: 30_000,
      writeTokens: 256,
      durationMs: 39_000,
      measuredPromptSpeed: true,
    });
    expect(decision?.keepC2).toBe(false);
    expect(decision?.reasons.join(' ')).toContain('below the 15 tok/s gate');
  });

  it('fails honestly when prompt speed could not be measured', () => {
    const decision = applySpeedGate({
      promptTokensPerSec: 0,
      writeTokensPerSec: 20,
      promptTokens: 30_000,
      writeTokens: 256,
      durationMs: 39_000,
      measuredPromptSpeed: false,
    });
    expect(decision?.keepC2).toBe(false);
    expect(decision?.reasons.join(' ')).toContain('prompt speed unmeasured');
  });

  it('reads server timings when the endpoint reports them', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      timings: { prompt_n: 30_000, prompt_per_second: 640, predicted_n: 200, predicted_per_second: 18 },
      usage: { prompt_tokens: 30_000, completion_tokens: 200 },
    }), { status: 200 })) as typeof fetch;
    const sample = await measureSpeed({ endpoint, apiKey: 'key', fetchImpl });
    expect(sample.promptTokensPerSec).toBe(640);
    expect(sample.writeTokensPerSec).toBe(18);
    expect(sample.measuredPromptSpeed).toBe(true);
    expect(sample.source).toBe('server-timings');
  });

  it('derives both speeds from wall clock when timings are absent', async () => {
    // Fake clock: prompt probe takes 10s, write probe takes 20s (10s prompt + 10s write of 200 tokens).
    const times = [0, 10_000, 10_000, 30_000];
    let call = 0;
    const nowImpl = (): number => times[Math.min(call, times.length - 1)] ?? 0;
    const now = (): number => {
      const value = nowImpl();
      call += 1;
      return value;
    };
    const fetchImpl = (async () => new Response(JSON.stringify({
      usage: { prompt_tokens: 30_000, completion_tokens: 200 },
    }), { status: 200 })) as typeof fetch;
    const sample = await measureSpeed({ endpoint, apiKey: 'key', fetchImpl, now });
    expect(sample.measuredPromptSpeed).toBe(true);
    expect(sample.source).toBe('wall-clock');
    expect(sample.promptTokensPerSec).toBeCloseTo(3_000, 0);
    expect(sample.writeTokensPerSec).toBeCloseTo(20, 0);
  });

  it('fails closed when the write phase cannot be separated from prompt time', async () => {
    const nowImpl = (): number => 1; // both probes "take" 1ms
    const fetchImpl = (async () => new Response(JSON.stringify({
      usage: { prompt_tokens: 30_000, completion_tokens: 200 },
    }), { status: 200 })) as typeof fetch;
    const sample = await measureSpeed({ endpoint, apiKey: 'key', fetchImpl, now: nowImpl });
    expect(sample.writeTokensPerSec).toBe(0);
  });

  it('gives each probe a unique prompt prefix so no cache can help', async () => {
    const prompts: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      prompts.push(body.messages[0]?.content.slice(0, 40) ?? '');
      return new Response(JSON.stringify({
        usage: { prompt_tokens: 30_000, completion_tokens: 200 },
      }), { status: 200 });
    }) as typeof fetch;
    let n = 0;
    await measureSpeed({ endpoint, apiKey: 'key', fetchImpl, now: () => 1, nonce: () => `n${n++}` });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).not.toBe(prompts[1]);
    expect(prompts[0]).toContain('probe nonce n0');
    expect(prompts[1]).toContain('probe nonce n1');
  });

  it('throws loudly when the server rejects the probe', async () => {
    const fetchImpl = (async () => new Response('model not loaded', { status: 503 })) as typeof fetch;
    await expect(measureSpeed({ endpoint, apiKey: 'key', fetchImpl })).rejects.toThrow(/HTTP 503/);
  });
});

const sample: SpeedGateSample = {
  promptTokensPerSec: 400,
  writeTokensPerSec: 20,
  promptTokens: 30_000,
  writeTokens: 256,
  durationMs: 10_000,
  measuredPromptSpeed: true,
  source: 'wall-clock',
};

describe('speed gate persistence', () => {
  it('records every measurement with history and picks the newest C2 decision for reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-gate-'));
    const path = speedGateLogPath(dir);
    expect(loadSpeedGateLog(path).entries).toEqual([]);
    appendSpeedGateRecord(path, { modelKey: 'qwen3.8-27b', measuredAt: '2026-10-16T00:00:00Z', sample, decision: null });
    appendSpeedGateRecord(path, {
      modelKey: 'qwen3.8-flash-next',
      measuredAt: '2026-10-16T00:01:00Z',
      sample,
      decision: { keepC2: false, sample, reasons: ['below gate'] },
    });
    appendSpeedGateRecord(path, {
      modelKey: 'qwen3.8-flash-next',
      measuredAt: '2026-10-16T00:02:00Z',
      sample,
      decision: { keepC2: true, sample, reasons: ['clears gate'] },
    });
    const log = loadSpeedGateLog(path);
    expect(log.entries).toHaveLength(3);
    expect(speedGateDecisionFromEntries(log.entries)?.keepC2).toBe(true);
    expect(latestSpeedGateByModel(log.entries).map((entry) => entry.modelKey).sort()).toEqual([
      'qwen3.8-27b',
      'qwen3.8-flash-next',
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('has no gate decision until a Flash-Next measurement exists', () => {
    expect(speedGateDecisionFromEntries([])).toBeNull();
    expect(
      speedGateDecisionFromEntries([
        { modelKey: 'qwen3.8-27b', measuredAt: '2026-10-16T00:00:00Z', sample, decision: null },
      ]),
    ).toBeNull();
  });
});

describe('per-run local speed probe', () => {
  it('captures prompt and write speeds from the server when it answers', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      timings: { prompt_per_second: 500, predicted_per_second: 25 },
      usage: { prompt_tokens: 30_000, completion_tokens: 200 },
    }), { status: 200 })) as typeof fetch;
    const measured = await probeLocalSpeed(endpoint, 'key', { fetchImpl });
    expect(measured.source).toBe('server-timings');
    expect(measured.promptTokensPerSec).toBe(500);
    expect(measured.writeTokensPerSec).toBe(25);
    expect(measured.note).toBeUndefined();
  });

  it('records a failed probe as unmeasured with the reason, and never throws', async () => {
    const fetchImpl = (async () => new Response('model not loaded', { status: 503 })) as typeof fetch;
    const measured = await probeLocalSpeed(endpoint, 'key', { fetchImpl });
    expect(measured.source).toBe('unmeasured');
    expect(measured.promptTokensPerSec).toBeNull();
    expect(measured.writeTokensPerSec).toBeNull();
    expect(measured.note).toContain('run probe failed');
    expect(measured.note).toContain('HTTP 503');
  });
});
