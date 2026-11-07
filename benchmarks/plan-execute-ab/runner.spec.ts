import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdPlan, cmdRun, cmdSpeedGate, type CliOptions } from './runner';
import { finalizeScoredRun } from './session';
import * as agentCli from './agent-cli';
import * as scoringSetup from './scoring-setup';
import { ModelControl } from './model-control';
import { createFixtureRepo } from './self-test';
import { emptyUsage, type AgentRunResult, type BenchmarkReport, type RunRecord } from './types';

function fixtureBank(taskId: string, repoId = 'ghost-repo', taskCount = 1): Record<string, unknown> {
  const task = (id: string, n: number): Record<string, unknown> => ({
    id,
    repoId,
    commitSha: `b${n.toString().padStart(39, '0')}`,
    parentSha: `a${n.toString().padStart(39, '0')}`,
    commitMessage: 'add a widget',
    size: 'small',
    prompt: 'Add a widget.',
    hiddenTests: ['widget.spec.ts'],
    hiddenTestCommand: ['npm', 'test'],
    damageCommands: [],
    sourceFiles: ['widget.ts'],
    verification: { failOnParent: true, passOnCommit: true, checkedAt: '2026-10-16', evidenceDir: '/tmp/fixture-evidence' },
  });
  return {
    version: 1,
    createdAt: '2026-10-16T00:00:00Z',
    repos: [{ id: repoId, localPath: '/nonexistent-repo', stack: 'test', notes: 'fixture' }],
    tasks: [
      task(taskId, 1),
      ...Array.from({ length: Math.max(0, taskCount - 1) }, (_, index) => task(`FILL-${index + 2}`, index + 2)),
    ],
  };
}

const sandboxes: string[] = [];
let sigintBefore = 0;
let sigtermBefore = 0;

/** cmdRun installs SIGINT/SIGTERM handlers (they exit the CLI on Ctrl+C). */
function dropSignalHandlersInstalledDuringTest(): void {
  for (const [event, before] of [['SIGINT', sigintBefore], ['SIGTERM', sigtermBefore]] as const) {
    for (const listener of process.listeners(event).slice(before)) {
      process.removeListener(event, listener);
    }
  }
}

function sandbox(taskCount = 1): { configPath: string; resultsRoot: string; options: (o: Partial<CliOptions>) => CliOptions } {
  const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-runner-'));
  sandboxes.push(dir);
  const resultsRoot = join(dir, 'results');
  const workRoot = join(dir, 'work');
  const bankPath = join(dir, 'bank.json');
  writeFileSync(bankPath, JSON.stringify(fixtureBank('T-CFG', 'ghost-repo', taskCount)));
  const configPath = join(dir, 'runner.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repoPaths: {},
      resultsRoot,
      workRoot,
      bankPath,
      wallClockMinutes: 1,
      turnCap: 2,
      localArms: [],
    }),
  );
  return {
    configPath,
    resultsRoot,
    options: (o) => ({
      command: 'run',
      dryRun: false,
      includeOptional: false,
      configPath,
      phase: 'pilot',
      ...o,
    }),
  };
}

afterEach(() => {
  dropSignalHandlersInstalledDuringTest();
  vi.restoreAllMocks();
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sigintBefore = process.listeners('SIGINT').length;
  sigtermBefore = process.listeners('SIGTERM').length;
});

