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
