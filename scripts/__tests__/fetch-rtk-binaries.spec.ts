import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { decideExit, selectTargets, deadlineMsFor, TARGETS, RTK_VERSION } from '../fetch-rtk-binaries';

const script = path.resolve(process.cwd(), 'scripts/fetch-rtk-binaries.js');

// Execute the actual provisioning composition with in-memory I/O. Never fetch,
// extract or install an executable, and never replace production algorithms.
const fixtureBinary = 'OBVIOUS FAKE RTK BINARY FOR PROVISIONING TESTS';
const fixtureHash = createHash('sha256').update(fixtureBinary).digest('hex');
const validManifest = () => ({ version: RTK_VERSION, hashes: {
  'darwin-arm64': fixtureHash, 'darwin-x64': fixtureHash,
} });

async function provision(options: {
  manifest?: unknown; rawManifest?: string; missing?: boolean; cached?: string;
  mode?: '--strict' | '--soft' | 'default'; networkFailures?: number; extracted?: string; copied?: string;
  licenseContent?: string | null;
  /** Never settle the transfer: 'request' gets no response at all, 'body' gets a response that never finishes. */
  stall?: 'request' | 'body';
  /** Overrides FETCH_RTK_DEADLINE_MS for this run (milliseconds). */
  deadlineMs?: number;
}) {
  const files = new Map<string, string>();
  const manifestPath = path.resolve(process.cwd(), 'scripts/rtk-binaries.sha256.json');
  if (!options.missing) files.set(manifestPath, options.rawManifest ?? JSON.stringify(options.manifest ?? validManifest()));
  const licensePath = path.join(path.dirname(script), 'licenses', `rtk-${RTK_VERSION}-LICENSE`);
  const licenseContent = options.licenseContent === undefined
    ? 'Apache License\nVersion 2.0\nSynthetic pinned licence for provisioning tests.'
    : options.licenseContent;
  if (licenseContent !== null) files.set(licensePath, licenseContent);
  for (const key of ['darwin-arm64', 'darwin-x64']) {
    if (options.cached !== undefined) files.set(path.resolve('resources/rtk', key, 'rtk'), options.cached);
  }
  const effects = {
    downloads: 0, copies: 0, extractions: 0, directories: 0, binaryReads: 0,
    requestDestroys: 0, responseDestroys: 0, streamDestroys: 0,
  };
  const messages: string[] = [];
  const fakeProcess: { argv: string[]; env: Record<string, string>; platform: string; exitCode: number } = {
    argv: [], env: {}, platform: 'darwin', exitCode: 0,
  };
  if (options.deadlineMs !== undefined) fakeProcess.env['FETCH_RTK_DEADLINE_MS'] = String(options.deadlineMs);
  let tempSequence = 0;
  const fakeFs = {
    existsSync: (file: string) => files.has(file),
    readFileSync(file: string, encoding?: string) {
      const value = files.get(file);
      if (value === undefined) throw new Error(`Missing synthetic file: ${file}`);
      if (file.endsWith('/rtk')) effects.binaryReads++;
      return encoding ? value : Buffer.from(value);
    },
    writeFileSync(file: string, value: string) { files.set(file, value); },
    mkdirSync() { effects.directories++; },
    mkdtempSync: () => `/synthetic-rtk-test/${++tempSequence}`,
    createWriteStream(file: string) {
      // The synthetic response body is empty, so a written archive hashes to the
      // empty-string digest; tests that pin archive hashes use that digest.
      let content = '';
      return Object.assign(new EventEmitter(), {
        write: (chunk: Buffer | string) => { content += String(chunk); },
        close: (callback: (err?: Error) => void) => { files.set(file, content); callback(); },
        destroy: () => { effects.streamDestroys++; },
      });
    },
    copyFileSync(from: string, to: string) { effects.copies++; files.set(to, options.copied ?? files.get(from)!); },
    chmodSync() { /* In-memory executable, never applied to disk. */ },
    unlinkSync(file: string) { files.delete(file); },
    rmSync(dir: string) { for (const key of files.keys()) if (key.startsWith(`${dir}/`)) files.delete(key); },
    readdirSync: () => [],
  };
  const fakeHttps = { get(_url: string, callback: (response: unknown) => void) {
    effects.downloads++;
    const request = Object.assign(new EventEmitter(), { destroy: () => { effects.requestDestroys++; } });
    queueMicrotask(() => {
      if (options.stall === 'request') return;
      if (effects.downloads <= (options.networkFailures ?? 0)) request.emit('error', new Error('Synthetic offline response'));
      else if (options.stall === 'body') {
        callback({
          statusCode: 200,
          pipe: () => undefined,
          destroy: () => { effects.responseDestroys++; },
        });
      } else callback({ statusCode: 200, pipe: (out: EventEmitter) => queueMicrotask(() => out.emit('finish')) });
    });
    return request;
  } };
  const realRequire = createRequire(script);
  const fakeRequire = Object.assign((id: string) => {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:https') return fakeHttps;
    if (id === 'node:child_process') return { spawnSync: (_command: string, args: string[]) => {
      effects.extractions++;
      files.set(path.join(args[args.indexOf('-C') + 1], 'rtk'), options.extracted ?? fixtureBinary);
      return { status: 0 };
    } };
    return realRequire(id);
  }, { main: {} });
  const context = vm.createContext({ require: fakeRequire, module: { exports: {} }, __dirname: path.dirname(script),
    process: fakeProcess, Buffer, setTimeout, clearTimeout,
    console: Object.fromEntries(['log', 'warn', 'error'].map(key =>
      [key, (...parts: unknown[]) => messages.push(parts.join(' '))])),
  });
  new vm.Script(`${readFileSync(script, 'utf8')}\nglobalThis.provisionMain = main;`).runInContext(context);
  const argv = options.mode === 'default' ? ['--platform=host'] : ['--platform=host', options.mode ?? '--strict'];
  await context['provisionMain'](argv, 'darwin');
  return { ...effects, exit: fakeProcess.exitCode, messages: messages.join('\n'), files };
}

