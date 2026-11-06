import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hookPath = path.join(
  process.cwd(),
  'src',
  'main',
  'cli',
  'hooks',
  'rtk-defer-hook.mjs',
);

/**
 * Build a stub rtk binary that exits with the requested code and prints the
 * given stdout. Lets us drive the hook's RTK integration without the real binary.
 */
function makeStubRtk(
  rootDir: string,
  spec: { exit: number; stdout?: string },
): string {
  if (process.platform === 'win32') {
    // Skip Windows in unit tests; covered by the integration matrix.
    return '';
  }
  const stubPath = path.join(rootDir, 'rtk');
  const lines: string[] = ['#!/usr/bin/env bash'];
  // Honor `rtk --version` so any precondition probe doesn't blow up
  lines.push(
    'if [[ "$1" == "--version" ]]; then',
    '  echo "rtk 0.39.0"',
    '  exit 0',
    'fi',
  );
  if (spec.stdout) {
    const safe = spec.stdout.replace(/'/g, `'\\''`);
    lines.push(`printf '${safe}'`);
  }
  lines.push(`exit ${spec.exit}`);
  writeFileSync(stubPath, lines.join('\n') + '\n', 'utf-8');
  chmodSync(stubPath, 0o755);
  // Pay the first-exec cost here rather than inside the hook's `rtk rewrite`
  // call. The first execution of a file the kernel has not seen before costs a
  // ~290ms median and a >1s tail on macOS (Gatekeeper / code-signing
  // evaluation) against ~3ms once warm; the hook gives that call 2s and
  // degrades to "no rewrite" when it expires, so on a busy host these tests
  // were measuring exec cold-start rather than hook behaviour.
  spawnSync(stubPath, ['--version'], { encoding: 'utf8' });
  return stubPath;
}

/**
 * A child env with the RTK feature-flag vars stripped, so "flag off" tests are
 * deterministic regardless of the host shell's ambient ORCHESTRATOR_RTK_* vars
 * (a dev machine may export ORCHESTRATOR_RTK_ENABLED=1 globally).
 */
function envWithRtkDisabled(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['ORCHESTRATOR_RTK_ENABLED'];
  delete env['ORCHESTRATOR_RTK_PATH'];
  delete env['ORCHESTRATOR_DECISION_DIR'];
  return env;
}

describe('rtk-defer-hook', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rtk-defer-hook-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('defers unsafe tools when feature flag is off (parity with defer-permission-hook)', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_use_id: 'tool-1',
        tool_input: { command: 'git status' },
      }),
      encoding: 'utf8',
      env: envWithRtkDisabled(),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'defer',
        permissionDecisionReason: 'Orchestrator: awaiting user approval',
      },
    });
  });

  it('auto-approves safe tools when feature flag is off', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_use_id: 'tool-2',
        tool_input: { file_path: '/tmp/foo.txt' },
      }),
      encoding: 'utf8',
      env: envWithRtkDisabled(),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rewrites Bash command and defers when rtk exits 0 (allow + defer for orchestrator UI)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-3',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Bash is not in AUTO_APPROVE — so we still defer, but with the rewritten command
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git status' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'forces defer with rewritten command when rtk exits 3 (ask)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 3, stdout: 'rtk git push' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-4',
          tool_input: { command: 'git push' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('RTK ask rule');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git push' });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'leaves command unchanged when rtk exits 1 (passthrough)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 1 });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-5',
          tool_input: { command: 'htop' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'leaves command unchanged when rtk exits 2 (deny)',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 2 });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-6',
          tool_input: { command: 'rm -rf /' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // We don't auto-allow on deny — Claude Code's native deny rules will fire
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'gracefully degrades when rtk binary is missing',
    () => {
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-7',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: '/nonexistent/path/to/rtk',
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      // Falls back to normal defer, no rewrite
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('defer');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'skips rtk for non-Bash tools',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'should-not-be-used' });
      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Edit',
          tool_use_id: 'tool-8',
          tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(parsed.hookSpecificOutput.updatedInput).toBeUndefined();
    },
  );

  it.runIf(process.platform !== 'win32')(
    'replays stored decision file on resume, preserving rewrite',
    () => {
      const stub = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
      writeFileSync(
        path.join(tempDir!, 'tool-9.json'),
        JSON.stringify({ permissionDecision: 'allow', reason: 'Previously approved' }),
        'utf8',
      );

      const result = spawnSync(process.execPath, [hookPath], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_use_id: 'tool-9',
          tool_input: { command: 'git status' },
        }),
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCHESTRATOR_RTK_ENABLED: '1',
          ORCHESTRATOR_RTK_PATH: stub,
          ORCHESTRATOR_DECISION_DIR: tempDir!,
        },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('allow');
      expect(parsed.hookSpecificOutput.permissionDecisionReason).toBe('Previously approved');
      expect(parsed.hookSpecificOutput.updatedInput).toEqual({ command: 'rtk git status' });
    },
  );
});

describe('rtk-defer-hook — rewrite-only mode (A13, Step 18b)', () => {
  let tempDir: string | null = null;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'rtk-rewrite-only-'));
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function rewriteOnlyEnv(stubPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env = envWithRtkDisabled();
    env['ORCHESTRATOR_RTK_ENABLED'] = '1';
    env['ORCHESTRATOR_RTK_REWRITE_ONLY'] = '1';
    env['ORCHESTRATOR_RTK_PATH'] = stubPath;
    delete env['ORCHESTRATOR_RTK_LOG_DIR'];
    return { ...env, ...extra };
  }

  function runHook(input: unknown, env: NodeJS.ProcessEnv) {
    return spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env,
    });
  }

  it('exit 0 with a rewrite prints allow with updatedInput', () => {
    const stubPath = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
    const result = runHook(
      { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(stubPath),
    );
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(reply.hookSpecificOutput.updatedInput.command).toBe('rtk git status');
  });

  it('exit 3 (no rule matched, rewritten) also allows — never defers', () => {
    const stubPath = makeStubRtk(tempDir!, { exit: 3, stdout: 'rtk git log' });
    const result = runHook(
      { tool_name: 'Bash', tool_use_id: 't2', tool_input: { command: 'git log' } },
      rewriteOnlyEnv(stubPath),
    );
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(reply.hookSpecificOutput.updatedInput.command).toBe('rtk git log');
    expect(result.stdout).not.toContain('defer');
    expect(result.stdout).not.toContain('deny');
  });

  it('exit 1 and exit 2 print nothing and exit 0', () => {
    for (const exit of [1, 2]) {
      const stubPath = makeStubRtk(tempDir!, { exit });
      const result = runHook(
        { tool_name: 'Bash', tool_use_id: `t-${exit}`, tool_input: { command: 'git status' } },
        rewriteOnlyEnv(stubPath),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
    }
  });

  it('a missing binary and a timeout print nothing and exit 0', () => {
    const missing = runHook(
      { tool_name: 'Bash', tool_use_id: 'm1', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(path.join(tempDir!, 'does-not-exist')),
    );
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe('');

    const slowStub = path.join(tempDir!, 'rtk-slow');
    writeFileSync(slowStub, '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "rtk 0.51.0"; exit 0; fi\nsleep 5\n', 'utf-8');
    chmodSync(slowStub, 0o755);
    const timeout = runHook(
      { tool_name: 'Bash', tool_use_id: 'm2', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(slowStub),
    );
    expect(timeout.status).toBe(0);
    expect(timeout.stdout).toBe('');
  });

  it('invalid JSON input prints nothing and exits 0 (fail open)', () => {
    const stubPath = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk x' });
    const result = spawnSync(process.execPath, [hookPath], {
      input: 'not json at all {',
      encoding: 'utf8',
      env: rewriteOnlyEnv(stubPath),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('never reads the decision directory: a deny file does not stop a rewrite', () => {
    const stubPath = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
    const decisionDir = path.join(tempDir!, 'decisions');
    mkdirSync(decisionDir, { recursive: true });
    writeFileSync(
      path.join(decisionDir, 't-dec.json'),
      JSON.stringify({ permissionDecision: 'deny', reason: 'blocked by user' }),
      'utf-8',
    );
    const result = runHook(
      { tool_name: 'Bash', tool_use_id: 't-dec', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(stubPath, { ORCHESTRATOR_DECISION_DIR: decisionDir }),
    );
    expect(result.status).toBe(0);
    const reply = JSON.parse(result.stdout);
    expect(reply.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  // The input carries a `command` string and the stub rtk WOULD rewrite it, so
  // the only thing keeping the output empty is the `tool_name !== 'Bash'`
  // guard. (A `Read` input with only `file_path` stays silent without it.)
  it.each(['BashOutput', 'Read'])('leaves a non-Bash tool (%s) with a command field alone (no output at all)', (toolName) => {
    const stubPath = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
    const result = runHook(
      { tool_name: toolName, tool_use_id: 'r1', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(stubPath),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('writes one decision-log line per Bash call, per day, and sweeps files older than 60 days', () => {
    const stubPath = makeStubRtk(tempDir!, { exit: 0, stdout: 'rtk git status' });
    const logDir = path.join(tempDir!, 'hook-decisions');
    mkdirSync(logDir, { recursive: true });
    const stale = path.join(logDir, '2026-07-01.jsonl');
    writeFileSync(stale, '{"old":true}\n', 'utf-8');
    const old = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const result = runHook(
      { session_id: 'sess-1', tool_name: 'Bash', tool_use_id: 't-log', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(stubPath, { ORCHESTRATOR_RTK_LOG_DIR: logDir }),
    );
    expect(result.status).toBe(0);

    const today = new Date().toISOString().slice(0, 10);
    const todayFile = path.join(logDir, `${today}.jsonl`);
    expect(existsSync(todayFile)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    const lines = readFileSync(todayFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.decision).toBe('rewritten');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.tool_use_id).toBe('t-log');
    expect(entry.rtkExit).toBe(0);
    expect(typeof entry.elapsedMs).toBe('number');
  });

  it('logs a passthrough for a no-op rewrite and ignored-deny for exit 2', () => {
    const logDir = path.join(tempDir!, 'hook-decisions-2');
    const noOp = makeStubRtk(tempDir!, { exit: 0, stdout: 'git status' });
    runHook(
      { tool_name: 'Bash', tool_use_id: 'noop', tool_input: { command: 'git status' } },
      rewriteOnlyEnv(noOp, { ORCHESTRATOR_RTK_LOG_DIR: logDir }),
    );
    const denyStub = makeStubRtk(tempDir!, { exit: 2 });
    runHook(
      { tool_name: 'Bash', tool_use_id: 'denied', tool_input: { command: 'git rm -rf .' } },
      rewriteOnlyEnv(denyStub, { ORCHESTRATOR_RTK_LOG_DIR: logDir }),
    );
    const today = new Date().toISOString().slice(0, 10);
    const lines = readFileSync(path.join(logDir, `${today}.jsonl`), 'utf-8').trim().split('\n');
    const decisions = lines.map((l) => JSON.parse(l).decision);
    expect(decisions).toContain('passthrough');
    expect(decisions).toContain('ignored-deny');
  });
});
