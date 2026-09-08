import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function loadCandidateBaseUrls(appData: string): () => string[] {
  const scriptPath = join(__dirname, 'run-tests-quiet.js');
  const source = readFileSync(scriptPath, 'utf8').replace(
    /\nmain\(\)\.catch\([\s\S]*$/,
    '\nmodule.exports = { candidateBaseUrls };\n',
  );
  const module = { exports: {} as { candidateBaseUrls?: () => string[] } };
  const processForTest = {
    ...process,
    argv: ['node', scriptPath],
    env: { ...process.env, APPDATA: appData, AIO_AUX_LLM_URL: undefined },
  };
  vm.runInNewContext(source, {
    AbortController,
    URL,
    __dirname,
    __filename: scriptPath,
    clearTimeout,
    console,
    fetch,
    module,
    process: processForTest,
    require: createRequire(scriptPath),
    setTimeout,
  });
  if (!module.exports.candidateBaseUrls) {
    throw new Error('candidateBaseUrls was not loaded from run-tests-quiet.js');
  }
  return module.exports.candidateBaseUrls;
}

describe('run-tests-quiet local-model endpoint routing', () => {
  it('does not fall back to localhost when the app setting disables Mac Ollama', () => {
    const appData = mkdtempSync(join(tmpdir(), 'aio-test-summary-'));
    const harnessDir = join(appData, 'harness');
    mkdirSync(harnessDir);
    writeFileSync(
      join(harnessDir, 'settings.json'),
      JSON.stringify({
        auxiliaryLlmEndpointsJson: '[]',
        auxiliaryLlmUseLocalhostOllama: false,
      }),
    );

    expect(loadCandidateBaseUrls(appData)()).toEqual([]);
  });
});

type QuietReport = {
  numFailedTests: number;
  numPassedTests?: number;
  numTotalTests: number;
};

type ClassifyRun = (
  report: QuietReport | null,
  exitCode: number,
  logText: string,
) => 'pass' | 'real_failures' | 'worker_rpc_timeout_after_pass' | 'crash';

/** Loads exported helpers without executing `main()`. */
function loadQuietRunnerExports(): {
  formatVerdictLine: (report: QuietReport | null, exitCode: number) => string;
  classifyRun: ClassifyRun;
} {
  const scriptPath = join(__dirname, 'run-tests-quiet.js');
  const source = readFileSync(scriptPath, 'utf8').replace(
    /\nmain\(\)\.catch\([\s\S]*$/,
    '\nmodule.exports = { formatVerdictLine, classifyRun };\n',
  );
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(source, {
    AbortController,
    URL,
    __dirname,
    __filename: scriptPath,
    clearTimeout,
    console,
    fetch,
    module,
    process: { ...process, argv: ['node', scriptPath] },
    require: createRequire(scriptPath),
    setTimeout,
  });
  const formatVerdictLine = module.exports['formatVerdictLine'];
  const classifyRun = module.exports['classifyRun'];
  if (typeof formatVerdictLine !== 'function' || typeof classifyRun !== 'function') {
    throw new Error('run-tests-quiet helpers were not loaded');
  }
  return {
    formatVerdictLine: formatVerdictLine as ReturnType<typeof loadQuietRunnerExports>['formatVerdictLine'],
    classifyRun: classifyRun as ClassifyRun,
  };
}

function loadFormatVerdictLine(): (
  report: QuietReport | null,
  exitCode: number,
) => string {
  return loadQuietRunnerExports().formatVerdictLine;
}

describe('run-tests-quiet failure verdict', () => {
  // 2026-08-30: a full run with 2 failures was read as a pass. The failure
  // summary is printed FIRST, above pages of stack traces, while the success
  // summary is the LAST line — so any truncated read (`| tail -3`, a CI log
  // excerpt, a pasted snippet) showed a stack trace then `full log: ...` and
  // looked green. The verdict is now repeated last on the failure path too.
  it('states the failure count and the exit code it will use', () => {
    const line = loadFormatVerdictLine()({ numFailedTests: 2, numTotalTests: 19706 }, 0);
    expect(line).toContain('FAILED');
    expect(line).toContain('2 of 19706');
    // vitest exited 0 despite failures; the wrapper floors it to 1.
    expect(line).toContain('exit 1');
  });

  it('reports vitest\'s own non-zero code when it had one', () => {
    expect(loadFormatVerdictLine()({ numFailedTests: 1, numTotalTests: 10 }, 137)).toContain('exit 137');
  });

  it('is explicit when there is no usable report, rather than implying a pass', () => {
    const line = loadFormatVerdictLine()(null, 1);
    expect(line).toContain('FAILED');
    expect(line).toContain('no usable JSON report');
  });

  it('does not call a present zero-failure report "no usable JSON report"', () => {
    const line = loadFormatVerdictLine()(
      { numFailedTests: 0, numPassedTests: 5604, numTotalTests: 5605 },
      1,
    );
    expect(line).toContain('FAILED');
    expect(line).toContain('5604 passed');
    expect(line).toContain('unhandled runner error');
    expect(line).not.toContain('no usable JSON report');
  });
});

describe('run-tests-quiet worker RPC timeout classification', () => {
  const passedReport: QuietReport = {
    numFailedTests: 0,
    numPassedTests: 5604,
    numTotalTests: 5605,
  };
  const flakeLog = [
    'Vitest caught 1 unhandled error during the test run.',
    'Error: [vitest-worker]: Timeout calling "onTaskUpdate"',
    ' Test Files  508 passed (508)',
    '      Tests  5604 passed | 1 skipped (5605)',
    '     Errors  1 error',
  ].join('\n');

  it('treats an all-pass shard with a single onTaskUpdate ACK timeout as that flake', () => {
    const { classifyRun } = loadQuietRunnerExports();
    expect(classifyRun(passedReport, 1, flakeLog)).toBe('worker_rpc_timeout_after_pass');
  });

  it('classifies the same flake when the CI log still has ANSI color codes', () => {
    const { classifyRun } = loadQuietRunnerExports();
    const ansiLog = [
      '\u001B[31m\u001B[1mVitest caught 1 unhandled error during the test run.',
      '\u001B[31m\u001B[1mError\u001B[22m: [vitest-worker]: Timeout calling "onTaskUpdate"\u001B[39m',
      '\u001B[2m Test Files \u001B[22m \u001B[1m\u001B[32m508 passed\u001B[39m\u001B[22m\u001B[90m (508)\u001B[39m',
      '\u001B[2m      Tests \u001B[22m \u001B[1m\u001B[32m5604 passed\u001B[39m\u001B[22m\u001B[2m | \u001B[22m\u001B[33m1 skipped\u001B[39m\u001B[90m (5605)\u001B[39m',
    ].join('\n');
    expect(classifyRun(passedReport, 1, ansiLog)).toBe('worker_rpc_timeout_after_pass');
  });

  it('still classifies a real failed test when the same timeout is also in the log', () => {
    const { classifyRun } = loadQuietRunnerExports();
    expect(
      classifyRun({ numFailedTests: 2, numPassedTests: 10, numTotalTests: 12 }, 1, flakeLog),
    ).toBe('real_failures');
  });

  it('does not treat a missing report or extra unhandled errors as the flake', () => {
    const { classifyRun } = loadQuietRunnerExports();
    expect(classifyRun(null, 1, flakeLog)).toBe('crash');
    expect(
      classifyRun(
        passedReport,
        1,
        flakeLog.replace('caught 1 unhandled error', 'caught 2 unhandled errors'),
      ),
    ).toBe('crash');
  });

  it('does not treat a timeout as the flake when the Vitest summary lists failures', () => {
    const { classifyRun } = loadQuietRunnerExports();
    const failedSummary = flakeLog
      .replace('Test Files  508 passed (508)', 'Test Files  1 failed | 507 passed (508)')
      .replace('Tests  5604 passed | 1 skipped (5605)', 'Tests  2 failed | 5602 passed (5604)');
    expect(classifyRun(passedReport, 1, failedSummary)).toBe('crash');
  });
});