describe('production provisioning verification', () => {
  it.each([
    { name: 'missing manifest', missing: true },
    { name: 'unparseable manifest', rawManifest: '{' },
    { name: 'null manifest', rawManifest: 'null' },
    { name: 'stale version', manifest: { ...validManifest(), version: 'OBVIOUS_STALE_VERSION' } },
    { name: 'missing hash map', manifest: { version: RTK_VERSION } },
    { name: 'array hash map', manifest: { version: RTK_VERSION, hashes: [] } },
    { name: 'missing second pin', manifest: { version: RTK_VERSION, hashes: { 'darwin-arm64': fixtureHash } } },
    { name: 'empty pin', manifest: { version: RTK_VERSION, hashes: { ...validManifest().hashes, 'darwin-x64': '' } } },
    { name: 'non-SHA256 pin', manifest: { version: RTK_VERSION, hashes: { ...validManifest().hashes, 'darwin-x64': 'OBVIOUS_INVALID_PIN' } } },
    { name: 'non-string pin', manifest: { version: RTK_VERSION, hashes: { ...validManifest().hashes, 'darwin-x64': 123 } } },
  ])('fails closed before any provisioning with $name, even with cached binaries', async options => {
    const result = await provision({ ...options, cached: fixtureBinary });
    expect(result.exit).toBe(1);
    expect(result.downloads).toBe(0);
    expect(result.copies).toBe(0);
    expect(result.extractions).toBe(0);
    expect(result.directories).toBe(0);
    expect(result.binaryReads).toBe(0);
    expect(result.messages).toMatch(/manifest|pin/i);
  });

  it('soft mode warns and continues without provisioning when a selected pin is absent', async () => {
    const result = await provision({ mode: '--soft', missing: true });
    expect(result.exit).toBe(0);
    expect(result.messages).toMatch(/manifest|pin/i);
    expect(result.downloads).toBe(0);
    expect(result.copies).toBe(0);
  });

  it('checks cached binaries against valid selected pins without requiring unselected pins', async () => {
    const result = await provision({ cached: fixtureBinary });
    expect(result.exit).toBe(0);
    expect(result.binaryReads).toBe(2);
    expect(result.downloads).toBe(0);
    expect(result.copies).toBe(0);
  });

  it('provisions verified binaries and replaces a cache that disagrees with its pin', async () => {
    const result = await provision({ cached: 'OBVIOUS STALE FAKE BINARY' });
    expect(result.exit).toBe(0);
    expect(result.downloads).toBe(2);
    expect(result.copies).toBe(2);
    expect(result.files.get(path.resolve('resources/rtk/darwin-arm64/rtk'))).toBe(fixtureBinary);
    expect(result.files.get(path.resolve('resources/rtk/darwin-x64/rtk'))).toBe(fixtureBinary);
  });

  it('rejects downloaded content that disagrees with the pin before copying it into place', async () => {
    const result = await provision({ extracted: 'OBVIOUS TAMPERED FAKE BINARY' });
    expect(result.exit).toBe(1);
    expect(result.messages).toContain('sha256 mismatch');
    expect(result.downloads).toBe(2);
    expect(result.copies).toBe(0);
    expect(result.files.has(path.resolve('resources/rtk/darwin-arm64/rtk'))).toBe(false);
  });

  it('strict mode retries each download once and succeeds after a transient failure', async () => {
    const result = await provision({ networkFailures: 1 });
    expect(result.exit).toBe(0);
    expect(result.downloads).toBe(3);
    expect(result.copies).toBe(2);
  });

  it('verifies the installed bytes too and quarantines a copy that disagrees with its pin', async () => {
    const result = await provision({ copied: 'OBVIOUS CORRUPTED FAKE COPY' });
    expect(result.exit).toBe(1);
    expect(result.messages).toContain('sha256 mismatch');
    expect(result.copies).toBe(2);
    expect(result.files.has(path.resolve('resources/rtk/darwin-arm64/rtk'))).toBe(false);
    expect(result.files.has(path.resolve('resources/rtk/darwin-x64/rtk'))).toBe(false);
  });

  it('restores the pinned Apache licence beside the binary even on the cached fast path', async () => {
    const result = await provision({ cached: fixtureBinary });
    expect(result.exit).toBe(0);
    for (const key of ['darwin-arm64', 'darwin-x64']) {
      const licence = result.files.get(path.resolve('resources/rtk', key, 'LICENSE'));
      expect(licence).toContain('Apache License');
      expect(licence).toContain('Version 2.0');
    }
  });

  it('fails closed when the pinned licence file is missing or invalid', async () => {
    const missing = await provision({ licenseContent: null, cached: fixtureBinary });
    expect(missing.exit).toBe(1);
    expect(missing.downloads).toBe(0);
    expect(missing.files.has(path.resolve('resources/rtk/darwin-arm64/LICENSE'))).toBe(false);
    const invalid = await provision({ licenseContent: 'OBVIOUSLY NOT AN APACHE LICENCE', cached: fixtureBinary });
    expect(invalid.exit).toBe(1);
    expect(invalid.downloads).toBe(0);
    expect(invalid.messages).toContain('licence');
  });

  it('rejects a downloaded archive whose sha256 disagrees with the pinned archive hash', async () => {
    const result = await provision({ manifest: { ...validManifest(), archiveHashes: {
      'darwin-arm64': 'OBVIOUS_TAMPERED_ARCHIVE_PIN', 'darwin-x64': 'OBVIOUS_TAMPERED_ARCHIVE_PIN',
    } } });
    expect(result.exit).toBe(1);
    expect(result.downloads).toBe(2);
    expect(result.copies).toBe(0);
    expect(result.messages).toContain('archive sha256 does not match');
  });

  it('accepts a downloaded archive that matches its pinned archive hash', async () => {
    // The synthetic response body is empty, so its archive digest is the empty-string digest.
    const emptyArchiveHash = createHash('sha256').update('').digest('hex');
    const result = await provision({ manifest: { ...validManifest(), archiveHashes: {
      'darwin-arm64': emptyArchiveHash, 'darwin-x64': emptyArchiveHash,
    } } });
    expect(result.exit).toBe(0);
    expect(result.downloads).toBe(2);
    expect(result.copies).toBe(2);
  });

  it.each([['--strict', 2, 1, 3], ['--soft', 1, 0, 2], ['default', 1, 0, 2]] as const)(
    '%s preserves partial-failure policy through production main', async (mode, networkFailures, exit, downloads) => {
      const result = await provision({ mode, networkFailures });
      expect(result.exit).toBe(exit);
      expect(result.downloads).toBe(downloads);
      expect(result.copies).toBe(1);
    });

  it.each([['--strict', 1, 4], ['--soft', 0, 2], ['default', 1, 2]] as const)(
    '%s preserves its exit policy and bounded retries on sustained failure', async (mode, exit, downloads) => {
      const result = await provision({ mode, networkFailures: Infinity });
      expect(result.exit).toBe(exit);
      expect(result.downloads).toBe(downloads);
      expect(result.copies).toBe(0);
    });
});

