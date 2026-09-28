// Mirrors src/main/sandbox/seatbelt.ts buildSeatbeltCommand + defaultHardenedWritableRoots
// exactly, so a probe runs a CLI under the same jail Harness uses for a hardened session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const BASE = fs.readFileSync(path.join(repo, 'resources/sandbox/aio-seatbelt-base.sbpl'), 'utf8');

function realpathForSandbox(root) {
  try {
    return fs.realpathSync(root);
  } catch (error) {
    if (error.code !== 'ENOENT') return root;
    const parent = path.dirname(root);
    if (parent === root) return root;
    return path.join(realpathForSandbox(parent), path.basename(root));
  }
}

export function defaultRoots(workspace) {
  const home = os.homedir();
  return [
    workspace,
    os.tmpdir(),
    path.join(home, '.claude'),
    path.join(home, '.codex'),
    path.join(home, '.gemini'),
    path.join(home, '.copilot'),
    path.join(home, '.ai-orchestrator'),
  ];
}

export function seatbeltArgs(roots, command, args) {
  const resolved = roots
    .map((root) => realpathForSandbox(path.resolve(root)))
    .filter((root, index, all) => all.indexOf(root) === index);
  const clauses = resolved
    .map((_r, i) => `(allow file-write* (subpath (param "WRITABLE_ROOT_${i}")))`)
    .join('\n');
  const policy = `${BASE}\n; --- generated writable roots (values via -D params) ---\n${clauses}\n`;
  const defs = resolved.flatMap((root, i) => ['-D', `WRITABLE_ROOT_${i}=${root}`]);
  return { command: '/usr/bin/sandbox-exec', args: ['-p', policy, ...defs, '--', command, ...args], roots: resolved };
}
