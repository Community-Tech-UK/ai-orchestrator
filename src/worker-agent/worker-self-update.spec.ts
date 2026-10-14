import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveSelfUpdateTarget,
  restorePreviousWorkerBundle,
  WORKER_SUPERVISED_ENV,
  WorkerSelfUpdater,
  type CommandResult,
  type RunCommand,
  type SelfUpdateFs,
  type WorkerSelfUpdaterOptions,
} from './worker-self-update';

const REPO = path.resolve('/repo');
const BUNDLE = path.join(REPO, 'dist', 'worker-agent', 'index.js');
const DIR = path.dirname(BUNDLE);
const STAMP = path.join(DIR, '.source-commit');
const FAILED = path.join(DIR, '.auto-update-failed');
const CANDIDATE = path.join(DIR, 'index.next.js');
const PREVIOUS = path.join(DIR, 'index.prev.js');

const commit = (ch: string): string => ch.repeat(40);
const C1 = commit('a');
const C2 = commit('b');
const C3 = commit('c');
const FORK = commit('f');

const MINUTE = 60_000;

function memoryFs(initial: Record<string, string>): SelfUpdateFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    exists: (p) => files.has(p),
    readText: (p) => files.get(p) ?? null,
    writeText: (p, text) => void files.set(p, text),
    copy: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, value);
    },
    rename: (from, to) => {
      const value = files.get(from);
      if (value === undefined) throw new Error(`ENOENT ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    remove: (p) => void files.delete(p),
  };
}

interface FakeRepo {
  head: string;
  upstream: string | null;
  /** Linear history, oldest first. FORK is deliberately not on it. */
  history: string[];
  fetchCode: number;
  mergeCode: number;
  buildCode: number;
  selfCheckCode: number;
  resetCode: number;
}

function harness(overrides: {
  repo?: Partial<FakeRepo>;
  files?: Record<string, string>;
  options?: Partial<WorkerSelfUpdaterOptions>;
} = {}) {
  let clock = 1_000_000;
  let busy = false;
  const repo: FakeRepo = {
    head: C1,
    upstream: C1,
    history: [C1, C2, C3],
    fetchCode: 0,
    mergeCode: 0,
    buildCode: 0,
    selfCheckCode: 0,
    resetCode: 0,
    ...overrides.repo,
  };
  const fs = memoryFs({ [BUNDLE]: 'bundle:C1', [STAMP]: `${C1}\n`, ...overrides.files });
  const calls: string[] = [];
  const invocations: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  let sshCommandConfig = '';
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const fail = (code: number, stderr: string): CommandResult => ({ code, stdout: '', stderr });

  const run: RunCommand = async (file, args, runOptions) => {
    invocations.push({ file, args, env: runOptions.env });
    if (file === 'git' && args[0] === 'config') return ok(sshCommandConfig ? `${sshCommandConfig}\n` : '');
    const label = file === 'git' ? `git ${args[0]}` : args.includes('--self-check') ? 'self-check' : 'build';
    calls.push(label === 'git merge' || label === 'git reset' ? `${label} ${args[args.length - 1]?.slice(0, 1)}` : label);
    if (file === 'git') {
      switch (args[0]) {
        case 'fetch':
          return repo.fetchCode === 0 ? ok() : fail(repo.fetchCode, 'fatal: unable to access remote');
        case 'rev-parse': {
          const ref = args[args.length - 1];
          if (ref === 'HEAD') return ok(`${repo.head}\n`);
          return repo.upstream ? ok(`${repo.upstream}\n`) : fail(1, '');
        }
        case 'merge-base': {
          const [a, b] = [args[2] ?? '', args[3] ?? ''];
          const ia = repo.history.indexOf(a);
          const ib = repo.history.indexOf(b);
          return ia >= 0 && ib >= 0 && ia <= ib ? ok() : fail(1, '');
        }
        case 'merge':
          if (repo.mergeCode !== 0) return fail(repo.mergeCode, 'error: Your local changes would be overwritten');
          repo.head = args[args.length - 1] ?? repo.head;
          return ok();
        case 'reset':
          if (repo.resetCode !== 0) return fail(repo.resetCode, 'error: Entry not uptodate');
          repo.head = args[args.length - 1] ?? repo.head;
          return ok();
        default:
          return fail(1, `unexpected git ${args[0]}`);
      }
    }
    if (args.includes('--self-check')) {
      return repo.selfCheckCode === 0 ? ok('Worker self-check ok') : fail(repo.selfCheckCode, 'Error: Cannot find module');
    }
    if (repo.buildCode !== 0) return fail(repo.buildCode, 'Could not resolve "new-dependency"');
    fs.files.set(CANDIDATE, `bundle:${repo.head.slice(0, 1)}`);
    return ok('Worker agent built');
  };

  const restart = vi.fn(async () => undefined);
  const logger = { info: vi.fn(), warn: vi.fn() };
  const options: WorkerSelfUpdaterOptions = {
    repoRoot: REPO,
    bundlePath: BUNDLE,
    configPath: '/cfg.json',
    isBusy: () => busy,
    restart,
    run,
    fs,
    now: () => clock,
    logger,
    firstCheckDelayMs: 0,
    checkIntervalMs: 5 * MINUTE,
    quietMs: 3 * MINUTE,
    ...overrides.options,
  };
  const make = () => new WorkerSelfUpdater(options);
  return {
    repo,
    fs,
    calls,
    invocations,
    setSshCommandConfig: (value: string) => {
      sshCommandConfig = value;
    },
    restart,
    logger,
    make,
    advance: (ms: number) => {
      clock += ms;
    },
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe('WorkerSelfUpdater', () => {
  it('does nothing when the running build is the upstream commit', async () => {
    const h = harness();
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls).not.toContain('build');
    expect(h.restart).not.toHaveBeenCalled();
    expect(updater.getSummary().state).toBe('idle');
  });

  it('fast-forwards, builds a candidate, self-checks it, swaps it in and restarts', async () => {
    const h = harness({ repo: { upstream: C2 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls).toEqual([
      'git fetch',
      'git rev-parse',
      'git rev-parse',
      'git merge-base',
      'git merge b',
      'build',
      'self-check',
    ]);
    expect(h.repo.head).toBe(C2);
    expect(h.fs.files.get(BUNDLE)).toBe('bundle:b');
    expect(h.fs.files.get(PREVIOUS)).toBe('bundle:C1');
    expect(h.fs.files.get(STAMP)).toBe(`${C2}\n`);
    expect(h.fs.files.get(`${STAMP}.prev`)).toBe(`${C1}\n`);
    expect(h.fs.files.get(`${STAMP}.swapped`)).toBe(`${C2}\n`);
    expect(h.fs.files.has(CANDIDATE)).toBe(false);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(updater.getSummary()).toMatchObject({ state: 'restart_pending', targetCommit: C2 });
    // The running process still reports what it was built from until it restarts.
    expect(updater.getRunningCommit()).toBe(C1);
  });

  it('rebuilds when an older launcher already pulled without building', async () => {
    const h = harness({ repo: { head: C2, upstream: C2 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls.some((call) => call.startsWith('git merge'))).toBe(false);
    expect(h.calls).toContain('build');
    expect(h.fs.files.get(STAMP)).toBe(`${C2}\n`);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('still rebuilds a pulled checkout when the fetch fails', async () => {
    const h = harness({ repo: { head: C2, upstream: C2, fetchCode: 128 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls).toContain('build');
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('reports a failed fetch without treating it as a failed update', async () => {
    const h = harness({ repo: { fetchCode: 128 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(updater.getSummary()).toMatchObject({ state: 'idle' });
    expect(updater.getSummary().reason).toContain('git fetch failed');
    expect(h.fs.files.has(FAILED)).toBe(false);
  });

  it('waits until the worker has been idle for the quiet period', async () => {
    const h = harness({ repo: { upstream: C2 }, options: { checkIntervalMs: MINUTE } });
    const updater = h.make();
    h.setBusy(true);
    h.advance(10 * MINUTE);

    await updater.tick();
    expect(updater.getSummary()).toMatchObject({ state: 'waiting_for_idle', targetCommit: C2 });
    expect(h.repo.head).toBe(C1);

    h.setBusy(false);
    h.advance(MINUTE);
    await updater.tick();
    expect(h.calls).not.toContain('build'); // only one quiet minute so far

    h.advance(3 * MINUTE);
    await updater.tick();
    expect(h.repo.head).toBe(C2);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('treats recent external activity (a browser command) as busy', async () => {
    let lastActivity = 0;
    const h = harness({ repo: { upstream: C2 }, options: { lastActivityAt: () => lastActivity } });
    const updater = h.make();
    h.advance(10 * MINUTE);
    lastActivity = 1_000_000 + 9 * MINUTE;

    await updater.tick();

    expect(updater.getSummary().state).toBe('waiting_for_idle');
    expect(h.calls).not.toContain('build');
  });

  it('keeps the new bundle but holds the restart while work is running', async () => {
    // Idle for the tick sample and the pre-update check, then work arrives
    // while the build runs, so the post-swap check sees it.
    const isBusy = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const h = harness({ repo: { upstream: C2 }, options: { checkIntervalMs: MINUTE, isBusy } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();
    expect(h.fs.files.get(BUNDLE)).toBe('bundle:b');
    expect(h.restart).not.toHaveBeenCalled();
    expect(updater.getSummary().state).toBe('restart_pending');

    isBusy.mockReturnValue(false);
    h.advance(4 * MINUTE);
    await updater.tick();
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((call) => call === 'build')).toHaveLength(1);
  });

  it.each([
    ['the build', { buildCode: 1 }, 'build failed'],
    ['the self-check', { selfCheckCode: 1 }, 'self-check of the new bundle failed'],
  ])('rolls the checkout back and keeps the live bundle when %s fails', async (_label, failure, reason) => {
    const h = harness({ repo: { upstream: C2, ...failure } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls).toContain('git reset a');
    expect(h.repo.head).toBe(C1);
    expect(h.fs.files.get(BUNDLE)).toBe('bundle:C1');
    expect(h.fs.files.get(STAMP)).toBe(`${C1}\n`);
    expect(h.fs.files.has(CANDIDATE)).toBe(false);
    expect(h.restart).not.toHaveBeenCalled();
    expect(updater.getSummary()).toMatchObject({ state: 'blocked', targetCommit: C2 });
    expect(updater.getSummary().reason).toContain(reason);
    expect(JSON.parse(h.fs.files.get(FAILED) ?? '{}')).toMatchObject({ commit: C2 });
  });

  it('does not try a failed commit again, even after a restart', async () => {
    const h = harness({ repo: { upstream: C2, buildCode: 1 } });
    const first = h.make();
    h.advance(10 * MINUTE);
    await first.tick();
    expect(h.calls.filter((call) => call === 'build')).toHaveLength(1);

    const second = h.make(); // a new process reads the failure back from disk
    h.advance(10 * MINUTE);
    await second.tick();

    expect(h.calls.filter((call) => call === 'build')).toHaveLength(1);
    expect(second.getSummary().state).toBe('blocked');
    expect(second.getSummary().reason).toContain('failed earlier');
  });

  it('retries a failed commit after two hours, since the failure may have been transient', async () => {
    const h = harness({ repo: { upstream: C2, buildCode: 1 } });
    const updater = h.make();
    h.advance(10 * MINUTE);
    await updater.tick();
    expect(updater.getSummary().reason).toContain('build failed');

    h.repo.buildCode = 0;
    h.advance(60 * MINUTE);
    await updater.tick();
    expect(h.restart).not.toHaveBeenCalled();
    expect(updater.getSummary().reason).toContain('retrying after');

    h.advance(61 * MINUTE);
    await updater.tick();
    expect(h.repo.head).toBe(C2);
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.fs.files.has(FAILED)).toBe(false);
  });

  it('never retries a commit whose bundle died on startup', async () => {
    const h = harness({
      repo: { head: C1, upstream: C2 },
      files: { [FAILED]: JSON.stringify({ commit: C2, reason: 'the new bundle exited during startup' }) },
    });
    const updater = h.make();
    h.advance(24 * 60 * MINUTE);

    await updater.tick();

    expect(h.calls).not.toContain('build');
    expect(updater.getSummary().reason).toContain('not retried until upstream moves on');
  });

  it('tries again once upstream moves past a failed commit', async () => {
    const h = harness({ repo: { upstream: C2, buildCode: 1 } });
    const updater = h.make();
    h.advance(10 * MINUTE);
    await updater.tick();

    h.repo.upstream = C3;
    h.repo.buildCode = 0;
    h.advance(10 * MINUTE);
    await updater.tick();

    expect(h.repo.head).toBe(C3);
    expect(h.fs.files.has(FAILED)).toBe(false);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('does not rewind a checkout that someone moved by hand during a failed update', async () => {
    const h = harness({ repo: { upstream: C2, selfCheckCode: 1 } });
    const run = h.make();
    // The self-check fails, and while the build ran HEAD was moved to C3 by hand.
    const original = h.fs.exists;
    h.fs.exists = (p) => {
      if (p === CANDIDATE) h.repo.head = C3;
      return original(p);
    };
    h.advance(10 * MINUTE);

    await run.tick();

    expect(h.calls.some((call) => call.startsWith('git reset'))).toBe(false);
    expect(h.repo.head).toBe(C3);
    expect(run.getSummary().reason).toContain('moved during the update');
  });

  it('records a refused fast-forward without resetting a checkout that never moved', async () => {
    const h = harness({ repo: { upstream: C2, mergeCode: 1 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls.some((call) => call.startsWith('git reset'))).toBe(false);
    expect(h.calls).not.toContain('build');
    expect(updater.getSummary().state).toBe('blocked');
    expect(updater.getSummary().reason).toContain('git merge --ff-only failed');
  });

  it('refuses to update a checkout that has diverged from upstream', async () => {
    const h = harness({ repo: { upstream: FORK } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls).not.toContain('build');
    expect(updater.getSummary()).toMatchObject({ state: 'blocked' });
    expect(updater.getSummary().reason).toContain('diverged');
  });

  it('builds local commits that are ahead of upstream', async () => {
    const h = harness({ repo: { head: C2, upstream: C1 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.fs.files.get(STAMP)).toBe(`${C2}\n`);
    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('waits for the first-check delay and the check interval', async () => {
    const h = harness({ repo: { upstream: C2 }, options: { firstCheckDelayMs: 2 * MINUTE } });
    const updater = h.make();

    await updater.tick();
    expect(h.calls).toEqual([]);

    h.advance(2 * MINUTE);
    h.setBusy(true);
    await updater.tick();
    expect(h.calls).toContain('git fetch');

    const callsAfterFirstCheck = h.calls.length;
    h.advance(MINUTE);
    await updater.tick();
    expect(h.calls).toHaveLength(callsAfterFirstCheck);
  });

  it('after the supervisor restored the old bundle, returns the checkout to it once', async () => {
    const h = harness({
      repo: { head: C2, upstream: C2 },
      files: { [FAILED]: JSON.stringify({ commit: C2, reason: 'the new bundle exited during startup' }) },
    });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();
    expect(h.calls).toContain('git reset a');
    expect(h.repo.head).toBe(C1);
    expect(updater.getSummary().state).toBe('blocked');

    // An old launcher pulls it forward again: do not fight it every check.
    h.repo.head = C2;
    h.advance(10 * MINUTE);
    await updater.tick();
    expect(h.calls.filter((call) => call.startsWith('git reset'))).toHaveLength(1);
    expect(h.calls).not.toContain('build');
  });

  it('builds into the candidate file, never over the live bundle, and self-checks that file', async () => {
    const h = harness({ repo: { upstream: C2 } });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    const build = h.invocations.find((call) => call.args.includes('build-worker-agent.ts'));
    expect(build?.file).toBe(process.execPath);
    expect(build?.args[0]).toBe(path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'));
    expect(build?.env?.['AIO_WORKER_BUILD_OUTFILE']).toBe(CANDIDATE);
    const selfCheck = h.invocations.find((call) => call.args.includes('--self-check'));
    expect(selfCheck?.args).toEqual([CANDIDATE, '--self-check', '--config', '/cfg.json']);
  });

  it.each([
    ['the rename', 'rename'],
    ['the stamp write after the rename', STAMP],
    ['the swap-marker write after the stamp', `${STAMP}.swapped`],
  ])('undoes a half-done swap when %s is refused', async (_label, failing) => {
    const h = harness({ repo: { upstream: C2 } });
    if (failing === 'rename') {
      h.fs.rename = () => {
        throw new Error('EPERM: operation not permitted');
      };
    } else {
      const write = h.fs.writeText;
      h.fs.writeText = (p, text) => {
        if (p === failing) throw new Error('EBUSY: resource busy');
        write(p, text);
      };
    }
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.fs.files.get(BUNDLE)).toBe('bundle:C1');
    expect(h.fs.files.get(STAMP)).toBe(`${C1}\n`);
    expect(h.repo.head).toBe(C1);
    expect(h.restart).not.toHaveBeenCalled();
    expect(updater.getSummary().state).toBe('blocked');
    expect(updater.getSummary().reason).toContain('could not swap in the new bundle');
    expect(h.fs.files.has(`${STAMP}.swapped`)).toBe(false);
    expect(JSON.parse(h.fs.files.get(FAILED) ?? '{}')).toMatchObject({ commit: C2 });
  });

  it('keeps going and reports it when an undo step is refused too', async () => {
    const h = harness({ repo: { upstream: C2 } });
    const write = h.fs.writeText;
    h.fs.writeText = (p, text) => {
      if (p === `${STAMP}.swapped`) throw new Error('EBUSY: resource busy');
      write(p, text);
    };
    const copy = h.fs.copy;
    h.fs.copy = (from, to) => {
      if (from === PREVIOUS) throw new Error('EPERM: operation not permitted');
      copy(from, to);
    };
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    // Bundle could not be put back, but the stamp and marker still were, and
    // the outcome is reported rather than thrown.
    expect(h.fs.files.get(STAMP)).toBe(`${C1}\n`);
    expect(h.fs.files.has(`${STAMP}.swapped`)).toBe(false);
    expect(updater.getSummary().state).toBe('blocked');
    expect(updater.getSummary().reason).toContain('restoring the previous bundle also failed');
  });

  it('adds BatchMode for ssh only when nothing else chose an ssh command', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', '');
    vi.stubEnv('GIT_SSH', '');
    try {
    const plain = harness();
    const first = plain.make();
    plain.advance(10 * MINUTE);
    await first.tick();
    const fetch = plain.invocations.find((call) => call.args[0] === 'fetch');
    expect(fetch?.env?.['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(fetch?.env?.['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');

    const keyed = harness();
    keyed.setSshCommandConfig('ssh -i C:/keys/deploy');
    const second = keyed.make();
    keyed.advance(10 * MINUTE);
    await second.tick();
    const keyedFetch = keyed.invocations.find((call) => call.args[0] === 'fetch');
    // core.sshCommand must win, so the variable that would override it stays unset.
    expect(keyedFetch?.env?.['GIT_SSH_COMMAND']).toBe('');

    // A legacy GIT_SSH (PuTTY plink on Windows) must keep working too.
    vi.stubEnv('GIT_SSH', 'C:/tools/plink.exe');
    const plink = harness();
    const third = plink.make();
    plink.advance(10 * MINUTE);
    await third.tick();
    expect(plink.invocations.find((call) => call.args[0] === 'fetch')?.env?.['GIT_SSH_COMMAND']).toBe('');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('does not rewind a failed commit that exists only on this machine', async () => {
    const h = harness({
      repo: { head: C2, upstream: C1 },
      files: { [FAILED]: JSON.stringify({ commit: C2, reason: 'the new bundle exited during startup' }) },
    });
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.calls.some((call) => call.startsWith('git reset'))).toBe(false);
    expect(h.repo.head).toBe(C2);
  });

  it('still restarts onto a swapped-in bundle when clearing the old failure record fails', async () => {
    const h = harness({
      repo: { upstream: C2 },
      files: { [FAILED]: JSON.stringify({ commit: C3, reason: 'old', retryAfter: 0 }) },
    });
    const remove = h.fs.remove;
    h.fs.remove = (p) => {
      if (p === FAILED) throw new Error('EBUSY: resource busy');
      remove(p);
    };
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(h.fs.files.get(BUNDLE)).toBe('bundle:b');
    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(updater.getSummary().state).toBe('restart_pending');
  });

  it('keeps the restart pending when the restart itself throws', async () => {
    const h = harness({ repo: { upstream: C2 } });
    h.restart.mockRejectedValueOnce(new Error('disconnect failed'));
    const updater = h.make();
    h.advance(10 * MINUTE);

    await updater.tick();

    expect(updater.getSummary()).toMatchObject({ state: 'restart_pending' });
    expect(updater.getSummary().reason).toContain('disconnect failed');
  });
});

describe('restorePreviousWorkerBundle', () => {
  it('puts the previous bundle and stamp back and records the new commit as failed', () => {
    const fs = memoryFs({
      [BUNDLE]: 'bundle:new',
      [PREVIOUS]: 'bundle:old',
      [STAMP]: `${C2}\n`,
      [`${STAMP}.prev`]: `${C1}\n`,
      [`${STAMP}.swapped`]: `${C2}\n`,
    });

    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(true);
    expect(fs.files.has(`${STAMP}.swapped`)).toBe(false);

    expect(fs.files.get(BUNDLE)).toBe('bundle:old');
    expect(fs.files.has(PREVIOUS)).toBe(false); // a second failure cannot loop
    expect(fs.files.get(STAMP)).toBe(`${C1}\n`);
    expect(JSON.parse(fs.files.get(FAILED) ?? '{}')).toMatchObject({ commit: C2 });
  });

  function restorableFs() {
    return memoryFs({
      [BUNDLE]: 'bundle:new',
      [PREVIOUS]: 'bundle:old',
      [STAMP]: `${C2}\n`,
      [`${STAMP}.prev`]: `${C1}\n`,
      [`${STAMP}.swapped`]: `${C2}\n`,
    });
  }

  it('never leaves the failed commit stamped over the old bundle when the stamp write is refused', () => {
    const fs = restorableFs();
    const write = fs.writeText;
    fs.writeText = (p, text) => {
      if (p === STAMP) throw new Error('EBUSY: resource busy');
      write(p, text);
    };

    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(true);

    expect(fs.files.get(BUNDLE)).toBe('bundle:old');
    expect(fs.files.has(STAMP)).toBe(false); // unknown, never "current"
    expect(JSON.parse(fs.files.get(FAILED) ?? '{}')).toMatchObject({ commit: C2 });
  });

  it('still restores the bundle when the failure record cannot be written', () => {
    const fs = restorableFs();
    const write = fs.writeText;
    fs.writeText = (p, text) => {
      if (p === FAILED) throw new Error('EPERM: operation not permitted');
      write(p, text);
    };

    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(true);
    expect(fs.files.get(BUNDLE)).toBe('bundle:old');
    expect(fs.files.get(STAMP)).toBe(`${C1}\n`);
  });

  it('reports no restore, and records the failure, when the bundle copy itself is refused', () => {
    const fs = restorableFs();
    fs.copy = () => {
      throw new Error('EBUSY: resource busy');
    };

    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(false);
    expect(fs.files.get(BUNDLE)).toBe('bundle:new');
    expect(fs.files.get(STAMP)).toBe(`${C2}\n`);
    expect(JSON.parse(fs.files.get(FAILED) ?? '{}')).toMatchObject({ commit: C2 });
  });

  it('leaves a manual rebuild alone even when an old index.prev.js is still on disk', () => {
    const fs = memoryFs({
      [BUNDLE]: 'bundle:manual',
      [PREVIOUS]: 'bundle:stale',
      [STAMP]: `${C3}\n`, // written by start-worker.bat / update-running-worker.ps1
      [`${STAMP}.prev`]: `${C1}\n`,
      [`${STAMP}.swapped`]: `${C2}\n`, // the last AUTOMATIC swap, since superseded
    });

    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(false);
    expect(fs.files.get(BUNDLE)).toBe('bundle:manual');
    expect(fs.files.has(FAILED)).toBe(false);
  });

  it('returns false when there is nothing to restore', () => {
    const fs = memoryFs({ [BUNDLE]: 'bundle:new', [STAMP]: `${C2}\n` });
    expect(restorePreviousWorkerBundle(BUNDLE, fs)).toBe(false);
    expect(fs.files.get(BUNDLE)).toBe('bundle:new');
    expect(restorePreviousWorkerBundle(undefined, fs)).toBe(false);
  });
});

describe('resolveSelfUpdateTarget', () => {
  const present = new Set([
    path.join(REPO, '.git'),
    path.join(REPO, 'build-worker-agent.ts'),
    path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  ]);
  const base = {
    enabledInConfig: true,
    env: { [WORKER_SUPERVISED_ENV]: '1' },
    entrypoint: BUNDLE,
    exists: (p: string) => present.has(p),
  };

  it('finds the checkout of a supervised dist bundle', () => {
    expect(resolveSelfUpdateTarget(base)).toEqual({ repoRoot: REPO, bundlePath: BUNDLE });
  });

  it.each([
    ['config turns it off', { enabledInConfig: false }, 'turned off'],
    ['nothing will respawn the process', { env: {} }, 'supervisor'],
    ['the entrypoint is not the dist bundle', { entrypoint: path.join(REPO, 'src', 'index.ts') }, 'dist/worker-agent'],
    ['there is no entrypoint script', { entrypoint: undefined }, 'entrypoint'],
    ['the checkout cannot build', { exists: (p: string) => !p.endsWith('cli.mjs') && present.has(p) }, 'cli.mjs'],
  ])('is off when %s', (_label, change, reason) => {
    const result = resolveSelfUpdateTarget({ ...base, ...change });
    expect(result).toHaveProperty('disabledReason');
    expect((result as { disabledReason: string }).disabledReason).toContain(reason);
  });
});
