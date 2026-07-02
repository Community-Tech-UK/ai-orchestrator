/**
 * provider-model-auto-update Phase 1.5 — install-method resolution.
 *
 * The npm-published CLI update plan must run the package manager the binary was
 * actually installed with (npm / bun / pnpm), resolving symlinks first, and
 * fall back to npm on any uncertainty so detection failure never makes things
 * worse.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CliUpdateService, type CliUpdateServiceDeps } from '../cli-update-service';
import type { CliInfo, DetectionResult } from '../cli-detection';

function makeInfo(path: string): CliInfo {
  return {
    name: 'codex',
    command: 'codex',
    displayName: 'Codex CLI',
    installed: true,
    version: '1.0.0',
    path,
  };
}

function makeService(opts: {
  activePath: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  existsPaths?: string[];
  realpathMap?: Record<string, string>;
  realpathThrows?: boolean;
}): CliUpdateService {
  const detection: NonNullable<CliUpdateServiceDeps['detection']> = {
    clearCache() {
      /* noop */
    },
    async detectAll(): Promise<DetectionResult> {
      return { detected: [makeInfo(opts.activePath)], available: [], unavailable: [], timestamp: new Date(0) };
    },
    async detectOne(): Promise<CliInfo> {
      return makeInfo(opts.activePath);
    },
    async scanAllCliInstalls(): Promise<{ path: string; version?: string }[]> {
      return []; // → activePath falls back to info.path
    },
  };
  const existsSet = new Set(opts.existsPaths ?? []);
  return new CliUpdateService({
    detection,
    env: opts.env ?? {},
    platform: opts.platform ?? 'linux',
    exists: (p) => existsSet.has(p),
    realpath: (p) => {
      if (opts.realpathThrows) throw new Error('ENOENT');
      return opts.realpathMap?.[p] ?? p;
    },
  });
}

describe('CliUpdateService — install-method resolution (provider-model Phase 1.5)', () => {
  afterEach(() => CliUpdateService._resetForTesting());

  it('uses `npm install -g` for a plain npm-global path', async () => {
    const svc = makeService({ activePath: '/usr/local/lib/node_modules/.bin/codex', env: { HOME: '/home/u' } });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.supported).toBe(true);
    expect(plan.args).toEqual(['install', '-g', '@openai/codex@latest']);
    expect(plan.command).toMatch(/(^|\/)npm$/);
  });

  it('uses `bun add -g` when the binary lives under the bun global root', async () => {
    const svc = makeService({ activePath: '/home/u/.bun/bin/codex', env: { HOME: '/home/u' } });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
    expect(plan.command).toBe('bun'); // no sibling bun present → bare command
  });

  it('prefers a sibling bun executable when present', async () => {
    const svc = makeService({
      activePath: '/home/u/.bun/bin/codex',
      env: { HOME: '/home/u' },
      existsPaths: ['/home/u/.bun/bin/bun'],
    });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.command).toBe('/home/u/.bun/bin/bun');
  });

  it('honours $BUN_INSTALL for the bun root', async () => {
    const svc = makeService({ activePath: '/opt/bun/bin/codex', env: { BUN_INSTALL: '/opt/bun' } });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
  });

  it('uses `pnpm add -g` for the Linux pnpm global root', async () => {
    const svc = makeService({ activePath: '/home/u/.local/share/pnpm/codex', env: { HOME: '/home/u' } });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
    expect(plan.command).toBe('pnpm');
  });

  it('honours $PNPM_HOME', async () => {
    const svc = makeService({ activePath: '/opt/pnpm-home/codex', env: { PNPM_HOME: '/opt/pnpm-home' } });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
  });

  it('on win32, probes pnpm.cmd before pnpm.exe for the sibling executable', async () => {
    // Windows-style paths: the service resolves install paths with win32
    // semantics when platform === 'win32' (independent of the test host), so the
    // sibling probe joins with backslashes — mirroring a real Windows install.
    const svc = makeService({
      activePath: 'C:\\fake\\pnpm\\codex',
      env: { PNPM_HOME: 'C:\\fake\\pnpm' },
      platform: 'win32',
      existsPaths: ['C:\\fake\\pnpm\\pnpm.cmd'], // .cmd present, .exe absent
    });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
    expect(plan.command).toBe('C:\\fake\\pnpm\\pnpm.cmd');
  });

  it('resolves symlinks before classifying (a /usr/local/bin shim into ~/.bun ⇒ bun)', async () => {
    const svc = makeService({
      activePath: '/usr/local/bin/codex',
      env: { HOME: '/home/u' },
      realpathMap: { '/usr/local/bin/codex': '/home/u/.bun/bin/codex' },
    });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['add', '-g', '@openai/codex@latest']);
  });

  it('falls back to npm when realpath throws (missing path)', async () => {
    const svc = makeService({ activePath: '/weird/path/codex', env: { HOME: '/home/u' }, realpathThrows: true });
    const plan = await svc.getUpdatePlan('codex');
    expect(plan.args).toEqual(['install', '-g', '@openai/codex@latest']);
  });
});
