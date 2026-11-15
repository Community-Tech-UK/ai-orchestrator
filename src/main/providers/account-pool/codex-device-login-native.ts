import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { codexDeviceLoginSpawnOptions } from './codex-device-login-runtime';
import { parseCodexAccountRead } from '../../cli/adapters/codex/account-rate-limits';

/** Filesystem discovery only; never execute npm, which, a shell, or a JS launcher. */
export function discoverCodexDeviceLoginExecutable(candidates = defaultCandidates()): string {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    let resolved: string;
    try { resolved = realpathSync(candidate); } catch { continue; }
    for (const binary of [resolved, ...vendorCandidates(resolved)]) {
      if (isNativeBinary(binary)) return realpathSync(binary);
    }
  }
  throw new Error('native_executable_unavailable');
}

function defaultCandidates(): string[] {
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(isAbsolute);
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'));
  return dirs.flatMap(dir => process.platform === 'win32'
    ? [join(dir, 'codex.exe'), join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')]
    : [join(dir, 'codex')]);
}

function vendorCandidates(launcher: string): string[] {
  if (basename(launcher) !== 'codex.js' || basename(dirname(launcher)) !== 'bin') return [];
  if (!['x64', 'arm64'].includes(process.arch) || !['darwin', 'linux', 'win32'].includes(process.platform)) return [];
  const root = dirname(dirname(launcher));
  if (basename(root) !== 'codex') return [];
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-musl'}`;
  const packageName = `@openai/codex-${process.platform}-${process.arch}`;
  // Resolve package metadata without importing or executing its code (also handles pnpm layout).
  const roots = [root, join(dirname(root), `codex-${process.platform}-${process.arch}`)];
  try { roots.unshift(dirname(createRequire(launcher).resolve(`${packageName}/package.json`))); } catch { /* bundled vendor layout */ }
  return roots.flatMap(base => ['bin', 'codex'].map(folder => join(base, 'vendor', triple, folder, process.platform === 'win32' ? 'codex.exe' : 'codex')));
}

function isNativeBinary(candidate: string): boolean {
  let fd: number | undefined;
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    fd = openSync(candidate, 'r');
    const header = Buffer.alloc(4);
    if (readSync(fd, header, 0, 4, 0) !== 4) return false;
    const magic = header.toString('hex');
    return process.platform === 'win32' ? magic.startsWith('4d5a')
      : process.platform === 'darwin' ? ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)
      : magic === '7f454c46';
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Identity-only app-server exchange with bounded private pipes and immediate owned-child abort. */
export function probeCodexDeviceLoginIdentity(executable: string, home: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('identity_probe_failed')); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, ['-c', 'cli_auth_credentials_store=file', 'app-server'], {
        ...codexDeviceLoginSpawnOptions(home), stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(new Error('identity_probe_failed')); return; }
    let settled = false;
    let buffer = '';
    let bytes = 0;
    let initialized = false;
    const finish = (ok: boolean, identity: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      buffer = '';
      try { if (!child.kill('SIGKILL')) ok = false; } catch { ok = false; }
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
      if (ok) resolve(identity); else reject(new Error('identity_probe_failed'));
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, 10_000); timer.unref();
    signal.addEventListener('abort', abort, { once: true });
    const send = (message: object) => {
      if (settled) return;
      try { child.stdin!.write(JSON.stringify(message) + '\n'); } catch { finish(false); }
    };
    child.on('error', abort); child.on('close', abort);
    child.stdin?.on('error', abort); child.stdout?.on('error', abort); child.stderr?.on('error', abort);
    child.stderr?.on('data', (chunk: Buffer) => { bytes += Buffer.byteLength(chunk); if (bytes > 65_536) finish(false); });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65_536) { finish(false); return; }
      buffer += chunk.toString();
      let newline: number;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { finish(false); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message) || message['error']) { finish(false); return; }
        if (message['id'] === 1 && !initialized && message['result'] !== undefined) {
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: false } });
        } else if (message['id'] === 2 && initialized && message['result'] !== undefined) {
          const email = parseCodexAccountRead(message['result']).email;
          // The shared parser trims display strings; authority requires the native spelling exactly.
          const raw = (message['result'] as { account?: { email?: unknown } } | null)?.account?.email;
          finish(typeof raw === 'string' && raw === email, email);
        } else { finish(false); }
      }
    });
    if (!child.stdin || !child.stdout || !child.stderr || signal.aborted) { finish(false); return; }
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harness-device-login', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}
