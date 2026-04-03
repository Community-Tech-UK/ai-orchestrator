# Remote Worker Nodes — Phases 3, 4, 6, 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the remote worker nodes feature by building the worker agent package (Phase 3), browser automation offloading (Phase 4), security hardening (Phase 6), and Angular renderer UI (Phase 7).

**Architecture:** Phases 1, 2, 5 are already complete — the coordinator can track nodes via WebSocket, route instances to remote nodes via `RemoteCliAdapter`, and expose IPC/preload APIs. This plan adds: (3) the actual Node.js agent that runs on worker machines, (4) browser intent detection in message routing, (6) auth token + TLS + payload validation, and (7) Angular UI for managing nodes.

**Tech Stack:** TypeScript 5.9, Node.js (ws), esbuild, Angular 21 (zoneless/signals), Zod 4, Vitest

**Spec:** `docs/bigchange_remote-nodes.md` (phases 3, 4, 6, 7 sections)

---

## File Structure

### Phase 3: Worker Node Agent

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/worker-agent/worker-config.ts` | Load config from `~/.orchestrator/worker-node.json`, defaults, CLI args |
| Create | `src/worker-agent/capability-reporter.ts` | Detect local CLIs, browser, GPU, memory |
| Create | `src/worker-agent/local-instance-manager.ts` | Create/track/destroy local CLI adapter instances |
| Create | `src/worker-agent/worker-agent.ts` | WebSocket client, RPC dispatcher, heartbeat loop |
| Create | `src/worker-agent/index.ts` | Entry point with graceful shutdown |
| Create | `tsconfig.worker.json` | Separate tsconfig excluding Electron |
| Create | `build-worker-agent.ts` | esbuild bundle script |
| Modify | `package.json` | Add `build:worker-agent` script, esbuild devDep |
| Create | `src/worker-agent/__tests__/capability-reporter.spec.ts` | Unit tests |
| Create | `src/worker-agent/__tests__/local-instance-manager.spec.ts` | Unit tests |
| Create | `src/worker-agent/__tests__/worker-agent.spec.ts` | Unit tests |

### Phase 4: Browser Automation Offloading

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/channels/browser-intent.ts` | `detectBrowserIntent()` pure function |
| Modify | `src/main/channels/channel-message-router.ts` | Wire browser intent → `nodePlacement`, add `/nodes`, `/run-on` commands |
| Create | `src/main/channels/__tests__/browser-intent.spec.ts` | Unit tests |

### Phase 6: Security

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/remote-node/auth-validator.ts` | Token generation, validation, middleware |
| Modify | `src/main/remote-node/remote-node-config.ts` | Add TLS cert path fields |
| Modify | `src/main/remote-node/worker-node-connection.ts` | Add TLS support + auth validation hook |
| Modify | `src/main/remote-node/rpc-event-router.ts` | Add auth token check before dispatching |
| Create | `src/main/remote-node/rpc-schemas.ts` | Zod schemas for RPC payloads |
| Create | `src/worker-agent/path-sandbox.ts` | Path sandboxing for worker agent |
| Modify | `src/main/remote-node/index.ts` | Export new modules |
| Create | `src/main/remote-node/__tests__/auth-validator.spec.ts` | Unit tests |
| Create | `src/main/remote-node/__tests__/rpc-schemas.spec.ts` | Unit tests |

### Phase 7: Renderer UI

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts` | Typed IPC wrapper for remote node APIs |
| Create | `src/renderer/app/features/remote-nodes/remote-nodes.store.ts` | Signal-based state store for nodes |
| Create | `src/renderer/app/features/remote-nodes/node-card.component.ts` | Individual node status card |
| Create | `src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts` | Node management page |
| Modify | `src/renderer/app/features/instance-list/instance-row.component.ts` | Execution location badge |
| Modify | `src/renderer/app/app.routes.ts` | Add remote-nodes route |

---

## Phase 3: Worker Node Agent

### Task 1: Install esbuild + create tsconfig.worker.json

**Files:**
- Modify: `package.json`
- Create: `tsconfig.worker.json`

- [ ] **Step 1: Install esbuild as dev dependency**

```bash
cd /Users/suas/work/orchestrat0r/ai-orchestrator && npm install -D esbuild
```

- [ ] **Step 2: Create tsconfig.worker.json**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist/worker-agent",
    "rootDir": "src",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": false,
    "sourceMap": false
  },
  "include": [
    "src/worker-agent/**/*.ts",
    "src/main/cli/**/*.ts",
    "src/main/logging/**/*.ts",
    "src/main/security/env-filter.ts",
    "src/main/security/secret-detector.ts",
    "src/shared/types/**/*.ts"
  ],
  "exclude": [
    "src/main/cli/adapters/codex/app-server-broker.ts",
    "**/*.spec.ts",
    "**/__tests__/**"
  ]
}
```

- [ ] **Step 3: Verify tsconfig compiles**

```bash
npx tsc --noEmit -p tsconfig.worker.json
```

Expected: Errors because worker-agent source files don't exist yet — that's fine. No config-level errors.

- [ ] **Step 4: Commit**

```bash
git add tsconfig.worker.json package.json package-lock.json
git commit -m "chore: add esbuild and worker agent tsconfig"
```

---

### Task 2: Worker config loader

**Files:**
- Create: `src/worker-agent/worker-config.ts`

- [ ] **Step 1: Create worker-config.ts**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface WorkerConfig {
  nodeId: string;
  name: string;
  coordinatorUrl: string;
  authToken: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  reconnectIntervalMs: number;
  heartbeatIntervalMs: number;
}

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.orchestrator', 'worker-node.json');

const DEFAULTS: WorkerConfig = {
  nodeId: '',
  name: os.hostname(),
  coordinatorUrl: 'ws://localhost:4878',
  authToken: '',
  maxConcurrentInstances: 10,
  workingDirectories: [],
  reconnectIntervalMs: 5_000,
  heartbeatIntervalMs: 10_000,
};

/**
 * Load worker config from disk. Creates a default config file on first run.
 * CLI flags override file values: --coordinator, --name, --token.
 */
export function loadWorkerConfig(configPath = DEFAULT_CONFIG_PATH): WorkerConfig {
  let fileConfig: Partial<WorkerConfig> = {};

  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    fileConfig = JSON.parse(raw) as Partial<WorkerConfig>;
  }

  const merged: WorkerConfig = { ...DEFAULTS, ...fileConfig };

  // Generate stable nodeId on first run
  if (!merged.nodeId) {
    merged.nodeId = crypto.randomUUID();
  }

  // Apply CLI overrides
  const args = parseCliArgs(process.argv.slice(2));
  if (args['coordinator']) merged.coordinatorUrl = args['coordinator'];
  if (args['name']) merged.name = args['name'];
  if (args['token']) merged.authToken = args['token'];

  // Persist generated values back
  persistConfig(configPath, merged);

  return merged;
}

function parseCliArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      const key = arg.slice(2);
      result[key] = argv[++i];
    }
  }
  return result;
}

function persistConfig(configPath: string, config: WorkerConfig): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/worker-agent/worker-config.ts
git commit -m "feat(worker-agent): add config loader with CLI overrides"
```

---

### Task 3: Capability reporter

