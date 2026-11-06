import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BudgetExhaustedError,
  OWNER_MARKER,
  SpendLedger,
  claimSandbox,
  cleanupSandbox,
  parseCliJson,
  prepareChat,
  projectDirFor,
  runChat,
  type ClaudeInvocation,
  type ClaudeRunner,
  type PipelineDeps,
  type SandboxClaim,
} from './recall-pipeline';

// Everything below is synthetic: no real transcript text is used or written.
const SESSION = '11111111-2222-3333-4444-555555555555';
const FORK_BEFORE = 'aaaaaaaa-0000-0000-0000-000000000001';
const usage = (context: number) => ({ input_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: context - 50, output_tokens: 5 });
const assistant = (id: string, context: number, text = `reply ${id}`): string =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { id, role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: usage(context) } });
const human = (text: string): string => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });

function transcript(): string[] {
  const lines: string[] = [];
  const facts = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  const filler = ' and then the usual checks were run afterwards'.repeat(6);
  for (let index = 0; index < 70; index++) {
    lines.push(human(`Step ${index}: please set option ${facts[index % 6]}-${index} to value ${index * 3}`));
    lines.push(assistant(`m${index}`, 10_000 + index * 4_000, `Set option ${facts[index % 6]}-${index} to value ${index * 3} as requested${filler}.`));
  }
  return lines;
}

const questionsJson = (excerpt: string): string => {
  const lines = excerpt.split('\n').filter(line => line.startsWith('ASSISTANT: Set option'));
  return JSON.stringify(lines.slice(0, 6).map(line => {
    const match = /option (\S+) to value (\d+)/.exec(line)!;
    return { question: `What value was option ${match[1]} set to in the setup chat?`, answer: match[2], evidence: `Set option ${match[1]} to value ${match[2]}` };
  }));
};

const result = (over: Record<string, unknown> = {}): string => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: FORK_BEFORE, total_cost_usd: 0.25, modelUsage: { 'claude-sonnet-5-5': {} }, ...over });

describe('parseCliJson', () => {
  it('reads the result object, from a single object or an event array, and never trusts is_error', () => {
    expect(parseCliJson(result({ result: 'hello' }))).toMatchObject({ result: 'hello', sessionId: FORK_BEFORE, costUsd: 0.25, model: 'claude-sonnet-5-5', isError: false });
    expect(parseCliJson(JSON.stringify([{ type: 'system' }, JSON.parse(result({ is_error: true, subtype: 'error_max_budget_usd' }))]))).toMatchObject({ isError: true, subtype: 'error_max_budget_usd' });
    expect(() => parseCliJson('not json')).toThrow(/no result/);
  });
});

describe('SpendLedger', () => {
  it('hands out the smaller of the per-call cap and what is left, and refuses when nothing is left', () => {
    const ledger = new SpendLedger(1);
    expect(ledger.capFor(0.4)).toBe(0.4);
    ledger.charge(0.8);
    expect(ledger.capFor(0.4)).toBeCloseTo(0.2, 6);
    ledger.charge(0.19);
    expect(() => ledger.capFor(0.4)).toThrow(BudgetExhaustedError);
    expect(ledger.spent).toBeCloseTo(0.99, 6);
  });
});

