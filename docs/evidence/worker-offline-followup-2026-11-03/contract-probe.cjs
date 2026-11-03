// Reproduce the original schema rejection without changing the working tree.
// Run: node docs/evidence/worker-offline-followup-2026-11-03/contract-probe.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const file = 'packages/contracts/src/schemas/remote-node.schemas.ts';
function load(source) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', compiled)(exports, require);
  return exports.RemoteNodeEventSchema;
}
const baseline = '2d210df7a867cb970dade9d4672657525e75f27c';
const before = load(execFileSync('git', ['show', baseline + ':' + file], { encoding: 'utf8' }));
const after = load(readFileSync(file, 'utf8'));
const states = ['running', 'stopped', 'absent', 'unknown'];
const result = states.map(state => {
  const event = { type: 'coordinator-route', coordinatorTailscale: state };
  const row = { state, baseline: before.safeParse(event).success, fixed: after.safeParse(event).success };
  assert.equal(row.baseline, false);
  assert.equal(row.fixed, true);
  return row;
});
for (const coordinatorTailscale of ['invalid', null, 1, undefined]) {
  assert.equal(after.safeParse({ type: 'coordinator-route', coordinatorTailscale }).success, false);
}
console.log(JSON.stringify({ states: result, invalidStatesRejected: true }));
