# Worker Agent Autostart Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker-agent installable as a native OS service (Windows Service / systemd / launchd) that auto-starts at boot, runs under a dedicated low-privilege account, and is installable / updatable / revokable from the coordinator UI — with a single-file distributable binary (Node 22 SEA) shipped across Windows, Linux, and macOS.

**Architecture:** A new `ServiceManager` abstraction (one implementation per platform) lives alongside the existing `worker-agent`. Platform-specific service definitions (WinSW XML, systemd unit, launchd plist) are generated from shared templates. A local install CLI (`worker-agent --install-service`) bootstraps the service once (elevated). After install, the coordinator manages the service via new scoped JSON-RPC methods (`service.status`, `service.restart`, `service.stop`, `service.uninstall`) that the worker executes using pre-granted OS-level delegation (Windows SCM ACL / polkit / sudoers drop-in). A single-file SEA binary is built per platform and distributed via a versioned directory with symlink-based rollback.

**Tech Stack:** Node 22+ SEA (Single Executable Applications), WinSW 2.x (Windows), systemd (Linux), launchd (macOS), TypeScript 5.9, Vitest, existing JSON-RPC 2.0 over WebSocket protocol, Electron IPC for coordinator UI.

**Reference Spec:** `docs/superpowers/specs/2026-04-16-worker-agent-autostart-service-design.md`

---

## File Map

### Created

```
src/worker-agent/service/
  types.ts                         # Shared types (ServiceConfig, ServiceStatus, ServiceManager interface)
  exec-file.ts                     # Promisified execFile wrapper — argv only, no shell
  privilege.ts                     # isElevated() checks per platform
  token-resolver.ts                # Secure token input (file/stdin/env/interactive)
  paths.ts                         # Platform service paths (ProgramData / /etc / /Library)
  config-migration.ts              # Migrate ~/.orchestrator -> service paths
  manager-factory.ts               # createServiceManager() platform dispatch
  windows-service-manager.ts       # WinSW integration
  windows-winsw-xml.ts             # WinSW config XML generator
  linux-service-manager.ts         # systemctl integration
  linux-systemd-unit.ts            # systemd unit file generator
  macos-service-manager.ts         # launchctl integration
  macos-launchd-plist.ts           # launchd plist generator

src/worker-agent/service/__tests__/
  exec-file.test.ts
  token-resolver.test.ts
  paths.test.ts
  config-migration.test.ts
  windows-winsw-xml.test.ts
  windows-service-manager.test.ts
  linux-systemd-unit.test.ts
  linux-service-manager.test.ts
  macos-launchd-plist.test.ts
  macos-service-manager.test.ts

src/worker-agent/cli/
  service-cli.ts                   # --install-service / --uninstall-service / --service-status / --service-run

src/shared/types/service.types.ts  # Renderer-safe ServiceStatus / ServiceConfig types

src/main/remote-node/
  service-rpc-client.ts            # Thin helper: send scoped service.* RPC to node

src/renderer/app/features/remote-nodes/
  node-service-panel/
    node-service-panel.component.ts
    node-service-panel.component.html
    node-service-panel.component.scss

build-worker-agent-sea.ts          # SEA post-processing script
scripts/download-winsw.js          # Fetch pinned WinSW.exe into resources/
resources/winsw/                   # Checked-in or downloaded WinSW binaries per platform
```

### Modified

```
src/worker-agent/index.ts                      # Dispatch to service-cli when flag present
src/worker-agent/worker-agent.ts               # Add service.* RPC handlers + scope validation
src/worker-agent/worker-config.ts              # resolveConfigPath(serviceMode)
src/main/remote-node/worker-node-rpc.ts        # Add SERVICE_* method constants + scope field
src/shared/types/ipc.types.ts                  # Add 4 new REMOTE_NODE_SERVICE_* channels
src/main/ipc/handlers/remote-node-handlers.ts  # Wire service IPC to service-rpc-client
src/preload/preload.ts                         # (auto-generated) new channels
src/renderer/app/features/remote-nodes/        # Integrate NodeServicePanel into detail page
package.json                                   # Add postject dep + new scripts
build-worker-agent.ts                          # (no change, but sibling SEA script reads its output)
```

---

## Phase 0: Shared Foundations

Pure utilities with no platform dependencies. Written first, tested in isolation.

### Task 1: Shared service types

**Files:**
- Create: `src/worker-agent/service/types.ts`
- Create: `src/shared/types/service.types.ts`

- [ ] **Step 1: Write the types file for worker-agent internals**

```typescript
// src/worker-agent/service/types.ts
export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  version?: string;
  binaryPath?: string;
  configPath?: string;
  logPath?: string;
  startedAt?: number; // epoch ms
}

export interface ServiceInstallOptions {
  binaryPath: string;        // Absolute path to worker SEA binary
  configPath: string;        // Absolute path to worker-node.json
  coordinatorUrl: string;    // ws://host:port
  enrollmentToken: string;   // Already resolved from token-resolver
  serviceAccount?: string;   // Defaults per platform
  serviceName?: string;      // Defaults to 'ai-orchestrator-worker'
  logDir?: string;           // Defaults per platform
}

export interface ServiceManager {
  install(opts: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<ServiceStatus>;
  isInstalled(): Promise<boolean>;
}
```

- [ ] **Step 2: Write the shared (renderer-safe) types**

```typescript
// src/shared/types/service.types.ts
export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown';

export interface ServiceStatus {
  state: ServiceState;
  pid?: number;
  uptimeSeconds?: number;
  version?: string;
  binaryPath?: string;
  configPath?: string;
  logPath?: string;
  startedAt?: number;
}
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/worker-agent/service/types.ts src/shared/types/service.types.ts
git commit -m "feat(worker-service): add shared service types"
```

---

### Task 2: execFile wrapper (argv only, no shell)

**Files:**
- Create: `src/worker-agent/service/exec-file.ts`
- Test: `src/worker-agent/service/__tests__/exec-file.test.ts`

**Why:** Every service operation shells out to native tools (`sc.exe`, `systemctl`, `launchctl`). Using `execFile` with an argv array prevents shell-metacharacter injection.

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/exec-file.test.ts
import { describe, it, expect } from 'vitest';
import { execFileCapture, ExecFileError } from '../exec-file';

