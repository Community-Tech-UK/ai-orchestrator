// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../../..');
const HOOK = path.join(ROOT, 'src/main/cli/hooks/precompact-role-hook.mjs');
const ROLES = ['queue-worker', 'loop', 'automation'] as const;
const INPUT = '{malformed input, ignored by the hook}\n'.repeat(8192);
let tempRoot: string;
let emptyPath: string;
const bundles = new Map<string, string>();

function compile(name: string, sea?: string): void {
  const outfile = path.join(tempRoot, `${name}.cjs`);
  // Run esbuild in plain Node: the test project's Zone/DOM globals cannot host
  // esbuild. Only Electron metadata and logging are substituted in the bundle.
  const result = spawnSync(process.execPath, ['-e', `
    const esbuild = require(process.argv[1]);
    const root = process.argv[2];
    const sea = process.argv[4];
    const source = require('node:fs').readFileSync(root + '/src/main/cli/hooks/precompact-role-hook.mjs');
    esbuild.build({
      stdin: {contents: "export * from './src/main/cli/hooks/hook-path-resolver'; export {buildPreCompactOverlay} from './src/main/cli/adapters/claude-precompact-overlay';", resolveDir: root},
      bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: process.argv[3],
      define: {__AIO_WORKER_PRECOMPACT_HOOK_BASE64__: JSON.stringify(source.toString('base64'))},
      plugins: [{name: 'offline-runtime', setup(build) {
        build.onResolve({filter: /^electron$/}, () => ({path: 'electron', namespace: 'offline'}));
        build.onResolve({filter: /logging\\/logger$/}, () => ({path: 'logger', namespace: 'offline'}));
        if (sea) build.onResolve({filter: /^node:sea$/}, () => ({path: sea, namespace: 'offline'}));
        build.onLoad({filter: /.*/, namespace: 'offline'}, ({path}) => ({contents:
          path === 'electron' ? 'exports.app = undefined;'
          : path === 'logger' ? 'exports.getLogger = () => ({info(){},warn(){},debug(){},error(){}});'
          : path === 'sea' ? 'exports.isSea = () => true;'
          : 'throw new Error("SEA API unavailable");'
        }));
      }}],
    }).catch(error => { console.error(error); process.exit(1); });
  `, require.resolve('esbuild'), ROOT, outfile, sea ?? ''], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  bundles.set(name, outfile);
}

function commandFor(role: string, platform = process.platform, bundle = 'worker', setup = ''): string | null {
  const result = spawnSync(process.execPath, ['-e', `${setup}
    if (process.versions.electron) throw new Error('expected plain Node');
    const resolver = require(process.argv[1]);
    console.log(JSON.stringify(resolver.buildPreCompactRoleHookCommand(process.argv[2], process.argv[3]) ?? null));
  `, bundles.get(bundle)!, role, platform], {
    cwd: tempRoot, encoding: 'utf8', timeout: 10_000, env: { PATH: emptyPath },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as string | null;
}

function canonical(role: string, input = INPUT): Buffer {
  const result = spawnSync(process.execPath, [HOOK, role], { cwd: tempRoot, input, timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr.length).toBe(0);
  return result.stdout;
}

describe('PreCompact canonical source in the Node worker bundle', () => {
  beforeAll(() => {
    const scratch = path.join(ROOT, '_scratch/oct2-phaseD-round2');
    mkdirSync(scratch, { recursive: true });
    tempRoot = mkdtempSync(path.join(scratch, 'precompact-worker-'));
    emptyPath = path.join(tempRoot, 'empty-path');
    mkdirSync(emptyPath);
    compile('worker');
    compile('sea-worker', 'sea');
    compile('old-runtime', 'no-sea-api');
  });
  afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

  it('wires the commands through the real machine-session overlay', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const {buildPreCompactOverlay} = require(process.argv[1]);
      console.log(JSON.stringify(['plan-queue','loop','automation'].map(role => buildPreCompactOverlay(role))));
    `, bundles.get('worker')!], { cwd: tempRoot, encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    const settings = JSON.parse(result.stdout) as { hooks: { PreCompact: { hooks: { command: string }[] }[] } }[];
    settings.forEach((overlay, index) => {
      expect(overlay).toHaveProperty('precomputeCompactionEnabled', false);
      expect(overlay.hooks.PreCompact[0].hooks[0].command).toBe(commandFor(ROLES[index]));
    });
  });

  it.each(ROLES)('executes %s with no metadata, assets, Node PATH or checkout cwd', (role) => {
    const command = commandFor(role)!;
    const result = spawnSync(command, {
      shell: true, cwd: tempRoot, input: INPUT, timeout: 10_000, env: { PATH: emptyPath },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.stdout).toEqual(canonical(role));
  });

  it('drains the pipe before printing, without parsing its contents', async () => {
    const child = spawn(commandFor('loop')!, { shell: true, cwd: tempRoot, env: { PATH: emptyPath } });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    const closed = once(child, 'close');
    try {
      await new Promise<void>((resolve, reject) => child.stdin.write(INPUT, error => error ? reject(error) : resolve()));
      expect(output).toHaveLength(0);
      child.stdin.end();
      const [status] = await closed;
      expect(status).toBe(0);
      expect(Buffer.concat(errors).length).toBe(0);
      expect(Buffer.concat(output)).toEqual(canonical('loop'));
    } finally { child.kill(); }
  });

  it.each(ROLES)('quotes the Windows %s bootstrap within the cmd.exe budget', (role) => {
    const command = commandFor(role, 'win32')!;
    // Reserve a full 260-character Windows executable path as well as shell overhead.
    expect(command.length + 260 + 100).toBeLessThan(8191);
    const parts = command.match(/^"[^"]+" -e "([^"]+)"$/);
    expect(parts).not.toBeNull();
    const encoded = parts![1].match(/^eval\(Buffer.from\('([A-Za-z0-9+/=]+)','base64'\).toString\(\)\)$/);
    expect(encoded).not.toBeNull();
    const result = spawnSync(process.execPath, ['-e', parts![1]], { cwd: tempRoot, input: INPUT, timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBe(0);
    expect(result.stdout).toEqual(canonical(role));
  });

  it('fails soft for unknown roles before any shell interpolation', () => {
    for (const role of ['nope', '__proto__', 'constructor', 'loop; echo injected', '']) {
      expect(commandFor(role)).toBeNull();
    }
  });

  it('uses external Node for SEA or an unavailable SEA API', () => {
    for (const bundle of ['sea-worker', 'old-runtime']) {
      expect(commandFor('loop', 'linux', bundle)).toMatch(/^'node' -e /);
      expect(commandFor('loop', 'win32', bundle)).toMatch(/^"node" -e /);
    }
  });

  it('quotes POSIX Node paths and avoids Windows executable expansion', () => {
    const setup = "Object.defineProperty(process, 'execPath', {value: `/owned/it's a node`});";
    expect(commandFor('loop', 'linux', 'worker', setup)).toMatch(/^'\/owned\/it'\\''s a node' -e /);
    const unsafeWindows = "Object.defineProperty(process, 'execPath', {value: 'C:\\\\%EXPAND%\\\\node.exe'});";
    expect(commandFor('loop', 'win32', 'worker', unsafeWindows)).toMatch(/^"node" -e /);
  });
});