describe('bounded transfer deadlines', () => {
  // A stalled transfer must never hang the run: the attempt is torn down at the
  // deadline (request/response/stream destroyed, partial file removed), --soft
  // warns and continues (dev/startup), and --strict retries once and then fails.
  const stallCases: { stall: 'request' | 'body'; mode: '--strict' | '--soft' | 'default'; exit: number; downloads: number }[] = [
    { stall: 'request', mode: '--soft', exit: 0, downloads: 2 },
    { stall: 'request', mode: '--strict', exit: 1, downloads: 4 },
    { stall: 'request', mode: 'default', exit: 1, downloads: 2 },
    { stall: 'body', mode: '--soft', exit: 0, downloads: 2 },
    { stall: 'body', mode: '--strict', exit: 1, downloads: 4 },
    { stall: 'body', mode: 'default', exit: 1, downloads: 2 },
  ];
  it.each(stallCases)('$mode terminates a stalled $stall within its deadline', async ({ stall, mode, exit, downloads }) => {
    const result = await provision({ stall, mode, deadlineMs: 25 });
    expect(result.exit).toBe(exit);
    expect(result.downloads).toBe(downloads);
    expect(result.messages).toMatch(/timed out/i);
    expect(result.requestDestroys).toBeGreaterThan(0);
    if (stall === 'body') expect(result.streamDestroys).toBeGreaterThan(0);
    expect(result.copies).toBe(0);
  });

  it('--soft warns and still exits 0 when every transfer stalls (startup continues)', async () => {
    const result = await provision({ stall: 'request', mode: '--soft', deadlineMs: 25 });
    expect(result.exit).toBe(0);
    expect(result.messages).toMatch(/timed out/i);
  });

  it('--strict reaches its bounded retry and then fails when the retry stalls too', async () => {
    const result = await provision({ stall: 'body', mode: '--strict', deadlineMs: 25 });
    expect(result.exit).toBe(1);
    expect(result.downloads).toBe(4);
    expect(result.messages).toMatch(/retrying once/i);
    expect(result.messages).toMatch(/timed out/i);
  });
});

