import { spawn, type ChildProcess } from 'node:child_process';
import { win32 } from 'node:path';
import { WORKER_KEEP_AWAKE_TTL_MS } from '../main/remote-node/keep-awake-rpc';
import { WINDOWS_KEEP_AWAKE_SCRIPT } from './windows-keep-awake-script';

interface Assertion {
  child: ChildProcess;
  ready: Promise<void>;
  settle: (error?: Error) => void;
}

/** Worker-side, connection-owned Windows sleep assertion with a bounded lease. */
export class WorkerKeepAwake {
  private assertion: Assertion | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: {
    platform?: NodeJS.Platform;
    spawn?: (command: string, args: string[], options: { windowsHide: boolean; stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;
  } = {}) {}

  async setEnabled(enabled: boolean): Promise<{ active: boolean }> {
    if (!enabled) { this.shutdown(); return { active: false }; }
    if ((this.dependencies.platform ?? process.platform) !== 'win32') {
      throw new Error('Worker keep-awake requires Windows.');
    }
    const assertion = this.assertion ?? this.startAssertion();
    this.renewExpiry();
    await assertion.ready;
    if (this.assertion !== assertion) return { active: false };
    assertion.child.stdin!.write('.', error => {
      if (error && this.assertion === assertion) this.shutdown();
    });
    return { active: true };
  }

  shutdown(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    const assertion = this.assertion;
    this.assertion = null;
    if (!assertion) return;
    assertion.settle();
    assertion.child.stdin?.end();
    assertion.child.kill();
  }

  private renewExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = setTimeout(() => this.shutdown(), WORKER_KEEP_AWAKE_TTL_MS);
    this.expiry.unref?.();
  }

  private startAssertion(): Assertion {
    const command = win32.join(process.env['SystemRoot'] ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = (this.dependencies.spawn ?? spawn)(command,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from(WINDOWS_KEEP_AWAKE_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let settle!: Assertion['settle'];
    const ready = new Promise<void>((resolve, reject) => {
      settle = error => error ? reject(error) : resolve();
    });
    const assertion = { child, ready, settle };
    this.assertion = assertion;
    const fail = (error: Error) => {
      if (this.assertion !== assertion) return;
      settle(error);
      console.warn('[WorkerKeepAwake] Windows sleep prevention failed', error.message);
      this.shutdown();
    };
    const startupTimer = setTimeout(() => fail(new Error('Windows keep-awake helper did not start.')), 10_000);
    startupTimer.unref?.();
    void ready.then(() => clearTimeout(startupTimer), () => clearTimeout(startupTimer));
    let output = '';
    child.stdout!.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-128);
      if (output.includes('READY\n') || output.includes('READY\r\n')) settle();
    });
    child.stderr!.resume();
    child.on('error', fail);
    child.stdin!.on('error', fail);
    child.once('exit', () => fail(new Error('Windows keep-awake helper exited.')));
    return assertion;
  }
}