describe('runner cmdRun', () => {
  it.each(['rejects', 'returns-failure', 'succeeds'])('unloads a local model only after its load succeeds: %s', async (outcome) => {
    const fixture = fixtureRepoSandbox({});
    const plans = join(fixture.resultsRoot, 'load-ownership/plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'SELF-TEST-1.md'), 'frozen fixture plan');
    const config = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    config.modelControl = { remoteArgv: ['fixture', '{cmd}'], loadCommands: {}, unloadCommands: {}, helperReloadCommand: 'fixture' };
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const load = vi.spyOn(ModelControl.prototype, 'loadModel');
    if (outcome === 'rejects') load.mockRejectedValue(new Error('fixture load rejected'));
    else load.mockResolvedValue({ ok: outcome === 'succeeds', command: 'fixture' });
    const unload = vi.spyOn(ModelControl.prototype, 'unloadModel').mockResolvedValue({ ok: true, command: 'fixture' });
    vi.spyOn(ModelControl.prototype, 'reloadHelperModels').mockResolvedValue({ ok: true, command: 'fixture' });
    const code = await cmdRun(fixture.options({ session: 'load-ownership', arms: ['C1'], runs: 1, tasks: ['SELF-TEST-1'], phase: 'pilot', localOnly: true }));
    expect(code).toBe(outcome === 'succeeds' ? 0 : 1);
    expect(unload).toHaveBeenCalledTimes(outcome === 'succeeds' ? 1 : 0);
    expect(existsSync(join(config.workRoot, 'SELF-TEST-1-C1-1'))).toBe(false);
  });
  it('cleans a failed dependency setup so the unscored cell can retry', async () => {
    const fixture = fixtureRepoSandbox({});
    const plans = join(fixture.resultsRoot, 'setup-retry/plans');
    mkdirSync(plans, { recursive: true });
    writeFileSync(join(plans, 'SELF-TEST-1.md'), 'frozen fixture plan');
    const prepare = vi.spyOn(scoringSetup, 'prepareScoringDependencies');
    prepare.mockRejectedValueOnce(new Error('fixture frozen install failed'));
    const options = fixture.options({ session: 'setup-retry', arms: ['C1'], runs: 1, tasks: ['SELF-TEST-1'], phase: 'pilot', localOnly: true });
    expect(await cmdRun(options)).toBe(1);
    expect(agentCli.runClaudeAgent).not.toHaveBeenCalled();
    const config = JSON.parse(readFileSync(fixture.configPath, 'utf8'));
    expect(existsSync(join(config.workRoot, 'SELF-TEST-1-C1-1'))).toBe(false);
    expect(existsSync(join(fixture.resultsRoot, 'setup-retry/runs.jsonl'))).toBe(false);
    expect(await cmdRun(options)).toBe(0);
    expect(agentCli.runClaudeAgent).toHaveBeenCalledOnce();
  });
  it('rejects a local-only plan command before creating a session', async () => {
    const { options, resultsRoot } = sandbox();
    const code = await cmdPlan(options({ command: 'plan', session: 'bounded', localOnly: true }));
    expect(code).toBe(1);
    expect(existsSync(join(resultsRoot, 'bounded'))).toBe(false);
  });

  it('rejects a local-only takeover request even when pilot filtering would remove it', async () => {
    const { options, resultsRoot } = sandbox();
    const code = await cmdRun(options({ session: 'bounded', arms: ['F'], phase: 'pilot', localOnly: true }));
    expect(code).toBe(1);
    expect(existsSync(join(resultsRoot, 'bounded'))).toBe(false);
  });

  it.each(['A', 'D', 'E', 'G', 'F'])('rejects arm %s in local-only mode before starting work', async (arm) => {
    // 30-task bank so the full-run matrix minimum passes and the local-only
    // arm rejection is what actually fires.
    const { options, resultsRoot } = sandbox(30);
    const code = await cmdRun(options({ session: 'bounded', dryRun: true, arms: [arm], phase: 'full', localOnly: true }));
    expect(code).toBe(1);
    expect(existsSync(join(resultsRoot, 'bounded'))).toBe(false);
  });

  it('refuses --phase full on a bank smaller than the plan\'s thirty-task matrix', async () => {
    // Regression (verifier round): `run --dry-run --phase full` on the supplied
    // ten-task pilot bank exited 0 and scheduled the full run over ten tasks —
    // bypassing the full run's required 30-task minimum (plan steps 12-13).
    const { configPath, options } = sandbox(10);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = await cmdRun(options({ configPath, session: 's-small-full', dryRun: true, phase: 'full', arms: ['A', 'C1'] }));
    expect(code).toBe(1);
    const out = writes.join('');
    expect(out).toContain('at least 30 tasks');
    expect(out).not.toContain('would run');

    // A 30-task bank passes the minimum; batching a subset stays allowed.
    writes.length = 0;
    const big = sandbox(30);
    const ok = await cmdRun(big.options({ configPath: big.configPath, session: 's-big-full', dryRun: true, phase: 'full', arms: ['A'], tasks: ['T-CFG'] }));
    expect(ok).toBe(0);
    expect(writes.join('')).toContain('would run T-CFG arm A run 1');
  });

  it('skips run cells that already have a record instead of re-running them', async () => {
    // Regression (verifier round): the loop re-ran numbered slots blindly, so a
    // resumed batch appended duplicate records of existing cells (extra
    // "evidence" that could reverse a decision) and re-spent metered runs.
    const { configPath, resultsRoot, options } = sandbox();
    const sessionDir = join(resultsRoot, 's-resume');
    mkdirSync(join(sessionDir, 'patches'), { recursive: true });
    mkdirSync(join(sessionDir, 'plans'), { recursive: true });
    mkdirSync(join(sessionDir, 'judge'), { recursive: true });
    const existing: RunRecord = {
      taskId: 'T-CFG', armId: 'A', runNumber: 1, startedAt: '2026-10-24T00:00:00Z',
      completedAt: '2026-10-24T00:01:00Z', durationMs: 60_000, workspaceDir: '/tmp/ws-resume', planUsed: false,
      plannerUsage: emptyUsage(), coderUsage: emptyUsage(), takeoverUsage: emptyUsage(), turns: 1,
      flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
      score: { hiddenTests: { passed: true, command: [], exitCode: 0, timedOut: false, outputTail: '' }, damage: [], damageOk: true },
      // No patch file on disk: judging simply skips the pair.
      patchPath: join(sessionDir, 'patches', 'gone.patch'),
    };
    writeFileSync(join(sessionDir, 'runs.jsonl'), `${JSON.stringify(existing)}\n`);
    const code = await cmdRun(options({ configPath, session: 's-resume', tasks: ['T-CFG'], arms: ['A'] }));
    expect(code).toBe(0);
    const lines = readFileSync(join(sessionDir, 'runs.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });

  it('requires every frozen plan before a local-only batch can start', async () => {
    const { options, resultsRoot } = sandbox();
    const code = await cmdRun(options({ session: 'bounded', arms: ['C1'], localOnly: true }));
    expect(code).toBe(1);
    expect(existsSync(join(resultsRoot, 'bounded', 'report.json'))).toBe(false);
  });

  it('never invokes judges for pending pairs in local-only mode', async () => {
    const { options, resultsRoot } = sandbox();
    const dir = join(resultsRoot, 'bounded');
    mkdirSync(dir, { recursive: true });
    const runs: RunRecord[] = (['A', 'B'] as const).map((armId) => ({
      taskId: 'T-CFG', armId, runNumber: 1, startedAt: '2026-10-20T00:00:00Z',
      completedAt: '2026-10-20T00:01:00Z', durationMs: 60000, workspaceDir: '', planUsed: false,
      plannerUsage: emptyUsage(), coderUsage: emptyUsage(), takeoverUsage: emptyUsage(), turns: 1,
      flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
      score: { hiddenTests: { passed: true, command: [], exitCode: 0, timedOut: false, outputTail: '' }, damage: [], damageOk: true },
      patchPath: join(dir, `${armId}.patch`),
    }));
    for (const run of runs) writeFileSync(run.patchPath, 'diff --git a/widget.ts b/widget.ts\n');
    writeFileSync(join(dir, 'runs.jsonl'), runs.map((run) => JSON.stringify(run)).join('\n') + '\n');
    // Real command/report flow; only the external model processes are blocked.
    const claude = vi.spyOn(agentCli, 'runClaudeAgent').mockRejectedValue(new Error('unexpected model call'));
    const codex = vi.spyOn(agentCli, 'runCodexAgent').mockRejectedValue(new Error('unexpected model call'));
    await cmdRun(options({ session: 'bounded', arms: ['B'], localOnly: true }));
    expect(claude).not.toHaveBeenCalled();
    expect(codex).not.toHaveBeenCalled();
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as { notes: string[] };
    expect(report.notes).toContain('Local-only mode: existing frozen plans required; judges deferred; no cloud coder or takeover.');
  });

  it('exits nonzero when a run fails before scoring, and still writes the report', async () => {
    const { configPath, resultsRoot, options } = sandbox();
    // The fixture task's repoId is absent from repoPaths, so runArm throws
    // before scoring — exactly the "hole in the matrix" shape.
    const code = await cmdRun(options({ configPath, session: 's-fail', tasks: ['T-CFG'], arms: ['A'] }));
    expect(code).toBe(1);
    expect(existsSync(join(resultsRoot, 's-fail', 'report.md'))).toBe(true);
    const report = JSON.parse(readFileSync(join(resultsRoot, 's-fail', 'report.json'), 'utf8')) as { notes: string[] };
    expect(report.notes.some((n) => n.includes('failed before scoring'))).toBe(true);
  });

  it('exits zero for a dry run', async () => {
    const { configPath, options } = sandbox();
    const code = await cmdRun(options({ configPath, session: 's-dry', tasks: ['T-CFG'], dryRun: true }));
    expect(code).toBe(0);
  });

  it('loads --bank instead of the configured bank when given', async () => {
    const { configPath, options } = sandbox();
    const customBankPath = configPath.replace('runner.config.json', 'custom-bank.json');
    writeFileSync(customBankPath, JSON.stringify(fixtureBank('T-CUSTOM')));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    await cmdRun(options({ configPath, session: 's-bank', dryRun: true, bankPath: customBankPath }));
    const out = writes.join('');
    expect(out).toContain('T-CUSTOM');
    expect(out).not.toContain('T-CFG');

    writes.length = 0;
    await cmdRun(options({ configPath, session: 's-bank', dryRun: true }));
    const fallbackOut = writes.join('');
    expect(fallbackOut).toContain('T-CFG');
    expect(fallbackOut).not.toContain('T-CUSTOM');
  });

  it('defaults the full-run matrix to the documented arms (F and G in, E opt-in)', async () => {
    const { configPath, options } = sandbox(30);
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdRun(options({ configPath, session: 's-full', tasks: ['T-CFG'], dryRun: true, phase: 'full' }));
    const full = writes.join('');
    for (const arm of ['A', 'B', 'C1', 'C2', 'D', 'G', 'F']) {
      expect(full).toContain(`arm ${arm} run 1`);
    }
    expect(full).not.toContain('arm E run');

    writes.length = 0;
    await cmdRun(options({ configPath, session: 's-full', tasks: ['T-CFG'], dryRun: true, phase: 'full', includeOptional: true }));
    const fullWithOptional = writes.join('');
    for (const arm of ['E', 'G', 'F']) {
      expect(fullWithOptional).toContain(`arm ${arm} run 1`);
    }
  });

  it('keeps the pilot default free of E/G/F unless optional arms are requested', async () => {
    const { configPath, options } = sandbox();
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    await cmdRun(options({ configPath, session: 's-pilot', tasks: ['T-CFG'], dryRun: true }));
    const pilot = writes.join('');
    for (const arm of ['A', 'B', 'C1', 'C2', 'D']) {
      expect(pilot).toContain(`arm ${arm} run 1`);
    }
    expect(pilot).not.toContain('arm E run');
    expect(pilot).not.toContain('arm F run');
    expect(pilot).not.toContain('arm G run');

    writes.length = 0;
    await cmdRun(options({ configPath, session: 's-pilot', tasks: ['T-CFG'], dryRun: true, includeOptional: true }));
    const pilotOptional = writes.join('');
    expect(pilotOptional).toContain('arm E run');
    expect(pilotOptional).toContain('arm G run');
    expect(pilotOptional).not.toContain('arm F run');
  });
});

describe('runner cmdSpeedGate', () => {
  async function stubEndpoint(): Promise<{ url: string; bodies: string[]; close: () => Promise<void> }> {
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          usage: { prompt_tokens: 30_000, completion_tokens: 256 },
          timings: { prompt_per_second: 500, predicted_per_second: 20 },
        }));
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      bodies,
      close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
    };
  }

  function gateSandbox(url: string): {
    configPath: string;
    resultsRoot: string;
    options: (o: Partial<CliOptions>) => CliOptions;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-gate-'));
    sandboxes.push(dir);
    const resultsRoot = join(dir, 'results');
    const configPath = join(dir, 'runner.config.json');
    writeFileSync(configPath, JSON.stringify({
      repoPaths: {},
      resultsRoot,
      workRoot: join(dir, 'work'),
      bankPath: join(dir, 'bank.json'),
      wallClockMinutes: 1,
      turnCap: 2,
      localArms: [{
        modelKey: 'qwen3.8-flash-next',
        servedModelName: 'qwen3.8-flash-next',
        baseUrl: url,
        apiKeyEnv: 'PLAN_EX_AB_LOCAL_KEY',
        configDir: join(dir, 'cfg'),
        apiStyle: 'anthropic',
      }],
    }));
    return {
      configPath,
      resultsRoot,
      options: (o) => ({
        command: 'speed-gate',
        dryRun: false,
        includeOptional: false,
        configPath,
        phase: 'pilot',
        ...o,
      }),
    };
  }

  it('withholds the C2 gate decision for synthetic probes', async () => {
    const stub = await stubEndpoint();
    try {
      const { configPath, resultsRoot, options } = gateSandbox(stub.url);
      const code = await cmdSpeedGate(options({ configPath }));
      expect(code).toBe(0);
      const log = JSON.parse(readFileSync(join(resultsRoot, 'speed-gate.json'), 'utf8')) as {
        entries: { decision: unknown; note?: string }[];
      };
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]?.decision).toBeNull();
      expect(log.entries[0]?.note).toContain('synthetic');
    } finally {
      await stub.close();
    }
  });

  it('decides the gate on a real prompt and probes with the supplied text', async () => {
    const stub = await stubEndpoint();
    try {
      const { configPath, resultsRoot, options } = gateSandbox(stub.url);
      const promptPath = join(dirname(configPath), 'real-prompt.txt');
      writeFileSync(promptPath, 'REAL_PROMPT_MARKER from a run transcript');
      const code = await cmdSpeedGate(options({ configPath, promptFile: promptPath }));
      expect(code).toBe(0);
      const log = JSON.parse(readFileSync(join(resultsRoot, 'speed-gate.json'), 'utf8')) as {
        entries: { decision: { keepC2: boolean } | null; note?: string }[];
      };
      expect(log.entries[0]?.decision?.keepC2).toBe(true);
      expect(log.entries[0]?.note).toContain('real-prompt');
      expect(stub.bodies).toHaveLength(2);
      for (const body of stub.bodies) expect(body).toContain('REAL_PROMPT_MARKER');
    } finally {
      await stub.close();
    }
  });
});

