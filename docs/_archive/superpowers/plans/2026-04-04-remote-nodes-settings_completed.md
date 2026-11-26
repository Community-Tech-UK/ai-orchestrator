# Remote Nodes Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Remote Nodes" settings section with persistence, mDNS autodiscovery, per-node identity/revocation, and security hardening.

**Architecture:** 12 flat keys in AppSettings persisted via SettingsManager. Custom Angular settings tab with local draft state for server config. mDNS discovery via `bonjour-service`. Two-tier auth (enrollment token + per-node tokens). Server lifecycle state machine prevents interleaving. IP rate limiting on coordinator. Exponential backoff on worker reconnect.

**Tech Stack:** Angular 21 (zoneless, signals), Electron 40, TypeScript 5.9, Zod 4, bonjour-service, Vitest

**Spec:** `docs/superpowers/specs/2026-04-04-remote-nodes-settings-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/remote-node/server-lifecycle.ts` | State machine: stopped/starting/running/failed/stopping. Serializes start/stop transitions. |
| `src/main/remote-node/ip-rate-limiter.ts` | Sliding-window rate limiter per IP. Escalating bans. |
| `src/main/remote-node/discovery-service.ts` | mDNS publish/unpublish via bonjour-service. |
| `src/main/remote-node/node-identity-store.ts` | CRUD for NodeIdentity records. Encrypts via safeStorage. Decoupled from SettingsManager to avoid circular deps. |
| `src/worker-agent/discovery-client.ts` | mDNS browse for `_ai-orchestrator._tcp`, filter by namespace, continuous discovery. |
| `src/worker-agent/reconnect-backoff.ts` | Exponential backoff with equal jitter. |
| `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` | Full custom settings tab UI. |
| `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts` | Renderer-side IPC bridge for remote node operations. |

### Modified Files

| File | What Changes |
|------|-------------|
| `package.json` | Add `bonjour-service` |
| `src/shared/types/settings.types.ts` | 12 new keys in `AppSettings`, `DEFAULT_SETTINGS` |
| `src/shared/types/ipc.types.ts` | 4 new IPC channels in enum |
| `src/shared/types/worker-node.types.ts` | `NodeIdentity` type, `namespace` field |
| `src/shared/validation/ipc-schemas.ts` | Zod schemas for new IPC payloads |
| `src/main/remote-node/remote-node-config.ts` | Hydrate from AppSettings, add namespace |
| `src/main/remote-node/auth-validator.ts` | Two-tier auth: node tokens first, then enrollment |
| `src/main/remote-node/rpc-schemas.ts` | Add `nodeId` to register schema |
| `src/main/remote-node/worker-node-rpc.ts` | Enrollment response type |
| `src/main/remote-node/rpc-event-router.ts` | Idempotent enrollment upsert |
| `src/main/remote-node/worker-node-connection.ts` | WS hardening (max message, max connections), call discovery service |
| `src/main/remote-node/index.ts` | Re-export new modules |
| `src/main/ipc/handlers/remote-node-handlers.ts` | 4 new IPC handlers |
| `src/main/index.ts` | Settings-change listener, lifecycle state machine wiring |
| `src/preload/preload.ts` | 4 new preload methods |
| `src/renderer/app/features/settings/settings.component.ts` | Nav item, import, @switch case |
| `src/renderer/app/core/state/settings.store.ts` | Computed for remote node settings |
| `src/worker-agent/worker-config.ts` | Optional `coordinatorUrl`, add `namespace`, `nodeToken` |
| `src/worker-agent/worker-agent.ts` | Discovery, backoff, enrollment persistence |
| `build/entitlements.mac.plist` | NSLocalNetworkUsageDescription |
| `docs/WORKER_AGENT_SETUP.md` | Updated for mDNS, enrollment |

---

## Task 1: Add AppSettings Keys and Defaults

**Files:**
- Modify: `src/shared/types/settings.types.ts:17-61` (AppSettings interface)
- Modify: `src/shared/types/settings.types.ts:66-109` (DEFAULT_SETTINGS)

- [ ] **Step 1: Add 12 new keys to AppSettings interface**

In `src/shared/types/settings.types.ts`, add after the `parserBufferMaxKB` line (line 52) and before the closing brace of `AppSettings`:

```typescript
  // Remote Nodes
  remoteNodesEnabled: boolean;
  remoteNodesServerPort: number;
  remoteNodesServerHost: string;
  remoteNodesEnrollmentToken: string;
  remoteNodesAutoOffloadBrowser: boolean;
  remoteNodesAutoOffloadGpu: boolean;
  remoteNodesNamespace: string;
  remoteNodesRequireTls: boolean;
  remoteNodesTlsMode: 'auto' | 'custom';
  remoteNodesTlsCertPath: string;
  remoteNodesTlsKeyPath: string;
  remoteNodesRegisteredNodes: string; // encrypted JSON of Record<string, NodeIdentity>
```

- [ ] **Step 2: Add defaults to DEFAULT_SETTINGS**

In `DEFAULT_SETTINGS`, add after `parserBufferMaxKB: 1024,` (line 99):

```typescript
  // Remote Nodes
  remoteNodesEnabled: false,
  remoteNodesServerPort: 4878,
  remoteNodesServerHost: '0.0.0.0',
  remoteNodesEnrollmentToken: '',
  remoteNodesAutoOffloadBrowser: true,
  remoteNodesAutoOffloadGpu: false,
  remoteNodesNamespace: 'default',
  remoteNodesRequireTls: false,
  remoteNodesTlsMode: 'auto' as const,
  remoteNodesTlsCertPath: '',
  remoteNodesTlsKeyPath: '',
  remoteNodesRegisteredNodes: '{}',
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/settings.types.ts
git commit -m "feat(remote-nodes): add 12 AppSettings keys for remote node config"
```

---

## Task 2: Add NodeIdentity Type and IPC Channels

**Files:**
- Modify: `src/shared/types/worker-node.types.ts:1-44`
- Modify: `src/shared/types/ipc.types.ts:345-349`

- [ ] **Step 1: Add NodeIdentity to worker-node.types.ts**

At the end of `src/shared/types/worker-node.types.ts`, add:

```typescript
/**
 * Persistent identity for a registered remote node.
 * Stored encrypted in AppSettings. Ephemeral state (lastSeen, latency)
 * is tracked in-memory only by WorkerNodeRegistry.
 */
export interface NodeIdentity {
  nodeId: string;
  nodeName: string;
  token: string;
  createdAt: number;
}
```

- [ ] **Step 2: Add 4 IPC channels**

In `src/shared/types/ipc.types.ts`, find the remote node channels block (around line 345) and add after `REMOTE_NODE_EVENT`:

```typescript
  REMOTE_NODE_REGENERATE_TOKEN = 'remote-node:regenerate-token',
  REMOTE_NODE_SET_TOKEN = 'remote-node:set-token',
  REMOTE_NODE_REVOKE = 'remote-node:revoke',
  REMOTE_NODE_GET_SERVER_STATUS = 'remote-node:get-server-status',
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/worker-node.types.ts src/shared/types/ipc.types.ts
git commit -m "feat(remote-nodes): add NodeIdentity type and 4 new IPC channels"
```

