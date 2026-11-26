// Escape tests run the real CLI while intercepting its destructive boundary.
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const output = process.env.AIO_RETIRE_TEST_RM_LOG;
if (!output) throw new Error('Scratch escape probe requires a fixture log');
fs.rmSync = (path) => {
  fs.appendFileSync(output, JSON.stringify({ path: String(path), physical: fs.realpathSync(path) }) + '\n');
  throw new Error('Scratch escape test intercepted rm');
};
const cp = require('node:child_process');
const execute = cp.execFileSync;
let checks = 0;
cp.execFileSync = function (...args) {
  const result = Reflect.apply(execute, this, args);
  const edit = process.env.AIO_RETIRE_TEST_EDIT_ON_GIT;
  if (args[0] === 'git' && args[1].includes('check-ignore')) checks++;
  if (edit && args[0] === 'git' && args[1].includes('check-ignore') && checks === Number(process.env.AIO_RETIRE_TEST_EDIT_AFTER_CHECK || 1)) {
    fs.writeFileSync(edit, 'changed');
    const old = new Date('2026-08-01T00:00:00Z');
    fs.utimesSync(edit, old, old);
  }
  return result;
};
syncBuiltinESMExports();