describe('finalizeScoredRun (LT-707)', () => {
  it('appends the scored run record even when workspace cleanup throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-final-'));
    sandboxes.push(dir);
    mkdirSync(join(dir, 'patches'), { recursive: true });
    const session = {
      dir,
      runsPath: join(dir, 'runs.jsonl'),
      patchesDir: join(dir, 'patches'),
      plansDir: join(dir, 'plans'),
      judgeDir: join(dir, 'judge'),
    };
    const record: RunRecord = {
      taskId: 'T-CFG', armId: 'C1', runNumber: 1,
      startedAt: '2026-10-24T00:00:00Z', completedAt: '2026-10-24T00:01:00Z',
      durationMs: 60_000, workspaceDir: '/tmp/ws-lt707', planUsed: true,
      plannerUsage: emptyUsage(), coderUsage: emptyUsage(), takeoverUsage: emptyUsage(),
      turns: 3,
      flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
      score: {
        hiddenTests: { passed: true, command: [], exitCode: 0, timedOut: false, outputTail: '' },
        damage: [],
        damageOk: true,
      },
      patchPath: join(dir, 'patches', 'p.patch'),
    };
    writeFileSync(record.patchPath, 'diff --git a/x b/x\n');
    const cleanup = (): void => {
      throw Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
    };
    finalizeScoredRun(session, record, '/tmp/ws-lt707', cleanup);
    const runs = readFileSync(session.runsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.taskId).toBe('T-CFG');
    expect(runs[0]?.score?.hiddenTests.passed).toBe(true);
  });

  it('cleans the workspace normally when no flake occurs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-final2-'));
    sandboxes.push(dir);
    mkdirSync(join(dir, 'patches'), { recursive: true });
    const session = {
      dir,
      runsPath: join(dir, 'runs.jsonl'),
      patchesDir: join(dir, 'patches'),
      plansDir: join(dir, 'plans'),
      judgeDir: join(dir, 'judge'),
    };
    const record: RunRecord = {
      taskId: 'T-CLEAN', armId: 'B', runNumber: 1,
      startedAt: '2026-10-24T00:00:00Z', completedAt: '2026-10-24T00:01:00Z',
      durationMs: 60_000, workspaceDir: '/tmp/ws-lt707b', planUsed: false,
      plannerUsage: emptyUsage(), coderUsage: emptyUsage(), takeoverUsage: emptyUsage(),
      turns: 1,
      flags: { looped: false, toolCallErrors: 0, hitTurnCap: false, gaveUp: false },
      score: {
        hiddenTests: { passed: false, command: [], exitCode: 1, timedOut: false, outputTail: '' },
        damage: [],
        damageOk: true,
      },
      patchPath: join(dir, 'patches', 'p2.patch'),
    };
    writeFileSync(record.patchPath, 'diff --git a/y b/y\n');
    const cleaned: string[] = [];
    finalizeScoredRun(session, record, '/tmp/ws-lt707b', (target) => { cleaned.push(target); });
    expect(cleaned).toEqual(['/tmp/ws-lt707b']);
    const runs = readFileSync(session.runsPath, 'utf8').trim().split('\n');
    expect(runs).toHaveLength(1);
  });
});

