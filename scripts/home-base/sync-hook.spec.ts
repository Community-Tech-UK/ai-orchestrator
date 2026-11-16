import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { renderSyncHook } = require('./sync-agent-setup.js') as {
  renderSyncHook(text: string, options: { scriptPath: string; remote: string; destinationHome: string; remoteNode: string }): string;
};
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('passes the selected remote Node path intact when the installed hook actually runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-sync-hook-')); roots.push(root);
  const scriptPath = path.join(root, "copy O'Brien.cjs");
  fs.writeFileSync(scriptPath, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const remoteNode = "/Users/example/Node O'Brien/node";
  const hookPath = path.join(root, 'sync.sh');
  fs.writeFileSync(hookPath, renderSyncHook('#!/bin/sh\n', {
    scriptPath, remote: 'ct-test-mac', destinationHome: '/Users/example/Home Folder', remoteNode,
  }));
  const output = execFileSync('/bin/sh', [hookPath], {
    encoding: 'utf8', env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] ?? ''}` },
  });
  expect(JSON.parse(output)).toEqual(['sync', '--remote', 'ct-test-mac', '--destination-home', '/Users/example/Home Folder', '--remote-node', remoteNode]);
});