**Files:**
- Create: `src/worker-agent/capability-reporter.ts`
- Create: `src/worker-agent/__tests__/capability-reporter.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/worker-agent/__tests__/capability-reporter.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportCapabilities } from '../capability-reporter';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
}));

describe('capability-reporter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns valid capabilities with correct platform', async () => {
    const caps = await reportCapabilities([]);
    expect(caps.platform).toBe(process.platform);
    expect(caps.arch).toBe(process.arch);
    expect(caps.cpuCores).toBeGreaterThan(0);
    expect(caps.totalMemoryMB).toBeGreaterThan(0);
    expect(caps.availableMemoryMB).toBeGreaterThan(0);
    expect(caps.maxConcurrentInstances).toBe(10);
    expect(Array.isArray(caps.supportedClis)).toBe(true);
    expect(Array.isArray(caps.workingDirectories)).toBe(true);
  });

  it('includes provided working directories', async () => {
    const caps = await reportCapabilities(['/tmp/project']);
    expect(caps.workingDirectories).toContain('/tmp/project');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/worker-agent/__tests__/capability-reporter.spec.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/worker-agent/capability-reporter.ts
import * as os from 'os';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { WorkerNodeCapabilities, NodePlatform } from '../shared/types/worker-node.types';

/**
 * Detect local capabilities (CLIs, browser, GPU, memory) for reporting
 * to the coordinator. Called once on startup and periodically on heartbeat.
 */
export async function reportCapabilities(
  workingDirectories: string[],
  maxConcurrentInstances = 10,
): Promise<WorkerNodeCapabilities> {
  const supportedClis = detectClis();
  const gpu = detectGpu();

  return {
    platform: process.platform as NodePlatform,
    arch: process.arch,
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    availableMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
    gpuName: gpu.name,
    gpuMemoryMB: gpu.memoryMB,
    supportedClis,
    hasBrowserRuntime: detectBrowser(),
    hasBrowserMcp: false, // Detected at runtime when Chrome MCP connects
    hasDocker: detectDocker(),
    maxConcurrentInstances,
    workingDirectories,
  };
}

type CliType = 'claude' | 'codex' | 'gemini' | 'copilot' | 'ollama';

function detectClis(): CliType[] {
  const clis: Array<{ name: CliType; command: string }> = [
    { name: 'claude', command: 'claude' },
    { name: 'codex', command: 'codex' },
    { name: 'gemini', command: 'gemini' },
    { name: 'copilot', command: 'gh' },
    { name: 'ollama', command: 'ollama' },
  ];

  const found: CliType[] = [];
  for (const cli of clis) {
    if (isCommandAvailable(cli.command)) {
      found.push(cli.name);
    }
  }
  return found;
}

function isCommandAvailable(command: string): boolean {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, [command], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function detectBrowser(): boolean {
  const paths = process.platform === 'win32'
    ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
       'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : [];

  for (const p of paths) {
    try { fs.accessSync(p); return true; } catch { /* not found */ }
  }

  // Fallback: try which for Linux
  if (process.platform === 'linux') {
    return isCommandAvailable('google-chrome') || isCommandAvailable('chromium-browser');
  }
  return false;
}

function detectGpu(): { name?: string; memoryMB?: number } {
  if (process.platform === 'win32' || process.platform === 'linux') {
    try {
      const output = execFileSync(
        'nvidia-smi',
        ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { stdio: 'pipe', timeout: 5_000 },
      ).toString().trim();
      if (output) {
        const [name, memory] = output.split(',').map((s) => s.trim());
        return { name, memoryMB: parseInt(memory, 10) || undefined };
      }
    } catch { /* nvidia-smi not available */ }
  }
  return {};
}

function detectDocker(): boolean {
  return isCommandAvailable('docker');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/worker-agent/__tests__/capability-reporter.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/capability-reporter.ts src/worker-agent/__tests__/capability-reporter.spec.ts
git commit -m "feat(worker-agent): add capability reporter for CLI/GPU/browser detection"
```

---

### Task 4: Local instance manager

**Files:**
- Create: `src/worker-agent/local-instance-manager.ts`
- Create: `src/worker-agent/__tests__/local-instance-manager.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/worker-agent/__tests__/local-instance-manager.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalInstanceManager } from '../local-instance-manager';

describe('LocalInstanceManager', () => {
  let manager: LocalInstanceManager;

  beforeEach(() => {
    manager = new LocalInstanceManager(['/tmp/allowed']);
  });

  it('starts with zero instances', () => {
    expect(manager.getInstanceCount()).toBe(0);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  it('rejects spawn for invalid working directory', async () => {
    await expect(
      manager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/etc/not-allowed',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('not in allowed working directories');
  });

  it('rejects spawn beyond capacity', async () => {
    const smallManager = new LocalInstanceManager(['/tmp'], 0);
    await expect(
      smallManager.spawn({
        instanceId: 'test-1',
        cliType: 'claude',
        workingDirectory: '/tmp',
        systemPrompt: 'test',
      }),
    ).rejects.toThrow('at capacity');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/worker-agent/__tests__/local-instance-manager.spec.ts
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/worker-agent/local-instance-manager.ts
import { EventEmitter } from 'events';
import * as path from 'path';

export interface SpawnParams {
  instanceId: string;
  cliType: string;
  workingDirectory: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ManagedInstance {
  instanceId: string;
  cliType: string;
  workingDirectory: string;
  adapter: unknown; // CliAdapter — typed loosely to avoid Electron imports at compile time
  createdAt: number;
}

/**
 * Manages CLI adapter instances on the worker machine.
 * Enforces working directory sandboxing and capacity limits.
 */
export class LocalInstanceManager extends EventEmitter {
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly allowedDirs: string[];
  private readonly maxInstances: number;

  constructor(allowedDirs: string[], maxInstances = 10) {
    super();
    this.allowedDirs = allowedDirs.map((d) => path.resolve(d));
    this.maxInstances = maxInstances;
  }

  getInstanceCount(): number {
    return this.instances.size;
  }

  getAllInstanceIds(): string[] {
    return [...this.instances.keys()];
  }

  getInstance(instanceId: string): ManagedInstance | undefined {
    return this.instances.get(instanceId);
  }

  async spawn(params: SpawnParams): Promise<void> {
    // Enforce working directory sandboxing
    const resolved = path.resolve(params.workingDirectory);
    const isAllowed = this.allowedDirs.some(
      (allowed) => resolved === allowed || resolved.startsWith(allowed + path.sep),
    );
    if (!isAllowed) {
      throw new Error(
        `Working directory "${params.workingDirectory}" is not in allowed working directories: ${this.allowedDirs.join(', ')}`,
      );
    }

    // Enforce capacity limit
    if (this.instances.size >= this.maxInstances) {
      throw new Error(`Worker at capacity (${this.maxInstances} instances)`);
    }

    // Dynamic import to avoid pulling in Electron at module load time.
    // In the bundled worker agent, the adapter factory is tree-shaken to
    // only include the CLI adapters that are used.
    const { createCliAdapter } = await import('../main/cli/adapters/adapter-factory');
    const adapter = createCliAdapter(params.cliType as Parameters<typeof createCliAdapter>[0], {
      sessionId: params.instanceId,
      workingDirectory: params.workingDirectory,
      systemPrompt: params.systemPrompt,
      model: params.model,
      yoloMode: params.yoloMode ?? true,
      allowedTools: params.allowedTools,
      disallowedTools: params.disallowedTools,
    });

    // Wire adapter events to emit them on this manager
    const ad = adapter as EventEmitter;
    ad.on('output', (msg: unknown) => this.emit('instance:output', params.instanceId, msg));
    ad.on('exit', (info: unknown) => {
      this.instances.delete(params.instanceId);
      this.emit('instance:exit', params.instanceId, info);
    });
    ad.on('stateChange', (state: unknown) => this.emit('instance:stateChange', params.instanceId, state));

    // Spawn the process
    await (adapter as { spawn?: () => Promise<void> }).spawn?.();

    this.instances.set(params.instanceId, {
      instanceId: params.instanceId,
      cliType: params.cliType,
      workingDirectory: params.workingDirectory,
      adapter,
      createdAt: Date.now(),
    });
  }

  async sendInput(instanceId: string, message: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    const adapter = inst.adapter as { sendInput?: (msg: string) => Promise<void>; sendMessage?: (msg: string) => Promise<void> };
    await (adapter.sendInput ?? adapter.sendMessage)?.call(adapter, message);
  }

  async terminate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const adapter = inst.adapter as { terminate?: () => Promise<void> };
    await adapter.terminate?.();
    this.instances.delete(instanceId);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    const adapter = inst.adapter as { interrupt?: () => Promise<void> };
    await adapter.interrupt?.();
  }

  async terminateAll(): Promise<void> {
    const ids = [...this.instances.keys()];
    await Promise.allSettled(ids.map((id) => this.terminate(id)));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/worker-agent/__tests__/local-instance-manager.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/local-instance-manager.ts src/worker-agent/__tests__/local-instance-manager.spec.ts
git commit -m "feat(worker-agent): add local instance manager with dir sandboxing"
```