interface FTakeoverFixture {
  configPath: string;
  resultsRoot: string;
  options: (o: Partial<CliOptions>) => CliOptions;
  takeoverCalls: () => { timeoutMs?: number; maxTurns?: number }[];
}

function fixtureRepoSandbox(coderResult: Partial<AgentRunResult>): FTakeoverFixture {
  const dir = mkdtempSync(join(tmpdir(), 'plan-ex-ab-ftakeover-'));
  sandboxes.push(dir);
  const fixture = createFixtureRepo(dir);
  mkdirSync(join(fixture.repoPath, 'node_modules'), { recursive: true });
  const resultsRoot = join(dir, 'results');
  const workRoot = join(dir, 'work');
  const bankPath = join(dir, 'bank.json');
  // 30 tasks: the fixture runs `--phase full` (arm F is full-only), and the full
  // run refuses banks below the plan's thirty-task matrix.
  writeFileSync(bankPath, JSON.stringify({
    version: 1,
    createdAt: '2026-10-24T00:00:00Z',
    repos: [{ id: fixture.task.repoId, localPath: fixture.repoPath, stack: 'test', notes: 'fixture' }],
    tasks: [
      fixture.task,
      ...Array.from({ length: 29 }, (_, index) => ({
        ...fixture.task,
        id: `FILL-${index + 2}`,
      })),
    ],
  }));
  const configPath = join(dir, 'runner.config.json');
  writeFileSync(configPath, JSON.stringify({
    repoPaths: { [fixture.task.repoId]: fixture.repoPath },
    resultsRoot,
    workRoot,
    bankPath,
    wallClockMinutes: 1,
    turnCap: 10,
    localArms: [{
      modelKey: 'qwen3.8-27b',
      servedModelName: 'qwen3.8-27b',
      baseUrl: 'http://127.0.0.1:1',
      apiKeyEnv: 'PLAN_EX_AB_LOCAL_KEY',
      configDir: join(dir, 'local-cfg'),
      apiStyle: 'anthropic',
      servingSetup: 'test-stack-27b',
    }],
  }));

  const takeoverCalls: { timeoutMs?: number; maxTurns?: number }[] = [];
  const success = (partial: Partial<AgentRunResult>): AgentRunResult => ({
    finalText: 'ok',
    usage: emptyUsage(),
    turns: 1,
    toolErrors: [],
    hitTurnCap: false,
    durationMs: 10,
    exitCode: 0,
    timedOut: false,
    rawLogPath: '',
    ...partial,
  });
  vi.spyOn(agentCli, 'runClaudeAgent').mockImplementation(async (request) => {
    if (request.prompt.includes('planning half')) {
      return success({ finalText: '1. Steps\n2. Files\n3. Test\n4. Done', turns: 1 });
    }
    if (request.prompt.includes('The previous coder stalled')) {
      takeoverCalls.push({ timeoutMs: request.timeoutMs, maxTurns: request.maxTurns });
      return success({ finalText: 'takeover finished', turns: 2, durationMs: 250 });
    }
    return success({ finalText: 'coder stalled', turns: 3, durationMs: 600, error: 'coder did not finish', ...coderResult });
  });
  vi.spyOn(agentCli, 'runCodexAgent').mockRejectedValue(new Error('unexpected codex call'));

  return {
    configPath,
    resultsRoot,
    options: (o) => ({
      command: 'run',
      dryRun: false,
      includeOptional: false,
      configPath,
      phase: 'full',
      ...o,
    }),
    takeoverCalls: () => takeoverCalls,
  };
}

