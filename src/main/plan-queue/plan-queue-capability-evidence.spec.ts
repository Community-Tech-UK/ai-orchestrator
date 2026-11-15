import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

// Execute the actual reader in a disposable process: a blocking open must not hang the test runner.
const source = readFileSync('src/main/plan-queue/plan-queue-capability-plan.ts', 'utf8');
const reader = source.slice(source.indexOf('export async function readCapabilityEvidence'),
  source.indexOf('export async function ensureCapabilityPlan')).replace('export async', 'async');
const program = `const fs = require('node:fs/promises'), path = require('node:path');
const { constants } = require('node:fs');
if (process.argv[2] === 'swap') {
  const open = fs.open;
  fs.open = async (file, flags) => {
    await fs.unlink(file);
    require('node:child_process').execFileSync('mkfifo', [file]);
    return open(file, flags);
  };
}
${ts.transpile(reader, { target: ts.ScriptTarget.ES2022 })}
readCapabilityEvidence(process.argv[1], 'receipt.json').then(
  value => console.log(JSON.stringify({ value })),
  error => console.log(JSON.stringify({ error: error.message })));
`;

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'aio-capability-evidence-'));
  folders.push(folder);
  return folder;
}

it('reads a regular evidence file through the isolated reader', () => {
  const folder = fixture();
  writeFileSync(join(folder, 'receipt.json'), 'bounded receipt');
  const result = spawnSync(process.execPath, ['-e', program, folder], { encoding: 'utf8', timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ value: 'bounded receipt' });
});

it.skipIf(process.platform === 'win32')('rejects a FIFO receipt without waiting for a writer', () => {
  const folder = fixture();
  execFileSync('mkfifo', [join(folder, 'receipt.json')]);
  const result = spawnSync(process.execPath, ['-e', program, folder], { encoding: 'utf8', timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ error: 'Capability evidence is not a bounded regular file.' });
});

it.skipIf(process.platform === 'win32')('rejects a regular receipt replaced with a FIFO before open', () => {
  const folder = fixture();
  writeFileSync(join(folder, 'receipt.json'), 'original receipt');
  const result = spawnSync(process.execPath, ['-e', program, folder, 'swap'], { encoding: 'utf8', timeout: 3000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ error: 'Capability evidence is not a bounded regular file.' });
});
