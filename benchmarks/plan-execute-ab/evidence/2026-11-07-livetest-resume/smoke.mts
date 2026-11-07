import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { readConfig } from '../../benchmarks/plan-execute-ab/config.ts';
import { runClaudeAgent } from '../../benchmarks/plan-execute-ab/agent-cli.ts';
import { localEndpointEnv } from '../../benchmarks/plan-execute-ab/arms.ts';
assert(process.env.PLAN_EX_AB_CONFIG);
assert(process.env.PLAN_EX_AB_LOCAL_KEY);
const config = readConfig(process.env.PLAN_EX_AB_CONFIG);
assert.equal(config.localArms.length, 1);
const endpoint = config.localArms[0];
const root = resolve('_scratch/plan-execute-ab');
mkdirSync(root, { recursive: true });
const fixture = mkdtempSync(join(root, 'smoke-'));
writeFileSync(join(fixture, 'answer.txt'), '0\n');
writeFileSync(join(fixture, 'package.json'), JSON.stringify({
  private: true, scripts: { test: 'node --test answer.test.cjs' },
}));
writeFileSync(join(fixture, 'answer.test.cjs'),
  "const fs=require('node:fs');const assert=require('node:assert/strict');" +
  "require('node:test')('answer',()=>assert.equal(fs.readFileSync('answer.txt','utf8').trim(),'42'));\n");
const result = await runClaudeAgent({
  prompt: 'Read answer.txt, change its value to 42, then run npm test. Work only in this fixture.',
  cwd: fixture, logPath: join(fixture, 'agent.log'),
  env: localEndpointEnv(endpoint), model: endpoint.servedModelName,
  timeoutMs: 60 * 60_000, maxTurns: 75,
});
writeFileSync(join(fixture, 'result.json'), JSON.stringify(result, null, 2));
assert.equal(result.error, undefined);
assert.equal(result.exitCode, 0);
assert.equal(result.timedOut, false);
assert.equal(result.hitTurnCap, false);
assert.deepEqual(result.toolErrors, []);
assert.equal(readFileSync(join(fixture, 'answer.txt'), 'utf8').trim(), '42');
const testOutput = execFileSync(process.execPath, ['--test', 'answer.test.cjs'], { cwd: fixture });
writeFileSync(join(fixture, 'independent-test.log'), testOutput);
console.log('Fixture tool outcome passed; inspect request-two native timing before passing A4.');
