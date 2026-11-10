import { describe, expect, it } from 'vitest';
import {
  VERIFICATION_CMD_PATTERN,
  classifyCommandOutcome,
  describeExitStatus,
  didCommandExitNonZero,
  isCheckCommand,
  isToolResultFailed,
  readExecutionEvidence,
  toolKindOf,
} from './tool-outcome';

describe('isCheckCommand', () => {
  it.each([
    'npm test',
    'npm run test:quiet -- src/main/foo.spec.ts',
    'npx vitest run src/foo.spec.ts',
    'npx tsc --noEmit',
    'npm run lint',
    'npm run build:main',
    'pytest -q tests/',
    'cargo test --workspace',
    'go test ./...',
    './gradlew test',
    'make check',
    'node scripts/run-tests-quiet.js',
    'cd frontend && npm test',
    "/bin/zsh -lc 'npm run typecheck:spec'",
    '/bin/bash -c "cd app && pnpm lint"',
    'powershell.exe -NoProfile -Command "npm test"',
    'cmd.exe /c "npm run build"',
    'CI=1 npm test',
    'time npm run verify',
    'npm test 2>&1 | tail -20',
    'npm run lint -- --rule "no-test"',
    'local-check',
  ])('treats %j as a check', (command) => {
    expect(isCheckCommand(command)).toBe(true);
  });

  it.each([
    'ls -la',
    'git status',
    'git diff --exit-code',
    'git commit -m "fix test"',
    'rg -n "test" src',
    'rg "foo|test" src',
    "rg 'a && test' src",
    'rg test',
    'grep -rn "build" docs',
    "sed -n '1,40p' tests/foo.spec.ts",
    'cat tests/helpers.ts',
    'find . -name "*.test.ts"',
    'echo "all tests passed"',
    'test -f package.json',
    '[ -d node_modules ]',
    'python -c "print(1)"',
    "/bin/zsh -lc 'rg --files tests'",
    'cd tests && ls',
    '',
  ])('does not treat %j as a check', (command) => {
    expect(isCheckCommand(command)).toBe(false);
  });

  it('handles a missing command', () => {
    expect(isCheckCommand(undefined)).toBe(false);
  });

  it('reads the commands around a here-document, not the text inside it', () => {
    expect(isCheckCommand("cat > notes.md <<'EOF'\nRun the tests before building\nEOF")).toBe(false);
    expect(isCheckCommand("cat > notes.md <<'EOF'\nRun the tests before building\nEOF\nnpm test")).toBe(true);
    expect(isCheckCommand('cat > notes.md <<-EOF\n\tRun the tests\n\tEOF\n')).toBe(false);
    expect(isCheckCommand("python - <<'PY'\nprint('test')\nPY")).toBe(false);
    expect(isCheckCommand('cat <<EOF\r\nrun the tests\r\nEOF\r\nnpm run lint')).toBe(true);
    expect(isCheckCommand('cat <<EOF\nrun the tests\nnever terminated')).toBe(false);
    expect(isCheckCommand('cat <<< "run the tests"')).toBe(false);
  });

  it('stays linear on a very long command with many quotes (it runs on the main thread for every command)', () => {
    const noisy = "it's a 'line' with \"quotes\" and a stray apostrophe\n".repeat(4000);
    const started = performance.now();
    expect(isCheckCommand(`cat > notes.txt <<'EOF'\n${noisy}EOF`)).toBe(false);
    expect(isCheckCommand(`/bin/zsh -lc "cd app && ${noisy.replaceAll('\n', ' ')} && npm test"`)).toBeTypeOf('boolean');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('keeps the loose phase pattern the Codex adapter already used', () => {
    expect(VERIFICATION_CMD_PATTERN.test('npm test')).toBe(true);
    expect(VERIFICATION_CMD_PATTERN.test('ls -la')).toBe(false);
  });
});

describe('classifyCommandOutcome', () => {
  it('treats a clean exit as a success', () => {
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: 0, status: 'completed' })).toEqual({
      isError: false, exitCode: 0, isCheck: true, checkFailed: false,
    });
  });

  it('keeps a non-zero exit of an ordinary command neutral, even when the provider says "failed"', () => {
    expect(classifyCommandOutcome({ command: 'rg missing src', exitCode: 1, status: 'failed' })).toEqual({
      isError: false, exitCode: 1, isCheck: false, checkFailed: false,
    });
    expect(classifyCommandOutcome({ command: 'git diff --exit-code', exitCode: 1, status: 'completed' })).toMatchObject({
      isError: false, checkFailed: false,
    });
  });

  it('records a failing check without calling it a transport error', () => {
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: 1, status: 'failed' })).toEqual({
      isError: false, exitCode: 1, isCheck: true, checkFailed: true,
    });
    expect(classifyCommandOutcome({ command: 'npx tsc --noEmit', exitCode: 2, status: 'completed' })).toMatchObject({
      isError: false, isCheck: true, checkFailed: true,
    });
  });

  it('calls a command that never ran an error', () => {
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: null, status: 'declined' })).toMatchObject({
      isError: true, isCheck: true, checkFailed: true,
    });
    expect(classifyCommandOutcome({ command: 'ls', status: 'failed' })).toMatchObject({
      isError: true, isCheck: false, checkFailed: false,
    });
    expect(classifyCommandOutcome({ command: 'ls', exitCode: null, status: 'failed' }).exitCode).toBeUndefined();
  });

  // A command can exit with any status on purpose (`exit 124`, a script's own
  // `exit 127`, `kill -9 $$` reported as 137). A number alone is never evidence
  // that the command could not run.
  it.each([1, 124, 126, 127, 137, 255, -1])(
    'keeps a supplied exit status of %i neutral: the command ran and chose that status',
    (exitCode) => {
      expect(classifyCommandOutcome({ command: 'ls', exitCode, status: 'failed' })).toEqual({
        isError: false, exitCode, isCheck: false, checkFailed: false,
      });
      expect(classifyCommandOutcome({ command: 'ls', exitCode, status: 'completed' }).isError).toBe(false);
    },
  );

  it('keeps a supplied clean exit a success even when the provider calls the item failed', () => {
    // The provider says "failed" but also reports that the process exited 0: the supplied
    // status wins. An irreducible ambiguity, recorded rather than guessed at.
    expect(classifyCommandOutcome({ command: 'ls', exitCode: 0, status: 'failed' }).isError).toBe(false);
  });

  it('calls a command an error when the provider says the process timed out', () => {
    expect(classifyCommandOutcome({ command: 'ls', exitCode: 1, status: 'completed', timedOut: true })).toMatchObject({
      isError: true, exitCode: 1,
    });
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: 124, status: 'failed', timedOut: true })).toMatchObject({
      isError: true, isCheck: true, checkFailed: true,
    });
  });

  it('calls a command an error when the provider reports the signal that ended it', () => {
    expect(classifyCommandOutcome({ command: 'ls', exitCode: 137, status: 'completed', signal: 'SIGKILL' })).toMatchObject({
      isError: true, exitCode: 137,
    });
    expect(classifyCommandOutcome({ command: 'ls', status: 'completed', signal: 15 }).isError).toBe(true);
  });

  it('ignores an empty or absent signal and a false timeout flag', () => {
    for (const evidence of [{ signal: null }, { signal: '' }, { signal: undefined }, { timedOut: false }, {}]) {
      expect(classifyCommandOutcome({ command: 'ls', exitCode: 2, status: 'completed', ...evidence }).isError).toBe(false);
    }
  });

  // A shell chain's exit status is the status of the last command that ran. When
  // something that can fail runs before the check, a non-zero exit may mean the check
  // was never reached, so it must not be reported as a failed test run.
  describe('a failed check must actually have been reached', () => {
    const failed = (command: string) => classifyCommandOutcome({ command, exitCode: 1, status: 'failed' });

    it.each([
      'npm test',
      'CI=1 npm test',
      'time npm run verify',
      'npm run lint && npm test',
      'npm run lint; npm test',
    ])('blames a non-zero exit of %j on the check', (command) => {
      expect(failed(command)).toMatchObject({ isCheck: true, checkFailed: true, isError: false });
    });

    it.each([
      'cd app && npm test',
      'cd app; npm test',
      'export CI=1 && npm test',
      '/bin/zsh -lc "cd app && npm test"',
      'npm test && echo done',
      'npm test || exit 1',
      'cd app && npm run lint && npm test && echo ok',
      'rg TODO src && npm test',
      'git pull && npm test',
      'npm ci && npm test',
      'cd app && rg TODO src && npm test',
      'mkdir -p out && npm test',
      'npm test; rm -rf tmp',
      'npm test && git push',
      'npm test | tail -20',
      'npm test 2>&1 | tee test.log',
      'if [ -f x ]; then npm test; fi',
      '(rg TODO src && npm test)',
    ])('does not blame a non-zero exit of %j on the check: it may never have run', (command) => {
      expect(failed(command)).toMatchObject({ isCheck: true, checkFailed: false, isError: false, exitCode: 1 });
    });

    it('blames a check that was killed or never started, whatever else is in the chain', () => {
      expect(classifyCommandOutcome({ command: 'git pull && npm test', status: 'declined' }))
        .toMatchObject({ isError: true, checkFailed: true });
      expect(classifyCommandOutcome({ command: 'git pull && npm test', exitCode: 1, timedOut: true }))
        .toMatchObject({ isError: true, checkFailed: true });
    });

    it('trusts the caller who marks the command as a check', () => {
      expect(classifyCommandOutcome({ command: 'git pull && ./ci.sh', exitCode: 1, explicitIsCheck: true }))
        .toMatchObject({ isCheck: true, checkFailed: true });
    });

    it('keeps a passing chain a pass', () => {
      expect(classifyCommandOutcome({ command: 'git pull && npm test', exitCode: 0, status: 'completed' }))
        .toMatchObject({ isCheck: true, checkFailed: false, isError: false });
    });
  });

  it('lets the caller mark any command as a check, or as not one', () => {
    expect(classifyCommandOutcome({ command: './ci.sh', exitCode: 1, explicitIsCheck: true })).toMatchObject({
      isCheck: true, checkFailed: true, isError: false,
    });
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: 1, explicitIsCheck: false })).toMatchObject({
      isCheck: false, checkFailed: false,
    });
  });

  it('honours an error flag the provider set itself, and counts it against a check', () => {
    expect(classifyCommandOutcome({ command: 'ls', exitCode: 0, status: 'completed', explicitIsError: true })).toMatchObject({
      isError: true, exitCode: 0, checkFailed: false,
    });
    expect(classifyCommandOutcome({ command: 'npm test', exitCode: 0, status: 'completed', explicitIsError: true })).toMatchObject({
      isError: true, isCheck: true, checkFailed: true,
    });
  });

  it('treats an unknown exit on a completed command as a pass', () => {
    expect(classifyCommandOutcome({ command: 'npm test', status: 'completed' })).toMatchObject({
      isError: false, checkFailed: false,
    });
  });
});