describe('deadlineMsFor', () => {
  it('bounds the startup path harder than build modes', () => {
    expect(deadlineMsFor('soft', {})).toBe(30_000);
    expect(deadlineMsFor('strict', {})).toBe(120_000);
    expect(deadlineMsFor('default', {})).toBe(120_000);
  });

  it('honours a positive FETCH_RTK_DEADLINE_MS override and ignores junk', () => {
    expect(deadlineMsFor('soft', { FETCH_RTK_DEADLINE_MS: '25' })).toBe(25);
    expect(deadlineMsFor('strict', { FETCH_RTK_DEADLINE_MS: '2500' })).toBe(2500);
    expect(deadlineMsFor('soft', { FETCH_RTK_DEADLINE_MS: 'not-a-number' })).toBe(30_000);
    expect(deadlineMsFor('soft', { FETCH_RTK_DEADLINE_MS: '-5' })).toBe(30_000);
    expect(deadlineMsFor('strict', { FETCH_RTK_DEADLINE_MS: '0' })).toBe(120_000);
  });
});

describe('selectTargets', () => {
  it('filters by explicit platform regardless of the host', () => {
    const selected = selectTargets(['--platform=darwin'], 'linux');
    expect(selected.map((target) => target.key).sort()).toEqual(['darwin-arm64', 'darwin-x64']);
  });

  it('host follows the platform', () => {
    expect(selectTargets(['--platform=host'], 'win32').map((target) => target.key)).toEqual(['win32-x64']);
    expect(selectTargets(['--platform=host'], 'linux').map((target) => target.key).sort()).toEqual(['linux-arm64', 'linux-x64']);
  });

  it('defaults to every target and rejects unknown platforms', () => {
    expect(selectTargets([], 'darwin')).toHaveLength(TARGETS.length);
    expect(() => selectTargets(['--platform=bogus'], 'linux')).toThrow(/Unknown --platform/);
  });
});

