import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const script = join(__dirname, 'serving-window.js');
const { isTailscaleAddress, loadArgs, runCommandLine, serverArgs, snapshotHelpers, tolerantJson, validateConfig, withPathFirst } = require('./serving-window.js') as {
  isTailscaleAddress(host: string): boolean;
  loadArgs(helper: Helper): string[];
  runCommandLine(command: string, config: unknown, deps: unknown): Promise<{ code: number; text: string }>;
  serverArgs(config: unknown): string[];
  snapshotHelpers(json: string): Helper[];
  tolerantJson(text: string): unknown;
  validateConfig(raw: unknown): Record<string, unknown>;
  withPathFirst(env: Record<string, string>, dirs: (string | undefined)[]): Record<string, string>;
};

interface Helper { identifier: string; model: string; contextLength: number; parallel: number | null }
interface Receipt {
  ok: boolean; refused?: string; error?: string; nothingToStop?: boolean; keyRemoved?: boolean; staleOwnership?: boolean;
  windowOpen?: boolean; gpuUsedMiBAfterUnload?: number; listenersOnLmStudioPort?: unknown[];
  keyProbe: { missing: number; wrong: number; configured: number };
}
interface PsEntry { identifier: string; modelKey: string; path: string; contextLength: number; status: string; queued: number; parallel: number; ttlMs: null | number }

const KEY = 'a-test-key-not-a-real-secret';
const config = {
  windowDir: 'C:\\Users\\tester\\plan-ex-ab-window',
  backendDir: 'C:\\lm\\backends\\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.60.0',
  modelFile: 'C:\\models\\qwen.gguf',
  keyFile: 'C:\\keys\\server.key',
  host: '100.113.93.104',
};
const helperEntry = (over: Partial<PsEntry> = {}): PsEntry => ({
  identifier: 'qwen/helper', modelKey: 'qwen/helper', path: 'qwen/helper', contextLength: 229376, status: 'idle', queued: 0, parallel: 2, ttlMs: null, ...over,
});

/** A small pretend PC: LM Studio helpers, one GPU, one listener table and files. Nothing real is touched. */
class FakePc {
  files = new Map<string, string>([
    [config.modelFile, 'model'], [config.keyFile, KEY], [`${config.backendDir}\\llama-server.exe`, 'exe'],
  ]);
  helpers: PsEntry[] = [helperEntry()];
  server: { pid: number; created: string; exe: string; cmd: string } | null = null;
  other: { LocalAddress: string; LocalPort: number; OwningProcess: number }[] = [{ LocalAddress: '127.0.0.1', LocalPort: 1234, OwningProcess: 7 }];
  clock = 1_000;
  log: string[] = [];
  // knobs
  gpuStaysFull = false;
  desktopMiB = 400;
  bindAddress = config.host;
  extraListenerAddress: string | null = null;
  acceptAnyKey = false;
  spawnFails = false;
  exitsWhileLoading = false;
  loadingAnswers503 = 0;
  unloadFails = false;
  loadFails = false;
  killWorks = true;
  pidReusedBy: { exe: string; created: string; cmd: string } | null = null;
  helpersOnReload: Partial<PsEntry> = {};