describe('readExecutionEvidence', () => {
  it('reads the explicit flags a provider supplies (Grok sends signal and timed_out)', () => {
    expect(readExecutionEvidence({ exit_code: 2, signal: null, timed_out: false })).toEqual({});
    expect(readExecutionEvidence({ timed_out: true })).toEqual({ timedOut: true });
    expect(readExecutionEvidence({ timedOut: true })).toEqual({ timedOut: true });
    expect(readExecutionEvidence({ signal: 'SIGKILL' })).toEqual({ signal: 'SIGKILL' });
    expect(readExecutionEvidence({ signal: 9, timed_out: true })).toEqual({ signal: 9, timedOut: true });
  });

  it('never manufactures evidence from an exit number, text or a missing source', () => {
    expect(readExecutionEvidence({ exitCode: 137 })).toEqual({});
    expect(readExecutionEvidence({ aggregatedOutput: 'command timed out after 10s' })).toEqual({});
    expect(readExecutionEvidence({ signal: '', timed_out: 'yes' })).toEqual({});
    expect(readExecutionEvidence(undefined)).toEqual({});
  });
});

describe('describeExitStatus', () => {
  it('words the exit neutrally', () => {
    expect(describeExitStatus(1)).toBe('Exited with status 1');
    expect(describeExitStatus(0)).toBe('Exited with status 0');
  });
});

