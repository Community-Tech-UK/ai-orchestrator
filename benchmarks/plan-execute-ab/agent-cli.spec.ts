import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseClaudeStream, parseCodexStream, runCodexAgent } from './agent-cli';

function resultEvent(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: 'result', ...fields });
}

describe('parseClaudeStream usage', () => {
  it('counts usage once when a result carries both aggregate usage and modelUsage', () => {
    // Regression: usage is the aggregate and modelUsage is the same invocation
    // split per model — adding both double-counts every token.
    const lines = [
      resultEvent({
        usage: { input_tokens: 100, output_tokens: 20 },
        modelUsage: {
          'claude-opus-5-5': { input_tokens: 100, output_tokens: 20 },
        },
      }),
    ];
    const state = parseClaudeStream(lines);
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(20);
  });

  it('sums modelUsage entries only when no aggregate usage is present', () => {
    const lines = [
      resultEvent({
        modelUsage: {
          'claude-opus-5-5': { input_tokens: 60, output_tokens: 10, cache_read_input_tokens: 5 },
          'claude-sonnet-5-5': { input_tokens: 40, output_tokens: 15, cache_creation_input_tokens: 2 },
        },
      }),
    ];
    const state = parseClaudeStream(lines);
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(25);
    expect(state.usage.cacheReadTokens).toBe(5);
    expect(state.usage.cacheWriteTokens).toBe(2);

    const emptyAggregate = parseClaudeStream([
      resultEvent({ usage: {}, modelUsage: { model: { input_tokens: 7, output_tokens: 3 } } }),
    ]);
    expect(emptyAggregate.usage.inputTokens).toBe(7);
    expect(emptyAggregate.usage.outputTokens).toBe(3);
  });

  it('takes the largest cumulative snapshot across result events instead of summing them', () => {
    // Claude Code re-emits cumulative usage at segment closes (non-decreasing,
    // with exact duplicate lines); summing snapshots recorded ~2x billed basis.
    const first = resultEvent({ usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 20 } });
    const later = resultEvent({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40 } });
    const state = parseClaudeStream([first, later, later]);
    expect(state.usage.inputTokens).toBe(100);
    expect(state.usage.outputTokens).toBe(20);
    expect(state.usage.cacheReadTokens).toBe(40);
  });

  it('keeps turns, tool errors and result text parsing unchanged', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'working' }] },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', is_error: true, content: 'npm test failed' }] },
      }),
      resultEvent({ subtype: 'success_max_turns', num_turns: 7, result: 'done', is_error: true }),
    ];
    const state = parseClaudeStream(lines);
    expect(state.turns).toBe(7);
    expect(state.hitTurnCap).toBe(true);
    expect(state.resultIsError).toBe(true);
    expect(state.finalText).toBe('done');
    expect(state.toolErrors).toEqual(['npm test failed']);
    expect(state.usage.outputTokens).toBe(0);
  });

  it('keeps message.usage from interrupted runs that never emit a result', () => {
    // Regression: real pilot runs killed at the wall clock recorded ZERO usage
    // for 911k/489k-token runs because only result events were read. The stream
    // repeats one message's usage on each of its content-block events, so usage
    // is summed once per message.id.
    const message = (id: string, usage: Record<string, unknown>, blocks: Record<string, unknown>[]): string[] =>
      blocks.map((block) => JSON.stringify({
        type: 'assistant',
        message: { id, content: [block], usage },
      }));
    const lines = [
      ...message('msg_1', { input_tokens: 25_000, output_tokens: 0, cache_read_input_tokens: 0 },
        [{ type: 'thinking', thinking: 'hmm' }]),
      ...message('msg_1', { input_tokens: 25_000, output_tokens: 0, cache_read_input_tokens: 0 },
        [{ type: 'tool_use', name: 'Read', input: {} }]),
      ...message('msg_2', { input_tokens: 26_000, output_tokens: 130, cache_read_input_tokens: 24_000 },
        [{ type: 'text', text: 'working' }]),
    ];
    const state = parseClaudeStream(lines);
    expect(state.usage.inputTokens).toBe(51_000);
    expect(state.usage.outputTokens).toBe(130);
    expect(state.usage.cacheReadTokens).toBe(24_000);
    // One assistant message is one turn, however many content-block events repeat it.
    expect(state.turns).toBe(2);
  });

  it('prefers the fuller of result snapshots and per-message sums without double-counting', () => {
    // A run interrupted AFTER a partial result snapshot must not drop the later
    // per-message usage; a completed run's aggregate (which carries output
    // tokens the local route leaves at 0 in message.usage) must not be doubled.
    const msg = (id: string, usage: Record<string, unknown>): string =>
      JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage } });
    const partial = parseClaudeStream([
      msg('msg_1', { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 0 }),
      resultEvent({ usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 0 } }),
      msg('msg_2', { input_tokens: 700, output_tokens: 60, cache_read_input_tokens: 0 }),
    ]);
    expect(partial.usage.inputTokens).toBe(1_200);
    expect(partial.usage.outputTokens).toBe(100);

    const complete = parseClaudeStream([
      msg('msg_1', { input_tokens: 941_183, output_tokens: 0, cache_read_input_tokens: 790_726 }),
      msg('msg_2', { input_tokens: 300_000, output_tokens: 0, cache_read_input_tokens: 200_000 }),
      resultEvent({ usage: { input_tokens: 1_241_183, output_tokens: 4_570, cache_read_input_tokens: 990_726 } }),
    ]);
    expect(complete.usage.inputTokens).toBe(1_241_183);
    expect(complete.usage.outputTokens).toBe(4_570);
    expect(complete.usage.cacheReadTokens).toBe(990_726);
  });

  it('falls back to message.usage when a result reports zero usage', () => {
    // The local serving route can close a result with an all-zero usage block
    // after real per-message volumes were streamed.
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 911_215, cache_read_input_tokens: 612_194 } },
      }),
      resultEvent({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }),
    ];
    const state = parseClaudeStream(lines);
    expect(state.usage.inputTokens).toBe(911_215);
    expect(state.usage.cacheReadTokens).toBe(612_194);
    expect(state.usage.outputTokens).toBe(0);
    expect(state.turns).toBe(1);
  });
});