describe('decideExit', () => {
  const failed = { key: 'x', error: 'nope' };
  const ok = { key: 'y', hash: 'abc', fromCache: true };

  it('is fatal in strict mode when any selected target failed', () => {
    expect(decideExit([ok, failed], 'strict')).toBe(1);
    expect(decideExit([ok, ok], 'strict')).toBe(0);
    expect(decideExit([], 'strict')).toBe(0);
  });

  it('keeps the default rule: only an all-failed run is fatal', () => {
    expect(decideExit([ok, failed], 'default')).toBe(0);
    expect(decideExit([failed, failed], 'default')).toBe(1);
    expect(decideExit([], 'default')).toBe(0);
  });

  it('soft mode is never fatal', () => {
    expect(decideExit([failed], 'soft')).toBe(0);
    expect(decideExit([failed, failed], 'soft')).toBe(0);
    expect(decideExit([ok], 'soft')).toBe(0);
  });
});

describe('command-line behaviour', () => {
  it('rejects --strict with --soft as a usage error', () => {
    const result = spawnSync(process.execPath, [script, '--strict', '--soft'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage');
  });

  it('soft mode returns 0 for a thrown error and default mode returns 1', () => {
    const soft = spawnSync(process.execPath, [script, '--soft', '--platform=bogus'], { encoding: 'utf8' });
    expect(soft.status).toBe(0);
    expect(soft.stderr + soft.stdout).toContain('Unknown --platform');
    const strict = spawnSync(process.execPath, [script, '--platform=bogus'], { encoding: 'utf8' });
    expect(strict.status).toBe(1);
  });
});

describe('build wiring', () => {
  it('ci.yml fetches the bundled RTK before the electron-builder packaging smoke', () => {
    const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const fetch = workflow.indexOf('node scripts/fetch-rtk-binaries.js --platform=host --strict');
    const packaging = workflow.indexOf('electron-builder --mac --dir');
    expect(fetch).toBeGreaterThan(-1);
    expect(packaging).toBeGreaterThan(-1);
    expect(fetch).toBeLessThan(packaging);
  });

  it('ci.yml fetches every RTK platform before the unit suite (pin/licence byte checks)', () => {
    const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const fetch = workflow.indexOf('node scripts/fetch-rtk-binaries.js');
    const tests = workflow.indexOf('npm run test -- --shard=');
    expect(fetch).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(-1);
    expect(fetch).toBeLessThan(tests);
    const line = workflow.slice(workflow.lastIndexOf('\n', fetch) + 1, workflow.indexOf('\n', fetch));
    // No --platform filter: the pin-and-licence suite needs all five targets,
    // not just the host one the packaging smoke provisions.
    expect(line.trim()).toBe('run: node scripts/fetch-rtk-binaries.js');
  });

  it('ci.yml caches the RTK binaries keyed on the manifest pins before fetching', () => {
    const workflow = readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const cachePath = workflow.indexOf('path: resources/rtk');
    const cacheKey = workflow.indexOf("key: rtk-${{ hashFiles('scripts/rtk-binaries.sha256.json') }}");
    const fetch = workflow.indexOf('node scripts/fetch-rtk-binaries.js');
    expect(cachePath).toBeGreaterThan(-1);
    expect(cacheKey).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(-1);
    // Restore before fetch: the fetch only fills missing platforms.
    expect(cachePath).toBeLessThan(fetch);
  });

  it('no package.json script contains ||', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `script ${name}`).not.toContain('||');
    }
  });

  it('electron:build fetches in strict mode and dev/start warn softly', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['electron:build']).toContain('fetch-rtk-binaries.js --platform=host --strict');
    expect(pkg.scripts['dev']).toContain('fetch-rtk-binaries.js --platform=host --soft &&');
    expect(pkg.scripts['start']).toContain('fetch-rtk-binaries.js --platform=host --soft &&');
  });
});