describe('toolKindOf', () => {
  it('buckets tool names', () => {
    expect(toolKindOf('Bash')).toBe('command');
    expect(toolKindOf('command_execution')).toBe('command');
    expect(toolKindOf('execute')).toBe('command');
    expect(toolKindOf('Edit')).toBe('edit');
    expect(toolKindOf('Write')).toBe('edit');
    expect(toolKindOf('apply_patch')).toBe('edit');
    expect(toolKindOf('Read')).toBe('other');
    expect(toolKindOf('lookup')).toBe('other');
    expect(toolKindOf(undefined)).toBe('other');
  });
});

describe('isToolResultFailed', () => {
  it('fails an edit or write that errored, and only that', () => {
    expect(isToolResultFailed('Edit', { is_error: true })).toBe(true);
    expect(isToolResultFailed('Write', { isError: true })).toBe(true);
    expect(isToolResultFailed('Edit', { is_error: false })).toBe(false);
    expect(isToolResultFailed('Edit', { checkFailed: true })).toBe(false);
  });

  it('fails a command that could not run', () => {
    expect(isToolResultFailed('Bash', { is_error: true, exitCode: null })).toBe(true);
  });

  it('fails a command the caller marks as a check when it exits non-zero', () => {
    expect(isToolResultFailed('Bash', { is_error: false, exitCode: 1, isCheck: true, checkFailed: true })).toBe(true);
    expect(isToolResultFailed('Bash', { is_error: false, exitCode: 1, isCheck: true })).toBe(true);
    expect(isToolResultFailed('Bash', { is_error: false, exitCode: 0, isCheck: true })).toBe(false);
  });

  it('leaves a neutral non-zero exit alone', () => {
    expect(isToolResultFailed('Bash', { is_error: false, exitCode: 1, isCheck: false, checkFailed: false })).toBe(false);
    expect(isToolResultFailed('Bash', { exitCode: 1 })).toBe(false);
  });

  it('honours check flags whatever the tool name, since only command results carry them', () => {
    expect(isToolResultFailed('Run deploy command', { isCheck: true, checkFailed: true })).toBe(true);
    expect(isToolResultFailed(undefined, { isCheck: true, checkFailed: true })).toBe(true);
  });

  it('is false with no metadata', () => {
    expect(isToolResultFailed('Bash', undefined)).toBe(false);
    expect(isToolResultFailed(undefined, {})).toBe(false);
  });
});

describe('didCommandExitNonZero', () => {
  it('reports any non-zero exit, for readers that learn from every failed command', () => {
    expect(didCommandExitNonZero({ exitCode: 1 })).toBe(true);
    expect(didCommandExitNonZero({ exitCode: 127 })).toBe(true);
    expect(didCommandExitNonZero({ exitCode: 0 })).toBe(false);
    expect(didCommandExitNonZero({ exitCode: null })).toBe(false);
    expect(didCommandExitNonZero({})).toBe(false);
    expect(didCommandExitNonZero(undefined)).toBe(false);
  });
});