describe('parseCodexStream usage', () => {
  it('sums per-turn usage additively (its events are per turn, not cumulative)', () => {
    const lines = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'a' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'b' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 7 } }),
    ];
    const state = parseCodexStream(lines);
    expect(state.usage.inputTokens).toBe(30);
    expect(state.usage.outputTokens).toBe(12);
    expect(state.turns).toBe(2);
  });
});

describe('parseCodexStream turns count model/tool cycles, not prompt turns', () => {
  const cycleEvents = (n: number): Record<string, unknown>[] => [
    { type: 'item.started', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
    { type: 'item.completed', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
    { type: 'item.started', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, status: 'in_progress' } },
    { type: 'item.completed', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, exit_code: 0, status: 'completed' } },
  ];

  it('counts five internal cycles inside one codex prompt turn as five turns', () => {
    // Regression: `turn.started` marks the whole submitted prompt ("a turn
    // encompasses all events while processing the prompt" — OpenAI's codex
    // sdk events.ts), so counting it reported turns=1 for a five-cycle run and
    // the shared turn cap never engaged for arm G.
    const lines = [
      JSON.stringify({ type: 'turn.started' }),
      ...[1, 2, 3, 4, 5].flatMap((n) => cycleEvents(n).map((e) => JSON.stringify(e))),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 5 } }),
    ];
    const state = parseCodexStream(lines);
    expect(state.turns).toBe(5);
  });

  it('counts the same cycles from completed-only streams (older fixtures)', () => {
    const lines = [
      JSON.stringify({ type: 'turn.started' }),
      ...[1, 2, 3].flatMap((n) => [
        JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: `s${n}`, exit_code: 0 } }),
      ]),
    ];
    expect(parseCodexStream(lines).turns).toBe(3);
  });

  it('counts one cycle per model response, however many items it emits', () => {
    // One response that reasoned, spoke and ran a tool is ONE model cycle —
    // the unit `claude --max-turns` counts (one assistant message).
    const lines = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.started', item: { id: 'r', type: 'reasoning', text: '' } }),
      JSON.stringify({ type: 'item.started', item: { id: 'm', type: 'agent_message', text: 'looking' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'looking' } }),
      JSON.stringify({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'ls', status: 'in_progress' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', exit_code: 0, status: 'completed' } }),
    ];
    expect(parseCodexStream(lines).turns).toBe(1);
  });
});