describe('recall pipeline', () => {
  let root: string;
  let sandbox: string;
  let projects: string;
  let calls: ClaudeInvocation[];
  let runner: ClaudeRunner;
  let judgeSwapped: boolean[] | null;
  let claim: SandboxClaim;
  const deps = (over: Partial<PipelineDeps> = {}): PipelineDeps => ({
    runner: (invocation) => runner(invocation), sandboxCwd: sandbox, projectsRoot: projects, claim, model: 'sonnet[1m]', helperModel: 'sonnet',
    ledger: new SpendLedger(10), perCallCapUsd: 3, log: () => undefined, now: () => new Date('2026-10-25T12:00:00Z'), ...over,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aio-recall-'));
    sandbox = join(root, 'sandbox');
    projects = join(root, 'projects');
    mkdirSync(sandbox, { recursive: true });
    mkdirSync(projects, { recursive: true });
    claim = claimSandbox(projects, sandbox, 'run-token-1');
    calls = [];
    judgeSwapped = null;
    runner = async (invocation) => {
      calls.push(invocation);
      const prompt = invocation.stdin ?? invocation.args.at(-1) ?? '';
      const folder = projectDirFor(projects, sandbox);
      const allocated = invocation.args.includes('--session-id') ? invocation.args[invocation.args.indexOf('--session-id') + 1] : null;
      if (prompt.includes('memory test about part of')) return { exitCode: 0, stdout: result({ result: questionsJson(prompt) }), stderr: '' };
      if (invocation.args.some(arg => arg.startsWith('/compact'))) {
        writeFileSync(join(folder, `${allocated}.jsonl`), [assistant('x', 5_000), JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 290_000, postTokens: 21_000 } })].join('\n') + '\n');
        return { exitCode: 0, stdout: result({ session_id: allocated }), stderr: '' };
      }
      if (prompt.startsWith('Answer these questions')) {
        const count = prompt.split('\n').filter(line => /^\d+\. /.test(line)).length;
        const resumed = invocation.args[invocation.args.indexOf('--resume') + 1];
        const answers = Array.from({ length: count }, (_, index) => (resumed === SESSION ? `answer ${index}` : "don't remember"));
        return { exitCode: 0, stdout: result({ result: JSON.stringify(answers), session_id: allocated ?? resumed, total_cost_usd: resumed === SESSION ? 0.25 : 0.29 }), stderr: '' };
      }
      if (prompt.startsWith('You are grading')) {
        const count = prompt.split('\n').filter(line => /^\d+\. Question:/.test(line)).length;
        const aLines = prompt.split('\n').filter(line => line.startsWith('   A: '));
        judgeSwapped = aLines.map(line => line.includes("don't remember"));
        const grades = aLines.map((line, index) => ({ q: index + 1, a: line.includes("don't remember") ? 'unknown' : 'correct', b: line.includes("don't remember") ? 'correct' : 'unknown' }));
        return { exitCode: 0, stdout: result({ result: JSON.stringify(grades.slice(0, count)) }), stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('prepares a chat: cuts near the target, installs a read-only copy, and writes validated questions from three early windows', async () => {
    const lines = transcript();
    const prepared = await prepareChat(deps(), { lines, sessionId: SESSION, chatKey: 'chat1' });
    expect(prepared.kind).toBe('ready');
    if (prepared.kind !== 'ready') return;
    expect(prepared.cut.contextTokens).toBeLessThanOrEqual(300_000);
    expect(prepared.cut.contextTokens).toBeGreaterThanOrEqual(255_000);
    expect(prepared.questions.length).toBeGreaterThanOrEqual(10);
    expect(prepared.questions.length).toBeLessThanOrEqual(15);
    const copy = join(projectDirFor(projects, sandbox), `${SESSION}.jsonl`);
    expect(readFileSync(copy, 'utf8').split('\n').filter(Boolean)).toEqual(lines.slice(0, prepared.cut.cutLine + 1));
    const generation = calls.filter(call => (call.stdin ?? '').includes('memory test about part of'));
    expect(generation).toHaveLength(3);
    for (const call of generation) {
      expect(call.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--tools', '', '--output-format', 'json', '--max-budget-usd']));
      expect(call.args).not.toContain('--resume');
      expect(call.args.join(' ')).not.toContain('Step 1');
    }
  });

  it('places the question windows by the conversation\'s own growth, not by the fixed prompt overhead every chat starts with', async () => {
    const overhead = 40_000;
    const filler = ' and then the usual checks were run afterwards'.repeat(6);
    const heavy: string[] = [];
    for (let index = 0; index < 130; index++) {
      heavy.push(human(`Step ${index}: please set option opt-${index} to value ${index * 3}`));
      heavy.push(assistant(`m${index}`, overhead + index * 2_000, `Set option opt-${index} to value ${index * 3} as requested${filler}.`));
    }
    const prepared = await prepareChat(deps(), { lines: heavy, sessionId: SESSION, chatKey: 'heavy' });
    expect(prepared.kind).toBe('ready');
    expect(calls.filter(call => (call.stdin ?? '').includes('memory test about part of'))).toHaveLength(3);
  });

  it('skips chats that are not a clean sample, without spending anything', async () => {
    const small = transcript().slice(0, 12);
    expect(await prepareChat(deps(), { lines: small, sessionId: SESSION, chatKey: 'c' })).toMatchObject({ kind: 'skipped', reason: 'no-cut' });
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
    const compacted = [...transcript().slice(0, 4), boundary, ...transcript().slice(4)];
    expect(await prepareChat(deps(), { lines: compacted, sessionId: SESSION, chatKey: 'c' })).toMatchObject({ kind: 'skipped', reason: 'already-compacted' });
    const fewPrompts = transcript().filter((line, index) => !line.includes('"role":"user"') || index < 8);
    expect(await prepareChat(deps(), { lines: fewPrompts, sessionId: SESSION, chatKey: 'c' })).toMatchObject({ kind: 'skipped', reason: 'too-few-prompts' });
    expect(calls).toHaveLength(0);
  });

  it('skips when too few valid questions can be made', async () => {
    runner = async (invocation) => { calls.push(invocation); return { exitCode: 0, stdout: result({ result: '[]' }), stderr: '' }; };
    expect(await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'c' })).toMatchObject({ kind: 'skipped', reason: 'too-few-questions' });
  });

  it('runs before, compaction, after and a blind judge, and returns counts only', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    calls = [];
    const outcome = await runChat(deps(), prepared);
    const n = prepared.questions.length;
    expect(outcome.before).toEqual({ correct: n, partial: 0, wrong: 0, unknown: 0 });
    expect(outcome.after).toEqual({ correct: 0, partial: 0, wrong: 0, unknown: n });
    expect(outcome.compaction).toEqual({ boundaries: 1, preTokens: 290_000, postTokens: 21_000 });
    expect(outcome).toMatchObject({ chatKey: 'chat1', questionCount: n, contextTokensAtCut: prepared.cut.contextTokens, humanPrompts: 70 });
    // before 0.25 + summary 0.25 + after 0.04 (the CLI reports 0.29 in total, 0.25 of it already paid for) + grading 0.25
    expect(outcome.costUsd).toBeCloseTo(0.79, 6);
    expect(judgeSwapped!.some(Boolean) && judgeSwapped!.some(flag => !flag)).toBe(true);
    const [before, compact, after] = calls;
    expect(before.args).toEqual(expect.arrayContaining(['--resume', SESSION, '--fork-session', '--tools', '', '--model', 'sonnet[1m]']));
    expect(compact.args).toEqual(expect.arrayContaining(['--resume', SESSION, '--fork-session', '/compact']));
    expect(after.args).toEqual(expect.arrayContaining(['--resume', compact.args[compact.args.indexOf('--session-id') + 1]]));
    expect(after.args).not.toContain('--fork-session');
    expect(JSON.stringify(outcome)).not.toMatch(/option|Step/);
  });

  it('stops before a call that the spend limit cannot cover and never prints transcript text in errors', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    await expect(runChat(deps({ ledger: new SpendLedger(0.3) }), prepared)).rejects.toBeInstanceOf(BudgetExhaustedError);
    runner = async () => ({ exitCode: 1, stdout: `{"result":"SECRET TEXT ${'x'.repeat(10)}"}`, stderr: 'SECRET STDERR' });
    const failure = await runChat(deps(), prepared).then(() => null, (error: Error) => error);
    expect(failure?.message).toMatch(/exit 1/);
    expect(failure?.message).not.toMatch(/SECRET/);
  });

  it('treats a compaction request that left no boundary as a failure', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    const original = runner;
    runner = async (invocation) => {
      if (invocation.args.some(arg => arg.startsWith('/compact'))) {
        const id = invocation.args[invocation.args.indexOf('--session-id') + 1];
        writeFileSync(join(projectDirFor(projects, sandbox), `${id}.jsonl`), assistant('x', 5_000) + '\n');
        return { exitCode: 0, stdout: result({ session_id: id }), stderr: '' };
      }
      return original(invocation);
    };
    await expect(runChat(deps(), prepared)).rejects.toThrow(/no compaction/);
  });

  it('keeps only the preallocated fork identities when a later phase fails', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    const original = runner;
    runner = async invocation => {
      if (!invocation.args.includes('/compact')) return original(invocation);
      calls.push(invocation);
      return { exitCode: 1, stdout: result({ session_id: invocation.args[invocation.args.indexOf('--session-id') + 1], is_error: true }), stderr: '' };
    };
    const ids: string[] = [];
    await expect(runChat(deps({ onForkSession: id => ids.push(id) }), prepared)).rejects.toThrow(/summarising/);
    expect(ids).toHaveLength(2);
    const forkCalls = calls.filter(call => call.args.includes('--fork-session'));
    expect(ids[0]).toBe(forkCalls[0].args[forkCalls[0].args.indexOf('--session-id') + 1]);
    expect(ids[1]).toBe(forkCalls[1].args[forkCalls[1].args.indexOf('--session-id') + 1]);
  });

  it('rejects a different reported session without authorizing cleanup of its files', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    const ids: string[] = [];
    runner = async () => ({ exitCode: 0, stdout: result({ session_id: 'unowned-session-placeholder' }), stderr: '' });
    await expect(runChat(deps({ onForkSession: id => ids.push(id) }), prepared)).rejects.toThrow(/unexpected fork session/);
    expect(ids).toHaveLength(1);
    expect(ids).not.toContain('unowned-session-placeholder');
  });

  it('registers an allocated fork before starting a call which yields no result at all', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    const ids: string[] = [];
    runner = async invocation => {
      expect(ids).toEqual([invocation.args[invocation.args.indexOf('--session-id') + 1]]);
      throw new Error('synthetic transport failure');
    };
    await expect(runChat(deps({ onForkSession: id => ids.push(id) }), prepared)).rejects.toThrow('synthetic transport failure');
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBe(SESSION);
  });

  it('refuses a timed-out call even when its final result and exit code otherwise claim success', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    runner = async invocation => ({ exitCode: 0, stdout: result({ result: '["answer"]', session_id: invocation.args[invocation.args.indexOf('--session-id') + 1] }), stderr: '', timedOut: true });
    await expect(runChat(deps(), prepared)).rejects.toThrow(/failed during answering/);
  });

  it('never adopts a project folder that already exists, and never overwrites a transcript', async () => {
    const existing = join(root, 'existing-projects');
    const otherCwd = join(root, 'other-sandbox');
    mkdirSync(otherCwd, { recursive: true });
    mkdirSync(join(existing, 'x'), { recursive: true });
    const taken = projectDirFor(existing, otherCwd);
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'keep.txt'), 'precious');
    expect(() => claimSandbox(existing, otherCwd)).toThrow(/already exists/);
    expect(readFileSync(join(taken, 'keep.txt'), 'utf8')).toBe('precious');
    const copy = join(claim.folder, `${SESSION}.jsonl`);
    writeFileSync(copy, 'existing transcript\n');
    await expect(prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'c' })).rejects.toThrow(/EEXIST|exists/);
    expect(readFileSync(copy, 'utf8')).toBe('existing transcript\n');
  });

  it('marks the folder it created and only removes a folder that carries its own marker', () => {
    expect(readFileSync(join(claim.folder, OWNER_MARKER), 'utf8')).toContain('run-token-1');
    writeFileSync(join(claim.folder, `${SESSION}.jsonl`), '{}\n');
    mkdirSync(join(claim.folder, SESSION, 'nested'), { recursive: true });
    writeFileSync(join(claim.folder, SESSION, 'nested', 'fork.jsonl'), '{}\n');
    const unrelated = join(projects, 'some-other-project');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'keep.jsonl'), '{}\n');
    expect(cleanupSandbox(projects, sandbox, { ...claim, token: 'someone-else' })).toMatchObject({ removedDirectory: false, refused: expect.stringMatching(/marker/) });
    expect(existsSync(claim.folder)).toBe(true);
    expect(cleanupSandbox(projects, sandbox, claim)).toEqual({ removedFiles: 2, removedDirectory: true });
    expect(existsSync(claim.folder)).toBe(false);
    expect(readdirSync(unrelated)).toEqual(['keep.jsonl']);
  });

  it('refuses to clean up a folder without a marker, a replaced folder, or a path outside the projects root', () => {
    rmSync(join(claim.folder, OWNER_MARKER));
    expect(cleanupSandbox(projects, sandbox, claim)).toMatchObject({ removedDirectory: false, refused: expect.stringMatching(/marker/) });
    expect(existsSync(claim.folder)).toBe(true);
    expect(cleanupSandbox(projects, sandbox, { ...claim, folder: join(projects, 'elsewhere') })).toMatchObject({ removedDirectory: false });
    expect(cleanupSandbox(projects, sandbox, { ...claim, folder: projects })).toMatchObject({ removedDirectory: false });
    rmSync(claim.folder, { recursive: true });
    const decoy = join(root, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, OWNER_MARKER), JSON.stringify({ token: 'run-token-1' }));
    symlinkSync(decoy, claim.folder);
    expect(cleanupSandbox(projects, sandbox, claim)).toMatchObject({ removedDirectory: false, refused: expect.stringMatching(/symbolic|link|directory/) });
    expect(existsSync(join(decoy, OWNER_MARKER))).toBe(true);
  });

  it('gives copies and forks of one conversation the same key, and different conversations different keys', async () => {
    const copy = transcript().map(line => line.replace(/^\{/, '{"sessionId":"another-session","cwd":"/elsewhere",'));
    const first = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'a' });
    rmSync(join(claim.folder, `${SESSION}.jsonl`));
    const second = await prepareChat(deps(), { lines: copy, sessionId: SESSION, chatKey: 'b' });
    rmSync(join(claim.folder, `${SESSION}.jsonl`));
    const different = await prepareChat(deps(), { lines: transcript().map(line => line.replace(/"id":"m(\d+)"/, '"id":"n$1"')), sessionId: SESSION, chatKey: 'c' });
    if (first.kind !== 'ready' || second.kind !== 'ready' || different.kind !== 'ready') throw new Error('not ready');
    expect(first.conversationKey).toMatch(/^[0-9a-f]{12}$/);
    expect(second.conversationKey).toBe(first.conversationKey);
    expect(different.conversationKey).not.toBe(first.conversationKey);
  });

  it('passes optional summarising instructions to /compact, and nothing extra by default', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    calls = [];
    await runChat(deps(), prepared);
    expect(calls.find(call => call.args.some(arg => arg.startsWith('/compact')))!.args.at(-1)).toBe('/compact');
    calls = [];
    await runChat(deps({ compactInstructions: '  Keep exact file names and numbers.  ' }), prepared);
    const custom = calls.find(call => call.args.at(-1)?.startsWith('/compact'))!;
    expect(custom.args.slice(-2)).toEqual(['--', '/compact Keep exact file names and numbers.']);
  });

  it('charges only what each call added, because a resumed session carries its earlier total into every reply', async () => {
    const carried = 99;
    const costState = JSON.stringify({ type: 'cost-state', totalCostUSD: carried, modelUsage: {}, sessionId: 's', startTime: 1 });
    const seeded = [...transcript().slice(0, 20), costState, ...transcript().slice(20)];
    runner = async (invocation) => {
      calls.push(invocation);
      const prompt = invocation.stdin ?? invocation.args.at(-1) ?? '';
      const folder = projectDirFor(projects, sandbox);
      const allocated = invocation.args.includes('--session-id') ? invocation.args[invocation.args.indexOf('--session-id') + 1] : null;
      if (prompt.includes('memory test about part of')) return { exitCode: 0, stdout: result({ result: questionsJson(prompt), total_cost_usd: 0.05 }), stderr: '' };
      if (invocation.args.some(arg => arg.startsWith('/compact'))) {
        writeFileSync(join(folder, `${allocated}.jsonl`), [assistant('x', 5_000), JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 290_000, postTokens: 21_000 } })].join('\n') + '\n');
        return { exitCode: 0, stdout: result({ session_id: allocated, total_cost_usd: carried + 0.6 }), stderr: '' };
      }
      if (prompt.startsWith('Answer these questions')) {
        const count = prompt.split('\n').filter(line => /^\d+\. /.test(line)).length;
        const full = invocation.args[invocation.args.indexOf('--resume') + 1] === SESSION;
        return { exitCode: 0, stdout: result({ result: JSON.stringify(Array.from({ length: count }, (_, index) => `answer ${index}`)), session_id: allocated ?? invocation.args[invocation.args.indexOf('--resume') + 1], total_cost_usd: full ? carried + 1.0 : carried + 0.6 + 0.04 }), stderr: '' };
      }
      const count = prompt.split('\n').filter(line => /^\d+\. Question:/.test(line)).length;
      return { exitCode: 0, stdout: result({ result: JSON.stringify(Array.from({ length: count }, (_, index) => ({ q: index + 1, a: 'correct', b: 'correct' }))), total_cost_usd: 0.02 }), stderr: '' };
    };
    const ledger = new SpendLedger(9);
    const prepared = await prepareChat(deps({ ledger }), { lines: seeded, sessionId: SESSION, chatKey: 'seeded' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    expect(prepared.seedCostUsd).toBeCloseTo(carried, 6);
    const outcome = await runChat(deps({ ledger }), prepared);
    // 1.00 for the full-chat answers, 0.60 for summarising, 0.04 for answering afterwards, 0.02 grading: never the carried 99.
    expect(outcome.costUsd).toBeCloseTo(1.66, 6);
    expect(ledger.spent).toBeCloseTo(1.66 + 3 * 0.05, 6);
  });

  it('charges a reply in full when its total is below what the session carried, because the carried amount cannot be trusted then', async () => {
    const costState = JSON.stringify({ type: 'cost-state', totalCostUSD: 50, modelUsage: {} });
    const prepared = await prepareChat(deps(), { lines: [...transcript().slice(0, 20), costState, ...transcript().slice(20)], sessionId: SESSION, chatKey: 'odd' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    const ledger = new SpendLedger(9);
    await runChat(deps({ ledger }), prepared);
    expect(ledger.spent).toBeGreaterThanOrEqual(0.25 * 3);
  });

  it('keeps every call away from user and project settings, hooks and MCP servers', async () => {
    const prepared = await prepareChat(deps(), { lines: transcript(), sessionId: SESSION, chatKey: 'chat1' });
    if (prepared.kind !== 'ready') throw new Error('not ready');
    await runChat(deps(), prepared);
    expect(calls.length).toBeGreaterThanOrEqual(7);
    for (const call of calls) {
      const at = (flag: string): string | undefined => call.args[call.args.indexOf(flag) + 1];
      expect(at('--setting-sources'), call.args.join(' ')).toBe('');
      expect(at('--tools')).toBe('');
      expect(call.args).toContain('--strict-mcp-config');
      expect(JSON.parse(at('--mcp-config')!)).toEqual({ mcpServers: {} });
    }
    const compact = calls.find(call => call.args.includes('/compact'))!;
    expect(compact.args.at(-2)).toBe('--');
    expect(compact.args.at(-1)).toBe('/compact');
  });
});
