/**
 * Exercises the REAL subprocess spawn → stdout-stream → close → parse pipeline of
 * BaseCliAdapter via {@link OutOfProcessFixtureAdapter} + the `cli-fixture-runner`
 * binary (backlog A6 out-of-process tail). Unlike the in-process ScriptedCliAdapter
 * tests, these actually fork a child process, so they cover line-buffering across
 * chunk boundaries, the `close` flush, exit codes and stderr — the base-class
 * machinery no other test touches.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OutOfProcessFixtureAdapter } from './out-of-process-fixture-adapter';
import { observeAdapterRuntimeEvents } from '../../providers/adapter-runtime-event-bridge';
import { ReceiptRecorder, drainRuntime } from './runtime-receipts';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE_RUNNER = join(SPEC_DIR, 'fixtures', 'cli-fixture-runner.mjs');

interface ScenarioStep {
  stream?: 'stdout' | 'stderr';
  data: string;
  delayMs?: number;
}

const tempDirs: string[] = [];

function writeScenario(steps: ScenarioStep[], exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-fixture-'));
  tempDirs.push(dir);
  const path = join(dir, 'scenario.json');
  writeFileSync(path, JSON.stringify({ steps, exitCode }), 'utf8');
  return path;
}

function ndjson(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

function makeAdapter(scenarioPath: string): OutOfProcessFixtureAdapter {
  return new OutOfProcessFixtureAdapter({ fixtureRunnerPath: FIXTURE_RUNNER, scenarioPath });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('OutOfProcessFixtureAdapter (real subprocess spawn + parse)', () => {
  it('spawns a real child process and resolves a parsed CliResponse with usage', async () => {
    const scenarioPath = writeScenario([
      { data: ndjson({ type: 'output', content: 'Hello, ' }) },
      { data: ndjson({ type: 'output', content: 'world.' }) },
      {
        data: ndjson({
          type: 'result',
          usage: {
            input_tokens: 1200,
            output_tokens: 340,
            cache_read_input_tokens: 200,
            cache_creation_input_tokens: 50,
          },
          total_cost_usd: 0.0123,
        }),
      },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const spawnedPids: number[] = [];
    adapter.on('spawned', (pid: number) => spawnedPids.push(pid));

    const response = await adapter.sendMessage({ role: 'user', content: 'hi' });

    expect(spawnedPids).toHaveLength(1);
    expect(spawnedPids[0]).toBeGreaterThan(0);
    expect(response.content).toBe('Hello, world.');
    expect(response.usage?.inputTokens).toBe(1200);
    expect(response.usage?.outputTokens).toBe(340);
    expect(response.usage?.cacheReadTokens).toBe(200);
    expect(response.usage?.cacheWriteTokens).toBe(50);
    expect(response.usage?.cost).toBe(0.0123);
    // duration is stamped by the adapter from the real wall-clock spawn.
    expect(typeof response.usage?.duration).toBe('number');
  });

  it('emits output events incrementally as the child streams (before close)', async () => {
    const scenarioPath = writeScenario([
      { data: ndjson({ type: 'output', content: 'one' }), delayMs: 5 },
      { data: ndjson({ type: 'tool_use', id: 't1', name: 'Read', input: { path: '/x' } }), delayMs: 5 },
      { data: ndjson({ type: 'output', content: 'two' }), delayMs: 5 },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const outputs: string[] = [];
    const toolUses: string[] = [];
    adapter.on('output', (m: { content?: string }) => outputs.push(m.content ?? ''));
    adapter.on('tool_use', (tc: { name: string }) => toolUses.push(tc.name));

    const response = await adapter.sendMessage({ role: 'user', content: 'go' });

    expect(outputs).toEqual(['one', 'two']);
    expect(toolUses).toEqual(['Read']);
    expect(response.content).toBe('onetwo');
    expect(response.toolCalls?.map((t) => t.name)).toEqual(['Read']);
  });

  it('reassembles a JSON line split across two stdout writes', async () => {
    const line = ndjson({ type: 'output', content: 'split-line-ok' });
    const cut = Math.floor(line.length / 2);
    const scenarioPath = writeScenario([
      { data: line.slice(0, cut), delayMs: 5 },
      { data: line.slice(cut), delayMs: 5 },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const outputs: string[] = [];
    adapter.on('output', (m: { content?: string }) => outputs.push(m.content ?? ''));

    const response = await adapter.sendMessage({ role: 'user', content: 'go' });

    // Despite arriving in two chunks, the line is parsed exactly once.
    expect(outputs).toEqual(['split-line-ok']);
    expect(response.content).toBe('split-line-ok');
  });

  it('surfaces child stderr as an adapter error event', async () => {
    const scenarioPath = writeScenario([
      { stream: 'stderr', data: 'a fixture warning\n' },
      { data: ndjson({ type: 'output', content: 'ok' }) },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const errors: string[] = [];
    adapter.on('error', (e: Error) => errors.push(e.message));

    const response = await adapter.sendMessage({ role: 'user', content: 'go' });

    expect(errors).toContain('a fixture warning');
    expect(response.content).toBe('ok');
  });

  it('emits an exit event carrying the real child exit code', async () => {
    const scenarioPath = writeScenario(
      [{ data: ndjson({ type: 'output', content: 'partial' }) }],
      3,
    );
    const adapter = makeAdapter(scenarioPath);

    const exits: Array<number | null> = [];
    adapter.on('exit', (code: number | null) => exits.push(code));

    // Non-zero exit but output present → still resolves with the partial parse.
    const response = await adapter.sendMessage({ role: 'user', content: 'go' });
    expect(response.content).toBe('partial');
    expect(exits).toEqual([3]);
  });

  it('rejects when the child exits non-zero with no output at all', async () => {
    const scenarioPath = writeScenario([], 1);
    const adapter = makeAdapter(scenarioPath);
    await expect(adapter.sendMessage({ role: 'user', content: 'go' })).rejects.toThrow(
      /fixture CLI exited with code 1/,
    );
  });

  it('streams output chunks through sendMessageStream', async () => {
    const scenarioPath = writeScenario([
      { data: ndjson({ type: 'output', content: 'alpha' }), delayMs: 3 },
      { data: ndjson({ type: 'output', content: 'beta' }), delayMs: 3 },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const chunks: string[] = [];
    for await (const chunk of adapter.sendMessageStream({ role: 'user', content: 'go' })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['alpha', 'beta']);
  });
});

describe('OutOfProcessFixtureAdapter drives the real runtime-event bridge', () => {
  it('normalizes real-subprocess lifecycle events into provider runtime events', async () => {
    const scenarioPath = writeScenario([
      { data: ndjson({ type: 'output', content: 'bridged' }) },
      {
        data: ndjson({
          type: 'result',
          usage: { input_tokens: 100, output_tokens: 25 },
          total_cost_usd: 0.004,
        }),
      },
    ]);
    const adapter = makeAdapter(scenarioPath);

    const recorder = new ReceiptRecorder(adapter);
    const events: Array<{ kind: string }> = [];
    const unobserve = observeAdapterRuntimeEvents(adapter, (e) => events.push(e.event));

    await adapter.sendMessage({ role: 'user', content: 'go' });
    await drainRuntime(recorder, { timeoutMs: 2000 });
    unobserve();
    recorder.dispose();

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('spawned');
    expect(kinds).toContain('output');
    expect(kinds).toContain('complete');
    expect(kinds).toContain('exit');
    // 'spawned' precedes 'complete' precedes 'exit' — the real ordering.
    expect(kinds.indexOf('spawned')).toBeLessThan(kinds.indexOf('complete'));

    const complete = events.find((e) => e.kind === 'complete') as
      | { kind: 'complete'; tokensUsed?: number; costUsd?: number }
      | undefined;
    expect(complete?.tokensUsed).toBe(125);
    expect(complete?.costUsd).toBe(0.004);
  });
});