describe('runner arm F takeover budget (same limits as every arm)', () => {
  it('hands the Opus takeover only the remaining wall clock and turns, and counts its time', async () => {
    const fixture = fixtureRepoSandbox({});
    const code = await cmdRun(fixture.options({
      session: 's-f',
      tasks: ['SELF-TEST-1'],
      arms: ['F'],
    }));
    expect(code).toBe(0);

    // Full-phase local arm: 2 runs per task, each coder(600ms/3 turns) + takeover.
    const takeovers = fixture.takeoverCalls();
    expect(takeovers).toHaveLength(2);
    for (const call of takeovers) {
      expect(call.timeoutMs).toBe(60_000 - 600);
      expect(call.maxTurns).toBe(10 - 3);
    }

    const runs = readFileSync(join(fixture.resultsRoot, 's-f', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.durationMs).toBe(600 + 250);
      expect(run.turns).toBe(3 + 2);
    }
  }, 60_000);

  it('skips the takeover when the coder used the whole budget, and records why', async () => {
    const fixture = fixtureRepoSandbox({ turns: 10, durationMs: 60_000 });
    const code = await cmdRun(fixture.options({
      session: 's-f-skip',
      tasks: ['SELF-TEST-1'],
      arms: ['F'],
    }));
    expect(code).toBe(0);
    expect(fixture.takeoverCalls()).toHaveLength(0);

    const runs = readFileSync(join(fixture.resultsRoot, 's-f-skip', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.durationMs).toBe(60_000);
      expect(run.error).toContain('takeover skipped: no budget remained');
    }
  }, 60_000);
});