---

### Task 5: Worker agent class (WebSocket client + RPC)

**Files:**
- Create: `src/worker-agent/worker-agent.ts`
- Create: `src/worker-agent/__tests__/worker-agent.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/worker-agent/__tests__/worker-agent.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerAgent } from '../worker-agent';
import type { WorkerConfig } from '../worker-config';

// Mock WebSocket
vi.mock('ws', () => {
  const EventEmitter = require('events').EventEmitter;
  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn((_data: string, cb?: (err?: Error) => void) => cb?.());
    close = vi.fn();
  }
  return { WebSocket: MockWebSocket, default: { WebSocket: MockWebSocket } };
});

// Mock capability-reporter
vi.mock('../capability-reporter', () => ({
  reportCapabilities: vi.fn(async () => ({
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 96000,
    availableMemoryMB: 64000,
    supportedClis: ['claude', 'codex'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasDocker: true,
    maxConcurrentInstances: 10,
    workingDirectories: [],
  })),
}));

const mockConfig: WorkerConfig = {
  nodeId: 'test-node-1',
  name: 'test-pc',
  coordinatorUrl: 'ws://localhost:4878',
  authToken: 'test-token',
  maxConcurrentInstances: 10,
  workingDirectories: ['/tmp/work'],
  reconnectIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
};

describe('WorkerAgent', () => {
  let agent: WorkerAgent;

  beforeEach(() => {
    vi.useFakeTimers();
    agent = new WorkerAgent(mockConfig);
  });

  afterEach(async () => {
    await agent.disconnect();
    vi.useRealTimers();
  });

  it('creates without error', () => {
    expect(agent).toBeDefined();
  });

  it('builds registration message with correct fields', () => {
    const msg = (agent as unknown as { buildRegistrationMessage: () => unknown }).buildRegistrationMessage();
    expect(msg).toMatchObject({
      jsonrpc: '2.0',
      method: 'node.register',
      params: {
        nodeId: 'test-node-1',
        name: 'test-pc',
        token: 'test-token',
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/worker-agent/__tests__/worker-agent.spec.ts
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/worker-agent/worker-agent.ts
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { reportCapabilities } from './capability-reporter';
import { LocalInstanceManager, type SpawnParams } from './local-instance-manager';
import type { WorkerConfig } from './worker-config';
import type { WorkerNodeCapabilities } from '../shared/types/worker-node.types';

interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Worker node agent — connects to coordinator, handles RPC commands,
 * manages local CLI instances, sends heartbeats.
 */
export class WorkerAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly instanceManager: LocalInstanceManager;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private capabilities: WorkerNodeCapabilities | null = null;
  private isShuttingDown = false;

  constructor(private readonly config: WorkerConfig) {
    super();
    this.instanceManager = new LocalInstanceManager(
      config.workingDirectories,
      config.maxConcurrentInstances,
    );
    this.wireInstanceEvents();
  }

  async connect(): Promise<void> {
    this.isShuttingDown = false;
    this.capabilities = await reportCapabilities(
      this.config.workingDirectories,
      this.config.maxConcurrentInstances,
    );

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.config.coordinatorUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.sendRegistration();
        this.startHeartbeat();
        resolve();
      });

      ws.on('message', (data: Buffer | string) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        this.ws = null;
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        if (!this.ws) {
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    await this.instanceManager.terminateAll();
    if (this.ws) {
      this.ws.close(1000, 'Worker shutting down');
      this.ws = null;
    }
  }

  // -- Registration & heartbeat -----------------------------------------------

  /** Exposed for testing. */
  buildRegistrationMessage(): RpcMessage {
    return {
      jsonrpc: '2.0',
      id: `reg-${Date.now()}`,
      method: 'node.register',
      params: {
        nodeId: this.config.nodeId,
        name: this.config.name,
        capabilities: this.capabilities,
        token: this.config.authToken,
      },
    };
  }

  private sendRegistration(): void {
    this.send(this.buildRegistrationMessage());
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      // Refresh capabilities (memory changes over time)
      this.capabilities = await reportCapabilities(
        this.config.workingDirectories,
        this.config.maxConcurrentInstances,
      );
      this.send({
        jsonrpc: '2.0',
        method: 'node.heartbeat',
        params: {
          nodeId: this.config.nodeId,
          capabilities: this.capabilities,
          activeInstances: this.instanceManager.getInstanceCount(),
          token: this.config.authToken,
        },
      });
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    console.log(`Connection lost. Reconnecting in ${this.config.reconnectIntervalMs}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        console.log('Reconnected to coordinator');
      } catch {
        // connect() failed — close handler will schedule next retry
      }
    }, this.config.reconnectIntervalMs);
  }

  // -- Message handling -------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw) as RpcMessage;
    } catch {
      console.error('Invalid JSON from coordinator:', raw.slice(0, 200));
      return;
    }

    // Response to one of our requests
    if (msg.result !== undefined || msg.error !== undefined) {
      return; // Responses are informational for now
    }

    // RPC request from coordinator
    if (msg.method && msg.id !== undefined) {
      this.handleRpcRequest(msg);
    }
  }

  private async handleRpcRequest(msg: RpcMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (msg.method) {
        case 'instance.spawn':
          await this.instanceManager.spawn(params as unknown as SpawnParams);
          result = { instanceId: params['instanceId'] };
          break;
        case 'instance.sendInput':
          await this.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
          );
          result = { ok: true };
          break;
        case 'instance.terminate':
          await this.instanceManager.terminate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case 'instance.interrupt':
          await this.instanceManager.interrupt(params['instanceId'] as string);
          result = { ok: true };
          break;
        case 'node.ping':
          result = { pong: Date.now() };
          break;
        default:
          this.sendError(msg.id!, -32601, `Unknown method: ${msg.method}`);
          return;
      }
      this.sendResult(msg.id!, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendError(msg.id!, -32603, message);
    }
  }

  // -- Instance event forwarding ----------------------------------------------

  private wireInstanceEvents(): void {
    this.instanceManager.on('instance:output', (instanceId: string, message: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.output',
        params: { instanceId, message, token: this.config.authToken },
      });
    });

    this.instanceManager.on('instance:stateChange', (instanceId: string, state: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.stateChange',
        params: { instanceId, state, token: this.config.authToken },
      });
    });

    this.instanceManager.on('instance:exit', (instanceId: string, info: unknown) => {
      this.send({
        jsonrpc: '2.0',
        id: `exit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        method: 'instance.stateChange',
        params: { instanceId, state: 'exited', info, token: this.config.authToken },
      });
    });
  }

  // -- Transport helpers ------------------------------------------------------

  private send(msg: RpcMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg), (err) => {
        if (err) console.error('Send error:', err.message);
      });
    }
  }

  private sendResult(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result } as RpcMessage);
  }

  private sendError(id: string | number, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } } as RpcMessage);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/worker-agent/__tests__/worker-agent.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/worker-agent.ts src/worker-agent/__tests__/worker-agent.spec.ts
git commit -m "feat(worker-agent): add main agent class with WebSocket RPC"
```

---

### Task 6: Entry point + build script

**Files:**
- Create: `src/worker-agent/index.ts`
- Create: `build-worker-agent.ts`
- Modify: `package.json` (add script)

- [ ] **Step 1: Create entry point**

```typescript
// src/worker-agent/index.ts
import { WorkerAgent } from './worker-agent';
import { loadWorkerConfig } from './worker-config';

async function main(): Promise<void> {
  const config = loadWorkerConfig();

  console.log(`Worker node "${config.name}" (${config.nodeId})`);
  console.log(`Connecting to coordinator at ${config.coordinatorUrl}...`);

  const agent = new WorkerAgent(config);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received — shutting down...`);
    await agent.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await agent.connect();
    console.log(`Connected! Listening for work.`);
  } catch (err) {
    console.error('Failed to connect:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Create build script**

```typescript
// build-worker-agent.ts
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/worker-agent/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/worker-agent/index.js',
  format: 'cjs',
  external: ['electron', 'better-sqlite3'],
  tsconfig: 'tsconfig.worker.json',
  banner: {
    js: '#!/usr/bin/env node',
  },
  logLevel: 'info',
});

console.log('Worker agent built -> dist/worker-agent/index.js');
```

- [ ] **Step 3: Add build script to package.json**

In `package.json` scripts, add:

```json
"build:worker-agent": "tsx build-worker-agent.ts"
```

- [ ] **Step 4: Verify build works**

```bash
npm run build:worker-agent
```

Expected: Produces `dist/worker-agent/index.js`. Check it exists and has the shebang:

```bash
head -1 dist/worker-agent/index.js
```

Expected: `#!/usr/bin/env node`

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/index.ts build-worker-agent.ts package.json
git commit -m "feat(worker-agent): add entry point and esbuild bundle script"
```

---

## Phase 4: Browser Automation Offloading

### Task 7: Browser intent detection

**Files:**
- Create: `src/main/channels/browser-intent.ts`
- Create: `src/main/channels/__tests__/browser-intent.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/main/channels/__tests__/browser-intent.spec.ts
import { describe, it, expect } from 'vitest';
import { detectBrowserIntent } from '../browser-intent';

describe('detectBrowserIntent', () => {
  it('returns true for browser-related keywords', () => {
    expect(detectBrowserIntent('open the browser and test')).toBe(true);
    expect(detectBrowserIntent('take a screenshot of the page')).toBe(true);
    expect(detectBrowserIntent('navigate to https://example.com')).toBe(true);
    expect(detectBrowserIntent('run the playwright e2e test')).toBe(true);
    expect(detectBrowserIntent('scrape the website data')).toBe(true);
    expect(detectBrowserIntent('click the submit button')).toBe(true);
  });

  it('returns false for non-browser content', () => {
    expect(detectBrowserIntent('fix the TypeScript compilation error')).toBe(false);
    expect(detectBrowserIntent('refactor the database module')).toBe(false);
    expect(detectBrowserIntent('write unit tests for the parser')).toBe(false);
    expect(detectBrowserIntent('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectBrowserIntent('OPEN CHROME and test')).toBe(true);
    expect(detectBrowserIntent('Run Selenium Tests')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/main/channels/__tests__/browser-intent.spec.ts
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/main/channels/browser-intent.ts

const BROWSER_KEYWORDS = [
  'browse',
  'browser',
  'website',
  'web page',
  'webpage',
  'click',
  'screenshot',
  'navigate',
  'test in browser',
  'open url',
  'selenium',
  'playwright',
  'e2e test',
  'end-to-end',
  'chrome',
  'scrape',
  'crawl',
  'puppeteer',
  'cypress',
];

/**
 * Heuristic: does this message content imply browser automation work?
 * Used by the channel message router to set `nodePlacement.requiresBrowser`.
 */
export function detectBrowserIntent(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return BROWSER_KEYWORDS.some((kw) => lower.includes(kw));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/main/channels/__tests__/browser-intent.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/channels/browser-intent.ts src/main/channels/__tests__/browser-intent.spec.ts
git commit -m "feat(channels): add browser intent detection heuristic"
```

---

### Task 8: Wire browser intent into channel router + add /nodes and /run-on commands

**Files:**
- Modify: `src/main/channels/channel-message-router.ts`

- [ ] **Step 1: Add import at top of file**

Add after the existing imports:

```typescript
import { detectBrowserIntent } from './browser-intent';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { getWorkerNodeRegistry } from '../remote-node';
```

- [ ] **Step 2: Modify `routeDefault()` to pass `nodePlacement`**

Replace the `createInstance` call in `routeDefault()` (lines 1124-1129) with:

```typescript
    // Detect browser intent for auto-offloading
    const remoteConfig = getRemoteNodeConfig();
    const needsBrowser = remoteConfig.autoOffloadBrowser && detectBrowserIntent(content);

    const instance = await im.createInstance({
      displayName: `${msg.platform}:${msg.senderName}`,
      workingDirectory,
      initialPrompt: content || undefined,
      yoloMode: true,
      ...(needsBrowser ? { nodePlacement: { requiresBrowser: true } } : {}),
    });
```

- [ ] **Step 3: Add new command cases in the command switch**

In the command `switch` block (around line 874), add before the `default` case:

```typescript
        case 'nodes':
          await this.handleNodesCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'run-on':
          await this.handleRunOnCommand(msg, intent.commandArgs || '', adapter);
          return;
```

- [ ] **Step 4: Add handler methods**

Add these methods to the class (before the `routeDefault` method):

```typescript
  private async handleNodesCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const registry = getWorkerNodeRegistry();
    const nodes = registry.getAllNodes();

    if (args.trim()) {
      // /nodes <name> - show details for a specific node
      const node = nodes.find((n) => n.name === args.trim() || n.id === args.trim());
      if (!node) {
        await adapter.sendMessage(msg.chatId, `Node "${args.trim()}" not found.`, { replyTo: msg.messageId });
        return;
      }
      const detail = [
        `**${node.name}** (${node.id})`,
        `Status: ${node.status}`,
        `Platform: ${node.capabilities.platform} / ${node.capabilities.arch}`,
        `CPU: ${node.capabilities.cpuCores} cores`,
        `Memory: ${node.capabilities.availableMemoryMB}/${node.capabilities.totalMemoryMB} MB`,
        node.capabilities.gpuName ? `GPU: ${node.capabilities.gpuName} (${node.capabilities.gpuMemoryMB} MB)` : null,
        `CLIs: ${node.capabilities.supportedClis.join(', ') || 'none'}`,
        `Browser: ${node.capabilities.hasBrowserRuntime ? 'yes' : 'no'}`,
        `Active instances: ${node.activeInstances}`,
        node.latencyMs !== undefined ? `Latency: ${node.latencyMs}ms` : null,
      ].filter(Boolean).join('\n');
      await adapter.sendMessage(msg.chatId, detail, { replyTo: msg.messageId });
      return;
    }

    // /nodes - list all
    if (nodes.length === 0) {
      await adapter.sendMessage(msg.chatId, 'No worker nodes connected.', { replyTo: msg.messageId });
      return;
    }

    const lines = nodes.map(
      (n) => `- **${n.name}** - ${n.status} | ${n.activeInstances} instances | ${n.capabilities.platform}`,
    );
    await adapter.sendMessage(msg.chatId, `**Worker Nodes (${nodes.length}):**\n${lines.join('\n')}`, { replyTo: msg.messageId });
  }

  private async handleRunOnCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    // /run-on <node> <message>
    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1 || !args.trim()) {
      await adapter.sendMessage(msg.chatId, 'Usage: /run-on <node-name> <message>', { replyTo: msg.messageId });
      return;
    }

    const nodeName = args.slice(0, spaceIdx).trim();
    const content = args.slice(spaceIdx + 1).trim();

    const registry = getWorkerNodeRegistry();
    const node = registry.getAllNodes().find((n) => n.name === nodeName || n.id === nodeName);
    if (!node) {
      await adapter.sendMessage(msg.chatId, `Node "${nodeName}" not found.`, { replyTo: msg.messageId });
      return;
    }

    const im = this.getInstanceManager();
    const workingDirectory = process.cwd();
    const instance = await im.createInstance({
      displayName: `${msg.platform}:${msg.senderName}`,
      workingDirectory,
      initialPrompt: content,
      yoloMode: true,
      forceNodeId: node.id,
    });

    this.streamResults(msg, instance.id, adapter);
    await adapter.sendMessage(msg.chatId, `Running on **${node.name}**...`, { replyTo: msg.messageId });
  }
```

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/channels/channel-message-router.ts
git commit -m "feat(channels): wire browser intent + add /nodes and /run-on commands"
```

---

## Phase 6: Security

### Task 9: Auth token generation and validation

**Files:**
- Create: `src/main/remote-node/auth-validator.ts`
- Create: `src/main/remote-node/__tests__/auth-validator.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/main/remote-node/__tests__/auth-validator.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { generateAuthToken, validateAuthToken, AUTH_TOKEN_LENGTH } from '../auth-validator';
import { resetRemoteNodeConfig, updateRemoteNodeConfig } from '../remote-node-config';

describe('auth-validator', () => {
  beforeEach(() => {
    resetRemoteNodeConfig();
  });

  describe('generateAuthToken', () => {
    it('generates a token of correct length', () => {
      const token = generateAuthToken();
      expect(token.length).toBe(AUTH_TOKEN_LENGTH);
    });

    it('generates unique tokens', () => {
      const a = generateAuthToken();
      const b = generateAuthToken();
      expect(a).not.toBe(b);
    });
  });

  describe('validateAuthToken', () => {
    it('returns true when token matches config', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('my-secret-token')).toBe(true);
    });

    it('returns false when token does not match', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('wrong-token')).toBe(false);
    });

    it('returns false when no token configured', () => {
      expect(validateAuthToken('any-token')).toBe(false);
    });

    it('returns false for empty token', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken('')).toBe(false);
    });

    it('returns false for undefined/null', () => {
      updateRemoteNodeConfig({ authToken: 'my-secret-token' });
      expect(validateAuthToken(undefined)).toBe(false);
      expect(validateAuthToken(null as unknown as string)).toBe(false);
    });

    it('uses timing-safe comparison', () => {
      updateRemoteNodeConfig({ authToken: 'secret' });
      expect(validateAuthToken('secret')).toBe(true);
      expect(validateAuthToken('secre')).toBe(false); // different length
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/main/remote-node/__tests__/auth-validator.spec.ts
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/main/remote-node/auth-validator.ts
import * as crypto from 'crypto';
import { getRemoteNodeConfig } from './remote-node-config';

/** Auth tokens are 64-character hex strings (32 bytes of entropy). */
export const AUTH_TOKEN_LENGTH = 64;

/**
 * Generate a cryptographically secure auth token.
 * Call this once when the user enables remote nodes for the first time.
 */
export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Validate an incoming token against the configured auth token.
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns false if no authToken is configured (security-by-default).
 */
export function validateAuthToken(token: string | undefined | null): boolean {
  const expected = getRemoteNodeConfig().authToken;
  if (!expected || !token) return false;

  // Timing-safe comparison requires equal-length buffers
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const tokenBuf = Buffer.from(token, 'utf-8');

  if (expectedBuf.length !== tokenBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

/**
 * Ensure the config has an auth token. Generates one if missing.
 * Returns the (possibly newly generated) token.
 */
export function ensureAuthToken(): string {
  const config = getRemoteNodeConfig();
  if (config.authToken) return config.authToken;

  const token = generateAuthToken();
  const { updateRemoteNodeConfig } = require('./remote-node-config') as typeof import('./remote-node-config');
  updateRemoteNodeConfig({ authToken: token });
  return token;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/main/remote-node/__tests__/auth-validator.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/auth-validator.ts src/main/remote-node/__tests__/auth-validator.spec.ts
git commit -m "feat(remote-node): add timing-safe auth token validation"
```

---

### Task 10: RPC payload validation with Zod schemas

**Files:**
- Create: `src/main/remote-node/rpc-schemas.ts`
- Create: `src/main/remote-node/__tests__/rpc-schemas.spec.ts`

- [ ] **Step 1: Write test**

```typescript
// src/main/remote-node/__tests__/rpc-schemas.spec.ts
import { describe, it, expect } from 'vitest';
import {
  NodeRegisterParamsSchema,
  NodeHeartbeatParamsSchema,
  validateRpcParams,
} from '../rpc-schemas';

describe('rpc-schemas', () => {
  describe('NodeRegisterParamsSchema', () => {
    it('accepts valid registration', () => {
      const result = NodeRegisterParamsSchema.safeParse({
        nodeId: 'abc-123',
        name: 'windows-pc',
        capabilities: {
          platform: 'win32',
          arch: 'x64',
          cpuCores: 16,
          totalMemoryMB: 96000,
          availableMemoryMB: 64000,
          supportedClis: ['claude'],
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 10,
          workingDirectories: ['/tmp'],
        },
        token: 'secret-token',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing nodeId', () => {
      const result = NodeRegisterParamsSchema.safeParse({ name: 'test' });
      expect(result.success).toBe(false);
    });
  });

  describe('validateRpcParams', () => {
    it('returns validated data on success', () => {
      const result = validateRpcParams(NodeHeartbeatParamsSchema, {
        nodeId: 'abc',
        capabilities: {
          platform: 'darwin',
          arch: 'arm64',
          cpuCores: 10,
          totalMemoryMB: 36000,
          availableMemoryMB: 20000,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 5,
          workingDirectories: [],
        },
        activeInstances: 3,
      });
      expect(result.nodeId).toBe('abc');
      expect(result.activeInstances).toBe(3);
    });

    it('throws on invalid data', () => {
      expect(() => validateRpcParams(NodeHeartbeatParamsSchema, {})).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/main/remote-node/__tests__/rpc-schemas.spec.ts
```

Expected: FAIL

- [ ] **Step 3: Write implementation**

```typescript
// src/main/remote-node/rpc-schemas.ts
import { z } from 'zod/v4';

// -- Shared sub-schemas -------------------------------------------------------

const WorkerNodeCapabilitiesSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.string(),
  cpuCores: z.number().int().positive(),
  totalMemoryMB: z.number().int().positive(),
  availableMemoryMB: z.number().int().nonnegative(),
  gpuName: z.string().optional(),
  gpuMemoryMB: z.number().int().optional(),
  supportedClis: z.array(z.string()),
  hasBrowserRuntime: z.boolean(),
  hasBrowserMcp: z.boolean(),
  hasDocker: z.boolean(),
  maxConcurrentInstances: z.number().int().positive(),
  workingDirectories: z.array(z.string()),
});

// -- Node -> Coordinator schemas -----------------------------------------------

export const NodeRegisterParamsSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string().min(1),
  capabilities: WorkerNodeCapabilitiesSchema,
  token: z.string().optional(),
});

export const NodeHeartbeatParamsSchema = z.object({
  nodeId: z.string().min(1),
  capabilities: WorkerNodeCapabilitiesSchema,
  activeInstances: z.number().int().nonnegative(),
  token: z.string().optional(),
});

export const InstanceOutputParamsSchema = z.object({
  instanceId: z.string().min(1),
  message: z.unknown(),
  token: z.string().optional(),
});

export const InstanceStateChangeParamsSchema = z.object({
  instanceId: z.string().min(1),
  state: z.string().min(1),
  info: z.unknown().optional(),
  token: z.string().optional(),
});

export const InstancePermissionRequestParamsSchema = z.object({
  instanceId: z.string().min(1),
  permission: z.unknown(),
  token: z.string().optional(),
});

// -- Coordinator -> Node schemas -----------------------------------------------

export const InstanceSpawnParamsSchema = z.object({
  instanceId: z.string().min(1),
  cliType: z.string().min(1),
  workingDirectory: z.string().min(1),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  yoloMode: z.boolean().optional(),
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
});

export const InstanceSendInputParamsSchema = z.object({
  instanceId: z.string().min(1),
  message: z.string().min(1),
});

export const InstanceIdParamsSchema = z.object({
  instanceId: z.string().min(1),
});

// -- Schema map for method-based lookup ---------------------------------------

export const RPC_PARAM_SCHEMAS: Record<string, z.ZodType> = {
  'node.register': NodeRegisterParamsSchema,
  'node.heartbeat': NodeHeartbeatParamsSchema,
  'instance.output': InstanceOutputParamsSchema,
  'instance.stateChange': InstanceStateChangeParamsSchema,
  'instance.permissionRequest': InstancePermissionRequestParamsSchema,
  'instance.spawn': InstanceSpawnParamsSchema,
  'instance.sendInput': InstanceSendInputParamsSchema,
  'instance.terminate': InstanceIdParamsSchema,
  'instance.interrupt': InstanceIdParamsSchema,
  'instance.hibernate': InstanceIdParamsSchema,
  'instance.wake': InstanceIdParamsSchema,
};

/**
 * Validate RPC params against a Zod schema. Throws with a descriptive
 * error message if validation fails.
 */
export function validateRpcParams<T>(schema: z.ZodType<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new Error(`RPC validation failed: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/main/remote-node/__tests__/rpc-schemas.spec.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/rpc-schemas.ts src/main/remote-node/__tests__/rpc-schemas.spec.ts
git commit -m "feat(remote-node): add Zod schemas for RPC payload validation"
```

---

### Task 11: Add auth validation to connection server + RPC router

**Files:**
- Modify: `src/main/remote-node/worker-node-connection.ts`
- Modify: `src/main/remote-node/rpc-event-router.ts`
- Modify: `src/main/remote-node/remote-node-config.ts`
- Modify: `src/main/remote-node/index.ts`

- [ ] **Step 1: Add TLS cert fields to config**

In `src/main/remote-node/remote-node-config.ts`, extend the `RemoteNodeConfig` interface by adding these fields after `maxRemoteInstances`:

```typescript
  /** Path to TLS certificate file (PEM). If set with tlsKeyPath, enables WSS. */
  tlsCertPath?: string;
  /** Path to TLS private key file (PEM). */
  tlsKeyPath?: string;
  /** Path to CA certificate for client cert verification (mutual TLS). */
  tlsCaPath?: string;
```

- [ ] **Step 2: Add TLS + auth imports to connection server**

In `src/main/remote-node/worker-node-connection.ts`, add these imports at the top:

```typescript
import * as https from 'https';
import * as fs from 'fs';
import { getRemoteNodeConfig } from './remote-node-config';
import { validateAuthToken } from './auth-validator';
```

- [ ] **Step 3: Replace the `start()` method to support TLS**

Replace the `start()` method body (lines 56-84) with this version that creates an HTTPS server when TLS certs are configured:

```typescript
  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.wss) {
      logger.warn('WorkerNodeConnectionServer already running');
      return;
    }

    const config = getRemoteNodeConfig();
    const useTls = config.tlsCertPath && config.tlsKeyPath;

    await new Promise<void>((resolve, reject) => {
      let wss: WebSocketServer;

      if (useTls) {
        const server = https.createServer({
          cert: fs.readFileSync(config.tlsCertPath!),
          key: fs.readFileSync(config.tlsKeyPath!),
          ...(config.tlsCaPath ? { ca: fs.readFileSync(config.tlsCaPath), requestCert: true, rejectUnauthorized: true } : {}),
        });

        wss = new WebSocketServer({ server });

        server.on('error', (err) => {
          if (!this.wss) reject(err);
          else logger.error('HTTPS server error', err);
        });

        server.listen(port, host, () => {
          this.wss = wss;
          logger.info('WorkerNodeConnectionServer listening (WSS/TLS)', { host, port });
          resolve();
        });
      } else {
        wss = new WebSocketServer({ host, port });

        wss.on('error', (err) => {
          if (!this.wss) reject(err);
          else logger.error('WebSocket server error', err);
        });

        wss.on('listening', () => {
          this.wss = wss;
          logger.info('WorkerNodeConnectionServer listening', { host, port });
          resolve();
        });
      }

      wss.on('connection', (ws) => {
        this.handleConnection(ws);
      });
    });
  }
```

- [ ] **Step 4: Add auth token validation to `handleRegistration()`**

In `handleRegistration()`, add this block after the `newNodeId` check and before the "Replace any existing socket" section (after line ~277):

```typescript
    // Validate auth token
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
      const errorResponse = createRpcError(
        msg.id,
        RPC_ERROR_CODES.UNAUTHORIZED,
        'Invalid or missing auth token',
      );
      ws.send(JSON.stringify(errorResponse));
      ws.close(4001, 'Unauthorized');
      logger.warn('Node registration rejected: invalid auth token', { nodeId: newNodeId });
      return;
    }
```

- [ ] **Step 5: Add auth + schema validation to RPC event router**

In `src/main/remote-node/rpc-event-router.ts`, add these imports:

```typescript
import { validateAuthToken } from './auth-validator';
import { validateRpcParams, RPC_PARAM_SCHEMAS } from './rpc-schemas';
```

Replace the `handleRpcRequest()` method with this version that validates auth and schemas before dispatch:

```typescript
  private handleRpcRequest(nodeId: string, request: RpcRequest): void {
    // Auth: validate token on every request
    const params = request.params as Record<string, unknown> | undefined;
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
      this.connection.sendResponse(
        nodeId,
        createRpcError(request.id, RPC_ERROR_CODES.UNAUTHORIZED, 'Invalid auth token'),
      );
      return;
    }

    // Validate payload schema if one is defined for this method
    const schema = RPC_PARAM_SCHEMAS[request.method];
    if (schema) {
      try {
        validateRpcParams(schema, request.params);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Validation failed';
        this.connection.sendResponse(
          nodeId,
          createRpcError(request.id, RPC_ERROR_CODES.INVALID_PARAMS, message),
        );
        return;
      }
    }

    switch (request.method) {
      case NODE_TO_COORDINATOR.REGISTER:
        this.handleNodeRegister(nodeId, request);
        break;
      case NODE_TO_COORDINATOR.HEARTBEAT:
        this.handleNodeHeartbeat(nodeId, request);
        break;
      case NODE_TO_COORDINATOR.INSTANCE_OUTPUT:
        this.handleInstanceOutput(nodeId, request);
        break;
      case NODE_TO_COORDINATOR.INSTANCE_STATE_CHANGE:
        this.handleInstanceStateChange(nodeId, request);
        break;
      case NODE_TO_COORDINATOR.INSTANCE_PERMISSION_REQUEST:
        this.handleInstancePermissionRequest(nodeId, request);
        break;
      default:
        logger.warn('Unknown RPC method received', { nodeId, method: request.method });
    }
  }
```

Replace the `handleRpcNotification()` method with token validation:

```typescript
  private handleRpcNotification(nodeId: string, notification: RpcNotification): void {
    // Auth: validate token on notifications too
    const params = notification.params as Record<string, unknown> | undefined;
    const token = typeof params?.['token'] === 'string' ? params['token'] : undefined;
    if (!validateAuthToken(token)) {
      logger.warn('Notification rejected: invalid auth token', { nodeId, method: notification.method });
      return;
    }

    switch (notification.method) {
      case NODE_TO_COORDINATOR.HEARTBEAT: {
        const hbParams = notification.params as Record<string, unknown> | undefined;
        this.registry.updateHeartbeat(nodeId, hbParams?.['capabilities'] as WorkerNodeCapabilities);
        break;
      }
      default:
        logger.warn('Unknown RPC notification method received', { nodeId, method: notification.method });
    }
  }
```

- [ ] **Step 6: Update barrel exports**

In `src/main/remote-node/index.ts`, add these export lines:

```typescript
export { generateAuthToken, validateAuthToken, ensureAuthToken } from './auth-validator';
export { validateRpcParams, RPC_PARAM_SCHEMAS } from './rpc-schemas';
```

- [ ] **Step 7: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/remote-node/worker-node-connection.ts src/main/remote-node/rpc-event-router.ts src/main/remote-node/remote-node-config.ts src/main/remote-node/index.ts
git commit -m "feat(remote-node): add TLS support, auth validation, and RPC schema enforcement"
```

---

### Task 12: Path sandboxing for worker agent

**Files:**
- Create: `src/worker-agent/path-sandbox.ts`

- [ ] **Step 1: Create path-sandbox.ts**

```typescript
// src/worker-agent/path-sandbox.ts
import * as path from 'path';

/**
 * Validate that a requested path is within one of the allowed roots.
 * Prevents path traversal attacks from the coordinator.
 */
export function isPathAllowed(
  requestedPath: string,
  allowedRoots: string[],
): boolean {
  const resolved = path.resolve(requestedPath);

  // Block null bytes (path traversal technique)
  if (resolved.includes('\0')) return false;

  return allowedRoots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}
```

Note: This is already enforced by `LocalInstanceManager.spawn()` (Task 4), but this module provides a reusable utility. The `LocalInstanceManager` already calls an equivalent check.

- [ ] **Step 2: Commit**

```bash
git add src/worker-agent/path-sandbox.ts
git commit -m "feat(worker-agent): add path sandbox utility"
```

---

## Phase 7: Renderer UI

### Task 13: Remote node IPC service

**Files:**
- Create: `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`

- [ ] **Step 1: Create the service**

```typescript
// src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

export interface RemoteNodeServerConfig {
  port?: number;
  host?: string;
}

export interface RemoteNodeEvent {
  type: 'connected' | 'disconnected' | 'degraded' | 'metrics';
  nodeId: string;
  node?: WorkerNodeInfo;
}

@Injectable({ providedIn: 'root' })
export class RemoteNodeIpcService {
  private readonly base = inject(ElectronIpcService);
  private get api() { return this.base.getApi(); }

  async listNodes(): Promise<WorkerNodeInfo[]> {
    if (!this.api) return [];
    const result = await this.api.remoteNodeList();
    return (result ?? []) as WorkerNodeInfo[];
  }

  async getNode(nodeId: string): Promise<WorkerNodeInfo | null> {
    if (!this.api) return null;
    const result = await this.api.remoteNodeGet(nodeId);
    return (result ?? null) as WorkerNodeInfo | null;
  }

  async startServer(config?: RemoteNodeServerConfig): Promise<void> {
    if (!this.api) return;
    await this.api.remoteNodeStartServer(config);
  }

  async stopServer(): Promise<void> {
    if (!this.api) return;
    await this.api.remoteNodeStopServer();
  }

  onNodeEvent(callback: (event: RemoteNodeEvent) => void): () => void {
    if (!this.api) return () => {};
    return this.api.onRemoteNodeEvent(callback as (event: unknown) => void);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
git commit -m "feat(renderer): add remote node IPC service"
```

---

### Task 14: Remote nodes signal store

**Files:**
- Create: `src/renderer/app/features/remote-nodes/remote-nodes.store.ts`

- [ ] **Step 1: Create the store**

```typescript
// src/renderer/app/features/remote-nodes/remote-nodes.store.ts
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { RemoteNodeIpcService, type RemoteNodeEvent } from '../../core/services/ipc/remote-node-ipc.service';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

@Injectable({ providedIn: 'root' })
export class RemoteNodesStore implements OnDestroy {
  private readonly ipc = inject(RemoteNodeIpcService);
  private unsubscribe?: () => void;

  /** All known worker nodes. */
  readonly nodes = signal<WorkerNodeInfo[]>([]);

  /** Loading state. */
  readonly loading = signal(false);

  /** Connected nodes only. */
  readonly connectedNodes = computed(() =>
    this.nodes().filter((n) => n.status === 'connected'),
  );

  /** Total active instances across all nodes. */
  readonly totalActiveInstances = computed(() =>
    this.nodes().reduce((sum, n) => sum + n.activeInstances, 0),
  );

  constructor() {
    this.unsubscribe = this.ipc.onNodeEvent((event: RemoteNodeEvent) => {
      this.handleEvent(event);
    });
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const nodes = await this.ipc.listNodes();
      this.nodes.set(nodes);
    } finally {
      this.loading.set(false);
    }
  }

  private handleEvent(event: RemoteNodeEvent): void {
    const current = this.nodes();
    switch (event.type) {
      case 'connected':
        if (event.node) {
          this.nodes.set([
            ...current.filter((n) => n.id !== event.nodeId),
            event.node,
          ]);
        }
        break;
      case 'disconnected':
        this.nodes.set(
          current.map((n) =>
            n.id === event.nodeId ? { ...n, status: 'disconnected' as const } : n,
          ),
        );
        break;
      case 'degraded':
        this.nodes.set(
          current.map((n) =>
            n.id === event.nodeId ? { ...n, status: 'degraded' as const } : n,
          ),
        );
        break;
      case 'metrics':
        if (event.node) {
          this.nodes.set(
            current.map((n) => (n.id === event.nodeId ? event.node! : n)),
          );
        }
        break;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/app/features/remote-nodes/remote-nodes.store.ts
git commit -m "feat(renderer): add remote nodes signal store"
```

---

### Task 15: Node card component

**Files:**
- Create: `src/renderer/app/features/remote-nodes/node-card.component.ts`

- [ ] **Step 1: Create node-card component**

```typescript
// src/renderer/app/features/remote-nodes/node-card.component.ts
import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

@Component({
  selector: 'app-node-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="node-card" [class]="'status-' + node().status">
      <div class="node-header">
        <span class="status-dot" [class]="'dot-' + node().status"></span>
        <span class="node-name">{{ node().name }}</span>
        <span class="node-platform">{{ platformLabel() }}</span>
      </div>

      <div class="node-metrics">
        <div class="metric">
          <span class="metric-label">CPU</span>
          <span class="metric-value">{{ node().capabilities.cpuCores }} cores</span>
        </div>
        <div class="metric">
          <span class="metric-label">Memory</span>
          <span class="metric-value">{{ memoryLabel() }}</span>
        </div>
        @if (node().capabilities.gpuName) {
          <div class="metric">
            <span class="metric-label">GPU</span>
            <span class="metric-value">{{ node().capabilities.gpuName }}</span>
          </div>
        }
        <div class="metric">
          <span class="metric-label">Instances</span>
          <span class="metric-value">{{ node().activeInstances }} / {{ node().capabilities.maxConcurrentInstances }}</span>
        </div>
        @if (node().latencyMs !== undefined) {
          <div class="metric">
            <span class="metric-label">Latency</span>
            <span class="metric-value">{{ node().latencyMs }}ms</span>
          </div>
        }
      </div>

      <div class="node-capabilities">
        @for (cli of node().capabilities.supportedClis; track cli) {
          <span class="cap-badge">{{ cli }}</span>
        }
        @if (node().capabilities.hasBrowserRuntime) {
          <span class="cap-badge browser">browser</span>
        }
        @if (node().capabilities.hasDocker) {
          <span class="cap-badge docker">docker</span>
        }
      </div>
    </div>
  `,
  styles: [`
    .node-card {
      padding: 16px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      transition: all var(--transition-fast);
    }

    .node-card:hover {
      background: rgba(255, 255, 255, 0.05);
      border-color: rgba(255, 255, 255, 0.1);
    }

    .node-card.status-disconnected {
      opacity: 0.5;
    }

    .node-card.status-degraded {
      border-color: rgba(var(--warning-rgb), 0.3);
    }

    .node-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .dot-connected { background: var(--color-success); }
    .dot-connecting { background: var(--color-info); animation: pulse 1.5s infinite; }
    .dot-degraded { background: var(--color-warning); }
    .dot-disconnected { background: var(--color-muted); }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .node-name {
      font-weight: 600;
      font-size: 14px;
      color: var(--color-text-primary);
    }

    .node-platform {
      margin-left: auto;
      font-size: 11px;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .node-metrics {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
    }

    .metric {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .metric-label {
      font-size: 10px;
      color: var(--color-text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .metric-value {
      font-size: 13px;
      color: var(--color-text-primary);
    }

    .node-capabilities {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .cap-badge {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--color-text-secondary);
    }

    .cap-badge.browser {
      background: rgba(var(--info-rgb), 0.15);
      color: var(--color-info);
    }

    .cap-badge.docker {
      background: rgba(var(--primary-rgb), 0.15);
      color: var(--color-primary);
    }
  `],
})
export class NodeCardComponent {
  readonly node = input.required<WorkerNodeInfo>();

  readonly platformLabel = computed(() => {
    const p = this.node().capabilities.platform;
    return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : 'Linux';
  });

  readonly memoryLabel = computed(() => {
    const c = this.node().capabilities;
    const used = c.totalMemoryMB - c.availableMemoryMB;
    return `${Math.round(used / 1024)}/${Math.round(c.totalMemoryMB / 1024)} GB`;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/app/features/remote-nodes/node-card.component.ts
git commit -m "feat(renderer): add node card component"
```

---

### Task 16: Remote nodes page component + route

**Files:**
- Create: `src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts`
- Modify: `src/renderer/app/app.routes.ts`

- [ ] **Step 1: Create page component**

```typescript
// src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts
import { Component, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { NodeCardComponent } from './node-card.component';
import { RemoteNodesStore } from './remote-nodes.store';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';

@Component({
  selector: 'app-remote-nodes-page',
  standalone: true,
  imports: [NodeCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page-container">
      <div class="page-header">
        <h2>Worker Nodes</h2>
        <div class="header-actions">
          <span class="node-count">
            {{ store.connectedNodes().length }} connected
          </span>
          <button class="btn btn-secondary" (click)="refresh()">
            Refresh
          </button>
          <button
            class="btn btn-primary"
            (click)="toggleServer()"
          >
            {{ serverRunning ? 'Stop Server' : 'Start Server' }}
          </button>
        </div>
      </div>

      @if (store.loading()) {
        <div class="loading-state">Loading nodes...</div>
      } @else if (store.nodes().length === 0) {
        <div class="empty-state">
          <p>No worker nodes connected.</p>
          <p class="hint">Start the worker agent on a remote machine to connect it here.</p>
        </div>
      } @else {
        <div class="nodes-grid">
          @for (node of store.nodes(); track node.id) {
            <app-node-card [node]="node" />
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .page-container {
      padding: 24px;
      max-width: 1200px;
    }

    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
    }

    .page-header h2 {
      font-size: 20px;
      font-weight: 600;
      color: var(--color-text-primary);
      margin: 0;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .node-count {
      font-size: 13px;
      color: var(--color-text-secondary);
    }

    .btn {
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      border: none;
      transition: all var(--transition-fast);
    }

    .btn-primary {
      background: var(--color-primary);
      color: white;
    }

    .btn-primary:hover {
      filter: brightness(1.1);
    }

    .btn-secondary {
      background: rgba(255, 255, 255, 0.06);
      color: var(--color-text-primary);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .btn-secondary:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .nodes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
    }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--color-text-secondary);
    }

    .empty-state .hint {
      font-size: 13px;
      margin-top: 8px;
      opacity: 0.7;
    }

    .loading-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--color-text-secondary);
    }
  `],
})
export class RemoteNodesPageComponent implements OnInit {
  readonly store = inject(RemoteNodesStore);
  private readonly ipc = inject(RemoteNodeIpcService);
  serverRunning = false;

  ngOnInit(): void {
    this.store.refresh();
  }

  refresh(): void {
    this.store.refresh();
  }

  async toggleServer(): Promise<void> {
    if (this.serverRunning) {
      await this.ipc.stopServer();
      this.serverRunning = false;
    } else {
      await this.ipc.startServer();
      this.serverRunning = true;
    }
  }
}
```

- [ ] **Step 2: Add route to app.routes.ts**

In `src/renderer/app/app.routes.ts`, add a new route entry before the catch-all `**` redirect:

```typescript
  {
    path: 'remote-nodes',
    loadComponent: () =>
      import('./features/remote-nodes/remote-nodes-page.component').then(
        (m) => m.RemoteNodesPageComponent,
      ),
  },
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/remote-nodes/remote-nodes-page.component.ts src/renderer/app/app.routes.ts
git commit -m "feat(renderer): add remote nodes page with grid layout and route"
```

---

### Task 17: Execution location badge in instance row

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-row.component.ts`

- [ ] **Step 1: Add remote node badge to template**

After the `instance-name-row` div closing tag (the `</div>` after the collapsed-badge), add:

```html
        @if (isRemote()) {
          <span class="remote-badge" [title]="'Running on node: ' + remoteNodeId()">
            {{ remoteNodeId() | slice:0:8 }}
          </span>
        }
```

- [ ] **Step 2: Add computed signals to the component class**

In the component class, add these computed properties:

```typescript
  readonly isRemote = computed(() =>
    this.instance().executionLocation?.type === 'remote',
  );

  readonly remoteNodeId = computed(() => {
    const loc = this.instance().executionLocation;
    return loc?.type === 'remote' ? loc.nodeId : '';
  });
```

- [ ] **Step 3: Add CSS for the badge**

In the styles section, add:

```css
    .remote-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 10px;
      background: rgba(var(--info-rgb), 0.12);
      color: var(--color-info);
      white-space: nowrap;
      margin-left: 4px;
    }
```

- [ ] **Step 4: Add SlicePipe import**

In the imports array of the component decorator, add `SlicePipe`:

```typescript
import { SlicePipe } from '@angular/common';

@Component({
  // ...
  imports: [SlicePipe],
  // ...
})
```

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/instance-list/instance-row.component.ts
git commit -m "feat(renderer): add execution location badge to instance row"
```

---

## Final Verification

### Task 18: Full verification pass

- [ ] **Step 1: TypeScript compilation (source)**

```bash
npx tsc --noEmit
```

Expected: PASS with 0 errors

- [ ] **Step 2: TypeScript compilation (specs)**

```bash
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: PASS with 0 errors

- [ ] **Step 3: ESLint**

```bash
npm run lint
```

Expected: PASS (or only pre-existing warnings)

- [ ] **Step 4: Run all new tests**

```bash
npx vitest run src/worker-agent/__tests__/ src/main/channels/__tests__/browser-intent.spec.ts src/main/remote-node/__tests__/auth-validator.spec.ts src/main/remote-node/__tests__/rpc-schemas.spec.ts
```

Expected: All PASS

- [ ] **Step 5: Run full test suite**

```bash
npm run test
```

Expected: No regressions

- [ ] **Step 6: Verify worker agent build**

```bash
npm run build:worker-agent
```

Expected: Produces `dist/worker-agent/index.js`