  deps = {
    now: () => this.clock,
    sleep: async (ms: number) => { this.clock += ms; },
    exists: (file: string) => this.files.has(file),
    readFile: (file: string) => Buffer.from(this.files.get(file) ?? ''),
    readText: (file: string) => this.files.get(file) ?? '',
    writeFile: (file: string, text: string) => { this.files.set(file, text); },
    remove: (file: string) => { this.log.push(`remove ${file}`); this.files.delete(file); },
    mkdir: () => undefined,
    gpuUsedMiB: async () => (this.helpers.length > 0 || this.gpuStaysFull ? 29_727 : this.desktopMiB) + (this.server ? 9_000 : 0),
    listeners: async () => {
      const rows = [...this.other];
      if (this.server && this.loadingAnswers503 <= 0) {
        rows.push({ LocalAddress: this.bindAddress, LocalPort: 1235, OwningProcess: this.server.pid });
        if (this.extraListenerAddress) rows.push({ LocalAddress: this.extraListenerAddress, LocalPort: 1235, OwningProcess: this.server.pid });
      }
      return rows;
    },
    processInfo: async (pid: number) => {
      if (this.server && this.server.pid === pid) return { executablePath: this.server.exe, commandLine: this.server.cmd, created: this.server.created };
      if (this.pidReusedBy && pid === 4242) return { executablePath: this.pidReusedBy.exe, commandLine: this.pidReusedBy.cmd, created: this.pidReusedBy.created };
      return null;
    },
    spawnServer: async (exe: string, args: string[]) => {
      this.log.push('spawn');
      if (this.spawnFails) return { pid: 0, error: 'ENOENT' };
      this.server = { pid: 4242, created: '2026-11-27T10:00:00.0000000Z', exe, cmd: `${exe} ${args.join(' ')}` };
      this.pidReusedBy = null;
      if (this.exitsWhileLoading) this.loadingAnswers503 = 1;
      return { pid: 4242 };
    },
    killTree: async (pid: number) => {
      this.log.push(`kill ${pid}`);
      if (this.killWorks && this.server?.pid === pid) this.server = null;
    },
    request: async (_host: string, _port: number, key: string | null) => {
      if (!this.server) return { status: 0, body: '' };
      if (this.exitsWhileLoading) { this.server = null; return { status: 0, body: '' }; }
      if (this.loadingAnswers503 > 0) { this.loadingAnswers503 -= 1; return { status: 503, body: '' }; }
      if (this.acceptAnyKey || key === KEY) return { status: 200, body: JSON.stringify({ data: [{ id: 'C:\\models\\qwen.gguf' }] }) };
      return { status: 401, body: '' };
    },
    run: async (_file: string, args: string[]) => {
      const verb = args[0];
      this.log.push(`lms ${args.join(' ')}`);
      if (verb === 'ps') return { code: 0, stdout: `${JSON.stringify(this.helpers)}\n`, stderr: '' };
      if (verb === 'unload') {
        if (this.unloadFails) return { code: 1, stdout: '', stderr: 'no' };
        this.helpers = this.helpers.filter((h) => h.identifier !== args[1]);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (verb === 'load') {
        if (this.loadFails) return { code: 1, stdout: '', stderr: 'no' };
        const at = (flag: string) => args[args.indexOf(flag) + 1];
        this.helpers.push(helperEntry({ identifier: at('--identifier'), contextLength: Number(at('--context-length')), parallel: Number(at('--parallel')), ...this.helpersOnReload }));
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unknown' };
    },
  };

  async run(command: string, over: Record<string, unknown> = {}) {
    const result = await runCommandLine(command, validateConfig({ ...config, ...over }), this.deps);
    return { code: result.code, receipt: JSON.parse(result.text) as Receipt };
  }
}

describe('serving-window config', () => {
  it('accepts only Tailscale addresses', () => {
    for (const host of ['100.113.93.104', '100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::434:5d68']) expect(isTailscaleAddress(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '127.0.0.1', '::1', '192.168.0.2', '100.128.0.1', '100.63.0.1', 'fe80::1', 'localhost', '']) expect(isTailscaleAddress(host)).toBe(false);
  });

  it('refuses a LAN or wildcard bind, LM Studio port, other backends, odd folders and unknown settings', () => {
    expect(() => validateConfig({ ...config, host: '0.0.0.0' })).toThrow(/Tailscale/);
    expect(() => validateConfig({ ...config, host: '192.168.0.2' })).toThrow(/Tailscale/);
    expect(() => validateConfig({ ...config, port: 1234 })).toThrow(/LM Studio/);
    expect(() => validateConfig({ ...config, port: 80 })).toThrow(/port/);
    expect(() => validateConfig({ ...config, backendDir: 'C:\\lm\\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.73.0' })).toThrow(/-2\.60\.0/);
    expect(() => validateConfig({ ...config, backendVersion: '2.73.0' })).toThrow(/frozen/);
    expect(() => validateConfig({ ...config, windowDir: 'C:\\Users\\tester\\Documents' })).toThrow(/plan-ex-ab/);
    expect(() => validateConfig({ ...config, windowDir: 'plan-ex-ab-x' })).toThrow(/absolute/);
    expect(() => validateConfig({ ...config, modelFile: 'C:\\m\\a.bin' })).toThrow(/\.gguf/);
    expect(() => validateConfig({ ...config, apiKey: 'x' })).toThrow(/not a setting/);
    expect(() => validateConfig({ ...config, expectedKeySha256: 'ABC' })).toThrow(/64/);
    expect(() => validateConfig([])).toThrow(/object/);
  });

  it('builds the runbook flags with the key by file only, and Flash-Next adds --n-cpu-moe', () => {
    const args = serverArgs(validateConfig(config));
    expect(args).toEqual(expect.arrayContaining(['--ctx-size', '65536', '--parallel', '1', '--host', '100.113.93.104', '--port', '1235', '--api-key-file', config.keyFile, '--jinja']));
    expect(args).not.toContain('--api-key');
    expect(args).not.toContain('--n-cpu-moe');
    expect(serverArgs(validateConfig({ ...config, cpuMoe: true })).slice(-2)).toEqual(['--n-cpu-moe', '999']);
  });
});

describe('serving-window helper snapshot', () => {
  it('reads the real lms ps shape and builds the matching reload command', () => {
    const [helper] = snapshotHelpers(JSON.stringify([helperEntry()]));
    expect(helper).toEqual({ identifier: 'qwen/helper', model: 'qwen/helper', contextLength: 229376, parallel: 2 });
    expect(loadArgs(helper)).toEqual(['load', 'qwen/helper', '--identifier', 'qwen/helper', '--context-length', '229376', '--parallel', '2', '--gpu', 'max', '-y']);
  });

  it('refuses a busy helper, one with a time-to-live, and one it could not reload exactly', () => {
    expect(() => snapshotHelpers(JSON.stringify([helperEntry({ status: 'generating' })]))).toThrow(/not idle/);
    expect(() => snapshotHelpers(JSON.stringify([helperEntry({ queued: 2 })]))).toThrow(/not idle/);
    expect(() => snapshotHelpers(JSON.stringify([helperEntry({ ttlMs: 60000 })]))).toThrow(/time-to-live/);
    expect(() => snapshotHelpers(JSON.stringify([{ ...helperEntry(), contextLength: undefined }]))).toThrow(/reloaded exactly/);
    expect(() => snapshotHelpers('not json')).toThrow(/JSON/);
    expect(snapshotHelpers('[]')).toEqual([]);
  });

  it('puts the backend first on the existing Path variable without adding a second one', () => {
    expect(withPathFirst({ Path: 'C:\\Windows', Other: 'x' }, ['C:\\b', undefined, 'C:\\v'])).toEqual({ Path: 'C:\\b;C:\\v;C:\\Windows', Other: 'x' });
    expect(withPathFirst({}, ['C:\\b'])).toEqual({ Path: 'C:\\b' });
  });

  it('reads JSON through PowerShell progress noise', () => {
    expect(tolerantJson('#< CLIXML\r\n[{"a":1}]\r\n<Objs Version="1.1"><Obj/></Objs>')).toEqual([{ a: 1 }]);
    expect(tolerantJson('nothing')).toBeNull();
  });
});

describe('serving-window start and stop', () => {
  it('opens a window: unloads the helper, proves the listener and 401/401/200, then stop restores everything', async () => {
    const pc = new FakePc();
    const started = await pc.run('start', { expectedKeySha256: createHash('sha256').update(KEY).digest('hex') });
    expect(started.code).toBe(0);
    expect(started.receipt).toMatchObject({
      ok: true, windowOpen: true, helpersUnloaded: ['qwen/helper'], keyProbe: { missing: 401, wrong: 401, configured: 200 },
      listeners: [{ address: '100.113.93.104', port: 1235, pid: 4242 }], modelIds: ['C:\\models\\qwen.gguf'],
    });
    expect(started.receipt.gpuUsedMiBAfterUnload).toBe(400);
    expect(JSON.stringify(started.receipt)).not.toContain(KEY);
    expect(pc.helpers).toEqual([]);
    expect(pc.server).not.toBeNull();

    const status = await pc.run('status');
    expect(status.receipt).toMatchObject({ windowOpen: true, serverPid: 4242, serverStillOurs: true, helpersToRestore: ['qwen/helper'] });

    const stopped = await pc.run('stop');
    expect(stopped.code).toBe(0);
    expect(stopped.receipt).toMatchObject({ ok: true, serverStopped: true, helpersRestored: true, keyRemoved: false });
    expect(pc.server).toBeNull();
    expect(pc.helpers).toMatchObject([{ identifier: 'qwen/helper', contextLength: 229376, parallel: 2, status: 'idle', queued: 0 }]);
    expect(pc.files.has(config.keyFile)).toBe(true);
    expect((await pc.run('status')).receipt.windowOpen).toBe(false);
  });

  it('does nothing on a second stop', async () => {
    const pc = new FakePc();
    await pc.run('start');
    await pc.run('stop');
    const before = pc.log.length;
    const again = await pc.run('stop');
    expect(again.code).toBe(0);
    expect(again.receipt.nothingToStop).toBe(true);
    expect(pc.log.slice(before).filter((l) => l.startsWith('lms load') || l.startsWith('kill'))).toEqual([]);
  });

  it('refuses a second start while a record exists', async () => {
    const pc = new FakePc();
    await pc.run('start');
    const second = await pc.run('start');
    expect(second.code).toBe(2);
    expect(second.receipt.refused).toMatch(/run stop first/);
    expect(pc.server).not.toBeNull();
  });

  it('refuses before changing anything: busy helper, missing files, wrong key hash, occupied port', async () => {
    const busy = new FakePc();
    busy.helpers = [helperEntry({ status: 'generating' })];
    expect((await busy.run('start')).code).toBe(2);
    expect(busy.log.some((l) => l.startsWith('lms unload'))).toBe(false);
    expect(busy.files.has(`${config.windowDir}\\serving-window.json`)).toBe(false);

    const noKey = new FakePc();
    noKey.files.delete(config.keyFile);
    expect((await noKey.run('start')).receipt.refused).toMatch(/keyFile was not found/);

    const wrongHash = new FakePc();
    expect((await wrongHash.run('start', { expectedKeySha256: 'a'.repeat(64) })).receipt.refused).toMatch(/expectedKeySha256/);

    const taken = new FakePc();
    taken.other.push({ LocalAddress: '127.0.0.1', LocalPort: 1235, OwningProcess: 9 });
    expect((await taken.run('start')).receipt.refused).toMatch(/already listens/);
    for (const pc of [noKey, wrongHash, taken]) expect(pc.helpers).toHaveLength(1);
  });

  it('puts the helper back when the unload fails part-way', async () => {
    const pc = new FakePc();
    pc.unloadFails = true;
    const result = await pc.run('start');
    expect(result.code).toBe(1);
    expect(result.receipt.error).toMatch(/lms unload/);
    expect(pc.helpers).toHaveLength(1);
    expect(pc.log).not.toContain('spawn');
    expect(pc.files.has(`${config.windowDir}\\serving-window.json`)).toBe(false);
  });

  it('opens with the default limit when desktop apps hold about 3.3 GB of the GPU (real PC reading)', async () => {
    const pc = new FakePc();
    pc.desktopMiB = 3_279;
    const started = await pc.run('start');
    expect(started.code).toBe(0);
    expect(started.receipt.gpuUsedMiBAfterUnload).toBe(3_279);
  });

  it('rolls back when the GPU is not freed, without starting the server', async () => {
    const pc = new FakePc();
    pc.gpuStaysFull = true;
    const result = await pc.run('start');
    expect(result.code).toBe(1);
    expect(result.receipt.error).toMatch(/GPU memory in use/);
    expect(pc.log).not.toContain('spawn');
    expect(pc.helpers).toHaveLength(1);
  });

  it('rolls back when the server did not start or exits while loading', async () => {
    const noStart = new FakePc();
    noStart.spawnFails = true;
    expect((await noStart.run('start')).receipt.error).toMatch(/did not start/);
    expect(noStart.helpers).toHaveLength(1);

    const dies = new FakePc();
    dies.exitsWhileLoading = true;
    const result = await dies.run('start');
    expect(result.receipt.error).toMatch(/exited/);
    expect(dies.helpers).toHaveLength(1);
    expect(dies.files.has(`${config.windowDir}\\serving-window.json`)).toBe(false);
  });

  it('waits through a loading server (503) before probing', async () => {
    const pc = new FakePc();
    pc.loadingAnswers503 = 3;
    const result = await pc.run('start');
    expect(result.receipt.ok).toBe(true);
    expect(result.receipt.keyProbe.configured).toBe(200);
  });

  it('stops and restores when a listener is on the wrong address or an extra address', async () => {
    const lan = new FakePc();
    lan.bindAddress = '192.168.0.2';
    const lanResult = await lan.run('start');
    expect(lanResult.code).toBe(1);
    expect(lanResult.receipt.error).toMatch(/listener check failed.*192\.168\.0\.2/);
    expect(lan.server).toBeNull();
    expect(lan.helpers).toHaveLength(1);

    const wildcard = new FakePc();
    wildcard.extraListenerAddress = '0.0.0.0';
    expect((await wildcard.run('start')).receipt.error).toMatch(/0\.0\.0\.0/);
    expect(wildcard.server).toBeNull();
  });

  it('stops and restores when a wrong key would be accepted', async () => {
    const pc = new FakePc();
    pc.acceptAnyKey = true;
    const result = await pc.run('start');
    expect(result.code).toBe(1);
    expect(result.receipt.error).toMatch(/missing key got 200, wanted 401/);
    expect(pc.server).toBeNull();
    expect(pc.helpers).toHaveLength(1);
  });

  it('never kills a process it did not start: a reused id is left alone and the helpers still come back', async () => {
    const pc = new FakePc();
    await pc.run('start');
    pc.pidReusedBy = { exe: 'C:\\Windows\\notepad.exe', created: '2026-11-27T11:00:00.0000000Z', cmd: 'notepad.exe' };
    pc.server = null;
    const stopped = await pc.run('stop');
    expect(stopped.code).toBe(0);
    expect(stopped.receipt).toMatchObject({ staleOwnership: true, serverStopped: false, helpersRestored: true });
    expect(pc.log.filter((l) => l.startsWith('kill'))).toEqual([]);
    expect(pc.helpers).toHaveLength(1);
  });

  it('treats a same-executable process with a different start time as not ours', async () => {
    const pc = new FakePc();
    await pc.run('start');
    const { exe, cmd } = pc.server!;
    pc.server = null;
    pc.pidReusedBy = { exe, cmd, created: '2026-11-27T12:00:00.0000000Z' };
    const stopped = await pc.run('stop');
    expect(stopped.receipt.staleOwnership).toBe(true);
    expect(pc.log.filter((l) => l.startsWith('kill'))).toEqual([]);
  });

  it('recovers an interrupted start: record with helpers unloaded and no server is stopped by stop', async () => {
    const pc = new FakePc();
    pc.files.set(`${config.windowDir}\\serving-window.json`, JSON.stringify({ version: 1, openedAt: 1, server: null, helpers: [{ identifier: 'qwen/helper', model: 'qwen/helper', contextLength: 229376, parallel: 2 }] }));
    pc.helpers = [];
    const stopped = await pc.run('stop');
    expect(stopped.code).toBe(0);
    expect(pc.helpers).toHaveLength(1);
    expect(pc.files.has(`${config.windowDir}\\serving-window.json`)).toBe(false);
  });

  it('keeps the record and reports failure when a helper does not come back, so stop can be retried', async () => {
    const pc = new FakePc();
    await pc.run('start');
    pc.loadFails = true;
    const failed = await pc.run('stop');
    expect(failed.code).toBe(1);
    expect(failed.receipt.error).toMatch(/helpers not restored/);
    expect(pc.files.has(`${config.windowDir}\\serving-window.json`)).toBe(true);
    expect(pc.server).toBeNull();
    pc.loadFails = false;
    const retried = await pc.run('stop');
    expect(retried.code).toBe(0);
    expect(pc.helpers).toHaveLength(1);
  });

  it('fails stop when the reloaded helper comes back with different settings', async () => {
    const pc = new FakePc();
    await pc.run('start');
    pc.helpersOnReload = { contextLength: 4096 };
    const failed = await pc.run('stop');
    expect(failed.receipt.error).toMatch(/context 4096, wanted 229376/);
    expect(pc.files.has(`${config.windowDir}\\serving-window.json`)).toBe(true);
  });

  it('keeps the record when the server survives the kill', async () => {
    const pc = new FakePc();
    await pc.run('start');
    pc.killWorks = false;
    const failed = await pc.run('stop');
    expect(failed.code).toBe(1);
    expect(failed.receipt.error).toMatch(/still running/);
    expect(pc.files.has(`${config.windowDir}\\serving-window.json`)).toBe(true);
  });

  it('removes the key file on stop only when asked', async () => {
    const pc = new FakePc();
    await pc.run('start', { removeKeyOnStop: true });
    const stopped = await pc.run('stop', { removeKeyOnStop: true });
    expect(stopped.receipt.keyRemoved).toBe(true);
    expect(pc.files.has(config.keyFile)).toBe(false);
  });

  it('inventory changes nothing', async () => {
    const pc = new FakePc();
    const result = await pc.run('inventory');
    expect(result.receipt).toMatchObject({ ok: true, gpuUsedMiB: 29_727, helpers: [{ identifier: 'qwen/helper', status: 'idle', queued: 0 }], listenersOnServingPort: [] });
    expect(result.receipt.listenersOnLmStudioPort).toHaveLength(1);
    expect(pc.log.filter((l) => /unload|load|spawn|kill/.test(l) && !l.startsWith('lms ps'))).toEqual([]);
  });
});

describe('serving-window command line', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const cli = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('refuses a bad command, a missing config and an unsafe config with exit 2 and changes nothing', () => {
    expect(cli().status).toBe(2);
    expect(cli('launch', 'x.json').status).toBe(2);
    expect(cli('start', join(tmpdir(), 'no-such-serving-window-config.json')).stderr).toMatch(/could not be read/);
    const dir = mkdtempSync(join(tmpdir(), 'serving-window-'));
    dirs.push(dir);
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ ...config, host: '0.0.0.0' }));
    const refused = cli('start', file);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/Tailscale/);
  });
});