describe('runner preplanned arms keep their frozen plan usage', () => {
  it('records a reused plan\'s planner usage in the run record and the report', async () => {
    // Regression: ensureFrozenPlan returned the saved usage for an existing
    // plan, but runArm replaced it with emptyUsage() unless the plan had just
    // been created — so every preplanned run (C1/C2/D/E/F) reported zero
    // planner tokens and inflated the >= 60% Claude-token saving rule.
    const fixture = fixtureRepoSandbox({ error: undefined, finalText: 'done', turns: 2, durationMs: 100 });
    const plansDir = join(fixture.resultsRoot, 's-plan', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, 'SELF-TEST-1.md'), '# seeded plan\n');
    const seeded = { inputTokens: 900, outputTokens: 40, cacheReadTokens: 5000, cacheWriteTokens: 100 };
    writeFileSync(join(plansDir, 'SELF-TEST-1.usage.json'), JSON.stringify(seeded));

    const code = await cmdRun(fixture.options({
      session: 's-plan',
      tasks: ['SELF-TEST-1'],
      arms: ['D'],
      phase: 'pilot',
    }));
    expect(code).toBe(0);

    // The planner never ran: the seeded plan file is untouched.
    expect(readFileSync(join(plansDir, 'SELF-TEST-1.md'), 'utf8')).toBe('# seeded plan\n');

    const runs = readFileSync(join(fixture.resultsRoot, 's-plan', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(1);
    expect(runs[0].planUsed).toBe(true);
    expect(runs[0].plannerUsage).toEqual(seeded);

    const report = JSON.parse(
      readFileSync(join(fixture.resultsRoot, 's-plan', 'report.json'), 'utf8'),
    ) as BenchmarkReport;
    const arm = report.arms.find((entry) => entry.armId === 'D');
    expect(arm?.avgClaudeTokens).toBe(900 + 40 + 5000 + 100);
  }, 60_000);
});

describe('runner serving-setup provenance (fairness control)', () => {
  it('records the endpoint serving setup on local runs and none on cloud runs', async () => {
    // Fairness control ("same model files, server build and settings throughout;
    // restart that arm" on change): run records must name the serving stack so
    // a mid-arm server/settings change is detectable and mixed arms can be
    // withheld in the report.
    const fixture = fixtureRepoSandbox({});
    const code = await cmdRun(fixture.options({
      session: 's-setup',
      tasks: ['SELF-TEST-1'],
      arms: ['C1', 'D'],
      phase: 'pilot',
    }));
    expect(code).toBe(0);
    const runs = readFileSync(join(fixture.resultsRoot, 's-setup', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(2);
    const local = runs.find((run) => run.armId === 'C1');
    const cloud = runs.find((run) => run.armId === 'D');
    expect(local?.servingSetupId).toBe('test-stack-27b');
    expect(cloud?.servingSetupId).toBeUndefined();
    const report = JSON.parse(
      readFileSync(join(fixture.resultsRoot, 's-setup', 'report.json'), 'utf8'),
    ) as BenchmarkReport;
    expect(report.arms.find((entry) => entry.armId === 'C1')?.servingSetups).toEqual(['test-stack-27b']);
    expect(report.arms.find((entry) => entry.armId === 'D')?.servingSetups).toEqual([]);
  }, 60_000);
});

describe('runner arm G turn cap wiring', () => {
  it('passes the configured turn cap to the Codex coder and records the cap flag', async () => {
    // Regression: the Codex branch omitted maxTurns, so arm G ran without the
    // turn cap every other arm gets (runner.config.json turnCap = 10 here).
    const fixture = fixtureRepoSandbox({});
    let seenMaxTurns: number | undefined;
    vi.spyOn(agentCli, 'runCodexAgent').mockImplementation(async (request) => {
      seenMaxTurns = request.maxTurns;
      return {
        finalText: 'done',
        usage: emptyUsage(),
        turns: 10,
        toolErrors: [],
        hitTurnCap: true,
        durationMs: 500,
        exitCode: 0,
        timedOut: false,
        rawLogPath: '',
      };
    });
    const code = await cmdRun(fixture.options({
      session: 's-g-cap',
      tasks: ['SELF-TEST-1'],
      arms: ['G'],
      phase: 'pilot',
    }));
    expect(code).toBe(0);
    expect(seenMaxTurns).toBe(10);

    const runs = readFileSync(join(fixture.resultsRoot, 's-g-cap', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(1);
    expect(runs[0].flags.hitTurnCap).toBe(true);
  }, 60_000);
});

describe('runner frozen-plan validation (failed planner runs never persist)', () => {
  const plannerResult = (partial: Partial<AgentRunResult>): AgentRunResult => ({
    finalText: '1. Steps\n2. Files\n3. Test\n4. Done',
    usage: emptyUsage(),
    turns: 2,
    toolErrors: [],
    hitTurnCap: false,
    durationMs: 100,
    exitCode: 0,
    timedOut: false,
    rawLogPath: '',
    ...partial,
  });

  function mockPlannerFirst(partial: Partial<AgentRunResult>): void {
    vi.spyOn(agentCli, 'runClaudeAgent').mockImplementation(async (request) =>
      request.prompt.includes('planning half')
        ? plannerResult(partial)
        : plannerResult({ finalText: 'coder done', turns: 1 }));
  }

  it.each([
    ['errored (exit 1)', { exitCode: 1, error: 'exit 1: planner exploded' }],
    ['timed out', { timedOut: true, error: 'timed out after 1000ms' }],
    ['returned empty text', { finalText: '   ' }],
    ['hit its turn cap', { hitTurnCap: true, finalText: 'partial plan' }],
  ])('rejects a planner run that was %s, saving nothing', async (_label, partial) => {
    // Regression: ensureFrozenPlan persisted every planner outcome as a frozen
    // plan, so error/exit/timeout runs were silently reused by all plan arms.
    const fixture = fixtureRepoSandbox({});
    mockPlannerFirst(partial as Partial<AgentRunResult>);
    const code = await cmdRun(fixture.options({
      session: 's-plan-invalid',
      tasks: ['SELF-TEST-1'],
      arms: ['D'],
      phase: 'pilot',
    }));
    expect(code).toBe(1);

    const plansDir = join(fixture.resultsRoot, 's-plan-invalid', 'plans');
    expect(existsSync(join(plansDir, 'SELF-TEST-1.md'))).toBe(false);
    expect(existsSync(join(plansDir, 'SELF-TEST-1.usage.json'))).toBe(false);
    expect(existsSync(join(fixture.resultsRoot, 's-plan-invalid', 'runs.jsonl'))).toBe(false);

    const report = JSON.parse(
      readFileSync(join(fixture.resultsRoot, 's-plan-invalid', 'report.json'), 'utf8'),
    ) as BenchmarkReport;
    expect(report.notes.join('\n')).toContain('planner failed for SELF-TEST-1');
    expect(report.notes.join('\n')).toContain('no frozen plan saved');
  }, 60_000);

  it('saves the frozen plan and its usage only for a completed planner run', async () => {
    const fixture = fixtureRepoSandbox({});
    const usage = { inputTokens: 120, outputTokens: 60, cacheReadTokens: 900, cacheWriteTokens: 5 };
    vi.spyOn(agentCli, 'runClaudeAgent').mockImplementation(async (request) =>
      request.prompt.includes('planning half')
        ? plannerResult({ finalText: '# plan\nsteps', usage })
        : plannerResult({ finalText: 'coder done', turns: 1 }));
    const code = await cmdRun(fixture.options({
      session: 's-plan-ok',
      tasks: ['SELF-TEST-1'],
      arms: ['D'],
      phase: 'pilot',
    }));
    expect(code).toBe(0);
    const plansDir = join(fixture.resultsRoot, 's-plan-ok', 'plans');
    expect(readFileSync(join(plansDir, 'SELF-TEST-1.md'), 'utf8')).toBe('# plan\nsteps');
    expect(JSON.parse(readFileSync(join(plansDir, 'SELF-TEST-1.usage.json'), 'utf8'))).toEqual(usage);
    const runs = readFileSync(join(fixture.resultsRoot, 's-plan-ok', 'runs.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as RunRecord);
    expect(runs).toHaveLength(1);
    expect(runs[0].plannerUsage).toEqual(usage);
  }, 60_000);
});

describe('runner --turn-cap override wiring', () => {
  it('applies --turn-cap to the coder over the configured cap', async () => {
    // Regression: --turn-cap was parsed but never applied — config's cap won
    // everywhere, so the advertised override did nothing.
    const fixture = fixtureRepoSandbox({});
    let seenMaxTurns: number | undefined;
    vi.spyOn(agentCli, 'runClaudeAgent').mockImplementation(async (request) => {
      seenMaxTurns = request.maxTurns;
      return {
        finalText: 'done',
        usage: emptyUsage(),
        turns: 1,
        toolErrors: [],
        hitTurnCap: false,
        durationMs: 100,
        exitCode: 0,
        timedOut: false,
        rawLogPath: '',
      };
    });
    const code = await cmdRun(fixture.options({
      session: 's-turn-cap',
      tasks: ['SELF-TEST-1'],
      arms: ['A'],
      phase: 'pilot',
      turnCap: 3,
    }));
    expect(code).toBe(0);
    expect(seenMaxTurns).toBe(3);
  }, 60_000);

  it('applies --turn-cap to the planner in the planning path', async () => {
    const fixture = fixtureRepoSandbox({});
    let plannerMaxTurns: number | undefined;
    vi.spyOn(agentCli, 'runClaudeAgent').mockImplementation(async (request) => {
      if (request.prompt.includes('planning half')) plannerMaxTurns = request.maxTurns;
      return {
        finalText: '# plan\nsteps',
        usage: emptyUsage(),
        turns: 1,
        toolErrors: [],
        hitTurnCap: false,
        durationMs: 100,
        exitCode: 0,
        timedOut: false,
        rawLogPath: '',
      };
    });
    const code = await cmdPlan(fixture.options({
      command: 'plan',
      session: 's-plan-cap',
      tasks: ['SELF-TEST-1'],
      turnCap: 4,
    }));
    expect(code).toBe(0);
    expect(plannerMaxTurns).toBe(4);
    expect(existsSync(join(fixture.resultsRoot, 's-plan-cap', 'plans', 'SELF-TEST-1.md'))).toBe(true);
  }, 60_000);

  it('rejects invalid --turn-cap values before any work starts', async () => {
    for (const turnCap of [0, -2, 2.5]) {
      const fixture = fixtureRepoSandbox({});
      const code = await cmdRun(fixture.options({
        session: 's-turn-cap-bad',
        tasks: ['SELF-TEST-1'],
        arms: ['A'],
        turnCap,
      }));
      expect(code).toBe(1);
      expect(existsSync(join(fixture.resultsRoot, 's-turn-cap-bad'))).toBe(false);
    }
  }, 60_000);
});