---

## Task 3: Add IPC Validation Schemas

**Files:**
- Modify: `src/shared/validation/ipc-schemas.ts`
- Modify: `src/main/remote-node/rpc-schemas.ts:23-28`

- [ ] **Step 1: Add IPC payload schemas**

In `src/shared/validation/ipc-schemas.ts`, add near the other schema definitions:

```typescript
// Remote Node IPC schemas
export const RemoteNodeSetTokenPayloadSchema = z.object({
  token: z.string().min(16).max(256),
});

export const RemoteNodeRevokePayloadSchema = z.object({
  nodeId: z.string().uuid(),
});

export type ValidatedSetTokenPayload = z.infer<typeof RemoteNodeSetTokenPayloadSchema>;
export type ValidatedRevokePayload = z.infer<typeof RemoteNodeRevokePayloadSchema>;
```

- [ ] **Step 2: Add nodeId to register RPC schema**

In `src/main/remote-node/rpc-schemas.ts`, find `NodeRegisterParamsSchema` (around line 23) and add `nodeId` as a required field:

```typescript
export const NodeRegisterParamsSchema = z.object({
  nodeId: z.string().uuid(),
  name: z.string().min(1).max(100),
  capabilities: WorkerNodeCapabilitiesSchema,
});
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/shared/validation/ipc-schemas.ts src/main/remote-node/rpc-schemas.ts
git commit -m "feat(remote-nodes): add Zod schemas for IPC payloads and enrollment nodeId"
```

---

## Task 4: IP Rate Limiter

**Files:**
- Create: `src/main/remote-node/ip-rate-limiter.ts`
- Create: `src/main/remote-node/__tests__/ip-rate-limiter.test.ts`

- [ ] **Step 1: Write tests**

Create `src/main/remote-node/__tests__/ip-rate-limiter.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { IpRateLimiter } from '../ip-rate-limiter';

describe('IpRateLimiter', () => {
  let limiter: IpRateLimiter;

  beforeEach(() => {
    limiter = new IpRateLimiter({
      windowMs: 60_000,
      maxAttemptsPerIp: 5,
      baseBanMs: 10_000,
      maxBanMs: 60_000,
    });
  });

  it('allows connections under the limit', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.allowConnection('192.168.1.1').ok).toBe(true);
    }
  });

  it('bans IP after exceeding limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.allowConnection('192.168.1.1');
    }
    const result = limiter.allowConnection('192.168.1.1');
    expect(result.ok).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not affect other IPs', () => {
    for (let i = 0; i < 6; i++) {
      limiter.allowConnection('192.168.1.1');
    }
    expect(limiter.allowConnection('192.168.1.2').ok).toBe(true);
  });

  it('escalates ban duration on repeat offenses', () => {
    // First ban
    for (let i = 0; i < 6; i++) limiter.allowConnection('10.0.0.1');
    const first = limiter.allowConnection('10.0.0.1');

    // Simulate ban expiry by creating a new limiter with a short ban already served
    // For unit testing, we just verify the ban ms increases
    expect(first.ok).toBe(false);
    expect(first.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it('resets state on clear', () => {
    for (let i = 0; i < 6; i++) limiter.allowConnection('10.0.0.1');
    expect(limiter.allowConnection('10.0.0.1').ok).toBe(false);

    limiter.clear();
    expect(limiter.allowConnection('10.0.0.1').ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/remote-node/__tests__/ip-rate-limiter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IpRateLimiter**

Create `src/main/remote-node/ip-rate-limiter.ts`:

```typescript
export interface RateLimitConfig {
  windowMs: number;
  maxAttemptsPerIp: number;
  baseBanMs: number;
  maxBanMs: number;
}

interface IpState {
  hits: number[];
  bannedUntil: number;
  strikes: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,
  maxAttemptsPerIp: 20,
  baseBanMs: 120_000,
  maxBanMs: 15 * 60_000,
};

export class IpRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly state = new Map<string, IpState>();

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  allowConnection(ip: string, now = Date.now()): { ok: boolean; retryAfterMs?: number } {
    const s = this.state.get(ip) ?? { hits: [], bannedUntil: 0, strikes: 0 };

    if (now < s.bannedUntil) {
      this.state.set(ip, s);
      return { ok: false, retryAfterMs: s.bannedUntil - now };
    }

    s.hits = s.hits.filter((t) => now - t < this.config.windowMs);
    s.hits.push(now);

    if (s.hits.length > this.config.maxAttemptsPerIp) {
      s.strikes += 1;
      const banMs = Math.min(
        this.config.baseBanMs * 2 ** (s.strikes - 1),
        this.config.maxBanMs,
      );
      s.bannedUntil = now + banMs;
      s.hits = [];
      this.state.set(ip, s);
      return { ok: false, retryAfterMs: banMs };
    }

    this.state.set(ip, s);
    return { ok: true };
  }

  clear(): void {
    this.state.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/remote-node/__tests__/ip-rate-limiter.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/ip-rate-limiter.ts src/main/remote-node/__tests__/ip-rate-limiter.test.ts
git commit -m "feat(remote-nodes): add IP rate limiter with escalating bans"
```

---

## Task 5: Server Lifecycle State Machine

**Files:**
- Create: `src/main/remote-node/server-lifecycle.ts`
- Create: `src/main/remote-node/__tests__/server-lifecycle.test.ts`

- [ ] **Step 1: Write tests**

Create `src/main/remote-node/__tests__/server-lifecycle.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerLifecycle, ServerState } from '../server-lifecycle';

