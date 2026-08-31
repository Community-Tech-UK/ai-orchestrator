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

/** Loads the verdict formatter without executing `main()`. */
function loadFormatVerdictLine(): (
  report: { numFailedTests: number; numTotalTests: number } | null,
  exitCode: number,
) => string {
  const scriptPath = join(__dirname, 'run-tests-quiet.js');
  const source = readFileSync(scriptPath, 'utf8').replace(
    /\nmain\(\)\.catch\([\s\S]*$/,
    '\nmodule.exports = { formatVerdictLine };\n',
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
  const fn = module.exports['formatVerdictLine'];
  if (typeof fn !== 'function') throw new Error('formatVerdictLine was not loaded');
  return fn as ReturnType<typeof loadFormatVerdictLine>;
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
});