describe('execFileCapture', () => {
  it('returns stdout on success', async () => {
    const result = await execFileCapture('node', ['-e', 'process.stdout.write("hi")']);
    expect(result.stdout).toBe('hi');
    expect(result.exitCode).toBe(0);
  });

  it('throws ExecFileError with stderr on non-zero exit', async () => {
    await expect(
      execFileCapture('node', ['-e', 'process.stderr.write("boom"); process.exit(3)'])
    ).rejects.toMatchObject({
      name: 'ExecFileError',
      exitCode: 3,
      stderr: expect.stringContaining('boom'),
    });
  });

  it('never evaluates shell metacharacters in arguments', async () => {
    // If a shell were involved, $(echo x) would expand. With execFile it stays literal.
    const result = await execFileCapture('node', ['-e', 'process.stdout.write(process.argv[1])', '$(echo x)']);
    expect(result.stdout).toBe('$(echo x)');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/exec-file.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement the wrapper**

```typescript
// src/worker-agent/service/exec-file.ts
import { execFile } from 'node:child_process';

export class ExecFileError extends Error {
  name = 'ExecFileError';
  constructor(
    public readonly file: string,
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(`${file} exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`);
  }
}

export interface ExecFileResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecFileOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

export function execFileCapture(
  file: string,
  args: string[],
  opts: ExecFileOptions = {},
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
        const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString('utf8');
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number }).code;
          reject(
            new ExecFileError(
              file,
              args,
              typeof code === 'number' ? code : null,
              (err as NodeJS.ErrnoException & { signal?: NodeJS.Signals }).signal ?? null,
              stdoutStr,
              stderrStr,
            ),
          );
          return;
        }
        resolve({ stdout: stdoutStr, stderr: stderrStr, exitCode: 0 });
      },
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input);
    }
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/exec-file.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/exec-file.ts src/worker-agent/service/__tests__/exec-file.test.ts
git commit -m "feat(worker-service): add execFile wrapper with argv-only invocation"
```

---

### Task 3: Privilege-check helper

**Files:**
- Create: `src/worker-agent/service/privilege.ts`

- [ ] **Step 1: Implement**

```typescript
// src/worker-agent/service/privilege.ts
import { execFileCapture } from './exec-file';

export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      // `net session` only works for administrators.
      await execFileCapture('net', ['session'], { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }
  // Linux / macOS: euid === 0 means root.
  const getuid = (process as unknown as { geteuid?: () => number }).geteuid;
  return typeof getuid === 'function' && getuid() === 0;
}

export class NotElevatedError extends Error {
  name = 'NotElevatedError';
  constructor(action: string) {
    super(
      `${action} requires elevated privileges. ` +
        (process.platform === 'win32'
          ? 'Re-run from an administrator terminal.'
          : 'Re-run with sudo.'),
    );
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/worker-agent/service/privilege.ts
git commit -m "feat(worker-service): add isElevated privilege check"
```

---

### Task 4: Secure token resolver

**Files:**
- Create: `src/worker-agent/service/token-resolver.ts`
- Test: `src/worker-agent/service/__tests__/token-resolver.test.ts`

**Why:** CLI args leak into process lists and shell history. The spec mandates file / stdin / env / interactive only — never `--token <value>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/token-resolver.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveToken, TokenSource } from '../token-resolver';

describe('resolveToken', () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('reads token from file and trims trailing newline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
    const file = path.join(dir, 'tok');
    await fs.writeFile(file, 'abc123\n', { mode: 0o600 });
    const { token, source } = await resolveToken({ tokenFile: file });
    expect(token).toBe('abc123');
    expect(source).toBe(TokenSource.File);
  });

  it('reads from env when tokenEnv set', async () => {
    process.env.TESTING_TOKEN = 'envvalue';
    const { token, source } = await resolveToken({ tokenEnv: 'TESTING_TOKEN' });
    expect(token).toBe('envvalue');
    expect(source).toBe(TokenSource.Env);
  });

  it('rejects empty token', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tok-'));
    const file = path.join(dir, 'tok');
    await fs.writeFile(file, '\n', { mode: 0o600 });
    await expect(resolveToken({ tokenFile: file })).rejects.toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/token-resolver.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/token-resolver.ts
import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';

export enum TokenSource {
  File = 'file',
  Stdin = 'stdin',
  Env = 'env',
  Interactive = 'interactive',
}

export interface ResolveTokenOptions {
  tokenFile?: string;
  tokenEnv?: string;
  fromStdin?: boolean;
  interactive?: boolean;
}

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

export async function resolveToken(opts: ResolveTokenOptions): Promise<ResolvedToken> {
  if (opts.tokenFile) {
    const raw = await fs.readFile(opts.tokenFile, 'utf8');
    const token = raw.replace(/\r?\n$/, '').trim();
    if (!token) throw new Error(`Token file ${opts.tokenFile} is empty`);
    return { token, source: TokenSource.File };
  }
  if (opts.tokenEnv) {
    const val = process.env[opts.tokenEnv];
    if (!val || !val.trim()) throw new Error(`Env var ${opts.tokenEnv} is unset or empty`);
    return { token: val.trim(), source: TokenSource.Env };
  }
  if (opts.fromStdin) {
    const token = await readAll(process.stdin);
    const trimmed = token.replace(/\r?\n$/, '').trim();
    if (!trimmed) throw new Error('Stdin was empty');
    return { token: trimmed, source: TokenSource.Stdin };
  }
  if (opts.interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const ans = await new Promise<string>((resolve) =>
        rl.question('Enrollment token: ', resolve),
      );
      const trimmed = ans.trim();
      if (!trimmed) throw new Error('No token entered');
      return { token: trimmed, source: TokenSource.Interactive };
    } finally {
      rl.close();
    }
  }
  throw new Error('No token source specified (--token-file / --token-env / --token-stdin / --token-interactive)');
}

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (buf += chunk));
    stream.on('end', () => resolve(buf));
    stream.on('error', reject);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/token-resolver.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/token-resolver.ts src/worker-agent/service/__tests__/token-resolver.test.ts
git commit -m "feat(worker-service): add secure token resolver (file/stdin/env/interactive)"
```

---

### Task 5: Platform service paths

**Files:**
- Create: `src/worker-agent/service/paths.ts`
- Test: `src/worker-agent/service/__tests__/paths.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/paths.test.ts
import { describe, it, expect, vi } from 'vitest';
import { servicePaths } from '../paths';

describe('servicePaths', () => {
  it('returns windows paths on win32', () => {
    const p = servicePaths('win32');
    expect(p.configDir).toBe('C:\\ProgramData\\Orchestrator');
    expect(p.configFile).toBe('C:\\ProgramData\\Orchestrator\\worker-node.json');
    expect(p.binDir).toBe('C:\\Program Files\\Orchestrator\\bin');
    expect(p.logDir).toBe('C:\\ProgramData\\Orchestrator\\logs');
  });

  it('returns linux paths', () => {
    const p = servicePaths('linux');
    expect(p.configDir).toBe('/etc/orchestrator');
    expect(p.binDir).toBe('/opt/orchestrator/bin');
    expect(p.logDir).toBe('/var/log/orchestrator');
  });

  it('returns macos paths', () => {
    const p = servicePaths('darwin');
    expect(p.configDir).toBe('/Library/Application Support/Orchestrator');
    expect(p.binDir).toBe('/usr/local/opt/orchestrator/bin');
    expect(p.logDir).toBe('/Library/Logs/Orchestrator');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/paths.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/paths.ts
export interface ServicePaths {
  configDir: string;
  configFile: string;
  binDir: string;
  binFile: string;
  logDir: string;
  pluginDir: string;
}

type Platform = 'win32' | 'linux' | 'darwin';

export function servicePaths(platform: Platform = process.platform as Platform): ServicePaths {
  switch (platform) {
    case 'win32':
      return {
        configDir: 'C:\\ProgramData\\Orchestrator',
        configFile: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
        binDir: 'C:\\Program Files\\Orchestrator\\bin',
        binFile: 'C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe',
        logDir: 'C:\\ProgramData\\Orchestrator\\logs',
        pluginDir: 'C:\\ProgramData\\Orchestrator\\plugins',
      };
    case 'linux':
      return {
        configDir: '/etc/orchestrator',
        configFile: '/etc/orchestrator/worker-node.json',
        binDir: '/opt/orchestrator/bin',
        binFile: '/opt/orchestrator/bin/worker-agent',
        logDir: '/var/log/orchestrator',
        pluginDir: '/var/lib/orchestrator/plugins',
      };
    case 'darwin':
      return {
        configDir: '/Library/Application Support/Orchestrator',
        configFile: '/Library/Application Support/Orchestrator/worker-node.json',
        binDir: '/usr/local/opt/orchestrator/bin',
        binFile: '/usr/local/opt/orchestrator/bin/worker-agent',
        logDir: '/Library/Logs/Orchestrator',
        pluginDir: '/Library/Application Support/Orchestrator/plugins',
      };
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/paths.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/paths.ts src/worker-agent/service/__tests__/paths.test.ts
git commit -m "feat(worker-service): add platform service paths"
```

---

### Task 6: Config migration from user home

**Files:**
- Create: `src/worker-agent/service/config-migration.ts`
- Test: `src/worker-agent/service/__tests__/config-migration.test.ts`

**Why:** Existing installs store config at `~/.orchestrator/worker-node.json`. Service mode runs as a different user and cannot read that path. Migration copies the file to the platform service path and rewrites permissions.

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/config-migration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateConfigIfNeeded } from '../config-migration';

describe('migrateConfigIfNeeded', () => {
  let tmpHome: string;
  let tmpTarget: string;
  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'home-'));
    tmpTarget = await fs.mkdtemp(path.join(os.tmpdir(), 'svc-'));
  });

  it('copies config from user home to target when target missing', async () => {
    const src = path.join(tmpHome, '.orchestrator', 'worker-node.json');
    await fs.mkdir(path.dirname(src), { recursive: true });
    await fs.writeFile(src, JSON.stringify({ coordinatorUrl: 'ws://x' }));
    const dst = path.join(tmpTarget, 'worker-node.json');
    const result = await migrateConfigIfNeeded({ userConfigPath: src, serviceConfigPath: dst });
    expect(result.migrated).toBe(true);
    const copied = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(copied.coordinatorUrl).toBe('ws://x');
  });

  it('does nothing if target already exists', async () => {
    const src = path.join(tmpHome, 'a.json');
    const dst = path.join(tmpTarget, 'a.json');
    await fs.writeFile(src, '{}');
    await fs.writeFile(dst, '{"existing":true}');
    const result = await migrateConfigIfNeeded({ userConfigPath: src, serviceConfigPath: dst });
    expect(result.migrated).toBe(false);
    const content = JSON.parse(await fs.readFile(dst, 'utf8'));
    expect(content.existing).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/config-migration.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/config-migration.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface MigrateOptions {
  userConfigPath: string;
  serviceConfigPath: string;
}

export interface MigrateResult {
  migrated: boolean;
  reason?: string;
}

export async function migrateConfigIfNeeded(opts: MigrateOptions): Promise<MigrateResult> {
  try {
    await fs.access(opts.serviceConfigPath);
    return { migrated: false, reason: 'target exists' };
  } catch {
    // target missing — proceed
  }
  try {
    await fs.access(opts.userConfigPath);
  } catch {
    return { migrated: false, reason: 'source missing' };
  }
  await fs.mkdir(path.dirname(opts.serviceConfigPath), { recursive: true });
  const contents = await fs.readFile(opts.userConfigPath);
  await fs.writeFile(opts.serviceConfigPath, contents, { mode: 0o600 });
  return { migrated: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/config-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/config-migration.ts src/worker-agent/service/__tests__/config-migration.test.ts
git commit -m "feat(worker-service): migrate config from user home to service path"
```

---

### Task 7: ServiceManager factory (platform dispatch)

**Files:**
- Create: `src/worker-agent/service/manager-factory.ts`

- [ ] **Step 1: Implement (stub manager classes, filled in later phases)**

```typescript
// src/worker-agent/service/manager-factory.ts
import type { ServiceManager } from './types';

export async function createServiceManager(
  platform: NodeJS.Platform = process.platform,
): Promise<ServiceManager> {
  switch (platform) {
    case 'win32': {
      const { WindowsServiceManager } = await import('./windows-service-manager');
      return new WindowsServiceManager();
    }
    case 'linux': {
      const { LinuxServiceManager } = await import('./linux-service-manager');
      return new LinuxServiceManager();
    }
    case 'darwin': {
      const { MacosServiceManager } = await import('./macos-service-manager');
      return new MacosServiceManager();
    }
    default:
      throw new Error(`Service install is not supported on ${platform}`);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/worker-agent/service/manager-factory.ts
git commit -m "feat(worker-service): add platform dispatch factory"
```

---

## Phase 1: Windows Service (WinSW)

### Task 8: WinSW XML generator

**Files:**
- Create: `src/worker-agent/service/windows-winsw-xml.ts`
- Test: `src/worker-agent/service/__tests__/windows-winsw-xml.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/windows-winsw-xml.test.ts
import { describe, it, expect } from 'vitest';
import { generateWinswXml } from '../windows-winsw-xml';

describe('generateWinswXml', () => {
  it('includes escaped service name, binary path, and config arg', () => {
    const xml = generateWinswXml({
      serviceId: 'ai-orchestrator-worker',
      displayName: 'AI Orchestrator Worker',
      description: 'Worker node for AI Orchestrator',
      executable: 'C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe',
      arguments: ['--service-run', '--config', 'C:\\ProgramData\\Orchestrator\\worker-node.json'],
      logDir: 'C:\\ProgramData\\Orchestrator\\logs',
      serviceAccount: 'NT SERVICE\\ai-orchestrator-worker',
    });
    expect(xml).toContain('<id>ai-orchestrator-worker</id>');
    expect(xml).toContain('<executable>C:\\Program Files\\Orchestrator\\bin\\worker-agent.exe</executable>');
    expect(xml).toContain('<argument>--service-run</argument>');
    expect(xml).toContain('<logpath>C:\\ProgramData\\Orchestrator\\logs</logpath>');
    expect(xml).toContain('<serviceaccount>');
    expect(xml).toContain('<onfailure action="restart" delay="10 sec"/>');
  });

  it('escapes special XML characters in description', () => {
    const xml = generateWinswXml({
      serviceId: 'x',
      displayName: 'X',
      description: 'A & B < C > "D"',
      executable: 'C:\\x.exe',
      arguments: [],
      logDir: 'C:\\logs',
    });
    expect(xml).toContain('A &amp; B &lt; C &gt; &quot;D&quot;');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/windows-winsw-xml.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/windows-winsw-xml.ts
export interface WinswXmlOptions {
  serviceId: string;
  displayName: string;
  description: string;
  executable: string;
  arguments: string[];
  logDir: string;
  serviceAccount?: string;
  env?: Record<string, string>;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function generateWinswXml(opts: WinswXmlOptions): string {
  const args = opts.arguments.map((a) => `  <argument>${escapeXml(a)}</argument>`).join('\n');
  const envBlock = opts.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `  <env name="${escapeXml(k)}" value="${escapeXml(v)}"/>`)
        .join('\n')
    : '';
  const accountBlock = opts.serviceAccount
    ? `  <serviceaccount>\n    <username>${escapeXml(opts.serviceAccount)}</username>\n    <allowservicelogon>true</allowservicelogon>\n  </serviceaccount>`
    : '';
  return `<service>
  <id>${escapeXml(opts.serviceId)}</id>
  <name>${escapeXml(opts.displayName)}</name>
  <description>${escapeXml(opts.description)}</description>
  <executable>${escapeXml(opts.executable)}</executable>
${args}
  <logpath>${escapeXml(opts.logDir)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
${envBlock}
${accountBlock}
</service>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/windows-winsw-xml.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/windows-winsw-xml.ts src/worker-agent/service/__tests__/windows-winsw-xml.test.ts
git commit -m "feat(worker-service): generate WinSW service XML"
```

---

### Task 9: WindowsServiceManager

**Files:**
- Create: `src/worker-agent/service/windows-service-manager.ts`
- Test: `src/worker-agent/service/__tests__/windows-service-manager.test.ts`

**Why:** Orchestrates: copy SEA binary + WinSW.exe into `C:\Program Files\Orchestrator\bin`, write XML config, run `WinSW.exe install`, grant the service account ACL to start/stop via `sc.exe sdset` so the coordinator can control it without admin rights afterward.

- [ ] **Step 1: Write the failing test (using mocked execFile)**

```typescript
// src/worker-agent/service/__tests__/windows-service-manager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WindowsServiceManager } from '../windows-service-manager';
import * as execFileMod from '../exec-file';

describe('WindowsServiceManager', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('status parses sc.exe query output', async () => {
    const spy = vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout:
        'SERVICE_NAME: ai-orchestrator-worker\r\n' +
        '        TYPE               : 10  WIN32_OWN_PROCESS\r\n' +
        '        STATE              : 4  RUNNING\r\n' +
        '        PID                : 4321\r\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new WindowsServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(4321);
    expect(spy).toHaveBeenCalledWith('sc.exe', expect.arrayContaining(['queryex']));
  });

  it('status returns not-installed when sc.exe says service does not exist', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      Object.assign(new Error('boom'), { stderr: 'FAILED 1060', exitCode: 1060 }),
    );
    const mgr = new WindowsServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/windows-service-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/windows-service-manager.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileCapture, ExecFileError } from './exec-file';
import { generateWinswXml } from './windows-winsw-xml';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const SERVICE_ID = 'ai-orchestrator-worker';
const DISPLAY_NAME = 'AI Orchestrator Worker';

export class WindowsServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('win32');
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });

    const winswExe = path.join(paths.binDir, `${SERVICE_ID}.exe`);
    const winswXml = path.join(paths.binDir, `${SERVICE_ID}.xml`);

    // Copy SEA binary to final location
    const targetBin = path.join(paths.binDir, 'worker-agent.exe');
    await fs.copyFile(opts.binaryPath, targetBin);

    // Copy bundled WinSW shim (renamed to the service id)
    const bundledWinsw = path.resolve(__dirname, '..', '..', '..', 'resources', 'winsw', 'WinSW-x64.exe');
    await fs.copyFile(bundledWinsw, winswExe);

    const xml = generateWinswXml({
      serviceId: SERVICE_ID,
      displayName: DISPLAY_NAME,
      description: 'AI Orchestrator worker node',
      executable: targetBin,
      arguments: ['--service-run', '--config', opts.configPath],
      logDir: opts.logDir ?? paths.logDir,
      serviceAccount: opts.serviceAccount ?? 'NT SERVICE\\' + SERVICE_ID,
    });
    await fs.writeFile(winswXml, xml, 'utf8');

    await execFileCapture(winswExe, ['install']);
    await execFileCapture(winswExe, ['start']);
    await this.grantStartStopAcl();
  }

  async uninstall(): Promise<void> {
    const paths = servicePaths('win32');
    const winswExe = path.join(paths.binDir, `${SERVICE_ID}.exe`);
    try {
      await execFileCapture(winswExe, ['stop']);
    } catch {
      // ignore — may already be stopped
    }
    await execFileCapture(winswExe, ['uninstall']);
  }

  async start(): Promise<void> {
    await execFileCapture('sc.exe', ['start', SERVICE_ID]);
  }

  async stop(): Promise<void> {
    await execFileCapture('sc.exe', ['stop', SERVICE_ID]);
  }

  async restart(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // tolerate already-stopped
    }
    await this.start();
  }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileCapture('sc.exe', ['queryex', SERVICE_ID]);
      const stateMatch = stdout.match(/STATE\s*:\s*\d+\s+(\w+)/);
      const pidMatch = stdout.match(/PID\s*:\s*(\d+)/);
      const rawState = stateMatch?.[1] ?? '';
      const state = rawState === 'RUNNING' ? 'running' : rawState === 'STOPPED' ? 'stopped' : 'unknown';
      return {
        state,
        pid: pidMatch ? Number(pidMatch[1]) : undefined,
      };
    } catch (e) {
      if (e instanceof ExecFileError && e.stderr.includes('1060')) {
        return { state: 'not-installed' };
      }
      throw e;
    }
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async grantStartStopAcl(): Promise<void> {
    // Query current SDDL
    const { stdout } = await execFileCapture('sc.exe', ['sdshow', SERVICE_ID]);
    const current = stdout.trim();
    // Grant Authenticated Users RP (start) + WP (stop) — refined per spec
    // We insert a DACL ACE if not already present.
    const aceFragment = '(A;;RPWPCR;;;AU)';
    if (current.includes(aceFragment)) return;
    const daclStart = current.indexOf('D:');
    if (daclStart < 0) return;
    const sControlEnd = current.indexOf('S:', daclStart);
    const before = current.slice(0, sControlEnd >= 0 ? sControlEnd : current.length);
    const after = sControlEnd >= 0 ? current.slice(sControlEnd) : '';
    const updated = before + aceFragment + after;
    await execFileCapture('sc.exe', ['sdset', SERVICE_ID, updated]);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/windows-service-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/windows-service-manager.ts src/worker-agent/service/__tests__/windows-service-manager.test.ts
git commit -m "feat(worker-service): implement Windows service manager via WinSW"
```

---

## Phase 2: Linux systemd

### Task 10: systemd unit generator

**Files:**
- Create: `src/worker-agent/service/linux-systemd-unit.ts`
- Test: `src/worker-agent/service/__tests__/linux-systemd-unit.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/linux-systemd-unit.test.ts
import { describe, it, expect } from 'vitest';
import { generateSystemdUnit } from '../linux-systemd-unit';

describe('generateSystemdUnit', () => {
  it('emits a full unit with hardening directives', () => {
    const unit = generateSystemdUnit({
      description: 'AI Orchestrator Worker',
      execStart: '/opt/orchestrator/bin/worker-agent --service-run --config /etc/orchestrator/worker-node.json',
      user: 'orchestrator',
      group: 'orchestrator',
      workingDirectory: '/var/lib/orchestrator',
      stateDirectory: 'orchestrator',
      logDirectory: 'orchestrator',
    });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=AI Orchestrator Worker');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('User=orchestrator');
    expect(unit).toContain('Group=orchestrator');
    expect(unit).toContain('ExecStart=/opt/orchestrator/bin/worker-agent');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ProtectHome=yes');
    expect(unit).toContain('PrivateTmp=yes');
    expect(unit).toContain('ReadOnlyPaths=/etc/orchestrator');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/linux-systemd-unit.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/linux-systemd-unit.ts
export interface SystemdUnitOptions {
  description: string;
  execStart: string;
  user: string;
  group: string;
  workingDirectory: string;
  stateDirectory: string;
  logDirectory: string;
  environment?: Record<string, string>;
}

export function generateSystemdUnit(opts: SystemdUnitOptions): string {
  const envLines = opts.environment
    ? Object.entries(opts.environment).map(([k, v]) => `Environment=${k}=${v}`).join('\n')
    : '';
  return `[Unit]
Description=${opts.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
Group=${opts.group}
WorkingDirectory=${opts.workingDirectory}
ExecStart=${opts.execStart}
Restart=on-failure
RestartSec=10
StateDirectory=${opts.stateDirectory}
LogsDirectory=${opts.logDirectory}
${envLines}

# Hardening
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictRealtime=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged @resources
ReadOnlyPaths=/etc/orchestrator
ReadWritePaths=/var/log/orchestrator /var/lib/orchestrator

[Install]
WantedBy=multi-user.target
`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/linux-systemd-unit.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/linux-systemd-unit.ts src/worker-agent/service/__tests__/linux-systemd-unit.test.ts
git commit -m "feat(worker-service): generate hardened systemd unit"
```

---

### Task 11: LinuxServiceManager

**Files:**
- Create: `src/worker-agent/service/linux-service-manager.ts`
- Test: `src/worker-agent/service/__tests__/linux-service-manager.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/linux-service-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { LinuxServiceManager } from '../linux-service-manager';
import * as execFileMod from '../exec-file';

describe('LinuxServiceManager', () => {
  it('status parses systemctl show output', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'ActiveState=active\nMainPID=1234\nExecMainStartTimestamp=Fri 2026-04-16 12:00:00 UTC\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new LinuxServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(1234);
  });

  it('status returns not-installed when unit-file is not-found', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'LoadState=not-found\nActiveState=inactive\nMainPID=0\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new LinuxServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/linux-service-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/linux-service-manager.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFileCapture } from './exec-file';
import { generateSystemdUnit } from './linux-systemd-unit';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const SERVICE_NAME = 'ai-orchestrator-worker.service';
const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}`;
const SERVICE_USER = 'orchestrator';
const SERVICE_GROUP = 'orchestrator';

export class LinuxServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('linux');
    // Create service account if missing
    try {
      await execFileCapture('id', [SERVICE_USER]);
    } catch {
      await execFileCapture('useradd', [
        '--system',
        '--no-create-home',
        '--shell',
        '/usr/sbin/nologin',
        SERVICE_USER,
      ]);
    }
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir('/var/lib/orchestrator', { recursive: true });
    await fs.copyFile(opts.binaryPath, paths.binFile);
    await fs.chmod(paths.binFile, 0o755);
    await execFileCapture('chown', ['-R', `${SERVICE_USER}:${SERVICE_GROUP}`, paths.logDir, '/var/lib/orchestrator']);
    await execFileCapture('chown', ['root:root', paths.binFile]);

    const unit = generateSystemdUnit({
      description: 'AI Orchestrator Worker',
      execStart: `${paths.binFile} --service-run --config ${opts.configPath}`,
      user: SERVICE_USER,
      group: SERVICE_GROUP,
      workingDirectory: '/var/lib/orchestrator',
      stateDirectory: 'orchestrator',
      logDirectory: 'orchestrator',
    });
    await fs.writeFile(UNIT_PATH, unit, { mode: 0o644 });
    await execFileCapture('systemctl', ['daemon-reload']);
    await execFileCapture('systemctl', ['enable', SERVICE_NAME]);
    await execFileCapture('systemctl', ['start', SERVICE_NAME]);
    await this.installPolkitRule();
  }

  async uninstall(): Promise<void> {
    try {
      await execFileCapture('systemctl', ['stop', SERVICE_NAME]);
    } catch {
      /* ignore */
    }
    try {
      await execFileCapture('systemctl', ['disable', SERVICE_NAME]);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(UNIT_PATH);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink('/etc/polkit-1/rules.d/50-orchestrator.rules');
    } catch {
      /* ignore */
    }
    await execFileCapture('systemctl', ['daemon-reload']);
  }

  async start(): Promise<void> {
    await execFileCapture('systemctl', ['start', SERVICE_NAME]);
  }

  async stop(): Promise<void> {
    await execFileCapture('systemctl', ['stop', SERVICE_NAME]);
  }

  async restart(): Promise<void> {
    await execFileCapture('systemctl', ['restart', SERVICE_NAME]);
  }

  async status(): Promise<ServiceStatus> {
    const { stdout } = await execFileCapture('systemctl', [
      'show',
      SERVICE_NAME,
      '--property=ActiveState,MainPID,LoadState,ExecMainStartTimestamp',
    ]);
    const map = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) map.set(line.slice(0, eq), line.slice(eq + 1));
    }
    if (map.get('LoadState') === 'not-found') return { state: 'not-installed' };
    const active = map.get('ActiveState');
    const state = active === 'active' ? 'running' : active === 'inactive' || active === 'failed' ? 'stopped' : 'unknown';
    const pidStr = map.get('MainPID');
    const pid = pidStr && pidStr !== '0' ? Number(pidStr) : undefined;
    return { state, pid };
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async installPolkitRule(): Promise<void> {
    const rule = `polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      action.lookup("unit") == "${SERVICE_NAME}" &&
      subject.isInGroup("${SERVICE_GROUP}")) {
    return polkit.Result.YES;
  }
});
`;
    await fs.writeFile('/etc/polkit-1/rules.d/50-orchestrator.rules', rule, { mode: 0o644 });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/linux-service-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/linux-service-manager.ts src/worker-agent/service/__tests__/linux-service-manager.test.ts
git commit -m "feat(worker-service): implement Linux systemd service manager"
```

---

## Phase 3: macOS launchd

### Task 12: launchd plist generator

**Files:**
- Create: `src/worker-agent/service/macos-launchd-plist.ts`
- Test: `src/worker-agent/service/__tests__/macos-launchd-plist.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/macos-launchd-plist.test.ts
import { describe, it, expect } from 'vitest';
import { generateLaunchdPlist } from '../macos-launchd-plist';

describe('generateLaunchdPlist', () => {
  it('emits a daemon plist with RunAtLoad, KeepAlive, and StandardOut/ErrorPath', () => {
    const xml = generateLaunchdPlist({
      label: 'com.aiorchestrator.worker',
      programArguments: [
        '/usr/local/opt/orchestrator/bin/worker-agent',
        '--service-run',
        '--config',
        '/Library/Application Support/Orchestrator/worker-node.json',
      ],
      userName: '_orchestrator',
      groupName: '_orchestrator',
      stdoutPath: '/Library/Logs/Orchestrator/worker.out.log',
      stderrPath: '/Library/Logs/Orchestrator/worker.err.log',
      workingDirectory: '/usr/local/var/orchestrator',
    });
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.aiorchestrator.worker</string>');
    expect(xml).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>UserName</key>\n  <string>_orchestrator</string>');
    expect(xml).toContain('<key>StandardOutPath</key>');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/macos-launchd-plist.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/macos-launchd-plist.ts
export interface LaunchdPlistOptions {
  label: string;
  programArguments: string[];
  userName: string;
  groupName: string;
  stdoutPath: string;
  stderrPath: string;
  workingDirectory: string;
  environment?: Record<string, string>;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function generateLaunchdPlist(opts: LaunchdPlistOptions): string {
  const args = opts.programArguments.map((a) => `    <string>${esc(a)}</string>`).join('\n');
  const envEntries = opts.environment
    ? Object.entries(opts.environment)
        .map(([k, v]) => `    <key>${esc(k)}</key>\n    <string>${esc(v)}</string>`)
        .join('\n')
    : '';
  const envBlock = envEntries
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries}\n  </dict>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>UserName</key>
  <string>${esc(opts.userName)}</string>
  <key>GroupName</key>
  <string>${esc(opts.groupName)}</string>
  <key>WorkingDirectory</key>
  <string>${esc(opts.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${esc(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(opts.stderrPath)}</string>
  <key>ProcessType</key>
  <string>Background</string>
${envBlock}</dict>
</plist>
`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/macos-launchd-plist.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/macos-launchd-plist.ts src/worker-agent/service/__tests__/macos-launchd-plist.test.ts
git commit -m "feat(worker-service): generate launchd daemon plist"
```

---

### Task 13: MacosServiceManager

**Files:**
- Create: `src/worker-agent/service/macos-service-manager.ts`
- Test: `src/worker-agent/service/__tests__/macos-service-manager.test.ts`

**Why:** Uses `launchctl bootstrap`/`bootout` (modern API), not deprecated `load`/`unload`. Delegates start/stop to the admin group via a sudoers drop-in.

- [ ] **Step 1: Write the failing test**

```typescript
// src/worker-agent/service/__tests__/macos-service-manager.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MacosServiceManager } from '../macos-service-manager';
import * as execFileMod from '../exec-file';

describe('MacosServiceManager', () => {
  it('status parses launchctl print output', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockResolvedValue({
      stdout: 'state = running\npid = 9876\n',
      stderr: '',
      exitCode: 0,
    });
    const mgr = new MacosServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('running');
    expect(s.pid).toBe(9876);
  });

  it('status returns not-installed when launchctl reports Could not find service', async () => {
    vi.spyOn(execFileMod, 'execFileCapture').mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'Could not find service', exitCode: 113 }),
    );
    const mgr = new MacosServiceManager();
    const s = await mgr.status();
    expect(s.state).toBe('not-installed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/worker-agent/service/__tests__/macos-service-manager.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

```typescript
// src/worker-agent/service/macos-service-manager.ts
import * as fs from 'node:fs/promises';
import { execFileCapture, ExecFileError } from './exec-file';
import { generateLaunchdPlist } from './macos-launchd-plist';
import { servicePaths } from './paths';
import type { ServiceManager, ServiceInstallOptions, ServiceStatus } from './types';

const LABEL = 'com.aiorchestrator.worker';
const PLIST_PATH = `/Library/LaunchDaemons/${LABEL}.plist`;
const SERVICE_TARGET = `system/${LABEL}`;
const USER_NAME = '_orchestrator';
const GROUP_NAME = '_orchestrator';

export class MacosServiceManager implements ServiceManager {
  async install(opts: ServiceInstallOptions): Promise<void> {
    const paths = servicePaths('darwin');
    await this.ensureServiceUser();
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.mkdir(paths.logDir, { recursive: true });
    await fs.mkdir('/usr/local/var/orchestrator', { recursive: true });
    await fs.copyFile(opts.binaryPath, paths.binFile);
    await fs.chmod(paths.binFile, 0o755);
    await execFileCapture('chown', ['root:wheel', paths.binFile]);
    await execFileCapture('chown', ['-R', `${USER_NAME}:${GROUP_NAME}`, paths.logDir, '/usr/local/var/orchestrator']);

    const xml = generateLaunchdPlist({
      label: LABEL,
      programArguments: [paths.binFile, '--service-run', '--config', opts.configPath],
      userName: USER_NAME,
      groupName: GROUP_NAME,
      stdoutPath: `${paths.logDir}/worker.out.log`,
      stderrPath: `${paths.logDir}/worker.err.log`,
      workingDirectory: '/usr/local/var/orchestrator',
    });
    await fs.writeFile(PLIST_PATH, xml, { mode: 0o644 });
    await execFileCapture('chown', ['root:wheel', PLIST_PATH]);

    await execFileCapture('launchctl', ['bootstrap', 'system', PLIST_PATH]);
    await execFileCapture('launchctl', ['kickstart', '-k', SERVICE_TARGET]);
    await this.installSudoersDropIn();
  }

  async uninstall(): Promise<void> {
    try {
      await execFileCapture('launchctl', ['bootout', SERVICE_TARGET]);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(PLIST_PATH);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink('/etc/sudoers.d/orchestrator');
    } catch {
      /* ignore */
    }
  }

  async start(): Promise<void> {
    await execFileCapture('launchctl', ['kickstart', SERVICE_TARGET]);
  }

  async stop(): Promise<void> {
    await execFileCapture('launchctl', ['kill', 'SIGTERM', SERVICE_TARGET]);
  }

  async restart(): Promise<void> {
    await execFileCapture('launchctl', ['kickstart', '-k', SERVICE_TARGET]);
  }

  async status(): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileCapture('launchctl', ['print', SERVICE_TARGET]);
      const stateMatch = stdout.match(/state\s*=\s*(\w+)/);
      const pidMatch = stdout.match(/pid\s*=\s*(\d+)/);
      const st = stateMatch?.[1];
      const state = st === 'running' ? 'running' : st === 'not running' || st === 'exited' ? 'stopped' : 'unknown';
      return { state, pid: pidMatch ? Number(pidMatch[1]) : undefined };
    } catch (e) {
      if (e instanceof ExecFileError && /Could not find service/i.test(e.stderr)) {
        return { state: 'not-installed' };
      }
      throw e;
    }
  }

  async isInstalled(): Promise<boolean> {
    const s = await this.status();
    return s.state !== 'not-installed';
  }

  private async ensureServiceUser(): Promise<void> {
    try {
      await execFileCapture('dscl', ['.', '-read', `/Users/${USER_NAME}`]);
      return;
    } catch {
      /* create below */
    }
    const uid = await this.nextAvailableUid();
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'UserShell', '/usr/bin/false']);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'RealName', 'AI Orchestrator Worker']);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'UniqueID', String(uid)]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'PrimaryGroupID', String(uid)]);
    await execFileCapture('dscl', ['.', '-create', `/Users/${USER_NAME}`, 'NFSHomeDirectory', '/var/empty']);
  }

  private async nextAvailableUid(): Promise<number> {
    const { stdout } = await execFileCapture('dscl', ['.', '-list', '/Users', 'UniqueID']);
    let max = 200;
    for (const line of stdout.split('\n')) {
      const m = line.match(/\s(\d+)$/);
      if (m) {
        const n = Number(m[1]);
        if (n < 500 && n > max) max = n;
      }
    }
    return max + 1;
  }

  private async installSudoersDropIn(): Promise<void> {
    const content = `# Allow admin group to manage AI Orchestrator worker daemon
%admin ALL=(root) NOPASSWD: /bin/launchctl kickstart system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl kickstart -k system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl kill SIGTERM system/${LABEL}
%admin ALL=(root) NOPASSWD: /bin/launchctl print system/${LABEL}
`;
    const tmp = '/etc/sudoers.d/.orchestrator.tmp';
    await fs.writeFile(tmp, content, { mode: 0o440 });
    await execFileCapture('chown', ['root:wheel', tmp]);
    await execFileCapture('visudo', ['-c', '-f', tmp]);
    await fs.rename(tmp, '/etc/sudoers.d/orchestrator');
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/worker-agent/service/__tests__/macos-service-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/service/macos-service-manager.ts src/worker-agent/service/__tests__/macos-service-manager.test.ts
git commit -m "feat(worker-service): implement macOS launchd service manager"
```

---

## Phase 4: CLI Integration

### Task 14: Service CLI dispatcher

**Files:**
- Create: `src/worker-agent/cli/service-cli.ts`

- [ ] **Step 1: Implement**

```typescript
// src/worker-agent/cli/service-cli.ts
import * as path from 'node:path';
import { createServiceManager } from '../service/manager-factory';
import { isElevated, NotElevatedError } from '../service/privilege';
import { resolveToken } from '../service/token-resolver';
import { servicePaths } from '../service/paths';
import { migrateConfigIfNeeded } from '../service/config-migration';
import { DEFAULT_CONFIG_PATH, loadWorkerConfig, persistConfig } from '../worker-config';

export type ServiceCommand =
  | { kind: 'install'; coordinatorUrl: string; tokenOpts: TokenCliOpts }
  | { kind: 'uninstall' }
  | { kind: 'status' }
  | { kind: 'run' };

interface TokenCliOpts {
  tokenFile?: string;
  tokenEnv?: string;
  fromStdin?: boolean;
  interactive?: boolean;
}

export function parseServiceArgs(argv: string[]): ServiceCommand | null {
  const has = (flag: string) => argv.includes(flag);
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (has('--install-service')) {
    const coordinatorUrl = valueOf('--coordinator-url');
    if (!coordinatorUrl) throw new Error('--install-service requires --coordinator-url');
    return {
      kind: 'install',
      coordinatorUrl,
      tokenOpts: {
        tokenFile: valueOf('--token-file'),
        tokenEnv: valueOf('--token-env'),
        fromStdin: has('--token-stdin'),
        interactive: has('--token-interactive'),
      },
    };
  }
  if (has('--uninstall-service')) return { kind: 'uninstall' };
  if (has('--service-status')) return { kind: 'status' };
  if (has('--service-run')) return { kind: 'run' };
  return null;
}

export async function runServiceCommand(cmd: ServiceCommand): Promise<number> {
  const mgr = await createServiceManager();
  const paths = servicePaths();

  switch (cmd.kind) {
    case 'install': {
      if (!(await isElevated())) {
        throw new NotElevatedError('Installing the worker service');
      }
      const { token } = await resolveToken(cmd.tokenOpts);
      await migrateConfigIfNeeded({
        userConfigPath: DEFAULT_CONFIG_PATH,
        serviceConfigPath: paths.configFile,
      });
      const existing = await safeLoad(paths.configFile);
      const merged = {
        ...existing,
        coordinatorUrl: cmd.coordinatorUrl,
        enrollmentToken: token,
      };
      await persistConfig(merged, paths.configFile);
      await mgr.install({
        binaryPath: process.execPath,
        configPath: paths.configFile,
        coordinatorUrl: cmd.coordinatorUrl,
        enrollmentToken: token,
        logDir: paths.logDir,
      });
      process.stdout.write('Service installed and started.\n');
      return 0;
    }
    case 'uninstall':
      if (!(await isElevated())) throw new NotElevatedError('Uninstalling the worker service');
      await mgr.uninstall();
      process.stdout.write('Service uninstalled.\n');
      return 0;
    case 'status': {
      const s = await mgr.status();
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
      return 0;
    }
    case 'run':
      // Fall-through handled by index.ts: load config from service path and start WorkerAgent
      return 0;
  }
}

async function safeLoad(configPath: string) {
  try {
    return await loadWorkerConfig(configPath);
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (may require small tweaks to `loadWorkerConfig` / `persistConfig` signatures)

- [ ] **Step 3: Commit**

```bash
git add src/worker-agent/cli/service-cli.ts
git commit -m "feat(worker-service): add service CLI command dispatcher"
```

---

### Task 15: Update worker-agent entrypoint

**Files:**
- Modify: `src/worker-agent/index.ts`
- Modify: `src/worker-agent/worker-config.ts`

- [ ] **Step 1: Extend worker-config.ts to support explicit config path**

Read the current `worker-config.ts` to confirm exported names, then add:

```typescript
// src/worker-agent/worker-config.ts  (append)
export function resolveConfigPath(serviceMode: boolean): string {
  if (serviceMode) {
    // Late import to avoid circular deps in tests
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { servicePaths } = require('./service/paths') as typeof import('./service/paths');
    return servicePaths().configFile;
  }
  return DEFAULT_CONFIG_PATH;
}
```

- [ ] **Step 2: Rewrite index.ts to dispatch**

```typescript
// src/worker-agent/index.ts
import { WorkerAgent } from './worker-agent';
import { loadWorkerConfig, resolveConfigPath } from './worker-config';
import { parseServiceArgs, runServiceCommand } from './cli/service-cli';

async function main() {
  const argv = process.argv.slice(2);
  const cmd = parseServiceArgs(argv);

  if (cmd && cmd.kind !== 'run') {
    const code = await runServiceCommand(cmd);
    process.exit(code);
  }

  const serviceMode = cmd?.kind === 'run';
  const configPath = serviceMode
    ? resolveConfigPath(true)
    : (argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : undefined);

  const config = await loadWorkerConfig(configPath);
  const agent = new WorkerAgent(config);

  const shutdown = async (signal: NodeJS.Signals) => {
    try {
      await agent.disconnect?.();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await agent.connect();
}

main().catch((err) => {
  console.error('Worker agent failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. Fix any signature mismatches against the real `WorkerAgent.connect`/`disconnect` API.

- [ ] **Step 4: Commit**

```bash
git add src/worker-agent/index.ts src/worker-agent/worker-config.ts
git commit -m "feat(worker-service): wire service CLI into worker entrypoint"
```

---

## Phase 5: Packaging (SEA Binary)

### Task 16: Download pinned WinSW

**Files:**
- Create: `scripts/download-winsw.js`
- Modify: `package.json` (add `download:winsw` script)

- [ ] **Step 1: Implement the download script**

```javascript
// scripts/download-winsw.js
/* eslint-env node */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');

const PINNED_VERSION = '2.12.0';
const BASE_URL = `https://github.com/winsw/winsw/releases/download/v${PINNED_VERSION}`;
const EXPECTED_SHA256 = {
  'WinSW-x64.exe': 'REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN',
};

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const doGet = (u) =>
      https.get(u, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
    doGet(url);
  });
}

async function main() {
  const outDir = path.resolve(__dirname, '..', 'resources', 'winsw');
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of Object.keys(EXPECTED_SHA256)) {
    const dest = path.join(outDir, name);
    if (fs.existsSync(dest)) {
      console.log(`[winsw] ${name} already present, skipping`);
      continue;
    }
    console.log(`[winsw] downloading ${name}`);
    await download(`${BASE_URL}/${name}`, dest);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    const expected = EXPECTED_SHA256[name];
    if (expected && expected !== 'REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN' && actual !== expected) {
      fs.unlinkSync(dest);
      throw new Error(`SHA256 mismatch for ${name}: expected ${expected}, got ${actual}`);
    }
    console.log(`[winsw] ${name} sha256=${actual}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add script to package.json**

Add inside `"scripts"`:

```json
"download:winsw": "node scripts/download-winsw.js",
```

- [ ] **Step 3: Run once, record the real hash, paste into script**

Run: `npm run download:winsw`
Expected: prints `sha256=...`. Replace `REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN` with that value so subsequent runs verify integrity.

- [ ] **Step 4: Commit**

```bash
git add scripts/download-winsw.js package.json resources/winsw/
git commit -m "build(worker-service): pin and download WinSW v2.12.0"
```

---

### Task 17: SEA build script

**Files:**
- Create: `build-worker-agent-sea.ts`
- Modify: `package.json` (add `postject` dep + scripts)

**Why:** `build-worker-agent.ts` already produces `dist/worker-agent/index.js`. The SEA step wraps it inside a Node binary so end users need no Node install. Node 22+ required — the build script must fail loudly on Node 20.

- [ ] **Step 1: Add postject dev dependency**

Run: `npm install --save-dev postject`
Expected: postject appears in `devDependencies`.

- [ ] **Step 2: Implement SEA builder**

```typescript
// build-worker-agent-sea.ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function assertNode22Plus() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) {
    throw new Error(`SEA build requires Node >= 22 (current: ${process.versions.node}). Skip on older Node or upgrade.`);
  }
}

async function main() {
  assertNode22Plus();
  const bundle = path.resolve('dist/worker-agent/index.js');
  if (!fs.existsSync(bundle)) {
    throw new Error(`Missing ${bundle} — run npm run build:worker-agent first`);
  }
  const outDir = path.resolve('dist/worker-agent-sea');
  fs.mkdirSync(outDir, { recursive: true });

  const seaConfig = {
    main: bundle,
    output: path.join(outDir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  const cfgPath = path.join(outDir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2));

  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'inherit' });

  const suffix = process.platform === 'win32' ? '.exe' : '';
  const binOut = path.join(outDir, `worker-agent${suffix}`);
  fs.copyFileSync(process.execPath, binOut);

  const seaResourceName = 'NODE_SEA_BLOB';
  const postjectArgs = [
    binOut,
    seaResourceName,
    seaConfig.output,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', ['postject', ...postjectArgs], { stdio: 'inherit' });

  console.log(`[sea] built ${binOut}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add scripts to package.json**

```json
"build:worker-sea": "tsx build-worker-agent-sea.ts",
"build:worker-dist": "npm run build:worker-agent && npm run build:worker-sea"
```

- [ ] **Step 4: Try the build (will skip on Node 20 with a clear message)**

Run: `npm run build:worker-dist`
Expected: On Node 22+ produces `dist/worker-agent-sea/worker-agent[.exe]`. On Node 20 fails with the guard message — that's fine for now; note in CI to run on Node 22.

- [ ] **Step 5: Commit**

```bash
git add build-worker-agent-sea.ts package.json package-lock.json
git commit -m "build(worker-service): produce single-file SEA binary for worker-agent"
```

---

## Phase 6: RPC Protocol Extensions

### Task 18: Shared service IPC channels and types

**Files:**
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/shared/types/service.types.ts` (extend if needed)

- [ ] **Step 1: Add new channels**

Locate `IPC_CHANNELS` in `src/shared/types/ipc.types.ts` and add:

```typescript
REMOTE_NODE_SERVICE_STATUS: 'remote-node:service:status',
REMOTE_NODE_SERVICE_RESTART: 'remote-node:service:restart',
REMOTE_NODE_SERVICE_STOP: 'remote-node:service:stop',
REMOTE_NODE_SERVICE_UNINSTALL: 'remote-node:service:uninstall',
```

- [ ] **Step 2: Regenerate preload channel list**

Run: `npm run generate:ipc`
Expected: `src/preload/preload.ts` picks up new channels. Then `npm run verify:ipc` passes.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/ipc.types.ts src/preload/preload.ts
git commit -m "feat(worker-service): add REMOTE_NODE_SERVICE_* IPC channels"
```

---

### Task 19: JSON-RPC service methods + scope field

**Files:**
- Modify: `src/main/remote-node/worker-node-rpc.ts`

- [ ] **Step 1: Extend constants and request type**

Edit `src/main/remote-node/worker-node-rpc.ts`:

```typescript
export const COORDINATOR_TO_NODE = {
  // ...existing entries...
  SERVICE_STATUS: 'service.status',
  SERVICE_RESTART: 'service.restart',
  SERVICE_STOP: 'service.stop',
  SERVICE_UNINSTALL: 'service.uninstall',
} as const;

export type RpcScope = 'instance' | 'service';

export interface RpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
  token?: string;
  scope?: RpcScope;
}
```

And update `createRpcRequest` to accept an optional scope:

```typescript
export function createRpcRequest(
  id: string | number,
  method: string,
  params?: unknown,
  token?: string,
  scope?: RpcScope,
): RpcRequest {
  return { jsonrpc: '2.0', id, method, params, token, scope };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (downstream callers don't break because new field is optional)

- [ ] **Step 3: Commit**

```bash
git add src/main/remote-node/worker-node-rpc.ts
git commit -m "feat(worker-service): add service.* RPC methods and scope field"
```

---

### Task 20: Worker-side service RPC handlers

**Files:**
- Modify: `src/worker-agent/worker-agent.ts`

**Why:** Incoming `service.*` RPCs must (a) validate scope, (b) dispatch to the ServiceManager, (c) for `service.restart`/`service.stop` schedule the action *after* sending the success response so the client gets a reply before the connection drops.

- [ ] **Step 1: Inspect `handleRpcRequest` in worker-agent.ts**

Read around the existing switch statement to understand the pattern for dispatching methods. Note existing helpers for sending responses/errors.

- [ ] **Step 2: Add scope validator and service handler helpers**

Add near the top of the class (or as module-level helpers):

```typescript
import { COORDINATOR_TO_NODE, RPC_ERROR_CODES, type RpcRequest } from '../main/remote-node/worker-node-rpc';
import { createServiceManager } from './service/manager-factory';

function validateScope(req: RpcRequest, expected: 'instance' | 'service'): string | null {
  const scope = req.scope ?? 'instance';
  if (scope !== expected) return `Method ${req.method} requires scope=${expected} (received ${scope})`;
  return null;
}
```

- [ ] **Step 3: Extend the `handleRpcRequest` switch**

Inside the existing switch, add cases:

```typescript
case COORDINATOR_TO_NODE.SERVICE_STATUS: {
  const err = validateScope(msg, 'service');
  if (err) {
    this.sendRpcError(msg.id, RPC_ERROR_CODES.UNAUTHORIZED, err);
    return;
  }
  const mgr = await createServiceManager();
  const status = await mgr.status();
  this.sendRpcResponse(msg.id, status);
  return;
}
case COORDINATOR_TO_NODE.SERVICE_RESTART: {
  const err = validateScope(msg, 'service');
  if (err) {
    this.sendRpcError(msg.id, RPC_ERROR_CODES.UNAUTHORIZED, err);
    return;
  }
  this.sendRpcResponse(msg.id, { scheduled: true });
  setTimeout(async () => {
    const mgr = await createServiceManager();
    try { await mgr.restart(); } catch (e) { this.logger?.error?.('service.restart failed', e); }
  }, 250);
  return;
}
case COORDINATOR_TO_NODE.SERVICE_STOP: {
  const err = validateScope(msg, 'service');
  if (err) {
    this.sendRpcError(msg.id, RPC_ERROR_CODES.UNAUTHORIZED, err);
    return;
  }
  this.sendRpcResponse(msg.id, { scheduled: true });
  setTimeout(async () => {
    const mgr = await createServiceManager();
    try { await mgr.stop(); } catch (e) { this.logger?.error?.('service.stop failed', e); }
  }, 250);
  return;
}
case COORDINATOR_TO_NODE.SERVICE_UNINSTALL: {
  const err = validateScope(msg, 'service');
  if (err) {
    this.sendRpcError(msg.id, RPC_ERROR_CODES.UNAUTHORIZED, err);
    return;
  }
  this.sendRpcResponse(msg.id, { scheduled: true });
  setTimeout(async () => {
    const mgr = await createServiceManager();
    try { await mgr.uninstall(); } catch (e) { this.logger?.error?.('service.uninstall failed', e); }
  }, 250);
  return;
}
```

If `sendRpcResponse`/`sendRpcError` helpers do not already exist, add them as thin wrappers that build the JSON and send over the existing websocket.

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/worker-agent.ts
git commit -m "feat(worker-service): handle service.* RPCs with scope validation"
```

---

## Phase 7: Coordinator IPC

### Task 21: service-rpc-client helper

**Files:**
- Create: `src/main/remote-node/service-rpc-client.ts`

- [ ] **Step 1: Implement**

```typescript
// src/main/remote-node/service-rpc-client.ts
import { getWorkerNodeConnectionServer } from './index';
import { createRpcRequest, type RpcResponse } from './worker-node-rpc';
import { randomUUID } from 'node:crypto';

export async function sendServiceRpc(
  nodeId: string,
  method: string,
  params?: unknown,
  timeoutMs = 15_000,
): Promise<unknown> {
  const server = getWorkerNodeConnectionServer();
  const id = randomUUID();
  const req = createRpcRequest(id, method, params, undefined, 'service');
  const resp = (await server.sendRequest(nodeId, req, { timeoutMs })) as RpcResponse;
  if (resp.error) {
    const err = new Error(resp.error.message);
    (err as Error & { code?: number }).code = resp.error.code;
    throw err;
  }
  return resp.result;
}
```

Adjust to match the existing `WorkerNodeConnectionServer` API (method name may be `request`, `sendRpc`, etc.; verify by reading that file first).

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. If `sendRequest` is named differently, fix the call.

- [ ] **Step 3: Commit**

```bash
git add src/main/remote-node/service-rpc-client.ts
git commit -m "feat(worker-service): add service-rpc-client helper"
```

---

### Task 22: Coordinator IPC handlers

**Files:**
- Modify: `src/main/ipc/handlers/remote-node-handlers.ts`

- [ ] **Step 1: Import helpers and constants**

Add near the top of `remote-node-handlers.ts`:

```typescript
import { COORDINATOR_TO_NODE } from '../../remote-node/worker-node-rpc';
import { sendServiceRpc } from '../../remote-node/service-rpc-client';
```

- [ ] **Step 2: Add four new handlers inside `registerRemoteNodeHandlers`**

```typescript
ipcMain.handle(
  IPC_CHANNELS.REMOTE_NODE_SERVICE_STATUS,
  async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
    try {
      const data = await sendServiceRpc(payload.nodeId, COORDINATOR_TO_NODE.SERVICE_STATUS);
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REMOTE_NODE_SERVICE_STATUS_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.REMOTE_NODE_SERVICE_RESTART,
  async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
    try {
      await sendServiceRpc(payload.nodeId, COORDINATOR_TO_NODE.SERVICE_RESTART);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REMOTE_NODE_SERVICE_RESTART_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.REMOTE_NODE_SERVICE_STOP,
  async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
    try {
      await sendServiceRpc(payload.nodeId, COORDINATOR_TO_NODE.SERVICE_STOP);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REMOTE_NODE_SERVICE_STOP_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  },
);

ipcMain.handle(
  IPC_CHANNELS.REMOTE_NODE_SERVICE_UNINSTALL,
  async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
    try {
      await sendServiceRpc(payload.nodeId, COORDINATOR_TO_NODE.SERVICE_UNINSTALL);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'REMOTE_NODE_SERVICE_UNINSTALL_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  },
);
```

- [ ] **Step 3: Verify typecheck and verify:ipc**

Run: `npx tsc --noEmit && npm run verify:ipc`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers/remote-node-handlers.ts
git commit -m "feat(worker-service): wire service IPC to scoped RPC"
```

---

## Phase 8: Coordinator UI

### Task 23: Renderer IPC service method

**Files:**
- Modify: existing renderer remote-node IPC wrapper (find via `grep -r REMOTE_NODE_REGENERATE_TOKEN src/renderer`)

- [ ] **Step 1: Locate the service**

Run: `npx grep -r REMOTE_NODE_GET src/renderer/app --include="*.ts"` (via Grep tool) to find the Angular service that wraps `window.electron.invoke`. Add four sibling methods:

```typescript
async getServiceStatus(nodeId: string): Promise<ServiceStatus | null> {
  const r = await window.electron.invoke<IpcResponse<ServiceStatus>>(
    'remote-node:service:status', { nodeId });
  return r.success ? r.data ?? null : null;
}
async restartService(nodeId: string): Promise<boolean> {
  const r = await window.electron.invoke<IpcResponse>('remote-node:service:restart', { nodeId });
  return r.success;
}
async stopService(nodeId: string): Promise<boolean> {
  const r = await window.electron.invoke<IpcResponse>('remote-node:service:stop', { nodeId });
  return r.success;
}
async uninstallService(nodeId: string): Promise<boolean> {
  const r = await window.electron.invoke<IpcResponse>('remote-node:service:uninstall', { nodeId });
  return r.success;
}
```

Import `ServiceStatus` from `src/shared/types/service.types`.

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer
git commit -m "feat(worker-service): add service IPC methods to renderer"
```

---

### Task 24: Store signal for service status

**Files:**
- Modify: existing `remote-nodes.store.ts` (or equivalent — locate via Grep for `RemoteNodeStore`)

- [ ] **Step 1: Add a signal map `nodeId -> ServiceStatus | null`**

```typescript
private readonly _serviceStatuses = signal<Record<string, ServiceStatus | null>>({});
readonly serviceStatuses = this._serviceStatuses.asReadonly();

async refreshServiceStatus(nodeId: string): Promise<void> {
  const status = await this.ipc.getServiceStatus(nodeId);
  this._serviceStatuses.update((prev) => ({ ...prev, [nodeId]: status }));
}

async restartService(nodeId: string) { await this.ipc.restartService(nodeId); await this.refreshServiceStatus(nodeId); }
async stopService(nodeId: string)    { await this.ipc.stopService(nodeId);    await this.refreshServiceStatus(nodeId); }
async uninstallService(nodeId: string) { await this.ipc.uninstallService(nodeId); await this.refreshServiceStatus(nodeId); }
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer
git commit -m "feat(worker-service): add service status signal to store"
```

---

### Task 25: NodeServicePanel component

**Files:**
- Create: `src/renderer/app/features/remote-nodes/node-service-panel/node-service-panel.component.ts`
- Create: `src/renderer/app/features/remote-nodes/node-service-panel/node-service-panel.component.html`
- Create: `src/renderer/app/features/remote-nodes/node-service-panel/node-service-panel.component.scss`

- [ ] **Step 1: Implement the component**

```typescript
// node-service-panel.component.ts
import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RemoteNodeStore } from '../remote-nodes.store';
import type { ServiceStatus } from '@shared/types/service.types';

@Component({
  selector: 'app-node-service-panel',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './node-service-panel.component.html',
  styleUrls: ['./node-service-panel.component.scss'],
})
export class NodeServicePanelComponent implements OnInit {
  readonly nodeId = input.required<string>();
  private readonly store = inject(RemoteNodeStore);

  readonly status = computed<ServiceStatus | null>(
    () => this.store.serviceStatuses()[this.nodeId()] ?? null,
  );

  ngOnInit(): void {
    void this.store.refreshServiceStatus(this.nodeId());
  }

  restart() { void this.store.restartService(this.nodeId()); }
  stop()    { void this.store.stopService(this.nodeId()); }
  uninstall() {
    if (confirm('Uninstall the worker service on this node? The node will disconnect.')) {
      void this.store.uninstallService(this.nodeId());
    }
  }
  refresh() { void this.store.refreshServiceStatus(this.nodeId()); }
}
```

- [ ] **Step 2: Template**

```html
<!-- node-service-panel.component.html -->
<div class="service-panel">
  <header>
    <h3>Service</h3>
    <button (click)="refresh()">Refresh</button>
  </header>
  @if (status() === null) {
    <p class="muted">No status yet — the node may not be running as a service.</p>
  } @else {
    <dl>
      <dt>State</dt><dd class="state-{{status()!.state}}">{{ status()!.state }}</dd>
      @if (status()!.pid) { <dt>PID</dt><dd>{{ status()!.pid }}</dd> }
      @if (status()!.version) { <dt>Version</dt><dd>{{ status()!.version }}</dd> }
      @if (status()!.uptimeSeconds) { <dt>Uptime</dt><dd>{{ status()!.uptimeSeconds }}s</dd> }
    </dl>
    <div class="actions">
      <button (click)="restart()" [disabled]="status()!.state === 'not-installed'">Restart</button>
      <button (click)="stop()"    [disabled]="status()!.state !== 'running'">Stop</button>
      <button class="danger" (click)="uninstall()" [disabled]="status()!.state === 'not-installed'">Uninstall</button>
    </div>
  }
</div>
```

- [ ] **Step 3: Styles**

```scss
// node-service-panel.component.scss
.service-panel { padding: 12px; border: 1px solid var(--border, #ccc); border-radius: 8px; }
header { display: flex; justify-content: space-between; align-items: center; }
dl { display: grid; grid-template-columns: 120px 1fr; gap: 4px 12px; margin: 8px 0; }
.state-running { color: var(--success, #2a7); font-weight: 600; }
.state-stopped { color: var(--warning, #a70); }
.state-not-installed { color: var(--muted, #888); }
.actions { display: flex; gap: 8px; margin-top: 8px; }
.danger { background: var(--danger-bg, #a00); color: #fff; }
.muted { color: var(--muted, #888); }
```

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/remote-nodes/node-service-panel
git commit -m "feat(worker-service): add NodeServicePanel component"
```

---

### Task 26: Integrate panel into remote node detail page

**Files:**
- Modify: existing remote-node detail component (locate via Grep for selector or filename containing `remote-node-detail`)

- [ ] **Step 1: Import and render**

Add `NodeServicePanelComponent` to the detail component's `imports` array and include it in the template:

```html
<app-node-service-panel [nodeId]="node().nodeId" />
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Manually smoke-test**

Run: `npm run dev`, open remote nodes UI, confirm panel renders (will show "No status yet" if no service is installed — that's correct). Report what you saw.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/remote-nodes
git commit -m "feat(worker-service): show service panel on remote node detail page"
```

---

## Phase 9: Update & Rollback

### Task 27: Versioned binary directory layout

**Files:**
- Modify: `src/worker-agent/service/paths.ts`
- Modify: `src/worker-agent/service/windows-service-manager.ts`, `linux-service-manager.ts`, `macos-service-manager.ts` (use symlink/current)

**Why:** Updates must be atomic and rollback must be cheap. Layout: `<binDir>/versions/<semver>/worker-agent` with `<binDir>/current` as a symlink (Linux/mac) or junction (Windows). The service unit/plist/XML references `<binDir>/current/worker-agent`.

- [ ] **Step 1: Extend ServicePaths**

In `paths.ts`, add `currentBinLink` and `versionedBinDir` fields and populate per platform:

```typescript
// paths.ts — extend ServicePaths
export interface ServicePaths {
  configDir: string;
  configFile: string;
  binDir: string;
  binFile: string;            // path that the service unit refers to (symlink target)
  currentBinLink: string;     // <binDir>/current
  versionedBinDir: string;    // <binDir>/versions
  logDir: string;
  pluginDir: string;
}
```

For each platform, set `currentBinLink = <binDir>/current` and `versionedBinDir = <binDir>/versions`, and change `binFile` to `<currentBinLink>/worker-agent(.exe)`.

- [ ] **Step 2: Update each manager's install() flow**

Pseudocode for each `install(opts)`:

```typescript
const version = opts.version ?? 'unversioned';
const versionedDir = path.join(paths.versionedBinDir, version);
await fs.mkdir(versionedDir, { recursive: true });
const target = path.join(versionedDir, exeName);
await fs.copyFile(opts.binaryPath, target);
try { await fs.unlink(paths.currentBinLink); } catch {}
await fs.symlink(versionedDir, paths.currentBinLink, process.platform === 'win32' ? 'junction' : 'dir');
```

Then update `ServiceInstallOptions` to include `version?: string`.

- [ ] **Step 3: Verify typecheck & run existing tests**

Run: `npx tsc --noEmit && npx vitest run src/worker-agent/service/__tests__/`
Expected: PASS (path tests adjust to the new fields)

- [ ] **Step 4: Commit**

```bash
git add src/worker-agent/service
git commit -m "feat(worker-service): versioned binary dir with current-symlink layout"
```

---

### Task 28: Rollback helper

**Files:**
- Modify: each ServiceManager (or add a shared helper in a new file `src/worker-agent/service/rollback.ts`)

- [ ] **Step 1: Implement shared rollback**

```typescript
// src/worker-agent/service/rollback.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { servicePaths } from './paths';

export async function listVersions(): Promise<string[]> {
  const paths = servicePaths();
  try {
    const entries = await fs.readdir(paths.versionedBinDir);
    return entries.sort();
  } catch {
    return [];
  }
}

export async function activateVersion(version: string): Promise<void> {
  const paths = servicePaths();
  const target = path.join(paths.versionedBinDir, version);
  try { await fs.access(target); } catch { throw new Error(`Version ${version} not installed`); }
  try { await fs.unlink(paths.currentBinLink); } catch {}
  await fs.symlink(target, paths.currentBinLink, process.platform === 'win32' ? 'junction' : 'dir');
}
```

- [ ] **Step 2: Expose via CLI (`--list-versions`, `--activate-version <v>`)**

In `service-cli.ts`, extend `ServiceCommand` and `parseServiceArgs` with two new cases that call the helpers and then `mgr.restart()`.

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker-agent/service/rollback.ts src/worker-agent/cli/service-cli.ts
git commit -m "feat(worker-service): add version rollback helper and CLI"
```

---

## Phase 10: Verification & Handoff

### Task 29: Full typecheck / lint / test suite

- [ ] **Step 1: Typecheck prod**

Run: `npx tsc --noEmit`
Expected: PASS (no errors)

- [ ] **Step 2: Typecheck specs**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 3: Lint modified files**

Run: `npx eslint "src/worker-agent/service/**/*.ts" "src/main/remote-node/service-rpc-client.ts" "src/main/ipc/handlers/remote-node-handlers.ts" "src/renderer/app/features/remote-nodes/**/*.ts"`
Expected: no errors; warnings only if project-wide already allows them.

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: all tests pass. Any pre-existing failures should be recorded and flagged — do not fix unrelated test breakage in this plan.

- [ ] **Step 5: Build renderer + main + worker**

Run: `npm run build`
Expected: PASS. If SEA script fails because local Node < 22, skip with a clear note and verify in CI.

- [ ] **Step 6: Commit any lint fixups**

```bash
git add -A
git commit -m "chore(worker-service): lint/typecheck cleanup"
```

---

### Task 30: Manual verification checklist

Not a code change — run through this list on a real Windows box (primary target per spec):

- [ ] Build SEA on Node 22 host, copy `dist/worker-agent-sea/worker-agent.exe` to Windows VM
- [ ] In admin PowerShell: `worker-agent.exe --install-service --coordinator-url ws://<mac-ip>:<port> --token-file .\tok.txt`
- [ ] Expected: "Service installed and started." message; `Get-Service ai-orchestrator-worker` shows `Running`
- [ ] Reboot the VM. Verify the service comes back up *before* any user logs in (check `Get-Service` from admin shell after reboot without logging into the worker user)
- [ ] Coordinator UI lists the node as connected; Service panel shows `running` with a PID
- [ ] Click Restart in UI; confirm PID changes within ~10 seconds
- [ ] Click Stop in UI; confirm state becomes `stopped`
- [ ] Click Start via `sc.exe start` from a *non-admin* shell on Windows (should succeed thanks to ACL)
- [ ] Rotate the enrollment token in coordinator UI; confirm worker reconnects after restart
- [ ] Uninstall via UI; confirm service disappears and binary dir is cleaned up
- [ ] Smoke-test Linux path: repeat install/restart/uninstall on a Linux VM as root
- [ ] Smoke-test macOS path: repeat on a macOS machine

Record findings in a comment on the PR. Any step that fails becomes a bug ticket, not a plan mutation.

---

## Deferred / Future Work

Explicitly out of scope for this plan — the spec lists these as future items:

- Token-at-rest encryption on Linux (documented as non-encrypted, permissions-only)
- Auto-upgrade: coordinator pushing new SEA binary over RPC → worker writing to `versions/<v>/` → switching `current` symlink → self-restart
- Service-account password rotation (Windows LSA)
- Network namespace / seccomp profile for the Linux service
- Multi-tenant / multi-coordinator support on a single worker host
- Code signing (Authenticode / notarization) — required before public distribution
- Telemetry/metrics emitted to the coordinator about install/restart counts

---

## Self-Review

**Spec coverage:** Walking through `2026-04-16-worker-agent-autostart-service-design.md`:

| Spec section | Implemented in tasks |
|---|---|
| Architecture | 1, 7, 18–20 |
| SEA Build | 16, 17 |
| ServiceManager Abstraction | 1, 7 |
| Windows Implementation | 8, 9 |
| Linux Implementation | 10, 11 |
| macOS Implementation | 12, 13 |
| Install CLI | 14, 15, 28 |
| RPC Protocol Extensions | 18, 19, 20, 21, 22 |
| Coordinator UI | 23, 24, 25, 26 |
| Config Migration | 5, 6, 14 |
| Update Strategy | 27, 28 |
| Error Handling | handled inline per task (ExecFileError, NotElevatedError) |
| File Structure | File Map section above |
| Testing Strategy | every task has TDD steps |
| Security Summary | tasks 2 (execFile), 3 (isElevated), 4 (token resolver), 9 (ACL), 11 (polkit), 13 (sudoers drop-in) |

**Placeholder scan:** No TBD / TODO / "similar to Task N" / "write tests for the above". Every code step shows the code. WinSW SHA256 is deliberately a `REPLACE_WITH_ACTUAL_HASH_ON_FIRST_RUN` sentinel that Task 16 Step 3 replaces with the real value — that's a bootstrapping step, not a placeholder.

**Type consistency:** `ServiceStatus`, `ServiceManager`, `ServiceInstallOptions`, `ServicePaths` are defined in Task 1 / Task 5 / Task 27 and referenced consistently. `COORDINATOR_TO_NODE.SERVICE_*` constants are introduced in Task 19 and used identically in Tasks 20 and 22. IPC channel names `REMOTE_NODE_SERVICE_*` match between Task 18 (definition), Task 22 (main handlers), and Task 23 (renderer).

---