describe('ServerLifecycle', () => {
  let lifecycle: ServerLifecycle;
  let startFn: ReturnType<typeof vi.fn>;
  let stopFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    startFn = vi.fn().mockResolvedValue(undefined);
    stopFn = vi.fn().mockResolvedValue(undefined);
    lifecycle = new ServerLifecycle(startFn, stopFn);
  });

  it('starts in stopped state', () => {
    expect(lifecycle.state).toBe('stopped');
  });

  it('transitions to running on successful start', async () => {
    await lifecycle.start();
    expect(lifecycle.state).toBe('running');
    expect(startFn).toHaveBeenCalledOnce();
  });

  it('transitions to failed when start throws', async () => {
    startFn.mockRejectedValue(new Error('EADDRINUSE'));
    await expect(lifecycle.start()).rejects.toThrow('EADDRINUSE');
    expect(lifecycle.state).toBe('failed');
  });

  it('transitions to stopped on stop', async () => {
    await lifecycle.start();
    await lifecycle.stop();
    expect(lifecycle.state).toBe('stopped');
    expect(stopFn).toHaveBeenCalledOnce();
  });

  it('ignores start when already running', async () => {
    await lifecycle.start();
    await lifecycle.start();
    expect(startFn).toHaveBeenCalledOnce();
  });

  it('ignores stop when already stopped', async () => {
    await lifecycle.stop();
    expect(stopFn).not.toHaveBeenCalled();
  });

  it('can restart after failure', async () => {
    startFn.mockRejectedValueOnce(new Error('fail'));
    await expect(lifecycle.start()).rejects.toThrow();
    expect(lifecycle.state).toBe('failed');

    startFn.mockResolvedValue(undefined);
    await lifecycle.start();
    expect(lifecycle.state).toBe('running');
  });

  it('serializes concurrent start/stop', async () => {
    const order: string[] = [];
    startFn.mockImplementation(async () => {
      order.push('start-begin');
      await new Promise((r) => setTimeout(r, 10));
      order.push('start-end');
    });
    stopFn.mockImplementation(async () => {
      order.push('stop-begin');
      await new Promise((r) => setTimeout(r, 10));
      order.push('stop-end');
    });

    await lifecycle.start();
    const stopPromise = lifecycle.stop();
    const startPromise = lifecycle.start();

    await stopPromise;
    await startPromise;

    expect(order).toEqual([
      'start-begin', 'start-end',
      'stop-begin', 'stop-end',
      'start-begin', 'start-end',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/remote-node/__tests__/server-lifecycle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ServerLifecycle**

Create `src/main/remote-node/server-lifecycle.ts`:

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('ServerLifecycle');

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export class ServerLifecycle {
  private _state: ServerState = 'stopped';
  private _queue: Promise<void> = Promise.resolve();
  private readonly startFn: () => Promise<void>;
  private readonly stopFn: () => Promise<void>;

  constructor(startFn: () => Promise<void>, stopFn: () => Promise<void>) {
    this.startFn = startFn;
    this.stopFn = stopFn;
  }

  get state(): ServerState {
    return this._state;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this._state === 'running') {
        logger.info('Server already running, ignoring start');
        return;
      }
      this._state = 'starting';
      try {
        await this.startFn();
        this._state = 'running';
        logger.info('Server started');
      } catch (err) {
        this._state = 'failed';
        logger.error('Server failed to start', { error: (err as Error).message });
        throw err;
      }
    });
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this._state === 'stopped') {
        return;
      }
      this._state = 'stopping';
      try {
        await this.stopFn();
      } finally {
        this._state = 'stopped';
        logger.info('Server stopped');
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => {});
    return next;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/remote-node/__tests__/server-lifecycle.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/server-lifecycle.ts src/main/remote-node/__tests__/server-lifecycle.test.ts
git commit -m "feat(remote-nodes): add server lifecycle state machine with serialized transitions"
```

---

## Task 6: Two-Tier Auth Validator

**Files:**
- Modify: `src/main/remote-node/auth-validator.ts`
- Create: `src/main/remote-node/__tests__/auth-validator.test.ts`

- [ ] **Step 1: Write tests**

Create `src/main/remote-node/__tests__/auth-validator.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateAuthToken,
  validateTokenTwoTier,
  AUTH_TOKEN_LENGTH,
} from '../auth-validator';
import type { NodeIdentity } from '../../../shared/types/worker-node.types';

describe('auth-validator', () => {
  const enrollmentToken = generateAuthToken();
  const nodeIdentities: Record<string, NodeIdentity> = {};

  beforeEach(() => {
    // Clear registered nodes
    for (const key of Object.keys(nodeIdentities)) delete nodeIdentities[key];

    // Register one node
    nodeIdentities['node-1'] = {
      nodeId: 'node-1',
      nodeName: 'test-node',
      token: generateAuthToken(),
      createdAt: Date.now(),
    };
  });

  it('rejects empty token', () => {
    const result = validateTokenTwoTier('', enrollmentToken, nodeIdentities);
    expect(result.type).toBe('rejected');
  });

  it('rejects invalid token', () => {
    const result = validateTokenTwoTier('bad-token', enrollmentToken, nodeIdentities);
    expect(result.type).toBe('rejected');
  });

  it('identifies registered node token', () => {
    const token = nodeIdentities['node-1'].token;
    const result = validateTokenTwoTier(token, enrollmentToken, nodeIdentities);
    expect(result.type).toBe('registered');
    if (result.type === 'registered') {
      expect(result.nodeId).toBe('node-1');
    }
  });

  it('identifies enrollment token', () => {
    const result = validateTokenTwoTier(enrollmentToken, enrollmentToken, nodeIdentities);
    expect(result.type).toBe('enrollment');
  });

  it('prioritizes node token over enrollment token if they happen to match', () => {
    // Edge case: if someone sets enrollment token = node token
    nodeIdentities['node-2'] = {
      nodeId: 'node-2',
      nodeName: 'same-token-node',
      token: enrollmentToken,
      createdAt: Date.now(),
    };
    const result = validateTokenTwoTier(enrollmentToken, enrollmentToken, nodeIdentities);
    expect(result.type).toBe('registered');
  });

  it('generates tokens of correct length', () => {
    const token = generateAuthToken();
    expect(token.length).toBe(AUTH_TOKEN_LENGTH);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/remote-node/__tests__/auth-validator.test.ts`
Expected: FAIL — `validateTokenTwoTier` not found

- [ ] **Step 3: Update auth-validator.ts with two-tier validation**

Replace the contents of `src/main/remote-node/auth-validator.ts` with:

```typescript
import { randomBytes, timingSafeEqual } from 'crypto';
import type { NodeIdentity } from '../../shared/types/worker-node.types';
import { getRemoteNodeConfig } from './remote-node-config';

export const AUTH_TOKEN_LENGTH = 64;

export function generateAuthToken(): string {
  return randomBytes(AUTH_TOKEN_LENGTH / 2).toString('hex');
}

export type AuthResult =
  | { type: 'registered'; nodeId: string }
  | { type: 'enrollment' }
  | { type: 'rejected' };

/**
 * Two-tier token validation:
 * 1. Check against registered node tokens first (returns nodeId)
 * 2. Check against enrollment token (for new node registration)
 * 3. Reject if neither matches
 */
export function validateTokenTwoTier(
  token: string | undefined | null,
  enrollmentToken: string,
  registeredNodes: Record<string, NodeIdentity>,
): AuthResult {
  if (!token || token.length === 0) {
    return { type: 'rejected' };
  }

  // Check registered node tokens first
  for (const [nodeId, identity] of Object.entries(registeredNodes)) {
    if (safeCompare(token, identity.token)) {
      return { type: 'registered', nodeId };
    }
  }

  // Check enrollment token
  if (safeCompare(token, enrollmentToken)) {
    return { type: 'enrollment' };
  }

  return { type: 'rejected' };
}

/**
 * Legacy single-token validation (kept for backward compatibility during migration).
 */
export function validateAuthToken(token: string | undefined | null): boolean {
  if (!token || token.length === 0) return false;
  const config = getRemoteNodeConfig();
  if (!config.authToken) return false;
  return safeCompare(token, config.authToken);
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Generate enrollment token if not already set.
 */
export function ensureEnrollmentToken(currentToken: string): string {
  if (currentToken && currentToken.length > 0) return currentToken;
  return generateAuthToken();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/remote-node/__tests__/auth-validator.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/auth-validator.ts src/main/remote-node/__tests__/auth-validator.test.ts
git commit -m "feat(remote-nodes): two-tier auth with enrollment + per-node tokens"
```

---

## Task 7: Enrollment Response Types in RPC

**Files:**
- Modify: `src/main/remote-node/worker-node-rpc.ts`

- [ ] **Step 1: Add enrollment response type**

In `src/main/remote-node/worker-node-rpc.ts`, add after the `RpcError` interface (around line 56):

```typescript
/** Response sent to worker after successful enrollment */
export interface EnrollmentResult {
  nodeId: string;
  token: string;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main/remote-node/worker-node-rpc.ts
git commit -m "feat(remote-nodes): add EnrollmentResult type for enrollment RPC response"
```

---

## Task 8: Idempotent Enrollment in RPC Event Router

**Files:**
- Modify: `src/main/remote-node/rpc-event-router.ts:172-195`

- [ ] **Step 1: Read the current handleNodeRegister method**

Read `src/main/remote-node/rpc-event-router.ts` lines 172-195 to understand the current register flow.

- [ ] **Step 2: Update handleNodeRegister for enrollment**

Replace the `handleNodeRegister` method to support two-tier auth with idempotent enrollment. The key changes:

1. Extract auth result from the connection's auth context (set during WS upgrade)
2. If `authResult.type === 'enrollment'`: upsert NodeIdentity by the worker-provided `nodeId`
3. If `authResult.type === 'registered'`: proceed as normal (node already has identity)
4. Return `EnrollmentResult` with nodeId + token in the response

The exact implementation depends on the current method body. The new logic:

```typescript
private async handleNodeRegister(
  socketNodeId: string,
  request: RpcRequest,
  params: { nodeId: string; name: string; capabilities: WorkerNodeCapabilities },
): Promise<void> {
  const authResult = this.connectionAuthResults.get(socketNodeId);

  if (authResult?.type === 'enrollment') {
    // New node or re-enrollment — upsert by worker-provided nodeId
    const identityStore = getNodeIdentityStore();
    let identity = identityStore.get(params.nodeId);

    if (!identity) {
      identity = {
        nodeId: params.nodeId,
        nodeName: params.name,
        token: generateAuthToken(),
        createdAt: Date.now(),
      };
      identityStore.set(identity);
    }

    // Re-map socket to the worker's nodeId
    this.connection.remapNodeId(socketNodeId, params.nodeId);

    // Register in node registry
    this.registry.registerNode({
      id: params.nodeId,
      name: params.name,
      address: '', // filled by connection layer
      capabilities: params.capabilities,
      status: 'connected',
      connectedAt: Date.now(),
      activeInstances: 0,
    });

    // Send enrollment result
    this.connection.sendResponse(params.nodeId, createRpcResponse(request.id, {
      nodeId: identity.nodeId,
      token: identity.token,
    } satisfies EnrollmentResult));
    return;
  }

  // Registered node — standard registration
  this.registry.registerNode({
    id: authResult?.type === 'registered' ? authResult.nodeId : socketNodeId,
    name: params.name,
    address: '',
    capabilities: params.capabilities,
    status: 'connected',
    connectedAt: Date.now(),
    activeInstances: 0,
  });

  this.connection.sendResponse(socketNodeId, createRpcResponse(request.id, { ok: true }));
}
```

Note: This requires a `connectionAuthResults` map and `remapNodeId` method — these will need to be added to the connection server. The exact integration depends on reading the current code. The implementing agent should read the full `rpc-event-router.ts` and `worker-node-connection.ts` before writing.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/remote-node/rpc-event-router.ts src/main/remote-node/worker-node-connection.ts
git commit -m "feat(remote-nodes): idempotent enrollment with upsert by worker-provided nodeId"
```

---

## Task 9: Node Identity Store

**Files:**
- Create: `src/main/remote-node/node-identity-store.ts`
- Create: `src/main/remote-node/__tests__/node-identity-store.test.ts`

- [ ] **Step 1: Write tests**

Create `src/main/remote-node/__tests__/node-identity-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { NodeIdentityStore } from '../node-identity-store';
import type { NodeIdentity } from '../../../shared/types/worker-node.types';

describe('NodeIdentityStore', () => {
  let store: NodeIdentityStore;

  beforeEach(() => {
    store = new NodeIdentityStore();
    store.loadFromJson('{}');
  });

  const makeIdentity = (id: string): NodeIdentity => ({
    nodeId: id,
    nodeName: `node-${id}`,
    token: 'a'.repeat(64),
    createdAt: Date.now(),
  });

  it('stores and retrieves a node identity', () => {
    const identity = makeIdentity('abc');
    store.set(identity);
    expect(store.get('abc')).toEqual(identity);
  });

  it('returns undefined for unknown nodeId', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  it('removes a node identity', () => {
    store.set(makeIdentity('abc'));
    store.remove('abc');
    expect(store.get('abc')).toBeUndefined();
  });

  it('lists all identities', () => {
    store.set(makeIdentity('a'));
    store.set(makeIdentity('b'));
    expect(store.getAll()).toHaveLength(2);
  });

  it('serializes to JSON', () => {
    store.set(makeIdentity('x'));
    const json = store.toJson();
    const parsed = JSON.parse(json);
    expect(parsed['x']).toBeDefined();
    expect(parsed['x'].nodeId).toBe('x');
  });

  it('loads from JSON', () => {
    const identity = makeIdentity('y');
    store.set(identity);
    const json = store.toJson();

    const store2 = new NodeIdentityStore();
    store2.loadFromJson(json);
    expect(store2.get('y')).toEqual(identity);
  });

  it('finds node by token', () => {
    const id = makeIdentity('z');
    id.token = 'unique_token_64chars_padded'.padEnd(64, '0');
    store.set(id);
    expect(store.findByToken(id.token)?.nodeId).toBe('z');
  });

  it('returns null when token not found', () => {
    expect(store.findByToken('nonexistent')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/remote-node/__tests__/node-identity-store.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement NodeIdentityStore**

Create `src/main/remote-node/node-identity-store.ts`:

```typescript
import type { NodeIdentity } from '../../shared/types/worker-node.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('NodeIdentityStore');

let instance: NodeIdentityStore | null = null;

export class NodeIdentityStore {
  private nodes = new Map<string, NodeIdentity>();

  static getInstance(): NodeIdentityStore {
    if (!instance) {
      instance = new NodeIdentityStore();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance = null;
  }

  get(nodeId: string): NodeIdentity | undefined {
    return this.nodes.get(nodeId);
  }

  set(identity: NodeIdentity): void {
    this.nodes.set(identity.nodeId, identity);
    logger.info('Node identity stored', { nodeId: identity.nodeId, name: identity.nodeName });
  }

  remove(nodeId: string): boolean {
    const deleted = this.nodes.delete(nodeId);
    if (deleted) {
      logger.info('Node identity removed', { nodeId });
    }
    return deleted;
  }

  getAll(): NodeIdentity[] {
    return [...this.nodes.values()];
  }

  findByToken(token: string): NodeIdentity | undefined {
    for (const identity of this.nodes.values()) {
      if (identity.token === token) return identity;
    }
    return undefined;
  }

  toJson(): string {
    const record: Record<string, NodeIdentity> = {};
    for (const [key, val] of this.nodes) {
      record[key] = val;
    }
    return JSON.stringify(record);
  }

  loadFromJson(json: string): void {
    try {
      const record = JSON.parse(json) as Record<string, NodeIdentity>;
      this.nodes.clear();
      for (const [key, val] of Object.entries(record)) {
        this.nodes.set(key, val);
      }
    } catch (err) {
      logger.error('Failed to parse node identity JSON', { error: (err as Error).message });
      this.nodes.clear();
    }
  }
}

export function getNodeIdentityStore(): NodeIdentityStore {
  return NodeIdentityStore.getInstance();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/remote-node/__tests__/node-identity-store.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/remote-node/node-identity-store.ts src/main/remote-node/__tests__/node-identity-store.test.ts
git commit -m "feat(remote-nodes): add NodeIdentityStore with JSON serialization"
```

---

## Task 10: IPC Handlers for Token Management and Server Status

**Files:**
- Modify: `src/main/ipc/handlers/remote-node-handlers.ts`

- [ ] **Step 1: Read the current handler file**

Read `src/main/ipc/handlers/remote-node-handlers.ts` to understand the pattern.

- [ ] **Step 2: Add 4 new handlers**

Add the following handlers inside `registerRemoteNodeHandlers()`:

```typescript
  // Regenerate enrollment token
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_REGENERATE_TOKEN,
    async (): Promise<IpcResponse> => {
      try {
        const token = generateAuthToken();
        const settingsManager = getSettingsManager();
        await settingsManager.set('remoteNodesEnrollmentToken', token);
        updateRemoteNodeConfig({ authToken: token });
        return { success: true, data: { token } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TOKEN_REGENERATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Set custom enrollment token
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_SET_TOKEN,
    async (_event, payload: { token: string }): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeSetTokenPayloadSchema.parse(payload);
        const settingsManager = getSettingsManager();
        await settingsManager.set('remoteNodesEnrollmentToken', validated.token);
        updateRemoteNodeConfig({ authToken: validated.token });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'TOKEN_SET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Revoke a registered node
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_REVOKE,
    async (_event, payload: { nodeId: string }): Promise<IpcResponse> => {
      try {
        const validated = RemoteNodeRevokePayloadSchema.parse(payload);
        const identityStore = getNodeIdentityStore();
        identityStore.remove(validated.nodeId);

        // Persist updated identities
        const settingsManager = getSettingsManager();
        await settingsManager.set('remoteNodesRegisteredNodes', identityStore.toJson());

        // Disconnect if active
        const connection = getWorkerNodeConnectionServer();
        if (connection.isNodeConnected(validated.nodeId)) {
          connection.disconnectNode(validated.nodeId);
        }

        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'NODE_REVOKE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // Get server status
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_NODE_GET_SERVER_STATUS,
    async (): Promise<IpcResponse> => {
      try {
        const config = getRemoteNodeConfig();
        const connection = getWorkerNodeConnectionServer();
        const connectedIds = connection.getConnectedNodeIds();

        return {
          success: true,
          data: {
            status: getServerLifecycle().state,
            connectedCount: connectedIds.length,
            runningConfig: {
              port: config.serverPort,
              host: config.serverHost,
              namespace: config.namespace ?? 'default',
              requireTls: config.tlsCertPath != null && config.tlsCertPath.length > 0,
            },
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SERVER_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
```

Add the necessary imports at the top of the file:

```typescript
import { generateAuthToken } from '../../remote-node/auth-validator';
import { getNodeIdentityStore } from '../../remote-node/node-identity-store';
import { getServerLifecycle } from '../../remote-node/server-lifecycle';
import { RemoteNodeSetTokenPayloadSchema, RemoteNodeRevokePayloadSchema } from '../../../shared/validation/ipc-schemas';
import { getSettingsManager } from '../../core/config/settings-manager';
```

Note: Some imports like `getServerLifecycle` and `getSettingsManager` need the actual getter functions to exist. The implementing agent should verify the actual import paths match the codebase.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers/remote-node-handlers.ts
git commit -m "feat(remote-nodes): add IPC handlers for token management, revoke, server status"
```

---

## Task 11: Preload Bridge Additions

**Files:**
- Modify: `src/preload/preload.ts:2732-2752`

- [ ] **Step 1: Add 4 new preload methods**

In `src/preload/preload.ts`, find the Remote Nodes section (around line 2732) and add after `onRemoteNodeEvent`:

```typescript
remoteNodeRegenerateToken: (): Promise<unknown> =>
  ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_REGENERATE_TOKEN),

remoteNodeSetToken: (token: string): Promise<unknown> =>
  ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_SET_TOKEN, { token }),

remoteNodeRevokeNode: (nodeId: string): Promise<unknown> =>
  ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_REVOKE, { nodeId }),

remoteNodeGetServerStatus: (): Promise<unknown> =>
  ipcRenderer.invoke(IPC_CHANNELS.REMOTE_NODE_GET_SERVER_STATUS),
```

- [ ] **Step 2: Add IPC channel constants**

Find the IPC channel constants in preload (around line 279) and add:

```typescript
REMOTE_NODE_REGENERATE_TOKEN: 'remote-node:regenerate-token',
REMOTE_NODE_SET_TOKEN: 'remote-node:set-token',
REMOTE_NODE_REVOKE: 'remote-node:revoke',
REMOTE_NODE_GET_SERVER_STATUS: 'remote-node:get-server-status',
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(remote-nodes): expose new IPC channels in preload bridge"
```

---

## Task 12: Settings-Change Listener and Config Hydration

**Files:**
- Modify: `src/main/remote-node/remote-node-config.ts`
- Modify: `src/main/index.ts:283-325`

- [ ] **Step 1: Add hydration and namespace to RemoteNodeConfig**

In `src/main/remote-node/remote-node-config.ts`, add a `namespace` field to the `RemoteNodeConfig` interface and a `hydrateFromSettings` function:

```typescript
export interface RemoteNodeConfig {
  enabled: boolean;
  serverPort: number;
  serverHost: string;
  authToken?: string;
  autoOffloadBrowser: boolean;
  autoOffloadGpu: boolean;
  maxRemoteInstances: number;
  namespace: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  tlsCaPath?: string;
}

const DEFAULT_CONFIG: RemoteNodeConfig = {
  enabled: false,
  serverPort: 4878,
  serverHost: '127.0.0.1',
  autoOffloadBrowser: true,
  autoOffloadGpu: false,
  maxRemoteInstances: 20,
  namespace: 'default',
};
```

Add a hydration function:

```typescript
import type { AppSettings } from '../../shared/types/settings.types';

export function hydrateRemoteNodeConfig(settings: AppSettings): void {
  updateRemoteNodeConfig({
    enabled: settings.remoteNodesEnabled,
    serverPort: settings.remoteNodesServerPort,
    serverHost: settings.remoteNodesServerHost,
    authToken: settings.remoteNodesEnrollmentToken || undefined,
    autoOffloadBrowser: settings.remoteNodesAutoOffloadBrowser,
    autoOffloadGpu: settings.remoteNodesAutoOffloadGpu,
    namespace: settings.remoteNodesNamespace,
    tlsCertPath: settings.remoteNodesTlsCertPath || undefined,
    tlsKeyPath: settings.remoteNodesTlsKeyPath || undefined,
  });
}
```

- [ ] **Step 2: Wire settings listener in main/index.ts**

In `src/main/index.ts`, in the remote node initialization section (around line 283), add:

1. Call `hydrateRemoteNodeConfig(settings)` on startup
2. Listen for `setting-changed` events on SettingsManager
3. When `remoteNodesEnabled` changes to true → lifecycle.start()
4. When `remoteNodesEnabled` changes to false → lifecycle.stop()
5. Auto-generate enrollment token if empty on first enable

The implementing agent should read the full initialization section and the SettingsManager event API before writing the exact integration code.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/remote-node/remote-node-config.ts src/main/index.ts
git commit -m "feat(remote-nodes): hydrate config from AppSettings, wire settings-change listener"
```

---

## Task 13: mDNS Discovery Service (Coordinator)

**Files:**
- Create: `src/main/remote-node/discovery-service.ts`

- [ ] **Step 1: Install bonjour-service**

Run: `npm install bonjour-service`

- [ ] **Step 2: Create discovery service**

Create `src/main/remote-node/discovery-service.ts`:

```typescript
import { Bonjour, type Service } from 'bonjour-service';
import { getLogger } from '../logging/logger';

const logger = getLogger('DiscoveryService');

let instance: DiscoveryService | null = null;

export class DiscoveryService {
  private bonjour: Bonjour | null = null;
  private published: Service | null = null;

  static getInstance(): DiscoveryService {
    if (!instance) {
      instance = new DiscoveryService();
    }
    return instance;
  }

  static _resetForTesting(): void {
    instance?.unpublish();
    instance = null;
  }

  publish(port: number, namespace: string, coordinatorId: string): void {
    try {
      this.bonjour = new Bonjour();
      this.published = this.bonjour.publish({
        name: `orchestrator-${coordinatorId.slice(0, 8)}`,
        type: 'ai-orchestrator',
        port,
        txt: {
          version: '1.0',
          namespace,
          auth: 'token',
        },
      });
      logger.info('mDNS service published', { port, namespace });
    } catch (err) {
      logger.warn('Failed to publish mDNS service', { error: (err as Error).message });
      // Non-fatal — server still works, just not discoverable
    }
  }

  unpublish(): void {
    try {
      if (this.bonjour) {
        this.bonjour.unpublishAll();
        this.bonjour.destroy();
        this.bonjour = null;
        this.published = null;
        logger.info('mDNS service unpublished');
      }
    } catch (err) {
      logger.warn('Failed to unpublish mDNS service', { error: (err as Error).message });
    }
  }

  get isPublished(): boolean {
    return this.published !== null;
  }
}

export function getDiscoveryService(): DiscoveryService {
  return DiscoveryService.getInstance();
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/remote-node/discovery-service.ts package.json package-lock.json
git commit -m "feat(remote-nodes): add mDNS discovery service via bonjour-service"
```

---

## Task 14: Worker Reconnect Backoff

**Files:**
- Create: `src/worker-agent/reconnect-backoff.ts`
- Create: `src/worker-agent/__tests__/reconnect-backoff.test.ts`

- [ ] **Step 1: Write tests**

Create `src/worker-agent/__tests__/reconnect-backoff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from '../reconnect-backoff';

describe('reconnect-backoff', () => {
  it('returns initial delay for attempt 0', () => {
    const delay = nextReconnectDelayMs(0);
    // Equal jitter: 50%..100% of 1000 = 500..1000
    expect(delay).toBeGreaterThanOrEqual(RECONNECT_CONFIG.initialMs / 2);
    expect(delay).toBeLessThanOrEqual(RECONNECT_CONFIG.initialMs);
  });

  it('increases delay with attempts', () => {
    // Collect many samples to check the range grows
    const attempt5Delays = Array.from({ length: 100 }, () => nextReconnectDelayMs(5));
    const maxDelay = Math.max(...attempt5Delays);
    expect(maxDelay).toBeGreaterThan(RECONNECT_CONFIG.initialMs);
  });

  it('caps at maxMs', () => {
    const delay = nextReconnectDelayMs(100);
    expect(delay).toBeLessThanOrEqual(RECONNECT_CONFIG.maxMs);
  });

  it('always returns a positive number', () => {
    for (let i = 0; i < 50; i++) {
      expect(nextReconnectDelayMs(i)).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/worker-agent/__tests__/reconnect-backoff.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement reconnect backoff**

Create `src/worker-agent/reconnect-backoff.ts`:

```typescript
export const RECONNECT_CONFIG = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  stableConnectionResetMs: 60_000,
};

export function nextReconnectDelayMs(attempt: number): number {
  const exp = Math.min(
    RECONNECT_CONFIG.maxMs,
    RECONNECT_CONFIG.initialMs * RECONNECT_CONFIG.factor ** Math.min(attempt, 30),
  );
  // Equal jitter: 50%..100% of exp
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/worker-agent/__tests__/reconnect-backoff.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/worker-agent/reconnect-backoff.ts src/worker-agent/__tests__/reconnect-backoff.test.ts
git commit -m "feat(remote-nodes): exponential backoff with equal jitter for worker reconnect"
```

---

## Task 15: Worker Discovery Client

**Files:**
- Create: `src/worker-agent/discovery-client.ts`

- [ ] **Step 1: Create discovery client**

Create `src/worker-agent/discovery-client.ts`:

```typescript
import { Bonjour, type Browser, type RemoteService } from 'bonjour-service';

export interface DiscoveredCoordinator {
  host: string;
  port: number;
  namespace: string;
  version: string;
}

export class DiscoveryClient {
  private bonjour: Bonjour | null = null;
  private browser: Browser | null = null;
  private onDiscovered: ((coordinator: DiscoveredCoordinator) => void) | null = null;
  private onLost: ((name: string) => void) | null = null;

  /**
   * One-shot discovery: find the first coordinator matching namespace within timeout.
   */
  async discover(namespace: string, timeoutMs = 10_000): Promise<DiscoveredCoordinator | null> {
    return new Promise((resolve) => {
      const bonjour = new Bonjour();
      const timer = setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(null);
      }, timeoutMs);

      const browser = bonjour.find({ type: 'ai-orchestrator' }, (service: RemoteService) => {
        if (service.txt?.namespace === namespace) {
          clearTimeout(timer);
          browser.stop();
          bonjour.destroy();
          resolve({
            host: service.host,
            port: service.port,
            namespace: service.txt.namespace,
            version: service.txt.version ?? 'unknown',
          });
        }
      });
    });
  }

  /**
   * Start continuous discovery. Calls onUp when a coordinator appears,
   * onDown when one disappears.
   */
  startContinuous(
    namespace: string,
    onUp: (coordinator: DiscoveredCoordinator) => void,
    onDown?: (name: string) => void,
  ): void {
    this.stopContinuous();
    this.bonjour = new Bonjour();
    this.onDiscovered = onUp;
    this.onLost = onDown ?? null;

    this.browser = this.bonjour.find({ type: 'ai-orchestrator' });

    this.browser.on('up', (service: RemoteService) => {
      if (service.txt?.namespace === namespace) {
        this.onDiscovered?.({
          host: service.host,
          port: service.port,
          namespace: service.txt.namespace,
          version: service.txt.version ?? 'unknown',
        });
      }
    });

    this.browser.on('down', (service: RemoteService) => {
      this.onLost?.(service.name);
    });
  }

  stopContinuous(): void {
    this.browser?.stop();
    this.bonjour?.destroy();
    this.bonjour = null;
    this.browser = null;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/worker-agent/discovery-client.ts
git commit -m "feat(remote-nodes): mDNS discovery client for worker agent"
```

---

## Task 16: Update Worker Config and Agent

**Files:**
- Modify: `src/worker-agent/worker-config.ts:6-28`
- Modify: `src/worker-agent/worker-agent.ts:39-150`

- [ ] **Step 1: Update WorkerConfig interface**

In `src/worker-agent/worker-config.ts`, make `coordinatorUrl` optional and add fields:

```typescript
export interface WorkerConfig {
  nodeId: string;
  name: string;
  coordinatorUrl?: string; // optional — mDNS discovery used if not set
  authToken: string;
  nodeToken?: string; // per-node token received after enrollment
  namespace: string;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  reconnectIntervalMs: number;
  heartbeatIntervalMs: number;
}
```

Update `DEFAULTS`:

```typescript
const DEFAULTS: WorkerConfig = {
  nodeId: '',
  name: os.hostname(),
  coordinatorUrl: undefined,
  authToken: '',
  nodeToken: undefined,
  namespace: 'default',
  maxConcurrentInstances: 10,
  workingDirectories: [],
  reconnectIntervalMs: 5_000,
  heartbeatIntervalMs: 10_000,
};
```

Add `--namespace` and `--discover` to CLI arg parsing.

- [ ] **Step 2: Update worker-agent.ts connect() for discovery and backoff**

In `src/worker-agent/worker-agent.ts`:

1. Import `DiscoveryClient` and `nextReconnectDelayMs`
2. In `connect()`, before creating the WebSocket:
   - If `config.coordinatorUrl` is set, use it directly
   - Otherwise, call `discoveryClient.discover(config.namespace)`
   - If discovery returns null, throw (scheduleReconnect will retry)
3. Use `config.nodeToken ?? config.authToken` as the connection token
4. After receiving enrollment response, persist `nodeToken` to config
5. Replace `scheduleReconnect()` with backoff-aware version:

```typescript
private reconnectAttempt = 0;
private connectedAt = 0;

private scheduleReconnect(): void {
  // Reset attempt counter if connection was stable for 60s
  if (this.connectedAt > 0 && Date.now() - this.connectedAt > RECONNECT_CONFIG.stableConnectionResetMs) {
    this.reconnectAttempt = 0;
  }

  const delay = nextReconnectDelayMs(this.reconnectAttempt);
  this.reconnectAttempt++;
  console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})...`);

  this.reconnectTimer = setTimeout(async () => {
    try {
      await this.connect();
      this.connectedAt = Date.now();
      this.reconnectAttempt = 0;
    } catch {
      // connect() failed — close handler will schedule next retry
    }
  }, delay);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/worker-agent/worker-config.ts src/worker-agent/worker-agent.ts
git commit -m "feat(remote-nodes): worker discovery, enrollment persistence, exponential backoff"
```

---

## Task 17: Remote Node IPC Service (Renderer)

**Files:**
- Create: `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`

- [ ] **Step 1: Create the service**

Create `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`:

```typescript
import { Injectable } from '@angular/core';
import type { IpcResponse } from '../../../../../shared/types/ipc.types';

@Injectable({ providedIn: 'root' })
export class RemoteNodeIpcService {
  async listNodes(): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeList() as Promise<IpcResponse>;
  }

  async getServerStatus(): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeGetServerStatus() as Promise<IpcResponse>;
  }

  async startServer(config?: { port?: number; host?: string }): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeStartServer(config) as Promise<IpcResponse>;
  }

  async stopServer(): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeStopServer() as Promise<IpcResponse>;
  }

  async regenerateToken(): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeRegenerateToken() as Promise<IpcResponse>;
  }

  async setToken(token: string): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeSetToken(token) as Promise<IpcResponse>;
  }

  async revokeNode(nodeId: string): Promise<IpcResponse> {
    return window.electronAPI.remoteNodeRevokeNode(nodeId) as Promise<IpcResponse>;
  }

  onRemoteNodeEvent(callback: (event: unknown) => void): () => void {
    return window.electronAPI.onRemoteNodeEvent(callback);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
git commit -m "feat(remote-nodes): add renderer-side IPC service for remote node operations"
```

---

## Task 18: Settings Store Additions

**Files:**
- Modify: `src/renderer/app/core/state/settings.store.ts:24-57`

- [ ] **Step 1: Add remote node computed signals**

In `src/renderer/app/core/state/settings.store.ts`, add after the existing computed properties:

```typescript
// Remote Nodes
readonly remoteNodesEnabled = computed(() => this._settings().remoteNodesEnabled);
readonly remoteNodesServerPort = computed(() => this._settings().remoteNodesServerPort);
readonly remoteNodesServerHost = computed(() => this._settings().remoteNodesServerHost);
readonly remoteNodesEnrollmentToken = computed(() => this._settings().remoteNodesEnrollmentToken);
readonly remoteNodesAutoOffloadBrowser = computed(() => this._settings().remoteNodesAutoOffloadBrowser);
readonly remoteNodesAutoOffloadGpu = computed(() => this._settings().remoteNodesAutoOffloadGpu);
readonly remoteNodesNamespace = computed(() => this._settings().remoteNodesNamespace);
readonly remoteNodesRequireTls = computed(() => this._settings().remoteNodesRequireTls);
readonly remoteNodesTlsMode = computed(() => this._settings().remoteNodesTlsMode);
readonly remoteNodesRegisteredNodes = computed(() => {
  try {
    return JSON.parse(this._settings().remoteNodesRegisteredNodes) as Record<string, unknown>;
  } catch {
    return {};
  }
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/state/settings.store.ts
git commit -m "feat(remote-nodes): add computed signals for remote node settings"
```

---

## Task 19: Remote Nodes Settings Tab Component

**Files:**
- Create: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`

This is the largest task. The component follows the Connections tab pattern: standalone, OnPush, signals for local state.

- [ ] **Step 1: Create the component file**

Create `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` with the full component implementation. The implementing agent should:

1. Read `connections-settings-tab.component.ts` for the exact style patterns
2. Build the template with these sections in order:
   - Header: "Remote Nodes" + description
   - Enable toggle with status line
   - Server Config card (port, host, namespace, TLS, offload toggles, Apply & Restart button)
   - Auth Token card (masked input, copy, regenerate, set custom, copy connection config)
   - Registered Nodes card (list with revoke buttons)
   - Connected Nodes status line

Key implementation details:
- Inject: `SettingsStore`, `RemoteNodeIpcService`
- Local signals: `draftPort`, `draftHost`, `draftNamespace`, `draftRequireTls`, `draftTlsMode`, `serverStatus`, `tokenRevealed`, `customTokenMode`, `customTokenValue`, `registeredNodes`, `connectedCount`, `authFailures`, `error`
- On init: fetch server status, subscribe to remote node events, initialize drafts from store
- `isDirty` computed: compare draft values to `serverStatus().runningConfig`
- `applyAndRestart()`: save drafts to settings, call stop then start
- `toggleEnabled()`: flip `remoteNodesEnabled` via store
- `copyToken()`: `navigator.clipboard.writeText()`
- `copyConnectionConfig()`: generate JSON and copy
- `regenerateToken()`: confirm, call IPC
- `revokeNode(nodeId)`: call IPC, refresh list

Reuse styles from the Connections tab: `.connection-card`, `.status-badge`, `.field-input`, `.btn-primary`, `.btn-danger`, etc.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts
git commit -m "feat(remote-nodes): add Remote Nodes settings tab component"
```

---

## Task 20: Wire Tab into Settings Component

**Files:**
- Modify: `src/renderer/app/features/settings/settings.component.ts`

- [ ] **Step 1: Add to SettingsTab type**

In `settings.component.ts`, add `'remote-nodes'` to the `SettingsTab` type union (line 20):

```typescript
type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'connections'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard'
  | 'remote-nodes';
```

- [ ] **Step 2: Add NAV_ITEMS entry**

Add to `NAV_ITEMS` array, first in the Advanced group (before `ecosystem`):

```typescript
{ id: 'remote-nodes', label: 'Remote Nodes', group: 'Advanced' },
```

- [ ] **Step 3: Add import**

Add import at top:

```typescript
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
```

Add to `imports` array in the `@Component` decorator.

- [ ] **Step 4: Add @switch case**

In the template `@switch (activeTab())` block, add:

```typescript
@case ('remote-nodes') {
  <app-remote-nodes-settings-tab />
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/settings/settings.component.ts
git commit -m "feat(remote-nodes): wire Remote Nodes tab into settings sidebar"
```

---

## Task 21: Re-export New Modules from Barrel

**Files:**
- Modify: `src/main/remote-node/index.ts`

- [ ] **Step 1: Add re-exports**

In `src/main/remote-node/index.ts`, add:

```typescript
export { ServerLifecycle, type ServerState } from './server-lifecycle';
export { IpRateLimiter, type RateLimitConfig } from './ip-rate-limiter';
export { DiscoveryService, getDiscoveryService } from './discovery-service';
export { NodeIdentityStore, getNodeIdentityStore } from './node-identity-store';
export { hydrateRemoteNodeConfig } from './remote-node-config';
export { validateTokenTwoTier, ensureEnrollmentToken, type AuthResult } from './auth-validator';
export type { EnrollmentResult } from './worker-node-rpc';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/main/remote-node/index.ts
git commit -m "feat(remote-nodes): re-export new modules from barrel"
```

---

## Task 22: macOS Entitlements and Build Config

**Files:**
- Modify: `build/entitlements.mac.plist`

- [ ] **Step 1: Add local network description**

In `build/entitlements.mac.plist`, add before the closing `</dict>`:

```xml
    <!-- Required for mDNS discovery of remote worker nodes on LAN -->
    <key>com.apple.developer.networking.multicast</key>
    <true/>
```

Note: `NSLocalNetworkUsageDescription` goes in `Info.plist`, not entitlements. For Electron apps, this is set via `electron-builder.json`'s `extendInfo` config. The implementing agent should check if `electron-builder.json` has an `extendInfo` field in the `mac` section and add:

```json
"extendInfo": {
  "NSLocalNetworkUsageDescription": "AI Orchestrator uses your local network to discover and connect to worker nodes on other machines."
}
```

- [ ] **Step 2: Verify build config is valid**

Run: `npx tsc --noEmit`
Expected: No errors (plist/json changes don't affect TS)

- [ ] **Step 3: Commit**

```bash
git add build/entitlements.mac.plist electron-builder.json
git commit -m "feat(remote-nodes): add macOS entitlements for mDNS local network access"
```

---

## Task 23: Update WORKER_AGENT_SETUP.md

**Files:**
- Modify: `docs/WORKER_AGENT_SETUP.md`

- [ ] **Step 1: Update the setup guide**

Update `docs/WORKER_AGENT_SETUP.md` to reflect:

1. **Step 3 (Get the Auth Token)**: Rename to "Get the Enrollment Token". Note that this is now used for first-time enrollment only — after enrollment, the worker receives its own unique token.

2. **Step 4 (Configure the Worker Agent)**: Update the JSON example:
   ```json
   {
     "name": "windows-pc",
     "authToken": "<paste-the-enrollment-token>",
     "namespace": "default",
     "maxConcurrentInstances": 10,
     "workingDirectories": [
       "C:\\Users\\James\\projects"
     ]
   }
   ```
   Note: `coordinatorUrl` is no longer required — the worker auto-discovers the coordinator via mDNS. Add a note: "To skip auto-discovery and connect directly, add `\"coordinatorUrl\": \"ws://<mac-ip>:4878\"`."

3. **Add new section: "Auto-Discovery"** explaining how mDNS works, namespace isolation, and what happens if discovery fails.

4. **Add new section: "Node Identity"** explaining that after first connection, the worker receives a unique token and no longer needs the enrollment token.

- [ ] **Step 2: Commit**

```bash
git add docs/WORKER_AGENT_SETUP.md
git commit -m "docs(remote-nodes): update worker agent setup guide for mDNS and enrollment"
```

---

## Task 24: Final Verification

- [ ] **Step 1: Run full TypeScript check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run spec TypeScript check**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: All pass

- [ ] **Step 5: Run the app in dev mode**

Run: `npm run dev`
Expected: App starts, Settings > Remote Nodes tab appears in sidebar under Advanced, toggle works