const fakeDirs: string[] = [];
afterEach(() => {
  for (const dir of fakeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeCodexScript(body: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-codex-cap-'));
  fakeDirs.push(dir);
  const script = join(dir, 'fake-codex.mjs');
  writeFileSync(script, `#!/usr/bin/env node\n${body}`);
  chmodSync(script, 0o755);
  return { dir, script };
}

function turnEvents(n: number, text: string): Record<string, unknown>[] {
  // One model/tool cycle inside one `codex exec` prompt turn: the model
  // reasoned, spoke and ran a tool (the real `reasoning -> message -> command`
  // response shape). `turn.started`/`turn.completed` wrap the WHOLE prompt.
  return [
    { type: 'turn.started' },
    { type: 'item.started', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
    { type: 'item.completed', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
    { type: 'item.completed', item: { id: `m-${n}`, type: 'agent_message', text } },
    { type: 'item.started', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, status: 'in_progress' } },
    { type: 'item.completed', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, exit_code: 0, status: 'completed' } },
    { type: 'turn.completed', usage: { input_tokens: n, output_tokens: 1 } },
  ];
}

describe('runCodexAgent turn cap (same cap as every arm)', () => {
  it('kills the run before an over-budget turn executes and reports the cap', async () => {
    // Regression: the Codex arm ignored request.maxTurns entirely, so arm G
    // got a bigger execution budget than the plan's shared turn cap allows.
    const marker = join(tmpdir(), `plan-ex-ab-turn3-ran-${process.pid}-${Date.now()}`);
    const events = [...turnEvents(1, 'turn-1'), ...turnEvents(2, 'turn-2')];
    const { dir, script } = fakeCodexScript([
      `import fs from 'node:fs';`,
      `const events = ${JSON.stringify(events)};`,
      `for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');`,
      // The 3rd cycle starts after the 2 allowed ones; its work runs 1s later,
      // so the marker proves whether the cap killed the child before it executed.
      `process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');`,
      `process.stdout.write(JSON.stringify({ type: 'item.started', item: { id: 'r-3', type: 'reasoning', text: '' } }) + '\\n');`,
      `setTimeout(() => {`,
      `  fs.writeFileSync(process.env.EXEC_MARKER, 'ran');`,
      `  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'r-3', type: 'reasoning', text: '' } }) + '\\n');`,
      `  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'm-3', type: 'agent_message', text: 'turn-3' } }) + '\\n');`,
      `  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 99, output_tokens: 99 } }) + '\\n');`,
      `}, 1000);`,
    ].join('\n'));
    const result = await runCodexAgent({
      prompt: 'p',
      cwd: dir,
      logPath: join(dir, 'logs', 'run.log'),
      timeoutMs: 15_000,
      maxTurns: 2,
      codexCommand: script,
      env: { ...process.env, EXEC_MARKER: marker },
    });
    expect(result.turns).toBe(2);
    expect(result.hitTurnCap).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('turn-2');
    expect(result.usage.inputTokens).toBe(3);
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });

  it('caps internal cycles when one codex prompt turn runs many of them', async () => {
    // Regression (verifier round): one `turn.started` with five sequential
    // reasoning/command cycles completed under maxTurns=2 with turns=1 and
    // hitTurnCap=false — the cap counted whole prompt turns, not the internal
    // model/tool cycles the shared limit is written in.
    const marker = join(tmpdir(), `plan-ex-ab-cycle3-ran-${process.pid}-${Date.now()}`);
    const cycles = (n: number): Record<string, unknown>[] => [
      { type: 'item.started', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
      { type: 'item.completed', item: { id: `r-${n}`, type: 'reasoning', text: '' } },
      { type: 'item.started', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, status: 'in_progress' } },
      { type: 'item.completed', item: { id: `c-${n}`, type: 'command_execution', command: `step ${n}`, exit_code: 0, status: 'completed' } },
    ];
    const { dir, script } = fakeCodexScript([
      `import fs from 'node:fs';`,
      `const out = (e) => process.stdout.write(JSON.stringify(e) + '\\n');`,
      `out({ type: 'turn.started' });`,
      `for (const e of ${JSON.stringify([...cycles(1), ...cycles(2)])}) out(e);`,
      `out({ type: 'item.started', item: { id: 'c-3', type: 'command_execution', command: 'step 3', status: 'in_progress' } });`,
      `setTimeout(() => {`,
      `  fs.writeFileSync(process.env.EXEC_MARKER, 'ran');`,
      `  for (const e of ${JSON.stringify([...cycles(4), ...cycles(5)])}) out(e);`,
      `  out({ type: 'item.completed', item: { id: 'm-5', type: 'agent_message', text: 'done' } });`,
      `  out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 5 } });`,
      `}, 1000);`,
    ].join('\n'));
    const result = await runCodexAgent({
      prompt: 'p',
      cwd: dir,
      logPath: join(dir, 'logs', 'run.log'),
      timeoutMs: 15_000,
      maxTurns: 2,
      codexCommand: script,
      env: { ...process.env, EXEC_MARKER: marker },
    });
    expect(result.turns).toBe(2);
    expect(result.hitTurnCap).toBe(true);
    expect(result.error).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    rmSync(marker, { force: true });
  });

  it('runs a short session to completion without touching the cap', async () => {
    const { dir, script } = fakeCodexScript([
      `const events = ${JSON.stringify([...turnEvents(1, 'first'), ...turnEvents(2, 'final answer')])};`,
      `for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');`,
    ].join('\n'));
    const result = await runCodexAgent({
      prompt: 'p',
      cwd: dir,
      logPath: join(dir, 'logs', 'run.log'),
      timeoutMs: 15_000,
      maxTurns: 5,
      codexCommand: script,
    });
    expect(result.turns).toBe(2);
    expect(result.hitTurnCap).toBe(false);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toBe('final answer');
    expect(result.usage.inputTokens).toBe(3);
  });

  it('does not flag the cap when the session ends exactly at the limit', async () => {
    const { dir, script } = fakeCodexScript([
      `const events = ${JSON.stringify([...turnEvents(1, 'first'), ...turnEvents(2, 'done')])};`,
      `for (const e of events) process.stdout.write(JSON.stringify(e) + '\\n');`,
    ].join('\n'));
    const result = await runCodexAgent({
      prompt: 'p',
      cwd: dir,
      logPath: join(dir, 'logs', 'run.log'),
      timeoutMs: 15_000,
      maxTurns: 2,
      codexCommand: script,
    });
    expect(result.turns).toBe(2);
    expect(result.hitTurnCap).toBe(false);
    expect(result.error).toBeUndefined();
  });
});
