# Pause on VPN Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pause on VPN" feature: when the user connects to a corporate VPN, the orchestrator stops sending AI-provider traffic until VPN is no longer active or the user explicitly resumes. Three-layer defense (renderer queue, CLI adapter gate, process-level network interceptor) plus a master kill switch for full disable.

**Architecture:** A central `PauseCoordinator` singleton tracks pause reasons (`vpn` | `user` | `detector-error`) as a refcount-style Set. A `VpnDetector` polls network interfaces and (optionally) probes a host. A process-level interceptor patches `http.request`/`http.get`/`https.request`/`https.get`/`globalThis.fetch` in memory (no node_modules modification) to throw `OrchestratorPausedError` for non-allow-listed hosts while paused. CLI adapters use a template-method gate (`BaseCliAdapter.sendInput` calls `protected sendInputImpl`); RemoteCliAdapter (which doesn't extend BaseCliAdapter) gets an explicit check. Settings include a master `pauseFeatureEnabled` kill switch that fully removes the feature when off. Spec: `docs/superpowers/specs/2026-04-28-pause-on-vpn-design_completed.md`.

**Tech Stack:** TypeScript 5.9, Electron 40, Angular 21 (zoneless, signals), Node `http`/`https` modules, electron-store, Zod 4, Vitest.

---

## Checkpoint Policy

This project's `CLAUDE.md` is explicit: **NEVER commit or push unless the user explicitly asks you to**. Each task's "Checkpoint marker" is a progress label, NOT an instruction to commit:

- After each checkpoint, ensure the named verification commands pass (typecheck, lint, the relevant tests).
- Do **NOT** create a git commit unless the user has explicitly asked you to commit at that point.
- If you are batching multiple tasks before stopping for review, you can keep going across multiple checkpoints — the working tree should remain in a green (compiling, lint-clean, tests-passing) state at each checkpoint, but you don't have to record it in git history.
- The one exception is **never commit a known-broken intermediate state** (Task 17 in particular has been reworded so its broken-compilation state is *not* checkpointed at all — Task 17 and Task 18 are executed back-to-back as a single atomic step).

The checkpoint labels can be reused as commit-message text only if the user explicitly asks for a commit.

---

## File Structure

### New files

**Main process — pause core:**
- `src/main/pause/pause-coordinator.ts` — singleton state holder; reason refcount; pause/resume events
- `src/main/pause/pause-persistence.ts` — electron-store wrapper for pause state
- `src/main/pause/orchestrator-paused-error.ts` — typed error thrown by gates

**Main process — network:**
- `src/main/network/vpn-detector.ts` — interface polling + probe (singleton)
- `src/main/network/install-network-pause-gate.ts` — http/https/fetch interceptor
- `src/main/network/allowed-hosts.ts` — local-host matcher

**Main process — IPC:**
- `src/main/ipc/handlers/pause-handlers.ts` — pause IPC handlers
- `src/main/core/config/settings-validators.ts` — per-key settings validators

**Contracts package:**
- `packages/contracts/src/channels/pause.channels.ts` — pause IPC channel constants
- `packages/contracts/src/schemas/pause.schemas.ts` — pause IPC Zod schemas

**Preload:**
- `src/preload/domains/pause.preload.ts` — pause IPC factory

**Renderer — state:**
- `src/renderer/app/core/state/pause/pause.store.ts` — Angular signal-based pause store
- `src/renderer/app/core/state/instance/queue-persistence.service.ts` — queue snapshot/restore

**Renderer — UI components:**
- `src/renderer/app/shared/components/pause-toggle/pause-toggle.component.ts` — title-bar master button
- `src/renderer/app/shared/components/pause-banner/pause-banner.component.ts` — top-of-app banner
- `src/renderer/app/shared/components/detector-error-modal/detector-error-modal.component.ts` — confirmation modal
- `src/renderer/app/features/settings/network-settings-tab.component.ts` — Network settings tab
- `src/renderer/app/features/settings/pause-detector-events-dialog.component.ts` — diagnostic events dialog

**Docs:**
- `docs/pause-on-vpn.md` — user-facing docs + calibration playbook

### Modified files

- `src/main/index.ts` — bootstrap order: settings → coordinator → kill-switch check → interceptor → detector → handlers → listeners
- `src/main/cli/adapters/base-cli-adapter.ts` — add concrete `sendInput`; declare `protected abstract sendInputImpl`
- `src/main/cli/adapters/{claude,codex,copilot,gemini,cursor,acp}-cli-adapter.ts` — rename `sendInput` → `sendInputImpl` (protected, override)
- `src/main/cli/adapters/remote-cli-adapter.ts` — add explicit pause check at top of `sendInput` (no rename)
- `src/main/instance/instance-lifecycle.ts:1273,1363` — branch on `OrchestratorPausedError`; route initial prompt to renderer queue; preserve instance state
- `src/main/instance/instance-manager.ts` — pause/resume listener that calls `adapter.interrupt()` on busy instances
- `src/main/instance/instance-communication.ts` — initial-prompt routing into renderer queue
- `src/main/orchestration/cross-model-review-service.ts` — abort + skip-on-paused
- `src/main/core/system/provider-quota-service.ts` and `src/main/core/system/provider-quota/*` — `isPaused` flag; leave timers installed
- `src/main/core/config/settings-manager.ts` — `set`/`update` invoke validators
- `src/main/ipc/handlers/instance-handlers.ts` — pause check at top of `INPUT_REQUIRED_RESPOND`; add `INSTANCE_QUEUE_SAVE`/`LOAD_ALL` handlers
- `src/main/ipc/handlers/index.ts` — re-export `registerPauseHandlers`
- `src/main/ipc/ipc-main-handler.ts` — call `registerPauseHandlers` from `registerHandlers`
- `src/main/core/config/settings-export.ts` — exclude `pause-state` and `instance-message-queue` namespaces
- `src/main/register-aliases.ts`, `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts` — pause contracts subpaths
- `packages/contracts/src/channels/index.ts` — re-export `PAUSE_CHANNELS`; merge into aggregate
- `packages/contracts/src/channels/instance.channels.ts` — add `INSTANCE_QUEUE_*` constants
- `packages/contracts/src/schemas/instance.schemas.ts` — add queue schemas
- `packages/contracts/package.json` — add subpath exports for pause channels/schemas
- `src/preload/preload.ts` — compose pause domain
- `src/preload/domains/instance.preload.ts` — invoke methods + listener for queue channels
- `src/shared/types/settings.types.ts` — 9 new keys; extend `SettingMetadata.category`
- `src/renderer/app/core/state/instance/instance-messaging.store.ts` — pause gates; extended retry
- `src/renderer/app/core/state/settings.store.ts` — `networkSettings` computed
- `src/renderer/app/features/settings/settings.component.ts` — tab union, NAV_ITEMS, switch
- `src/renderer/app/app.component.html` — pause-banner + pause-toggle slots
- `src/renderer/app/app.component.ts` — pause store init
- `package.json` — add `safe-regex` runtime dep

---

## Verification commands (used throughout)

After every implementation step that touches code:

```bash
npx tsc --noEmit                                # main + renderer typecheck
npx tsc --noEmit -p tsconfig.spec.json          # spec files typecheck
npx eslint <changed-files>                      # lint changed files
npx vitest run path/to/spec.spec.ts             # run the new test
```

Full sweep before any phase merge:
```bash
npm run lint
npx vitest run
```

---

# Phase 1 — Pause core (no external integration yet)

This phase builds the central state holder and its persistence. No IPC, no UI, no detector. By the end of Phase 1, the coordinator can be unit-tested in isolation.

---

### Task 1: `OrchestratorPausedError` typed error

**Files:**
- Create: `src/main/pause/orchestrator-paused-error.ts`
- Test: `src/main/pause/orchestrator-paused-error.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/main/pause/orchestrator-paused-error.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { OrchestratorPausedError, isOrchestratorPausedError } from './orchestrator-paused-error';

describe('OrchestratorPausedError', () => {
  it('extends Error and carries the message', () => {
    const e = new OrchestratorPausedError('blocked');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('blocked');
    expect(e.name).toBe('OrchestratorPausedError');
  });

  it('is detectable via isOrchestratorPausedError', () => {
    const e = new OrchestratorPausedError('x');
    expect(isOrchestratorPausedError(e)).toBe(true);
    expect(isOrchestratorPausedError(new Error('x'))).toBe(false);
    expect(isOrchestratorPausedError('string')).toBe(false);
    expect(isOrchestratorPausedError(null)).toBe(false);
  });

  it('carries hostname when provided', () => {
    const e = new OrchestratorPausedError('blocked', { hostname: 'api.anthropic.com' });
    expect(e.hostname).toBe('api.anthropic.com');
  });
});
```

- [ ] **Step 2: Run the test (expect fail)**

```bash
npx vitest run src/main/pause/orchestrator-paused-error.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/main/pause/orchestrator-paused-error.ts`:

```typescript
/**
 * Thrown by pause gates (BaseCliAdapter.sendInput, network interceptor,
 * sendInputResponse, etc.) when the orchestrator is paused. Callers detect
 * this via `isOrchestratorPausedError` to handle re-queue / refusal flows
 * differently from generic errors.
 */
export class OrchestratorPausedError extends Error {
  readonly name = 'OrchestratorPausedError';
  readonly hostname?: string;

  constructor(message: string, opts?: { hostname?: string }) {
    super(message);
    this.hostname = opts?.hostname;
  }
}

export function isOrchestratorPausedError(err: unknown): err is OrchestratorPausedError {
  return err instanceof OrchestratorPausedError;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx vitest run src/main/pause/orchestrator-paused-error.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: 3 passing; typecheck clean.

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): add OrchestratorPausedError
```

---

### Task 2: Pause persistence (electron-store wrapper)

**Files:**
- Create: `src/main/pause/pause-persistence.ts`
- Test: `src/main/pause/pause-persistence.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/main/pause/pause-persistence.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock electron-store with a plain in-memory backing store.
let mockBacking: Record<string, unknown> = {};

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get store() { return mockBacking; },
    set: (k: string, v: unknown) => { mockBacking[k] = v; },
    clear: () => { mockBacking = {}; },
  })),
}));

import { PausePersistence } from './pause-persistence';

describe('PausePersistence', () => {
  beforeEach(() => {
    mockBacking = {};
  });

  it('returns null when no state has been saved', () => {
    const p = new PausePersistence();
    expect(p.load()).toBeNull();
  });

  it('returns "corrupted" sentinel when stored data is malformed', () => {
    mockBacking['state'] = { reasons: 'not-an-array', persistedAt: 'oops' };
    const p = new PausePersistence();
    expect(p.load()).toBe('corrupted');
  });

  it('round-trips a valid state', () => {
    const p = new PausePersistence();
    p.save({ reasons: ['user'], persistedAt: 1000, recentTransitions: [] });
    expect(p.load()).toEqual({ reasons: ['user'], persistedAt: 1000, recentTransitions: [] });
  });

  it('trims recentTransitions to last 20 on save', () => {
    const p = new PausePersistence();
    const transitions = Array.from({ length: 30 }, (_, i) => ({
      at: i, from: [], to: ['vpn'] as const, trigger: `t${i}`,
    }));
    p.save({ reasons: [], persistedAt: 0, recentTransitions: transitions });
    const loaded = p.load();
    expect(loaded).not.toBeNull();
    expect(loaded).not.toBe('corrupted');
    if (loaded && loaded !== 'corrupted') {
      expect(loaded.recentTransitions).toHaveLength(20);
      expect(loaded.recentTransitions[0]?.at).toBe(10); // first 10 dropped
    }
  });
});
```

- [ ] **Step 2: Run test (expect fail — module missing)**

```bash
npx vitest run src/main/pause/pause-persistence.spec.ts
```

- [ ] **Step 3: Implement**

`src/main/pause/pause-persistence.ts`:

```typescript
import ElectronStore from 'electron-store';

export type PauseReason = 'vpn' | 'user' | 'detector-error';

export interface PauseTransition {
  at: number;
  from: readonly PauseReason[];
  to: readonly PauseReason[];
  trigger: string;
}

export interface PersistedPauseState {
  reasons: PauseReason[];
  persistedAt: number;
  recentTransitions: PauseTransition[];
}

const MAX_TRANSITIONS = 20;

interface Store<T> {
  store: T;
  set<K extends keyof T>(k: K, v: T[K]): void;
  clear(): void;
}

interface BackingShape {
  state?: PersistedPauseState;
}

function isValidReason(r: unknown): r is PauseReason {
  return r === 'vpn' || r === 'user' || r === 'detector-error';
}

function isValidState(value: unknown): value is PersistedPauseState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<PersistedPauseState>;
  if (!Array.isArray(v.reasons) || !v.reasons.every(isValidReason)) return false;
  if (typeof v.persistedAt !== 'number') return false;
  if (!Array.isArray(v.recentTransitions)) return false;
  return true;
}

export class PausePersistence {
  private store: Store<BackingShape>;

  constructor() {
    this.store = new ElectronStore<BackingShape>({ name: 'pause-state' }) as unknown as Store<BackingShape>;
  }

  load(): PersistedPauseState | null | 'corrupted' {
    const raw = this.store.store?.state;
    if (raw === undefined || raw === null) return null;
    return isValidState(raw) ? raw : 'corrupted';
  }

  save(state: PersistedPauseState): void {
    const trimmed: PersistedPauseState = {
      ...state,
      recentTransitions: state.recentTransitions.slice(-MAX_TRANSITIONS),
    };
    this.store.set('state', trimmed);
  }

  clear(): void {
    this.store.clear();
  }
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
npx vitest run src/main/pause/pause-persistence.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): add pause-state persistence with corruption detection
```

---

### Task 3: PauseCoordinator — reason refcount

**Files:**
- Create: `src/main/pause/pause-coordinator.ts`
- Test: `src/main/pause/pause-coordinator.spec.ts`

- [ ] **Step 1: Write the failing test (state machine basics)**

`src/main/pause/pause-coordinator.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';

let mockBacking: Record<string, unknown> = {};
vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get store() { return mockBacking; },
    set: (k: string, v: unknown) => { mockBacking[k] = v; },
    clear: () => { mockBacking = {}; },
  })),
}));

import { PauseCoordinator } from './pause-coordinator';

describe('PauseCoordinator — refcount', () => {
  beforeEach(() => {
    mockBacking = {};
    PauseCoordinator._resetForTesting();
  });

  it('starts running when persistence is empty', () => {
    const c = PauseCoordinator.getInstance();
    expect(c.isPaused()).toBe(false);
    expect(c.getState().reasons.size).toBe(0);
  });

  it('addReason transitions to paused', () => {
    const c = PauseCoordinator.getInstance();
    c.addReason('vpn');
    expect(c.isPaused()).toBe(true);
    expect(c.getState().reasons.has('vpn')).toBe(true);
  });

  it('multiple reasons act as refcount', () => {
    const c = PauseCoordinator.getInstance();
    c.addReason('vpn');
    c.addReason('user');
    expect(c.getState().reasons.size).toBe(2);

    c.removeReason('vpn');
    expect(c.isPaused()).toBe(true); // user reason still held
    expect(c.getState().reasons.has('user')).toBe(true);

    c.removeReason('user');
    expect(c.isPaused()).toBe(false);
  });

  it('emits "pause" event on first reason added', () => {
    const c = PauseCoordinator.getInstance();
    const onPause = vi.fn();
    c.on('pause', onPause);
    c.addReason('vpn');
    expect(onPause).toHaveBeenCalledOnce();
    c.addReason('user');
    expect(onPause).toHaveBeenCalledOnce(); // not re-fired on subsequent reasons
  });

  it('emits "resume" event only when last reason is removed', () => {
    const c = PauseCoordinator.getInstance();
    const onResume = vi.fn();
    c.on('resume', onResume);
    c.addReason('vpn');
    c.addReason('user');
    c.removeReason('vpn');
    expect(onResume).not.toHaveBeenCalled(); // user still holds
    c.removeReason('user');
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('addReason and removeReason are idempotent', () => {
    const c = PauseCoordinator.getInstance();
    const onPause = vi.fn();
    c.on('pause', onPause);
    c.addReason('vpn');
    c.addReason('vpn');
    c.addReason('vpn');
    expect(onPause).toHaveBeenCalledOnce();
    c.removeReason('user'); // not held
    expect(c.isPaused()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
npx vitest run src/main/pause/pause-coordinator.spec.ts
```

- [ ] **Step 3: Implement minimal coordinator (no persistence yet)**

`src/main/pause/pause-coordinator.ts`:

```typescript
import { EventEmitter } from 'events';
import { PausePersistence, type PauseReason } from './pause-persistence';

export type { PauseReason };

export interface PauseState {
  isPaused: boolean;
  reasons: Set<PauseReason>;
  pausedAt: number | null;
  lastChange: number;
}

export class PauseCoordinator extends EventEmitter {
  private static instance: PauseCoordinator | null = null;

  private state: PauseState = {
    isPaused: false,
    reasons: new Set(),
    pausedAt: null,
    lastChange: Date.now(),
  };
  private persistence = new PausePersistence();

  static getInstance(): PauseCoordinator {
    if (!this.instance) this.instance = new PauseCoordinator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  isPaused(): boolean {
    return this.state.isPaused;
  }

  getState(): Readonly<PauseState> {
    return this.state;
  }

  addReason(source: PauseReason, _meta?: Record<string, unknown>): void {
    const wasPaused = this.state.isPaused;
    if (this.state.reasons.has(source)) return; // idempotent
    this.state.reasons.add(source);
    this.state.isPaused = true;
    this.state.pausedAt ??= Date.now();
    this.state.lastChange = Date.now();
    if (!wasPaused) this.emit('pause', this.state);
    this.emit('change', this.state);
  }

  removeReason(source: PauseReason): void {
    if (!this.state.reasons.has(source)) return;
    this.state.reasons.delete(source);
    this.state.lastChange = Date.now();
    if (this.state.reasons.size === 0) {
      this.state.isPaused = false;
      this.state.pausedAt = null;
      this.emit('resume', this.state);
    }
    this.emit('change', this.state);
  }
}

export function getPauseCoordinator(): PauseCoordinator {
  return PauseCoordinator.getInstance();
}
```

- [ ] **Step 4: Run test (expect pass)**

```bash
npx vitest run src/main/pause/pause-coordinator.spec.ts
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): add PauseCoordinator with reason refcount
```

---

### Task 4: PauseCoordinator — persistence + fail-closed restart

**Files:**
- Modify: `src/main/pause/pause-coordinator.ts`
- Modify: `src/main/pause/pause-coordinator.spec.ts`

- [ ] **Step 1: Add failing tests for restart paths**

Append to `src/main/pause/pause-coordinator.spec.ts`:

```typescript
describe('PauseCoordinator — restart reconciliation', () => {
  beforeEach(() => {
    mockBacking = {};
    PauseCoordinator._resetForTesting();
  });

  it('starts running when no state file', () => {
    const c = PauseCoordinator.getInstance();
    c.bootstrap();
    expect(c.isPaused()).toBe(false);
  });

  it('starts paused with user reason when persistence had user', () => {
    mockBacking['state'] = {
      reasons: ['user'], persistedAt: 1000, recentTransitions: [],
    };
    const c = PauseCoordinator.getInstance();
    c.bootstrap();
    expect(c.isPaused()).toBe(true);
    expect(c.getState().reasons.has('user')).toBe(true);
    expect(c.needsFirstScanForceVpnTreatment()).toBe(false);
  });

  it('starts paused with detector-error and forceVpn flag when persistence had vpn only', () => {
    mockBacking['state'] = {
      reasons: ['vpn'], persistedAt: 1000, recentTransitions: [],
    };
    const c = PauseCoordinator.getInstance();
    c.bootstrap();
    expect(c.isPaused()).toBe(true);
    expect(c.getState().reasons.has('detector-error')).toBe(true);
    expect(c.getState().reasons.has('vpn')).toBe(false); // swapped
    expect(c.needsFirstScanForceVpnTreatment()).toBe(true);
  });

  it('starts paused with detector-error when persistence is corrupted', () => {
    mockBacking['state'] = { reasons: 'malformed', persistedAt: 'oops' };
    const c = PauseCoordinator.getInstance();
    c.bootstrap();
    expect(c.isPaused()).toBe(true);
    expect(c.getState().reasons.has('detector-error')).toBe(true);
    expect(c.needsFirstScanForceVpnTreatment()).toBe(true);
  });

  it('persists reasons on every change', () => {
    const c = PauseCoordinator.getInstance();
    c.bootstrap();
    c.addReason('user');
    expect(mockBacking['state']).toBeDefined();
    const stored = mockBacking['state'] as { reasons: string[] };
    expect(stored.reasons).toEqual(['user']);
  });
});
```

- [ ] **Step 2: Run tests (expect fail — bootstrap/needsFirstScan undefined)**

```bash
npx vitest run src/main/pause/pause-coordinator.spec.ts
```

- [ ] **Step 3: Implement bootstrap + persistence write-through**

Replace the `PauseCoordinator` class body in `src/main/pause/pause-coordinator.ts`:

```typescript
export class PauseCoordinator extends EventEmitter {
  private static instance: PauseCoordinator | null = null;

  private state: PauseState = {
    isPaused: false,
    reasons: new Set(),
    pausedAt: null,
    lastChange: Date.now(),
  };
  private persistence = new PausePersistence();
  private firstScanForceVpn = false;
  private bootstrapped = false;

  static getInstance(): PauseCoordinator {
    if (!this.instance) this.instance = new PauseCoordinator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Read persisted state and apply fail-closed restart reconciliation. */
  bootstrap(): void {
    if (this.bootstrapped) return;
    const loaded = this.persistence.load();

    if (loaded === null) {
      // first launch — running
      this.bootstrapped = true;
      return;
    }
    if (loaded === 'corrupted') {
      // unknown state — fail closed
      this.state.reasons.add('detector-error');
      this.state.isPaused = true;
      this.state.pausedAt = Date.now();
      this.firstScanForceVpn = true;
      this.bootstrapped = true;
      return;
    }

    const reasons = new Set<PauseReason>(loaded.reasons);
    if (reasons.has('vpn') && !reasons.has('user')) {
      // VPN-only: don't trust the stale flag, swap to detector-error
      reasons.delete('vpn');
      reasons.add('detector-error');
      this.firstScanForceVpn = true;
    } else if (reasons.has('detector-error')) {
      this.firstScanForceVpn = true;
    }

    this.state.reasons = reasons;
    this.state.isPaused = reasons.size > 0;
    this.state.pausedAt = this.state.isPaused ? Date.now() : null;
    this.bootstrapped = true;
  }

  needsFirstScanForceVpnTreatment(): boolean {
    return this.firstScanForceVpn;
  }

  /** Called by detector after first scan completes. */
  consumeFirstScanFlag(): void {
    this.firstScanForceVpn = false;
  }

  isPaused(): boolean {
    return this.state.isPaused;
  }

  getState(): Readonly<PauseState> {
    return this.state;
  }

  addReason(source: PauseReason, meta?: Record<string, unknown>): void {
    const wasPaused = this.state.isPaused;
    if (this.state.reasons.has(source)) return;
    const from = [...this.state.reasons];
    this.state.reasons.add(source);
    this.state.isPaused = true;
    this.state.pausedAt ??= Date.now();
    this.state.lastChange = Date.now();
    this.persist(from, [...this.state.reasons], `add:${source}`, meta);
    if (!wasPaused) this.emit('pause', this.state);
    this.emit('change', this.state);
  }

  removeReason(source: PauseReason): void {
    if (!this.state.reasons.has(source)) return;
    const from = [...this.state.reasons];
    this.state.reasons.delete(source);
    this.state.lastChange = Date.now();
    if (this.state.reasons.size === 0) {
      this.state.isPaused = false;
      this.state.pausedAt = null;
      this.persist(from, [], `remove:${source}`);
      this.emit('resume', this.state);
    } else {
      this.persist(from, [...this.state.reasons], `remove:${source}`);
    }
    this.emit('change', this.state);
  }

  private persist(
    from: PauseReason[],
    to: PauseReason[],
    trigger: string,
    _meta?: Record<string, unknown>,
  ): void {
    const existing = this.persistence.load();
    const recent = existing && existing !== 'corrupted' ? existing.recentTransitions : [];
    this.persistence.save({
      reasons: [...this.state.reasons],
      persistedAt: Date.now(),
      recentTransitions: [...recent, { at: Date.now(), from, to, trigger }],
    });
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx vitest run src/main/pause/pause-coordinator.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): coordinator persistence + fail-closed restart reconciliation
```

---

# Phase 1 complete

At this point, `PauseCoordinator` and its persistence layer work in isolation. Phases 2+ build on top of this foundation.

---

# Phase 2 — Allowed-host matcher and network interceptor

This phase builds Layer 3 (the safety primitive) without wiring it into anything yet. The interceptor can be installed/uninstalled in tests and verified against http/https/fetch. No wiring into `src/main/index.ts` yet.

---

### Task 5: Allowed-host matcher

**Files:**
- Create: `src/main/network/allowed-hosts.ts`
- Test: `src/main/network/allowed-hosts.spec.ts`

- [ ] **Step 1: Write the failing test**

`src/main/network/allowed-hosts.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AllowedHostMatcher } from './allowed-hosts';

describe('AllowedHostMatcher', () => {
  it('allows localhost variants by default', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: false });
    expect(m.isAllowed('localhost')).toBe(true);
    expect(m.isAllowed('127.0.0.1')).toBe(true);
    expect(m.isAllowed('::1')).toBe(true);
    expect(m.isAllowed('0.0.0.0')).toBe(true);
  });

  it('does NOT allow public hosts by default', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: false });
    expect(m.isAllowed('api.anthropic.com')).toBe(false);
    expect(m.isAllowed('1.1.1.1')).toBe(false);
  });

  it('blocks RFC 1918 ranges by default', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: false });
    expect(m.isAllowed('10.1.2.3')).toBe(false);
    expect(m.isAllowed('172.16.0.1')).toBe(false);
    expect(m.isAllowed('192.168.1.1')).toBe(false);
  });

  it('allows RFC 1918 when opted in', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: true });
    expect(m.isAllowed('10.1.2.3')).toBe(true);
    expect(m.isAllowed('192.168.1.1')).toBe(true);
    expect(m.isAllowed('api.anthropic.com')).toBe(false);
  });

  it('does not match boundary 172.32.x as private', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: true });
    expect(m.isAllowed('172.32.0.1')).toBe(false);
    expect(m.isAllowed('172.15.0.1')).toBe(false);
  });

  it('returns false for undefined or empty hostname', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: false });
    expect(m.isAllowed(undefined)).toBe(false);
    expect(m.isAllowed('')).toBe(false);
  });

  it('allows configured extra hosts', () => {
    const m = new AllowedHostMatcher({ allowPrivateRanges: false, extraAllowedHosts: ['my-worker.local'] });
    expect(m.isAllowed('my-worker.local')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
npx vitest run src/main/network/allowed-hosts.spec.ts
```

- [ ] **Step 3: Implement**

`src/main/network/allowed-hosts.ts`:

```typescript
export interface AllowedHostsConfig {
  allowPrivateRanges: boolean;
  extraAllowedHosts?: string[];
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

function isPrivateIPv4(hostname: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const m = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(hostname);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

export class AllowedHostMatcher {
  private extra: Set<string>;
  constructor(private cfg: AllowedHostsConfig) {
    this.extra = new Set(cfg.extraAllowedHosts ?? []);
  }

  isAllowed(hostname: string | undefined): boolean {
    if (!hostname) return false;
    if (isLoopback(hostname)) return true;
    if (this.extra.has(hostname)) return true;
    if (this.cfg.allowPrivateRanges && isPrivateIPv4(hostname)) return true;
    return false;
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
npx vitest run src/main/network/allowed-hosts.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): add allowed-host matcher (loopback + private opt-in + extras)
```

---

### Task 6: Network interceptor — install/uninstall + identity restoration

**Files:**
- Create: `src/main/network/install-network-pause-gate.ts`
- Test: `src/main/network/install-network-pause-gate.spec.ts`

- [ ] **Step 1: Write the failing test (install/uninstall identity)**

`src/main/network/install-network-pause-gate.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as https from 'https';
import { installNetworkPauseGate } from './install-network-pause-gate';
import { AllowedHostMatcher } from './allowed-hosts';

interface MockCoordinator { isPaused(): boolean; }
let uninstall: (() => void) | null = null;

describe('installNetworkPauseGate — install/uninstall identity', () => {
  let realHttpRequest: typeof http.request;
  let realHttpGet: typeof http.get;
  let realHttpsRequest: typeof https.request;
  let realHttpsGet: typeof https.get;
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    realHttpRequest = http.request;
    realHttpGet = http.get;
    realHttpsRequest = https.request;
    realHttpsGet = https.get;
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (uninstall) { uninstall(); uninstall = null; }
  });

  it('replaces all five primitives on install', () => {
    const coordinator: MockCoordinator = { isPaused: () => false };
    uninstall = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    expect(http.request).not.toBe(realHttpRequest);
    expect(http.get).not.toBe(realHttpGet);
    expect(https.request).not.toBe(realHttpsRequest);
    expect(https.get).not.toBe(realHttpsGet);
    expect(globalThis.fetch).not.toBe(realFetch);
  });

  it('restores identity on uninstall', () => {
    const coordinator: MockCoordinator = { isPaused: () => false };
    uninstall = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    uninstall();
    uninstall = null;
    expect(http.request).toBe(realHttpRequest);
    expect(http.get).toBe(realHttpGet);
    expect(https.request).toBe(realHttpsRequest);
    expect(https.get).toBe(realHttpsGet);
    expect(globalThis.fetch).toBe(realFetch);
  });
});
```

- [ ] **Step 2: Run test (expect fail)**

```bash
npx vitest run src/main/network/install-network-pause-gate.spec.ts
```

- [ ] **Step 3: Implement**

`src/main/network/install-network-pause-gate.ts`:

```typescript
// IMPORTANT: under the project's CommonJS-emit + esModuleInterop config,
// `import * as http from 'http'` compiles to `__importStar(require('http'))`
// which creates a NEW wrapper object. Mutating that wrapper does not affect
// the actual module export — other code's imports get a different wrapper
// and would bypass our patches.
//
// Instead, use `import = require` form, which compiles to a direct reference
// to the singleton module exports object. Mutations to its properties affect
// every other consumer.
import http = require('http');
import https = require('https');
import type { AllowedHostMatcher } from './allowed-hosts';
import { OrchestratorPausedError } from '../pause/orchestrator-paused-error';

interface CoordinatorLike { isPaused(): boolean; }
interface InstallDeps {
  coordinator: CoordinatorLike;
  allowedHosts: AllowedHostMatcher;
}

/**
 * IPv6 literal hostnames returned by `URL.hostname` are wrapped in square
 * brackets (e.g., `[::1]`). Strip them so the matcher's loopback check
 * (which holds the bare `::1`) works correctly.
 */
function normaliseHostname(hostname: string | undefined): string | undefined {
  if (!hostname) return hostname;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Node's `http.request` accepts `host` as an alias for `hostname`. Unlike
 * `hostname`, `host` may include a `:port` suffix (e.g., 'example.com:8080'
 * or '[::1]:8080'). Strip the port so the result can be compared against
 * the bare-hostname allow-list.
 *
 * Post-review fix: without `host` support, `http.request({ host: '127.0.0.1' })`
 * would be blocked while paused even though loopback is allow-listed.
 */
function stripPort(hostWithPort: string): string {
  // IPv6 literal: '[...]:port' → '[...]' (port comes after the closing bracket)
  if (hostWithPort.startsWith('[')) {
    const close = hostWithPort.indexOf(']');
    if (close !== -1) return hostWithPort.slice(0, close + 1);
    return hostWithPort;
  }
  // IPv4 / hostname: 'name:port' → 'name'. A bare IPv6 (no brackets, has
  // multiple colons) shouldn't appear in `host` per Node convention; we
  // only split on the LAST colon to be safe with future formats.
  const lastColon = hostWithPort.lastIndexOf(':');
  if (lastColon === -1) return hostWithPort;
  // If there's more than one colon, it's likely a bare IPv6 — leave it alone.
  if (hostWithPort.indexOf(':') !== lastColon) return hostWithPort;
  return hostWithPort.slice(0, lastColon);
}

function extractHostname(args: unknown[]): string | undefined {
  const arg = args[0];
  if (typeof arg === 'string') {
    try { return normaliseHostname(new URL(arg).hostname); } catch { return undefined; }
  }
  if (arg instanceof URL) return normaliseHostname(arg.hostname);
  if (arg && typeof arg === 'object') {
    // Prefer `hostname` (canonical), fall back to `host` (Node alias).
    if ('hostname' in arg) {
      const h = (arg as { hostname?: unknown }).hostname;
      if (typeof h === 'string') return normaliseHostname(h);
    }
    if ('host' in arg) {
      const h = (arg as { host?: unknown }).host;
      if (typeof h === 'string') return normaliseHostname(stripPort(h));
    }
  }
  return undefined;
}

function makeGated<F extends (...args: unknown[]) => unknown>(
  scheme: 'http' | 'https',
  real: F,
  deps: InstallDeps,
): F {
  return function gated(this: unknown, ...args: unknown[]): unknown {
    const hostname = extractHostname(args);
    if (!deps.allowedHosts.isAllowed(hostname) && deps.coordinator.isPaused()) {
      throw new OrchestratorPausedError(
        `Network call refused while paused: ${scheme}://${hostname ?? '<unknown>'}`,
        { hostname },
      );
    }
    return real.apply(this, args);
  } as F;
}

function makeGatedFetch(real: typeof globalThis.fetch, deps: InstallDeps): typeof globalThis.fetch {
  return async (input, init) => {
    let hostname: string | undefined;
    try {
      const url = typeof input === 'string'
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL((input as Request).url);
      hostname = normaliseHostname(url.hostname);
    } catch { /* leave undefined */ }
    if (!deps.allowedHosts.isAllowed(hostname) && deps.coordinator.isPaused()) {
      throw new OrchestratorPausedError(
        `Network call refused while paused: fetch ${hostname ?? '<unknown>'}`,
        { hostname },
      );
    }
    return real(input as RequestInfo | URL, init);
  };
}

export function installNetworkPauseGate(deps: InstallDeps): () => void {
  const realHttpRequest = http.request;
  const realHttpGet = http.get;
  const realHttpsRequest = https.request;
  const realHttpsGet = https.get;
  const realFetch = globalThis.fetch;

  http.request = makeGated('http', realHttpRequest as never, deps) as never;
  http.get = makeGated('http', realHttpGet as never, deps) as never;
  https.request = makeGated('https', realHttpsRequest as never, deps) as never;
  https.get = makeGated('https', realHttpsGet as never, deps) as never;
  globalThis.fetch = makeGatedFetch(realFetch, deps);

  return () => {
    http.request = realHttpRequest;
    http.get = realHttpGet;
    https.request = realHttpsRequest;
    https.get = realHttpsGet;
    globalThis.fetch = realFetch;
  };
}
```

- [ ] **Step 4: Run install/uninstall tests (expect pass)**

```bash
npx vitest run src/main/network/install-network-pause-gate.spec.ts
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): network interceptor install/uninstall with identity restoration
```

---

### Task 7: Network interceptor — refusal behaviour tests

**Files:**
- Modify: `src/main/network/install-network-pause-gate.spec.ts`

- [ ] **Step 1: Append refusal-behaviour tests**

Append to `src/main/network/install-network-pause-gate.spec.ts`:

```typescript
import { OrchestratorPausedError } from '../pause/orchestrator-paused-error';

describe('installNetworkPauseGate — refusal while paused', () => {
  let uninstall2: (() => void) | null = null;
  afterEach(() => {
    if (uninstall2) { uninstall2(); uninstall2 = null; }
  });

  it('http.request to non-local host throws when paused', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    expect(() => http.request({ hostname: 'api.openai.com', path: '/' })).toThrow(OrchestratorPausedError);
  });

  it('http.get to non-local host throws when paused', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    expect(() => http.get('http://api.openai.com/')).toThrow(OrchestratorPausedError);
  });

  it('https.request and https.get throw when paused', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    expect(() => https.request({ hostname: 'api.anthropic.com', path: '/' })).toThrow(OrchestratorPausedError);
    expect(() => https.get('https://api.anthropic.com/')).toThrow(OrchestratorPausedError);
  });

  it('fetch rejects with OrchestratorPausedError when paused', async () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    await expect(globalThis.fetch('https://api.anthropic.com/')).rejects.toBeInstanceOf(OrchestratorPausedError);
  });

  it('does NOT throw OrchestratorPausedError for localhost when paused (allow-list)', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    let thrown: unknown = null;
    try {
      const req = http.request({ hostname: 'localhost', port: 1, path: '/', timeout: 1 });
      req.on('error', () => { /* swallow */ });
      req.end();
    } catch (e) { thrown = e; }
    expect(thrown).not.toBeInstanceOf(OrchestratorPausedError);
  });

  it('does NOT throw for http.request({ host: "127.0.0.1" }) when paused (post-review R18)', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    let thrown: unknown = null;
    try {
      const req = http.request({ host: '127.0.0.1', port: 1, path: '/', timeout: 1 });
      req.on('error', () => { /* swallow */ });
      req.end();
    } catch (e) { thrown = e; }
    expect(thrown).not.toBeInstanceOf(OrchestratorPausedError);
  });

  it('does NOT throw for http.request({ host: "127.0.0.1:8080" }) when paused (post-review R18)', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    let thrown: unknown = null;
    try {
      const req = http.request({ host: '127.0.0.1:8080', path: '/', timeout: 1 });
      req.on('error', () => { /* swallow */ });
      req.end();
    } catch (e) { thrown = e; }
    expect(thrown).not.toBeInstanceOf(OrchestratorPausedError);
  });

  it('DOES throw for http.request({ host: "api.example.com" }) when paused (verify host alias still gated)', () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    expect(() =>
      http.request({ host: 'api.example.com', path: '/' }),
    ).toThrow(OrchestratorPausedError);
  });

  it('does NOT throw for IPv6 loopback URL [::1] when paused (post-review R17)', async () => {
    const coordinator = { isPaused: () => true };
    uninstall2 = installNetworkPauseGate({
      coordinator,
      allowedHosts: new AllowedHostMatcher({ allowPrivateRanges: false }),
    });
    // URL.hostname returns '[::1]' (with brackets); the interceptor must
    // strip them before comparing against the allow-list ('::1').
    let fetchThrew = false;
    try {
      // Use port 0 so the connection itself errors fast; we only care that
      // OrchestratorPausedError is NOT raised.
      await globalThis.fetch('http://[::1]:0/').catch(() => null);
    } catch (e) {
      if (e instanceof OrchestratorPausedError) fetchThrew = true;
    }
    expect(fetchThrew).toBe(false);
  });
});
```

- [ ] **Step 2: Run + commit**

```bash
npx vitest run src/main/network/install-network-pause-gate.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
# Checkpoint files: see the task file list above
Checkpoint marker: test(pause): network interceptor refusal for all five primitives
```

---

# Phase 2 complete

---

> **NOTE TO IMPLEMENTER:** From Phase 3 onward, tasks become more terse to keep the plan manageable. Full **production code** is still shown for every implementation step. **Test code** is shown for one or two representative cases per task, with the remaining cases listed as bullet descriptions — the engineer writes idiomatic tests for each. Run + commit are folded into a single closing step.

---

# Phase 3 — VPN detector

The detector polls network interfaces every 2 s and (optionally) probes a host. The state machine is documented in spec §3 — six bugs were fixed across review rounds, so follow this plan literally.

---

### Task 8: VpnDetector — interface state machine

**Files:**
- Create: `src/main/network/vpn-detector.ts`
- Test: `src/main/network/vpn-detector.spec.ts`

- [ ] **Step 1: Write tests (one full + others as bullets)**

`src/main/network/vpn-detector.spec.ts` — one fully-spelled-out case:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { VpnDetector } from './vpn-detector';

vi.mock('os', () => ({ networkInterfaces: vi.fn() }));
import * as os from 'os';

describe('VpnDetector — interface algorithm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (os.networkInterfaces as ReturnType<typeof vi.fn>).mockReturnValue({ lo0: [], en0: [], utun0: [] });
  });

  it('emits vpn-up when a matching interface appears mid-session', () => {
    const d = new VpnDetector({
      pattern: /^utun[0-9]+$/,
      treatExistingAsVpn: false,
      probeMode: 'disabled',
    });
    const onUp = vi.fn();
    d.on('vpn-up', onUp);
    d.start();
    expect(onUp).not.toHaveBeenCalled();

    (os.networkInterfaces as ReturnType<typeof vi.fn>).mockReturnValue({ lo0: [], en0: [], utun0: [], utun5: [] });
    vi.advanceTimersByTime(2000);
    expect(onUp).toHaveBeenCalledOnce();
  });
});
```

Additional cases the engineer must cover (one `it()` each):

- **`treatExistingAsVpn=true` with matching IF at startup → init seeds `activeVpnIfaces`; emits `vpn-up` after init.**
- **`treatExistingAsVpn=false` with matching IF at startup → no emit; seeds `knownNonVpnIfaces`.**
- **Disconnect-then-reconnect of `utun5` → second connect emits `vpn-up` again** (the bug fixed in R6).
- **2-tick flap suppression on disconnect** — single missing tick does NOT emit `vpn-down`; two consecutive do.
- **Pattern recompiles on update; if invalid, falls back to default and emits `detector-error` event.**
- **`forceFirstScanVpnTreatment` flag honoured** — overrides `treatExistingAsVpn=false` for the first scan only.
- **Idempotent emits** — no duplicate `vpn-up` if state stays `up`.

- [ ] **Step 2: Run tests (expect fail)**

```bash
npx vitest run src/main/network/vpn-detector.spec.ts
```

- [ ] **Step 3: Implement detector (interface portion only — probe stubbed)**

`src/main/network/vpn-detector.ts`:

```typescript
import { EventEmitter } from 'events';
import * as os from 'os';

export type ProbeMode = 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';

export interface VpnDetectorConfig {
  pattern: RegExp;
  treatExistingAsVpn: boolean;
  probeMode: ProbeMode;
  probeHost?: string;
  probeIntervalSec?: number;
  forceFirstScanVpnTreatment?: boolean;
}

export interface DetectorEvent {
  at: number;
  interfacesAdded: string[];
  interfacesRemoved: string[];
  matchedPattern: string | null;
  decision: 'no-change' | 'pause' | 'resume' | 'flap-suppressed' | 'detector-error';
  note?: string;
}

const POLL_MS = 2000;
const HEARTBEAT_MS = 10_000;
const RING_BUFFER_MAX = 50;

export class VpnDetector extends EventEmitter {
  private static instance: VpnDetector | null = null;
  private cfg: VpnDetectorConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt = 0;
  private activeVpnIfaces = new Set<string>();
  private knownNonVpnIfaces = new Set<string>();
  private interfaceSignalActive = false;
  private probeSignalActive = false;
  private probeKnown = false;
  private probeNonAffirmativeCount = 0;
  private removalTickCount = 0;
  private lastEmittedVpnUp = false;
  private ringBuffer: DetectorEvent[] = [];

  constructor(cfg: VpnDetectorConfig) {
    super();
    this.cfg = cfg;
  }

  static getInstance(cfg: VpnDetectorConfig): VpnDetector {
    if (!this.instance) this.instance = new VpnDetector(cfg);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  recentEvents(): DetectorEvent[] { return [...this.ringBuffer]; }
  getLastTickAt(): number { return this.lastTickAt; }

  start(): void {
    if (this.timer) return;
    this.init();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  updatePattern(pattern: RegExp): void {
    this.cfg = { ...this.cfg, pattern };
    // Re-evaluate using current interfaces.
    this.tick();
  }

  private init(): void {
    const current = Object.keys(os.networkInterfaces());
    const matching = current.filter(n => this.cfg.pattern.test(n));
    const treatAsVpn = this.cfg.forceFirstScanVpnTreatment || this.cfg.treatExistingAsVpn;
    if (treatAsVpn) {
      this.activeVpnIfaces = new Set(matching);
    } else {
      this.knownNonVpnIfaces = new Set(matching);
    }
    this.lastTickAt = Date.now();
    this.recomputeAggregateAndEmit();
    // First-evaluation completion (post-review):
    // - If probe is disabled, the interface scan IS the full evaluation;
    //   emit immediately so bootstrap can clear `detector-error`.
    // - If probe is configured, defer until the first probe result. The
    //   probe loop is responsible for emitting then.
    if (this.cfg.probeMode === 'disabled') {
      this.emit('first-evaluation-complete');
    }
  }

  private tick(): void {
    let current: string[];
    try {
      current = Object.keys(os.networkInterfaces());
    } catch (err) {
      this.recordEvent({ decision: 'detector-error', note: String(err) });
      this.emit('detector-error', err);
      return;
    }
    const matching = current.filter(n => this.cfg.pattern.test(n));

    // Drop disappeared known-non-vpn names so future reappearances are fresh.
    for (const n of [...this.knownNonVpnIfaces]) {
      if (!current.includes(n)) this.knownNonVpnIfaces.delete(n);
    }

    const newMatches = matching.filter(n => !this.activeVpnIfaces.has(n) && !this.knownNonVpnIfaces.has(n));
    const goneVpn = [...this.activeVpnIfaces].filter(n => !current.includes(n));

    let decision: DetectorEvent['decision'] = 'no-change';
    if (newMatches.length > 0) {
      newMatches.forEach(n => this.activeVpnIfaces.add(n));
      this.removalTickCount = 0;
      decision = 'pause';
    } else if (goneVpn.length > 0) {
      this.removalTickCount += 1;
      if (this.removalTickCount >= 2) {
        goneVpn.forEach(n => this.activeVpnIfaces.delete(n));
        this.removalTickCount = 0;
        decision = 'resume';
      } else {
        decision = 'flap-suppressed';
      }
    } else {
      this.removalTickCount = 0;
    }

    this.lastTickAt = Date.now();
    this.recordEvent({
      decision,
      interfacesAdded: newMatches,
      interfacesRemoved: goneVpn,
    });
    this.recomputeAggregateAndEmit();
  }

  /** Called by probe loop (Task 9) and on every interface tick. */
  protected recomputeAggregateAndEmit(): void {
    this.interfaceSignalActive = this.activeVpnIfaces.size > 0;
    const vpnUp = this.interfaceSignalActive || this.probeSignalActive;

    // Suppress emit during probe-unknown phase
    if (!vpnUp && this.cfg.probeMode !== 'disabled' && !this.probeKnown) {
      return;
    }

    if (vpnUp !== this.lastEmittedVpnUp) {
      if (vpnUp) this.emit('vpn-up', { sources: this.signalSources() });
      else this.emit('vpn-down', { sources: this.signalSources() });
      this.lastEmittedVpnUp = vpnUp;
    }
  }

  private signalSources(): string[] {
    const out: string[] = [];
    if (this.interfaceSignalActive) out.push('interface');
    if (this.probeSignalActive) out.push('probe');
    return out;
  }

  private recordEvent(partial: Partial<DetectorEvent> & { decision: DetectorEvent['decision'] }): void {
    const event: DetectorEvent = {
      at: Date.now(),
      interfacesAdded: partial.interfacesAdded ?? [],
      interfacesRemoved: partial.interfacesRemoved ?? [],
      matchedPattern: this.cfg.pattern.source,
      decision: partial.decision,
      note: partial.note,
    };
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > RING_BUFFER_MAX) this.ringBuffer.shift();
  }

  // Heartbeat watchdog — coordinator polls this externally (see Phase 9 wiring)
  isHeartbeatStale(): boolean {
    return Date.now() - this.lastTickAt > HEARTBEAT_MS;
  }

  // Probe hooks (implemented in Task 9)
  probeKnownNow(): boolean { return this.probeKnown; }
}

export function getVpnDetector(cfg?: VpnDetectorConfig): VpnDetector {
  if (!cfg) {
    const i = VpnDetector['instance'];
    if (!i) throw new Error('VpnDetector not initialised; pass cfg on first call');
    return i;
  }
  return VpnDetector.getInstance(cfg);
}
```

- [ ] **Step 4: Run + commit**

```bash
npx vitest run src/main/network/vpn-detector.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): VpnDetector interface state machine (no probe yet)
```

---

### Task 9: VpnDetector — reachability probe + non-affirmative debounce

**Files:**
- Modify: `src/main/network/vpn-detector.ts`
- Modify: `src/main/network/vpn-detector.spec.ts`

- [ ] **Step 1: Write probe tests (cases as bullets)**

Cases the engineer must add:

- **Probe-disabled mode never sets `probeSignalActive`.**
- **`reachable-means-vpn` mode: probe success → `probeSignalActive=true` → `vpn-up` emitted.**
- **`unreachable-means-vpn` mode: probe failure → `probeSignalActive=true` → `vpn-up` emitted.**
- **Single non-affirmative does NOT clear `probeSignalActive`** (debounce); two consecutive do.
- **Affirmative result resets `probeNonAffirmativeCount`.**
- **`probeKnown` flips to true after first probe attempt** (success or failure).
- **Probe-unknown phase suppresses `vpn-down` emit during init.**

- [ ] **Step 2: Implement probe loop**

Add to `src/main/network/vpn-detector.ts` (within `VpnDetector` class):

```typescript
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  startProbeIfConfigured(): void {
    if (this.cfg.probeMode === 'disabled') return;
    if (!this.cfg.probeHost) return;
    const intervalMs = (this.cfg.probeIntervalSec ?? 30) * 1000;
    if (this.probeTimer) clearInterval(this.probeTimer);
    void this.runProbe();
    this.probeTimer = setInterval(() => void this.runProbe(), intervalMs);
  }

  stopProbe(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  private async runProbe(): Promise<void> {
    if (!this.cfg.probeHost) return;
    const reachable = await this.tcpProbe(this.cfg.probeHost);
    const affirmative = this.cfg.probeMode === 'reachable-means-vpn'
      ? reachable
      : this.cfg.probeMode === 'unreachable-means-vpn'
        ? !reachable
        : false;
    this.onProbeResult(affirmative);
  }

  protected onProbeResult(affirmative: boolean): void {
    const wasKnown = this.probeKnown;
    this.probeKnown = true;
    if (affirmative) {
      this.probeSignalActive = true;
      this.probeNonAffirmativeCount = 0;
    } else {
      this.probeNonAffirmativeCount += 1;
      if (this.probeNonAffirmativeCount >= 2) {
        this.probeSignalActive = false;
        this.probeNonAffirmativeCount = 0;
      }
    }
    this.recomputeAggregateAndEmit();
    // First probe result arrived — full evaluation is now complete.
    // Emit once (idempotent against subsequent probe results).
    if (!wasKnown) {
      this.emit('first-probe-completed');
      this.emit('first-evaluation-complete');
    }
  }

  private async tcpProbe(hostPort: string): Promise<boolean> {
    const [host, portStr] = hostPort.split(':');
    const port = Number(portStr);
    if (!host || !Number.isInteger(port) || port <= 0) return false;
    const net = await import('net');
    return new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      const timeout = setTimeout(() => { socket.destroy(); resolve(false); }, 5000);
      socket.connect(port, host, () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => { clearTimeout(timeout); resolve(false); });
    });
  }
```

Also extend `start()` to call `startProbeIfConfigured()` and `stop()` to call `stopProbe()`.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run src/main/network/vpn-detector.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): detector reachability probe with non-affirmative debounce
```

---

# Phase 3 complete

---

# Phase 4 — Settings types, validators, contracts

---

### Task 10: AppSettings — 9 new keys + DEFAULT_SETTINGS + SETTINGS_METADATA

**Files:**
- Modify: `src/shared/types/settings.types.ts`

- [ ] **Step 1: Extend `AppSettings` interface**

Append to the `AppSettings` interface (alphabetically near "Memory Management" section, or in a new `// Network (Pause on VPN)` section at the end):

```typescript
  // Network (Pause on VPN)
  pauseFeatureEnabled: boolean;            // master kill switch — fully removes feature when false
  pauseOnVpnEnabled: boolean;              // auto-detection master
  pauseVpnInterfacePattern: string;        // regex source string
  pauseTreatExistingVpnAsActive: boolean;  // matching IF at startup counts as VPN-up
  pauseDetectorDiagnostics: boolean;       // verbose detector logging
  pauseReachabilityProbeHost: string;      // 'host:port' or empty
  pauseReachabilityProbeMode: 'disabled' | 'reachable-means-vpn' | 'unreachable-means-vpn';
  pauseReachabilityProbeIntervalSec: number;
  pauseAllowPrivateRanges: boolean;
```

- [ ] **Step 2: Extend `DEFAULT_SETTINGS`**

```typescript
  // Network (Pause on VPN)
  pauseFeatureEnabled: true,
  pauseOnVpnEnabled: true,
  pauseVpnInterfacePattern: '^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$',
  pauseTreatExistingVpnAsActive: true,
  pauseDetectorDiagnostics: false,
  pauseReachabilityProbeHost: '',
  pauseReachabilityProbeMode: 'disabled',
  pauseReachabilityProbeIntervalSec: 30,
  pauseAllowPrivateRanges: false,
```

- [ ] **Step 3: Extend `SettingMetadata.category` union and append entries**

Change:
```typescript
category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review';
```

to:

```typescript
category: 'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'review' | 'network';
```

Append `SETTINGS_METADATA` entries:

```typescript
  // Network (Pause on VPN)
  {
    key: 'pauseFeatureEnabled',
    label: 'Enable VPN pause feature',
    description: 'Master switch. When off, no detector runs and no network interception happens.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseOnVpnEnabled',
    label: 'Pause on VPN',
    description: 'Automatically pause AI traffic when a VPN is detected.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseVpnInterfacePattern',
    label: 'Interface pattern (regex)',
    description: 'Network interface names matching this regex are treated as VPN.',
    type: 'string',
    category: 'network',
  },
  {
    key: 'pauseTreatExistingVpnAsActive',
    label: 'Treat existing VPN as active at startup',
    description: 'If a matching interface is present when the app launches, treat the VPN as already up.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseDetectorDiagnostics',
    label: 'Verbose detection logging',
    description: 'Record every detector tick for calibration.',
    type: 'boolean',
    category: 'network',
  },
  {
    key: 'pauseReachabilityProbeHost',
    label: 'Reachability probe host',
    description: 'host:port for VPN-only reachability check. Empty = disabled.',
    type: 'string',
    category: 'network',
    placeholder: 'host.internal:443',
  },
  {
    key: 'pauseReachabilityProbeMode',
    label: 'Probe mode',
    description: 'How to interpret probe reachability.',
    type: 'select',
    category: 'network',
    options: [
      { value: 'disabled', label: 'Disabled' },
      { value: 'reachable-means-vpn', label: 'Reachable means VPN' },
      { value: 'unreachable-means-vpn', label: 'Unreachable means VPN' },
    ],
  },
  {
    key: 'pauseReachabilityProbeIntervalSec',
    label: 'Probe interval (seconds)',
    description: 'How often to attempt the probe (10–600).',
    type: 'number',
    category: 'network',
    min: 10,
    max: 600,
  },
  {
    key: 'pauseAllowPrivateRanges',
    label: 'Allow RFC 1918 (private ranges) during pause',
    description: 'Default off. Enable only if you have a known-safe local network.',
    type: 'boolean',
    category: 'network',
  },
```

- [ ] **Step 4: Verify + checkpoint**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): add 9 Network category settings + metadata
```

---

### Task 11: Settings validators

**Files:**
- Create: `src/main/core/config/settings-validators.ts`
- Test: `src/main/core/config/settings-validators.spec.ts`
- Modify: `package.json` (add `safe-regex` dep)

- [ ] **Step 1: Add `safe-regex` runtime dependency**

```bash
npm install safe-regex
```

(or `safe-regex2` if `safe-regex` is unmaintained at implementation time — check first.)

- [ ] **Step 2: Write validator tests (cases as bullets)**

Cases the engineer must add:

- **`pauseVpnInterfacePattern`**: empty → reject; valid regex → accept; invalid syntax → reject; catastrophic-backtracking pattern (e.g., `(a+)+b`) → reject; > 200 chars → reject.
- **`pauseReachabilityProbeHost`**: empty → accept (disables probe); `host.internal:443` → accept; `host without port` → reject; `host:99999` → reject (port out of range); 254-char host → reject.
- **`pauseReachabilityProbeMode`**: each of the 3 enum values → accept; `'foo'` → reject.
- **`pauseReachabilityProbeIntervalSec`**: 10 → accept; 600 → accept; 9 → reject; 601 → reject; 30.5 → reject (must be integer).
- **`pauseAllowPrivateRanges`**, **booleans**: `true`/`false` accept; non-boolean → reject.

One example test:

```typescript
import { describe, it, expect } from 'vitest';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';

describe('PAUSE_SETTING_VALIDATORS', () => {
  it('rejects catastrophic-backtracking regex', () => {
    const result = PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern!('(a+)+b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/safe/i);
  });

  it('accepts a valid regex', () => {
    const result = PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern!('^utun[0-9]+$');
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Implement validators**

`src/main/core/config/settings-validators.ts`:

```typescript
import safeRegex from 'safe-regex';
import type { AppSettings } from '../../../shared/types/settings.types';

export type ValidationResult<V> =
  | { ok: true; value: V }
  | { ok: false; error: string };

type Validator<K extends keyof AppSettings> = (value: unknown) => ValidationResult<AppSettings[K]>;

function asBoolean<K extends keyof AppSettings>(): Validator<K> {
  return (v) =>
    typeof v === 'boolean'
      ? { ok: true, value: v as AppSettings[K] }
      : { ok: false, error: `Expected boolean, got ${typeof v}` };
}

const validateRegexString: Validator<'pauseVpnInterfacePattern'> = (v) => {
  if (typeof v !== 'string') return { ok: false, error: 'Expected string' };
  if (v.length === 0 || v.length > 200) return { ok: false, error: 'Length must be 1–200' };
  try {
    new RegExp(v);
  } catch (e) {
    return { ok: false, error: `Invalid regex: ${(e as Error).message}` };
  }
  if (!safeRegex(v)) return { ok: false, error: 'Regex appears unsafe (catastrophic backtracking)' };
  return { ok: true, value: v };
};

const validateHostPort: Validator<'pauseReachabilityProbeHost'> = (v) => {
  if (typeof v !== 'string') return { ok: false, error: 'Expected string' };
  if (v === '') return { ok: true, value: '' };
  const m = /^([a-zA-Z0-9.-]{1,253}):([1-9][0-9]{0,4})$/.exec(v);
  if (!m) return { ok: false, error: 'Expected host:port (host max 253 chars; port 1-65535)' };
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return { ok: false, error: `Port out of range: ${port}` };
  return { ok: true, value: v };
};

const validateProbeMode: Validator<'pauseReachabilityProbeMode'> = (v) => {
  if (v === 'disabled' || v === 'reachable-means-vpn' || v === 'unreachable-means-vpn') {
    return { ok: true, value: v };
  }
  return { ok: false, error: `Invalid mode: ${String(v)}` };
};

const validateIntInRange = (min: number, max: number): Validator<'pauseReachabilityProbeIntervalSec'> => (v) => {
  if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, error: 'Expected integer' };
  if (v < min || v > max) return { ok: false, error: `Out of range ${min}–${max}` };
  return { ok: true, value: v };
};

export const PAUSE_SETTING_VALIDATORS: Partial<{ [K in keyof AppSettings]: Validator<K> }> = {
  pauseFeatureEnabled: asBoolean<'pauseFeatureEnabled'>(),
  pauseOnVpnEnabled: asBoolean<'pauseOnVpnEnabled'>(),
  pauseTreatExistingVpnAsActive: asBoolean<'pauseTreatExistingVpnAsActive'>(),
  pauseDetectorDiagnostics: asBoolean<'pauseDetectorDiagnostics'>(),
  pauseAllowPrivateRanges: asBoolean<'pauseAllowPrivateRanges'>(),
  pauseVpnInterfacePattern: validateRegexString,
  pauseReachabilityProbeHost: validateHostPort,
  pauseReachabilityProbeMode: validateProbeMode,
  pauseReachabilityProbeIntervalSec: validateIntInRange(10, 600),
};
```

- [ ] **Step 4: Wire validator into `SettingsManager` + emit `setting:<key>` from all mutation paths (post-review)**

Two changes to `src/main/core/config/settings-manager.ts`:

(a) Validator hook in `set()` and `update()`:

```typescript
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    const validator = PAUSE_SETTING_VALIDATORS[key];
    if (validator) {
      const result = validator(value);
      if (!result.ok) {
        throw new Error(`Invalid setting ${String(key)}: ${result.error}`);
      }
      value = result.value;
    }
    const normalizedValue =
      key === 'defaultCli' && value === 'openai'
        ? ('codex' as AppSettings[K])
        : value;
    // ... existing body unchanged (already emits setting-changed AND setting:<key>) ...
  }
```

(b) **`update()` and `resetOne()` and `reset()` currently do NOT emit `setting:<key>`** (verified at `settings-manager.ts:211-225, 261-274`). They emit only the generic `setting-changed` and `settings-updated` / `settings-reset`. The bootstrap listeners in Phase 10 use `setting:<key>` exclusively, so a settings import (`update()`) or reset would NOT trigger interceptor/detector rebuilds, leaving the kill switch active until app restart.

Extend each mutation path to also emit `setting:<key>`:

```typescript
  update(settings: Partial<AppSettings>): void {
    for (const [key, value] of Object.entries(settings)) {
      // ... existing per-key validation + normalisation ...
      this.store.set(key as keyof AppSettings, normalizedValue as AppSettings[keyof AppSettings]);
      this.emit('setting-changed', key, normalizedValue);
      this.emit(`setting:${key}`, normalizedValue);     // ← NEW (post-review)
    }
    this.invalidate(3);
    this.emit('settings-updated', this.getAll());
  }

  reset(): void {
    this.store.clear();
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.store.set(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
      this.emit(`setting:${key}`, value);              // ← NEW (post-review)
    }
    this.emit('settings-reset', DEFAULT_SETTINGS);
  }

  resetOne<K extends keyof AppSettings>(key: K): void {
    this.store.set(key, DEFAULT_SETTINGS[key]);
    this.emit('setting-changed', key, DEFAULT_SETTINGS[key]);
    this.emit(`setting:${key}`, DEFAULT_SETTINGS[key]); // ← NEW (post-review)
  }
```

Also apply validators in `update()` per-key (same pattern as `set()`).

This makes the bootstrap's setting listeners fire on imports/resets too, so kill-switch toggles via Settings → Import work correctly.

- [ ] **Step 5: Run + commit**

```bash
npx vitest run src/main/core/config/settings-validators.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): per-key settings validators + safe-regex check
```

---

### Task 12: Pause IPC channels + Zod schemas + contracts package

**Files:**
- Create: `packages/contracts/src/channels/pause.channels.ts`
- Create: `packages/contracts/src/schemas/pause.schemas.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Modify: `packages/contracts/package.json`
- Modify: `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts`, `src/main/register-aliases.ts`

- [ ] **Step 1: Create channel constants**

`packages/contracts/src/channels/pause.channels.ts`:

```typescript
export const PAUSE_CHANNELS = {
  PAUSE_STATE_CHANGED: 'pause:state-changed',
  PAUSE_GET_STATE: 'pause:get-state',
  PAUSE_SET_MANUAL: 'pause:set-manual',
  PAUSE_DETECTOR_RECENT_EVENTS: 'pause:detector-recent-events',
  PAUSE_DETECTOR_RESUME_AFTER_ERROR: 'pause:detector-resume-after-error',
} as const;
```

- [ ] **Step 2: Create Zod schemas**

`packages/contracts/src/schemas/pause.schemas.ts`:

```typescript
import { z } from 'zod';

export const PauseReasonSchema = z.enum(['vpn', 'user', 'detector-error']);

export const PauseStateSchema = z.object({
  isPaused: z.boolean(),
  reasons: z.array(PauseReasonSchema),
  pausedAt: z.number().nullable(),
  lastChange: z.number(),
});

export const PauseSetManualPayloadSchema = z.object({
  paused: z.boolean(),
});

export const PauseDetectorEventSchema = z.object({
  at: z.number(),
  interfacesAdded: z.array(z.string()),
  interfacesRemoved: z.array(z.string()),
  matchedPattern: z.string().nullable(),
  decision: z.enum(['no-change', 'pause', 'resume', 'flap-suppressed', 'detector-error']),
  note: z.string().optional(),
});

export const PauseDetectorRecentEventsResponseSchema = z.object({
  events: z.array(PauseDetectorEventSchema),
});

export type PauseReason = z.infer<typeof PauseReasonSchema>;
export type PauseStatePayload = z.infer<typeof PauseStateSchema>;
```

- [ ] **Step 3: Re-export from channels index + merge into IPC_CHANNELS**

Modify `packages/contracts/src/channels/index.ts`:

```typescript
import { PAUSE_CHANNELS } from './pause.channels';
// ... existing imports ...

export { PAUSE_CHANNELS, /* existing exports */ };

export const IPC_CHANNELS = {
  ...INSTANCE_CHANNELS,
  // ... existing spreads ...
  ...PAUSE_CHANNELS,
} as const;
```

- [ ] **Step 4: Update package.json subpath exports**

In `packages/contracts/package.json` `exports`:

```json
"./channels/pause":  { "types": "./src/channels/pause.channels.ts",  "default": "./src/channels/pause.channels.ts" },
"./schemas/pause":   { "types": "./src/schemas/pause.schemas.ts",    "default": "./src/schemas/pause.schemas.ts" }
```

- [ ] **Step 5: Update path aliases**

In `tsconfig.json`, `tsconfig.electron.json`, `vitest.config.ts`, and `src/main/register-aliases.ts` (`exactAliases`), add entries for `@contracts/channels/pause` and `@contracts/schemas/pause` matching the existing pattern.

- [ ] **Step 6: Verify + checkpoint**

```bash
npm run generate:ipc       # regenerates src/preload/generated/channels.ts
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): IPC channels + Zod schemas + contract subpaths
```

---

### Task 13: Instance queue channels + persisted schema (post-review)

**Files:**
- Modify: `packages/contracts/src/channels/instance.channels.ts`
- Modify: `packages/contracts/src/schemas/instance.schemas.ts`

- [ ] **Step 1: Add channel constants**

Append to `packages/contracts/src/channels/instance.channels.ts`:

```typescript
  // Queue persistence (Pause on VPN feature)
  INSTANCE_QUEUE_SAVE: 'instance:queue:save',
  INSTANCE_QUEUE_LOAD_ALL: 'instance:queue:load-all',
  INSTANCE_QUEUE_INITIAL_PROMPT: 'instance:queue:initial-prompt',
```

- [ ] **Step 2: Add Zod schemas**

Append to `packages/contracts/src/schemas/instance.schemas.ts`:

```typescript
// Persisted form excludes attachment binary data; only a flag remains.
// `kind` MUST be persisted to preserve steering priority across restarts.
export const PersistedQueuedMessageSchema = z.object({
  message: z.string(),
  hadAttachmentsDropped: z.boolean(),
  retryCount: z.number().int().min(0).max(10).optional(),
  seededAlready: z.boolean().optional(),
  kind: z.enum(['queue', 'steer']).optional(),
});

export const InstanceQueueSavePayloadSchema = z.object({
  instanceId: z.string(),
  queue: z.array(PersistedQueuedMessageSchema),
});

export const InstanceQueueLoadAllResponseSchema = z.object({
  queues: z.record(z.string(), z.array(PersistedQueuedMessageSchema)),
});

export const InstanceQueueInitialPromptPayloadSchema = z.object({
  instanceId: z.string(),
  message: z.string(),
  attachments: z.array(FileAttachmentSchema).optional(),
  seededAlready: z.literal(true),
});
```

- [ ] **Step 3: Verify + checkpoint**

```bash
npm run generate:ipc
npm run verify:ipc
npm run verify:exports
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): instance queue IPC channels + persisted schemas
```

---

# Phase 4 complete

---

# Phase 5 — IPC handlers + preload wiring

---

### Task 14: Pause IPC handlers (main side)

**Files:**
- Create: `src/main/ipc/handlers/pause-handlers.ts`
- Test: `src/main/ipc/handlers/pause-handlers.spec.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`

- [ ] **Step 1: Implement handlers**

`src/main/ipc/handlers/pause-handlers.ts`:

```typescript
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import { PauseSetManualPayloadSchema } from '@contracts/schemas/pause';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { getVpnDetector } from '../../network/vpn-detector';
import { getSettingsManager } from '../../core/config/settings-manager';
import { WindowManager } from '../../window-manager';

interface PauseHandlerDeps {
  windowManager: WindowManager;
}

export function registerPauseHandlers(deps: PauseHandlerDeps): void {
  const coordinator = getPauseCoordinator();

  ipcMain.handle(IPC_CHANNELS.PAUSE_GET_STATE, async (): Promise<IpcResponse> => {
    const state = coordinator.getState();
    return { success: true, data: { isPaused: state.isPaused, reasons: [...state.reasons], pausedAt: state.pausedAt, lastChange: state.lastChange } };
  });

  ipcMain.handle(IPC_CHANNELS.PAUSE_SET_MANUAL, async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      // Kill-switch gate (post-review): when pauseFeatureEnabled=false the
      // entire feature is supposed to be inert. Refuse manual-pause requests
      // even if a stale UI somehow rendered the toggle.
      if (!getSettingsManager().get('pauseFeatureEnabled')) {
        return { success: false, error: { code: 'PAUSE_FEATURE_DISABLED', message: 'Pause feature is disabled in settings', timestamp: Date.now() } };
      }
      const { paused } = validateIpcPayload(PauseSetManualPayloadSchema, payload, 'PAUSE_SET_MANUAL');
      if (paused) coordinator.addReason('user');
      else coordinator.removeReason('user');
      return { success: true };
    } catch (e) {
      return { success: false, error: { code: 'PAUSE_SET_MANUAL_FAILED', message: (e as Error).message, timestamp: Date.now() } };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PAUSE_DETECTOR_RECENT_EVENTS, async (): Promise<IpcResponse> => {
    try {
      const events = getVpnDetector().recentEvents();
      return { success: true, data: { events } };
    } catch (e) {
      return { success: false, error: { code: 'PAUSE_DETECTOR_RECENT_EVENTS_FAILED', message: (e as Error).message, timestamp: Date.now() } };
    }
  });

  ipcMain.handle(IPC_CHANNELS.PAUSE_DETECTOR_RESUME_AFTER_ERROR, async (): Promise<IpcResponse> => {
    coordinator.removeReason('detector-error');
    return { success: true };
  });

  // Broadcast on every state change.
  coordinator.on('change', (state) => {
    const payload = { isPaused: state.isPaused, reasons: [...state.reasons], pausedAt: state.pausedAt, lastChange: state.lastChange };
    deps.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.PAUSE_STATE_CHANGED, payload);
  });
}
```

- [ ] **Step 2: Re-export and register**

In `src/main/ipc/handlers/index.ts`, append:

```typescript
export { registerPauseHandlers } from './pause-handlers';
```

In `src/main/ipc/ipc-main-handler.ts` `registerHandlers()`, add (after `registerSettingsHandlers`):

```typescript
    registerPauseHandlers({ windowManager: this.windowManager });
```

- [ ] **Step 3: Verify + checkpoint**

```bash
npx tsc --noEmit
npx eslint src/main/ipc/handlers/pause-handlers.ts src/main/ipc/handlers/index.ts src/main/ipc/ipc-main-handler.ts
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): pause IPC handlers + register from IpcMainHandler
```

Tests for `pause-handlers.spec.ts` should cover: get-state happy path, set-manual true/false toggling, detector-recent-events return shape, resume-after-error removes reason, change broadcast goes to main window.

---

### Task 15: Instance queue handlers + privacy gate

**Files:**
- Modify: `src/main/ipc/handlers/instance-handlers.ts`
- Test: `src/main/ipc/handlers/instance-queue-handlers.spec.ts`

- [ ] **Step 1: Add electron-store namespace + handlers**

In `src/main/ipc/handlers/instance-handlers.ts`, near the top of `registerInstanceHandlers`:

```typescript
import ElectronStore from 'electron-store';
import { InstanceQueueSavePayloadSchema } from '@contracts/schemas/instance';
import { getSettingsManager } from '../../core/config/settings-manager';

interface QueueStoreShape { [instanceId: string]: Array<{
  message: string;
  hadAttachmentsDropped: boolean;
  retryCount?: number;
  seededAlready?: boolean;
  kind?: 'queue' | 'steer';
}>; }

const queueStore = new ElectronStore<QueueStoreShape>({ name: 'instance-message-queue' }) as unknown as {
  store: QueueStoreShape;
  set: (k: string, v: QueueStoreShape[string]) => void;
  delete: (k: string) => void;
  clear: () => void;
};
```

Then register:

```typescript
  ipcMain.handle(IPC_CHANNELS.INSTANCE_QUEUE_SAVE, async (_e, payload: unknown) => {
    try {
      const v = validateIpcPayload(InstanceQueueSavePayloadSchema, payload, 'INSTANCE_QUEUE_SAVE');
      const settings = getSettingsManager();
      if (!settings.get('pauseFeatureEnabled') || !settings.get('persistSessionContent')) {
        return { success: true }; // kill-switch/privacy gate: no-op
      }
      if (v.queue.length === 0) {
        queueStore.delete(v.instanceId);
      } else {
        queueStore.set(v.instanceId, v.queue);
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: { code: 'INSTANCE_QUEUE_SAVE_FAILED', message: (e as Error).message, timestamp: Date.now() } };
    }
  });

  ipcMain.handle(IPC_CHANNELS.INSTANCE_QUEUE_LOAD_ALL, async () => {
    const settings = getSettingsManager();
    if (!settings.get('pauseFeatureEnabled') || !settings.get('persistSessionContent')) {
      return { success: true, data: { queues: {} } };
    }
    return { success: true, data: { queues: queueStore.store ?? {} } };
  });

  // Clear namespace when persistSessionContent flips true → false.
  getSettingsManager().on('setting:persistSessionContent', (value: unknown) => {
    if (value === false) queueStore.clear();
  });
```

- [ ] **Step 2: INPUT_REQUIRED_RESPOND pause gate at the boundary**

In the same file's `INPUT_REQUIRED_RESPOND` handler, add pause check as the FIRST statement after `validateIpcPayload`:

```typescript
        if (getPauseCoordinator().isPaused()) {
          return { success: false, error: { code: 'ORCHESTRATOR_PAUSED', message: 'Orchestrator is paused. Resume to respond.', timestamp: Date.now() } };
        }
```

This covers all three branches (`deferred_permission`, `permission_denial`, generic).

- [ ] **Step 3: Verify + checkpoint**

```bash
npx vitest run src/main/ipc/handlers/instance-queue-handlers.spec.ts
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): queue persistence handlers + INPUT_REQUIRED_RESPOND gate
```

Test cases: SAVE while `persistSessionContent=false` writes nothing; LOAD_ALL while off returns empty; flipping setting `true→false` clears the namespace; queue with empty array deletes the instance entry; INPUT_REQUIRED_RESPOND while paused returns `ORCHESTRATOR_PAUSED` for all three branches.

---

### Task 16: Pause preload domain + composition

**Files:**
- Create: `src/preload/domains/pause.preload.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/preload/domains/instance.preload.ts`

- [ ] **Step 1: Create pause domain**

`src/preload/domains/pause.preload.ts`:

```typescript
import type { IpcRenderer, IpcRendererEvent } from 'electron';

export interface PauseStatePayload {
  isPaused: boolean;
  reasons: string[];
  pausedAt: number | null;
  lastChange: number;
}

export interface DetectorEvent {
  at: number;
  interfacesAdded: string[];
  interfacesRemoved: string[];
  matchedPattern: string | null;
  decision: string;
  note?: string;
}

export function createPauseDomain(ipcRenderer: IpcRenderer, channels: Record<string, string>) {
  return {
    pauseGetState: () => ipcRenderer.invoke(channels['PAUSE_GET_STATE']),
    pauseSetManual: (paused: boolean) => ipcRenderer.invoke(channels['PAUSE_SET_MANUAL'], { paused }),
    pauseDetectorRecentEvents: () => ipcRenderer.invoke(channels['PAUSE_DETECTOR_RECENT_EVENTS']),
    pauseDetectorResumeAfterError: () => ipcRenderer.invoke(channels['PAUSE_DETECTOR_RESUME_AFTER_ERROR']),
    onPauseStateChanged: (cb: (state: PauseStatePayload) => void) => {
      const listener = (_e: IpcRendererEvent, state: PauseStatePayload) => cb(state);
      ipcRenderer.on(channels['PAUSE_STATE_CHANGED'], listener);
      return () => ipcRenderer.removeListener(channels['PAUSE_STATE_CHANGED'], listener);
    },
  };
}
```

- [ ] **Step 2: Compose into preload**

In `src/preload/preload.ts`:

```typescript
import { createPauseDomain } from './domains/pause.preload';
// ...

const electronAPI = {
  // ...existing spreads...
  ...createPauseDomain(ipcRenderer, IPC_CHANNELS),
};
```

- [ ] **Step 3: Add queue methods to instance domain**

In `src/preload/domains/instance.preload.ts`, return methods (alongside existing):

```typescript
    instanceQueueSave: (instanceId: string, queue: unknown[]) =>
      ipcRenderer.invoke(channels['INSTANCE_QUEUE_SAVE'], { instanceId, queue }),
    instanceQueueLoadAll: () => ipcRenderer.invoke(channels['INSTANCE_QUEUE_LOAD_ALL']),
    onInstanceQueueInitialPrompt: (cb: (payload: unknown) => void) => {
      const listener = (_e: unknown, p: unknown) => cb(p);
      ipcRenderer.on(channels['INSTANCE_QUEUE_INITIAL_PROMPT'], listener);
      return () => ipcRenderer.removeListener(channels['INSTANCE_QUEUE_INITIAL_PROMPT'], listener);
    },
```

- [ ] **Step 4: Verify + checkpoint**

```bash
npm run generate:ipc
npm run verify:ipc
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): preload pause domain + instance queue methods
```

---

### Task 16b: Renderer IPC services for pause + instance queue (post-review)

**Files:**
- Create: `src/renderer/app/core/services/ipc/pause-ipc.service.ts`
- Modify: `src/renderer/app/core/services/ipc/instance-ipc.service.ts`
- Modify: `src/renderer/app/core/services/ipc/index.ts` (the actual facade — `IpcFacadeService` exported as `ElectronIpcService`)

**Why this task exists:** in this repo, `electron-ipc.service.ts` is the **low-level base service** (the IPC bridge). The actual **facade** is `IpcFacadeService` in `index.ts:92`, which is re-exported as `ElectronIpcService` for backwards compatibility. Adding domain-service injections to the base would create a DI cycle (base would depend on services that depend on base). Bindings must live on `IpcFacadeService` in `index.ts`.

The renderer `IpcResponse` type (`electron-ipc.service.ts:14-17`) only allows `error: { message: string }` — no `code` or `timestamp` (those are main-process shape). Fallback objects must match.

- [ ] **Step 1: Create `PauseIpcService`** (mirrors the existing `InstanceIpcService` pattern verbatim — verified at `instance-ipc.service.ts:31-41`: domain services inject `ElectronIpcService` from `./electron-ipc.service`, expose private `api` / `ngZone` getters via `this.base.getApi()` / `this.base.getNgZone()`)

`src/renderer/app/core/services/ipc/pause-ipc.service.ts`:

```typescript
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

interface PauseStatePayload {
  isPaused: boolean;
  reasons: string[];
  pausedAt: number | null;
  lastChange: number;
}

interface DetectorEvent {
  at: number;
  interfacesAdded: string[];
  interfacesRemoved: string[];
  matchedPattern: string | null;
  decision: string;
  note?: string;
}

const NOT_IN_ELECTRON: IpcResponse = { success: false, error: { message: 'Not in Electron' } };

@Injectable({ providedIn: 'root' })
export class PauseIpcService {
  private base = inject(ElectronIpcService);

  private get api() { return this.base.getApi(); }
  private get ngZone() { return this.base.getNgZone(); }

  async pauseGetState(): Promise<IpcResponse> {
    if (!this.api?.pauseGetState) return NOT_IN_ELECTRON;
    return this.api.pauseGetState();
  }

  async pauseSetManual(paused: boolean): Promise<IpcResponse> {
    if (!this.api?.pauseSetManual) return NOT_IN_ELECTRON;
    return this.api.pauseSetManual({ paused });
  }

  async pauseDetectorRecentEvents(): Promise<IpcResponse> {
    if (!this.api?.pauseDetectorRecentEvents) return NOT_IN_ELECTRON;
    return this.api.pauseDetectorRecentEvents();
  }

  async pauseDetectorResumeAfterError(): Promise<IpcResponse> {
    if (!this.api?.pauseDetectorResumeAfterError) return NOT_IN_ELECTRON;
    return this.api.pauseDetectorResumeAfterError();
  }

  onPauseStateChanged(cb: (state: PauseStatePayload) => void): () => void {
    if (!this.api?.onPauseStateChanged) return () => { /* noop in non-Electron */ };
    return this.api.onPauseStateChanged((state) => this.ngZone.run(() => cb(state)));
  }
}
```

(`BaseIpcService` is just a barrel alias re-exported from `index.ts`; importing it from a domain service would cause a circular import. Always import the concrete `ElectronIpcService` from `./electron-ipc.service` directly.)

- [ ] **Step 2: Add queue methods to `InstanceIpcService`** (mirror the existing private-getter accessor pattern verified at `instance-ipc.service.ts:35-41`: `this.api` and `this.ngZone` are private getters, NOT methods; do not invent new accessors)

Add to `src/renderer/app/core/services/ipc/instance-ipc.service.ts` (anywhere among the existing methods — pattern-match the file style):

```typescript
const NOT_IN_ELECTRON: IpcResponse = { success: false, error: { message: 'Not in Electron' } };

  async instanceQueueSave(instanceId: string, queue: unknown[]): Promise<IpcResponse> {
    if (!this.api?.instanceQueueSave) return NOT_IN_ELECTRON;
    return this.api.instanceQueueSave({ instanceId, queue });
  }

  async instanceQueueLoadAll(): Promise<IpcResponse> {
    if (!this.api?.instanceQueueLoadAll) return NOT_IN_ELECTRON;
    return this.api.instanceQueueLoadAll();
  }

  onInstanceQueueInitialPrompt(cb: (payload: unknown) => void): () => void {
    if (!this.api?.onInstanceQueueInitialPrompt) return () => { /* noop in non-Electron */ };
    return this.api.onInstanceQueueInitialPrompt((p) => this.ngZone.run(() => cb(p)));
  }
```

(Use `this.api` / `this.ngZone` — the existing private getters. Do NOT introduce `getApi()` or `zone` aliases.)

- [ ] **Step 3: Bind the new methods on the real facade (`IpcFacadeService` in `index.ts`)**

The facade is `IpcFacadeService` exported from `core/services/ipc/index.ts:92` (re-exported as `ElectronIpcService` for backwards compatibility — verified in this codebase). Bindings live there, NOT in `electron-ipc.service.ts` (which is the low-level base).

In `src/renderer/app/core/services/ipc/index.ts`, inside the `IpcFacadeService` class:

(a) Inject `PauseIpcService`:

```typescript
  readonly pause = inject(PauseIpcService);
```

(`InstanceIpcService` is already injected as `readonly instance = inject(InstanceIpcService);` on line ~96.)

(b) Add forwarder methods that call into the domain services. Place these near the other forwarders (the file already follows this pattern for hundreds of methods). Add **between existing fields and the closing brace** — preserve every other line:

```typescript
  // Pause IPC (post-review forwarders)
  pauseGetState = () => this.pause.pauseGetState();
  pauseSetManual = (paused: boolean) => this.pause.pauseSetManual(paused);
  pauseDetectorRecentEvents = () => this.pause.pauseDetectorRecentEvents();
  pauseDetectorResumeAfterError = () => this.pause.pauseDetectorResumeAfterError();
  onPauseStateChanged = (cb: Parameters<PauseIpcService['onPauseStateChanged']>[0]) =>
    this.pause.onPauseStateChanged(cb);

  // Instance queue persistence (post-review forwarders)
  instanceQueueSave = (instanceId: string, queue: unknown[]) =>
    this.instance.instanceQueueSave(instanceId, queue);
  instanceQueueLoadAll = () => this.instance.instanceQueueLoadAll();
  onInstanceQueueInitialPrompt = (cb: Parameters<InstanceIpcService['onInstanceQueueInitialPrompt']>[0]) =>
    this.instance.onInstanceQueueInitialPrompt(cb);
```

Add the imports at the top of the file:

```typescript
import { PauseIpcService } from './pause-ipc.service';
```

(`InstanceIpcService` is already imported.)

The exported `ElectronIpcService` alias at the bottom of `index.ts` (around line 593) automatically picks up these new methods because it is `IpcFacadeService` itself.

- [ ] **Step 4: Re-export from barrel**

In `src/renderer/app/core/services/ipc/index.ts`:

```typescript
export { PauseIpcService } from './pause-ipc.service';
```

- [ ] **Step 5: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
# Checkpoint: "feat(pause): renderer pause/queue IPC services + facade bindings"
```

---

# Phase 5 complete

---

# Phase 6 — CLI adapter template-method refactor

This is the trickiest mechanical change because it touches 8 files (1 base + 7 concrete) and their tests. The base class needs a concrete public `sendInput` calling a `protected abstract sendInputImpl`. Six adapters extend `BaseCliAdapter` and rename. `RemoteCliAdapter` does NOT extend `BaseCliAdapter` and gets an explicit pause check inside its existing method.

---

### Task 17: BaseCliAdapter — add concrete `sendInput` + abstract `sendInputImpl`

**Files:**
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`

- [ ] **Step 1: Add concrete `sendInput` and abstract `sendInputImpl`**

Inside the `BaseCliAdapter` class body (place near the existing abstract methods around line 326-356):

```typescript
  /**
   * Public send entry point. Gates on the PauseCoordinator before delegating
   * to the subclass-specific implementation. Subclasses MUST implement
   * `sendInputImpl`, NOT override `sendInput`.
   */
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    const { getPauseCoordinator } = await import('../../pause/pause-coordinator');
    const { OrchestratorPausedError } = await import('../../pause/orchestrator-paused-error');
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError(`adapter.sendInput refused while paused`);
    }
    return this.sendInputImpl(message, attachments);
  }

  protected abstract sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void>;
```

(`FileAttachment` should already be imported in this file; if not, import from `../../../shared/types/instance.types`.)

- [ ] **Step 2: Do NOT verify yet — proceed directly to Task 18**

The base-class change makes the concrete adapters (each defines its own `sendInput`) fail compilation under `noImplicitOverride`. **Tasks 17 and 18 are executed atomically as one logical step — no checkpoint between them.**

Do not run `tsc` between Task 17 and Task 18. Do not stage or commit the partial change. Move directly to Task 18.

---

### Task 18: Rename `sendInput` → `sendInputImpl` in 6 concrete adapters

**Files:**
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts:856`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts:466`
- Modify: `src/main/cli/adapters/copilot-cli-adapter.ts:934`
- Modify: `src/main/cli/adapters/gemini-cli-adapter.ts` (line at impl time)
- Modify: `src/main/cli/adapters/cursor-cli-adapter.ts` (line at impl time)
- Modify: `src/main/cli/adapters/acp-cli-adapter.ts:430`

- [ ] **Step 1: For each of the six files, rename**

Change:

```typescript
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
```

to:

```typescript
  protected override async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
```

(The `override` modifier is required by `noImplicitOverride`. The body of the method is untouched.)

- [ ] **Step 2: Verify all adapters compile**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: clean (or only failures in adapter spec files, fixed next step).

- [ ] **Step 3: Update adapter specs that subclass for testing**

Search for spec files that subclass an adapter and override `sendInput`:

```bash
grep -rln "extends ClaudeCliAdapter\|extends CodexCliAdapter\|extends CopilotCliAdapter\|extends GeminiCliAdapter\|extends CursorCliAdapter\|extends AcpCliAdapter" src/main/cli/adapters
```

For any matches, rename the test subclass's override from `sendInput` → `sendInputImpl`.

- [ ] **Step 4: Run all adapter specs**

```bash
npx vitest run src/main/cli/adapters/
```

- [ ] **Step 5: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: refactor(cli): rename adapter sendInput → sendInputImpl (template method)
```

---

### Task 19: RemoteCliAdapter — explicit pause check (no rename)

**Files:**
- Modify: `src/main/cli/adapters/remote-cli-adapter.ts:159-173`

- [ ] **Step 1: Add pause check at top of existing `sendInput`**

Insert as the new first statement:

```typescript
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    const { getPauseCoordinator } = await import('../../pause/pause-coordinator');
    const { OrchestratorPausedError } = await import('../../pause/orchestrator-paused-error');
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError(`adapter.sendInput refused while paused (remote)`);
    }
    if (!this.remoteInstanceId) {
      throw new Error('RemoteCliAdapter: not spawned — call spawn() before sendInput()');
    }
    // ... existing body unchanged ...
```

(Do NOT rename to `sendInputImpl`; this class extends `EventEmitter`, not `BaseCliAdapter`.)

- [ ] **Step 2: Run + commit**

```bash
npx tsc --noEmit
npx vitest run src/main/cli/adapters/
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): RemoteCliAdapter explicit pause check (special case)
```

Test: with mock coordinator paused, `RemoteCliAdapter.sendInput()` throws `OrchestratorPausedError` and does NOT call `nodeConnection.sendRpc`.

---

# Phase 6 complete

All `adapter.sendInput()` calls in the codebase are now gated when paused. The 14+ direct call sites in `instance-lifecycle.ts` are covered by this without further changes (their existing error handlers need the `OrchestratorPausedError` branch — added in Phase 7 Task 20).

---

# Phase 7 — Subsystem hooks (main process)

---

### Task 20: instance-lifecycle.ts — initial-prompt error handling

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts:1273-1287` (warm path)
- Modify: `src/main/instance/instance-lifecycle.ts:1363-1378` (cold path)
- Modify: `src/main/instance/instance-communication.ts` (add `queueInitialPromptForRenderer` helper)

- [ ] **Step 1: Add helper to InstanceCommunication**

Add to `src/main/instance/instance-communication.ts`:

```typescript
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { WindowManager } from '../window-manager';

  /**
   * Route an initial-prompt message to the renderer's per-instance queue
   * when the orchestrator is paused at instance-creation time. The renderer
   * inserts the message with seededAlready=true so the user-bubble already
   * in the output buffer is not duplicated on drain.
   */
  queueInitialPromptForRenderer(
    windowManager: WindowManager,
    payload: { instanceId: string; message: string; attachments?: FileAttachment[] },
  ): void {
    windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.INSTANCE_QUEUE_INITIAL_PROMPT, {
      ...payload,
      seededAlready: true as const,
    });
  }
```

(Wire `windowManager` into `InstanceCommunication` constructor or via `deps` if not already passed.)

- [ ] **Step 2: Add `OrchestratorPausedError` branch in lifecycle.ts:1273**

Find the warm-path catch block (line ~1273):

```typescript
            } catch (error) {
              this.transitionState(instance, 'failed');
              // ... existing failure handling ...
            }
```

Replace with:

```typescript
            } catch (error) {
              const { isOrchestratorPausedError } = await import('../pause/orchestrator-paused-error');
              if (isOrchestratorPausedError(error)) {
                logger.info('Initial prompt queued — orchestrator paused', { instanceId: instance.id });
                this.deps.queueInitialPromptForRenderer({
                  instanceId: instance.id,
                  message: initialUserMessage.content,
                  attachments: config.attachments,
                });
                // Instance stays in idle/ready; the message will drain on resume.
                return;
              }
              this.transitionState(instance, 'failed');
              // ... existing failure handling preserved ...
            }
```

Apply the SAME branch logic at the cold-path catch block (line ~1363).

- [ ] **Step 3: Wire `queueInitialPromptForRenderer` into LifecycleDependencies**

(post-review concrete dependency path — `InstanceLifecycle.deps` is typed as `LifecycleDependencies`; this interface needs the new field, and the construction site needs to supply it.)

(a) In `src/main/instance/instance-lifecycle.ts:194` extend the interface:

```typescript
export interface LifecycleDependencies {
  // ... existing fields ...
  queueInitialPromptForRenderer: (payload: {
    instanceId: string;
    message: string;
    attachments?: FileAttachment[];
  }) => void;
}
```

(b) `InstanceManager` does not currently hold a `WindowManager` reference. The wiring path: `WindowManager` lives at the `Application` level (where `InstanceManager` is constructed).

**Make the new constructor argument OPTIONAL** to avoid breaking the multiple `new InstanceManager(...)` test sites (verified — exists in `src/main/instance/__tests__/instance-manager.spec.ts` and `src/main/instance/__tests__/instance-manager.normalized-event.spec.ts`). When omitted (in tests), `queueInitialPromptForRenderer` falls back to a no-op — tests don't exercise the queue-routing path.

In `src/main/instance/instance-manager.ts`:

```typescript
import { WindowManager } from '../window-manager';

  constructor(
    // ... existing args preserved in original order ...
    private windowManager?: WindowManager,
  ) {
    // ... existing body ...
  }
```

In wherever `InstanceManager` builds its `LifecycleDependencies` (the existing `forEachInstance`/`getInstance`/etc. block — typically around line 261):

```typescript
      // ... existing fields preserved ...
      queueInitialPromptForRenderer: (payload) => {
        if (!this.windowManager) {
          logger.warn('queueInitialPromptForRenderer: no WindowManager (test mode?), dropping initial-prompt-while-paused', { instanceId: payload.instanceId });
          return;
        }
        this.communication.queueInitialPromptForRenderer(this.windowManager, payload);
      },
```

(c) Update the production bootstrap to pass `windowManager`. Search for the existing `new InstanceManager(...)` invocation in `src/main/index.ts` and add `windowManager` as the new last constructor argument.

(d) **Test sites left untouched:** `instance-manager.spec.ts` and `instance-manager.normalized-event.spec.ts` continue to construct `InstanceManager` without the new arg. They compile because `windowManager?` is optional, and `queueInitialPromptForRenderer` is a no-op in their context (they don't trigger initial-prompt-while-paused flows).

Add an explicit unit test verifying the optional path:

```typescript
it('does not throw when initial prompt is queued without a WindowManager (test mode)', async () => {
  const manager = new InstanceManager(/* existing args */);    // no windowManager
  // ... simulate paused initial-prompt path ...
  // assert: no exception, log message emitted
});
```

- [ ] **Step 4: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/main/instance/
# Checkpoint files: see the task file list above
# Checkpoint: "feat(pause): initial-prompt error handling routes to renderer queue when paused"
```

(R12 added `WindowManager` to `InstanceManager`'s constructor and the production `new InstanceManager(...)` call site in `src/main/index.ts`. R16 fix: those changes are part of this same logical task and MUST be in the same checkpoint — staging only the lifecycle files would leave the branch broken.)

---

### Task 21: InstanceManager — pause listener that interrupts active turns

**Files:**
- Modify: `src/main/instance/instance-manager.ts`

- [ ] **Step 1: Subscribe to coordinator on construction**

In `InstanceManager` constructor (after instance-state setup):

```typescript
import { getPauseCoordinator } from '../pause/pause-coordinator';

    getPauseCoordinator().on('pause', () => {
      this.state.forEachInstance((instance, id) => {
        const adapter = this.getAdapter(id);
        if (!adapter) return;
        if (instance.status === 'busy' || instance.status === 'processing' || instance.status === 'thinking_deeply') {
          try {
            adapter.interrupt();
            logger.info('Pause: interrupted active turn', { instanceId: id, status: instance.status });
          } catch (e) {
            logger.warn('Pause: interrupt failed', { instanceId: id, error: String(e) });
          }
        }
      });
    });
```

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/main/instance/__tests__/instance-manager.spec.ts
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): InstanceManager interrupts active turns on pause event
```

Test: pause event with two `busy` instances → `adapter.interrupt()` called on both; pause event with no busy instances → no calls.

---

### Task 22: CrossModelReviewService — abort + skip-on-paused

**Files:**
- Modify: `src/main/orchestration/cross-model-review-service.ts`

- [ ] **Step 1: Verify the existing service shape**

Verified at `cross-model-review-service.ts:54`: the service already has `private pendingReviews = new Map<string, AbortController>()`, and `onInstanceIdle(instanceId: string): Promise<void>` is the public entry point. No need for a parallel `activeAborters` set — reuse `pendingReviews`.

- [ ] **Step 2: Add isPaused flag + subscribe to coordinator (uses existing `pendingReviews`)**

Inside `CrossModelReviewService`:

```typescript
import { getPauseCoordinator } from '../pause/pause-coordinator';

  // Seed from current coordinator state (post-review). The coordinator may
  // already be paused at construction time — e.g., fail-closed restart with
  // persisted vpn/detector-error reasons. Initialising to `false` and
  // relying on future events would miss the startup-paused window.
  private isPaused = getPauseCoordinator().isPaused();

  // In constructor or init():
  getPauseCoordinator().on('pause', () => {
    this.isPaused = true;
    // Abort all currently-tracked review controllers.
    for (const abort of this.pendingReviews.values()) abort.abort();
    this.pendingReviews.clear();
  });
  getPauseCoordinator().on('resume', () => {
    this.isPaused = false;
  });
```

- [ ] **Step 3: Gate `onInstanceIdle` (return `void`, matching existing signature)**

At the top of `onInstanceIdle(instanceId)`:

```typescript
  async onInstanceIdle(instanceId: string): Promise<void> {
    if (this.isPaused) {
      logger.info('Cross-model review skipped — orchestrator paused', { instanceId });
      return;     // matches existing Promise<void> return
    }
    // ... existing body unchanged ...
  }
```

(No `{ skipped: true } as never` cast — the existing return type is already `Promise<void>`.)

- [ ] **Step 4: Acknowledge in-flight adapter limitation**

The `pendingReviews` controllers stop the orchestrator's *abortable* portion (waiting on the adapter's response stream). They do NOT terminate the spawned review-adapter process; an in-flight `adapter.sendMessage()` call on the review side may continue until its existing timeout. This is documented in `docs/pause-on-vpn.md` under "What pause cannot fully prevent" — Layer 3 (network interceptor) catches subsequent outbound HTTPS, so user content stops crossing the VPN even if the review adapter's process technically remains alive briefly.

- [ ] **Step 3: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/main/orchestration/cross-model-review-service.spec.ts
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): cross-model review aborts in-flight + skips while paused
```

---

### Task 23: ProviderQuotaService — isPaused gate (leave timers installed)

**Files:**
- Modify: `src/main/core/system/provider-quota-service.ts`

- [ ] **Step 1: Add isPaused flag + AbortController set + subscribe**

```typescript
import { getPauseCoordinator } from '../../pause/pause-coordinator';

  // Seed from coordinator (post-review): the coordinator may already be
  // paused at construction time (fail-closed restart). See same fix in
  // CrossModelReviewService.
  private isPaused = getPauseCoordinator().isPaused();
  private activeAborters = new Set<AbortController>();

  // In constructor:
  getPauseCoordinator().on('pause', () => {
    this.isPaused = true;
    for (const c of this.activeAborters) c.abort();
    this.activeAborters.clear();
  });
  getPauseCoordinator().on('resume', () => {
    this.isPaused = false;
  });
```

- [ ] **Step 2: Gate refresh entry points + register the local AbortController**

Verified at `provider-quota-service.ts:102`: `refresh(provider)` already does `const ac = new AbortController()` and passes `{ signal: ac.signal }` to the probe. Wire that controller into `activeAborters`:

```typescript
  async refresh(provider: ProviderId): Promise<ProviderQuotaSnapshot | null> {
    if (this.isPaused) {
      logger.info('Quota refresh skipped — orchestrator paused', { provider });
      return null;
    }

    // ... existing setup ...
    const ac = new AbortController();
    this.activeAborters.add(ac);                // post-review: register
    try {
      const result = await probe.probe({ signal: ac.signal });
      // ... existing success-path body ...
      return result;
    } catch (err) {
      // Suppress abort errors when pause aborted us (post-review): without
      // this guard, the existing catch path stores an ok:false error
      // snapshot for the abort, which contradicts the design promise of
      // "leave the previous good snapshot, don't emit a new one." The
      // existing storeSnapshot(errSnap) call lives further down the
      // catch — bail BEFORE reaching it for pause-aborts only.
      if (ac.signal.aborted && this.isPaused) {
        logger.info('Quota probe aborted by pause — preserving last snapshot', { provider });
        return null;
      }
      // ... existing non-abort error handling preserved (storeSnapshot etc.) ...
      throw err;
    } finally {
      this.activeAborters.delete(ac);           // post-review: deregister
    }
  }
```

(Apply the same gate to `refreshAll()` if it doesn't already delegate to `refresh()`.)

The existing `setInterval` body in `startPolling` already calls `refresh()`; with the above gate, the tick is naturally a no-op while paused. **Do not modify `startPolling`/`stopPolling` to clear timers on pause** (verified — clearing would lose the configured interval).

- [ ] **Step 3: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/main/core/system/
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): quota service no-ops on paused (leaves timers installed)
```

---

### Task 24: settings-export — regression test for namespace exclusion

**Files:**
- Create or modify: `src/main/core/config/__tests__/settings-export.spec.ts`

- [ ] **Step 1: Verify the existing export shape (post-review)**

Verified at `src/main/core/config/settings-export.ts:48`: `buildExportData()` does NOT iterate electron-store namespaces. It builds export data from:
- `settings.getAll()` (only `AppSettings`)
- explicit `credStore.getAll()` and `policyStore.getAll()` calls
- (no other namespace enumeration)

The new `pause-state` and `instance-message-queue` electron-store namespaces are therefore **already absent from export by construction** — there is no loop that would pick them up.

This means the originally-planned code change is a no-op. Replace the task with a **regression test** that locks the exclusion in place so a future edit to `settings-export.ts` (e.g., someone adds a "snapshot all stores" feature) doesn't accidentally pull these namespaces in.

- [ ] **Step 2: Add the regression test (with required module mocks)**

`buildExportData()` touches `electron`, `getRLMDatabase()`, `ChannelCredentialStore`, `ChannelAccessPolicyStore`, and `getSettingsManager()` — without mocks the test would open real persistence or throw. Mock them up-front, mirroring the style of nearby config tests:

`src/main/core/config/__tests__/settings-export.spec.ts` (new file):

```typescript
import { describe, it, expect, vi } from 'vitest';

// Mocks must be hoisted above the SUT import so vi.mock() takes effect.
// Verified imports/usage in settings-export.ts:
//   line 15: import { getRLMDatabase } from '../../persistence/rlm-database';
//   line 50: getRLMDatabase().getRawDb()
//   line 51: new ChannelCredentialStore(db)
//   line 52: new ChannelAccessPolicyStore(db)
//   line 72: app.getVersion()

// All mock specifiers below are RELATIVE TO THE TEST FILE
// (src/main/core/config/__tests__/settings-export.spec.ts), NOT the SUT.
// SUT imports verified at settings-export.ts:9-15:
//   line 9:  import { app, dialog } from 'electron';
//   line 13: from '../../channels/channel-credential-store'
//            → src/main/channels/channel-credential-store
//            from test file: ../../../channels/channel-credential-store
//   line 14: from '../../channels/channel-access-policy-store'
//            from test file: ../../../channels/channel-access-policy-store
//   line 15: from '../../persistence/rlm-database'
//            → src/main/persistence/rlm-database
//            from test file: ../../../persistence/rlm-database

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-userdata'),
    getVersion: vi.fn().mockReturnValue('0.0.0-test'),
  },
  // SUT imports `dialog` as a named export at line 9; provide a stub
  // even if this test doesn't exercise the dialog-using paths, so the
  // module-level import succeeds.
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
}));

vi.mock('../../../persistence/rlm-database', () => ({
  getRLMDatabase: vi.fn().mockReturnValue({
    // settings-export.ts:50 calls .getRawDb() on the returned value.
    getRawDb: vi.fn().mockReturnValue({ /* opaque DB stub — channel stores receive it but mocked stores ignore */ }),
  }),
}));

// Channel stores are CONSTRUCTED with `new` (verified at lines 51-52).
// Mock as constructible classes returning instances with the methods the
// exporter calls (`.getAll()`).
vi.mock('../../../channels/channel-credential-store', () => ({
  ChannelCredentialStore: vi.fn().mockImplementation(() => ({
    getAll: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../../channels/channel-access-policy-store', () => ({
  ChannelAccessPolicyStore: vi.fn().mockImplementation(() => ({
    getAll: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../settings-manager', () => ({
  getSettingsManager: vi.fn().mockReturnValue({
    getAll: () => ({
      // Plausible AppSettings shape — only fields the exporter touches matter.
      defaultCli: 'claude',
      pauseFeatureEnabled: true,
    }),
  }),
}));

import { buildExportData } from '../settings-export';

describe('settings:export — pause-related namespace exclusion (post-review regression)', () => {
  it('does NOT include pause-state in export data', () => {
    const data = buildExportData();
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/recentTransitions/);   // pause-state shape marker
  });

  it('does NOT include instance-message-queue in export data', () => {
    const data = buildExportData();
    const json = JSON.stringify(data);
    expect(json).not.toMatch(/hadAttachmentsDropped/); // queue shape marker
    expect(json).not.toMatch(/seededAlready/);
  });
});
```

The relative-path style (`../../...` from `__tests__/`) and the mock surface area above match the exporter as verified at `settings-export.ts:13-15, 50-52, 72`. If the exporter file is restructured, regrep its actual imports/calls and update the mocks to mirror.

Shape-marker assertions (`/recentTransitions/`, `/hadAttachmentsDropped/`, `/seededAlready/`) avoid false positives that a literal `/pause-state/` substring search would risk (the string could appear in unrelated comments or settings values).

- [ ] **Step 3: Verify + checkpoint**

```bash
npx vitest run src/main/core/config/__tests__/settings-export.spec.ts
# Checkpoint: "test(pause): regression test locks pause-state + queue out of settings:export"
```

---

# Phase 7 complete

All main-process subsystem hooks are in place. The renderer side comes next.

---

# Phase 8 — Renderer state (PauseStore, queue gates, queue persistence)

---

### Task 25: PauseStore (Angular signal-based)

**Files:**
- Create: `src/renderer/app/core/state/pause/pause.store.ts`
- Test: `src/renderer/app/core/state/pause/pause.store.spec.ts`

- [ ] **Step 1: Implement store**

`src/renderer/app/core/state/pause/pause.store.ts`:

```typescript
import { Injectable, computed, signal, inject } from '@angular/core';
import { ElectronIpcService } from '../../services/ipc';
import type { PauseStatePayload } from '../../../../../preload/domains/pause.preload';

export type PauseSource = 'none' | 'vpn' | 'user' | 'both' | 'detector-error';

export interface PauseStoreState {
  isPaused: boolean;
  reasons: ReadonlySet<string>;
  pausedAt: number | null;
  lastChange: number;
}

@Injectable({ providedIn: 'root' })
export class PauseStore {
  private ipc = inject(ElectronIpcService);

  private _state = signal<PauseStoreState>({
    isPaused: false,
    reasons: new Set(),
    pausedAt: null,
    lastChange: 0,
  });

  readonly state = this._state.asReadonly();
  readonly isPaused = computed(() => this._state().isPaused);
  readonly source = computed<PauseSource>(() => {
    const r = this._state().reasons;
    if (r.has('detector-error')) return 'detector-error';
    if (r.has('vpn') && r.has('user')) return 'both';
    if (r.has('user')) return 'user';
    if (r.has('vpn')) return 'vpn';
    return 'none';
  });
  // queuedTotal is derived from InstanceStateService.messageQueue via an
  // effect installed in InstanceMessagingStore (see Task 26 step 7).
  // We use a signal here (not computed) so PauseStore stays decoupled from
  // InstanceStateService — the messaging store does the cross-store update.
  readonly queuedTotal = signal(0);

  applyState(payload: PauseStatePayload): void {
    this._state.set({
      isPaused: payload.isPaused,
      reasons: new Set(payload.reasons),
      pausedAt: payload.pausedAt,
      lastChange: payload.lastChange,
    });
  }

  async setManual(paused: boolean): Promise<void> {
    await this.ipc.pauseSetManual(paused);
  }

  async resumeAfterDetectorError(): Promise<void> {
    await this.ipc.pauseDetectorResumeAfterError();
  }
}
```

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit -p tsconfig.spec.json
npx vitest run src/renderer/app/core/state/pause/pause.store.spec.ts
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): renderer PauseStore (signal-based)
```

Test cases: default state running; `applyState({ isPaused: true, reasons: ['vpn'] })` → `isPaused()===true`, `source()==='vpn'`; `reasons: ['vpn','user']` → `source()==='both'`; `reasons: ['detector-error']` → `source()==='detector-error'`; `setManual(true)` invokes IPC `pauseSetManual` with payload `{ paused: true }`.

---

### Task 26: instance-messaging.store — three pause gates

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance-messaging.store.ts`

- [ ] **Step 1: Inject PauseStore**

At the top of the class:

```typescript
import { PauseStore } from '../pause/pause.store';

  private pauseStore = inject(PauseStore);
```

- [ ] **Step 2: Gate `sendInput` queue path**

In `sendInput()`, modify the existing transient-status check at line ~221:

```typescript
    if (
      this.pauseStore.isPaused() ||
      isTransientQueueStatus(instance.status)
    ) {
      // queue (existing code path unchanged)
      this.stateService.messageQueue.update((currentMap) => {
        const newMap = new Map(currentMap);
        const queue = newMap.get(instanceId) || [];
        queue.push({ message, files });
        newMap.set(instanceId, queue);
        return newMap;
      });
      return;
    }
```

- [ ] **Step 3: Gate `processMessageQueue` (covers ALL drain paths)**

At line 360:

```typescript
  processMessageQueue(instanceId: string): void {
    if (this.pauseStore.isPaused()) return;       // ← NEW
    // ... rest unchanged ...
  }
```

This covers the watchdog drain, the batch-update drain (called from `instance.store.ts:302,389`), and the retry path.

- [ ] **Step 4: Recognise OrchestratorPausedError in retry disposition**

Add to `getRetryDisposition` (around line 402, alongside other transient-error matchers):

```typescript
    if (normalized.includes('orchestrator-paused') || normalized.includes('orchestratorpausederror')) {
      return { shouldRetry: true, nextStatus: status };
    }
```

- [ ] **Step 5: Add `seededAlready` + `skipUserBubble` plumbing**

Extend the runtime queue type in `src/renderer/app/core/state/instance/instance.types.ts:146` (verified location — this interface is exported from `instance.types.ts`, NOT `instance-state.service.ts`; the latter only imports it).

**Important: the existing interface already has a `kind?: 'queue' | 'steer'` field** that `instance-messaging.store.ts` uses for steering priority. Preserve every existing field; only **add** the two new fields:

```typescript
export interface QueuedMessage {
  message: string;
  files?: File[];
  retryCount?: number;
  kind?: 'queue' | 'steer';        // ← EXISTING — do NOT remove (steering priority)
  seededAlready?: boolean;         // ← NEW: set on initial-prompt-while-paused entries
  hadAttachmentsDropped?: boolean; // ← NEW: set on rehydrated entries with dropped attachments
}
```

Imports in `instance-messaging.store.ts` and `queue-persistence.service.ts` should reference `./instance.types` (matching the existing `instance-state.service.ts` import).

**Persisted shape must also carry `kind`** (post-review): in Task 13 (`PersistedQueuedMessageSchema`), add `kind: z.enum(['queue', 'steer']).optional()`. In Task 27 persistence service `persistNow`, include `kind: q.kind` in the mapped payload. In `restoreFromDisk`, copy `kind: e.kind` back into the runtime entry. Without this, restoring a steer-priority message after a crash demotes it to a regular queue entry.

In `processMessageQueue` at the dequeue:

```typescript
    if (nextMessage) {
      const retryCount = nextMessage.retryCount ?? 0;
      const skipUserBubble = nextMessage.seededAlready === true;
      setTimeout(() => {
        this.sendInputImmediate(instanceId, nextMessage.message, nextMessage.files, retryCount, skipUserBubble);
      }, 100);
    }
```

In `sendInputImmediate` signature:

```typescript
  async sendInputImmediate(
    instanceId: string,
    message: string,
    files?: File[],
    retryCount = 0,
    skipUserBubble = false,
  ): Promise<void> {
```

And the IPC call (around line 287):

```typescript
    const result = await this.ipc.sendInput(instanceId, message, attachments, skipUserBubble || retryCount > 0);
```

- [ ] **Step 7: Wire `pauseStore.queuedTotal` from messageQueue (post-review)**

In `instance-messaging.store.ts` constructor:

```typescript
import { PauseStore } from '../pause/pause.store';
import { effect } from '@angular/core';

  constructor() {
    // ... existing watchdog setup ...

    // Keep PauseStore.queuedTotal in sync with the actual queue depth.
    // Without this, the banner queued-count and resume-toast totals
    // never update.
    effect(() => {
      const map = this.stateService.messageQueue();
      let total = 0;
      for (const queue of map.values()) total += queue.length;
      this.pauseStore.queuedTotal.set(total);
    });
  }
```

Add `pauseStore: PauseStore = inject(PauseStore);` to the class fields if not already present (Task 26 step 1 added this; double-check the import path).

- [ ] **Step 8: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/renderer/app/core/state/instance/instance-messaging.store.spec.ts
# Checkpoint files: see the task file list above
# Checkpoint: "feat(pause): renderer queue gates + queuedTotal sync"
```

(The QueuedMessage extension in step 5 modifies `instance.types.ts`, NOT `instance-state.service.ts` — the latter only imports the type. Stage the right file.)

Test cases: `pauseStore.isPaused()` true → `sendInput` queues regardless of instance status; `processMessageQueue` early-returns when paused; `getRetryDisposition` for `orchestrator-paused` returns `shouldRetry=true`; `seededAlready=true` queue entry maps to `skipUserBubble=true` on drain; **adding 3 messages updates `pauseStore.queuedTotal` to 3; draining all updates back to 0.**

---

### Task 27: queue-persistence.service — debounced save + restore + privacy gate

**Files:**
- Create: `src/renderer/app/core/state/instance/queue-persistence.service.ts`
- Test: `src/renderer/app/core/state/instance/queue-persistence.service.spec.ts`

- [ ] **Step 1: Implement persistence service**

`src/renderer/app/core/state/instance/queue-persistence.service.ts`:

```typescript
import { Injectable, effect, inject, untracked } from '@angular/core';
import { InstanceStateService } from './instance-state.service';
import { ElectronIpcService } from '../../services/ipc';
import { SettingsStore } from '../settings.store';
import type { QueuedMessage } from './instance.types';   // post-review: imported from instance.types.ts (the type's actual home)

interface PersistedEntry {
  message: string;
  hadAttachmentsDropped: boolean;
  retryCount?: number;
  seededAlready?: boolean;
  kind?: 'queue' | 'steer';   // post-review: round-trip steering priority
}

const DEBOUNCE_MS = 250;

@Injectable({ providedIn: 'root' })
export class QueuePersistenceService {
  private state = inject(InstanceStateService);
  private ipc = inject(ElectronIpcService);
  private settings = inject(SettingsStore);
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track which instance IDs we've ever persisted, so we can issue an
  // explicit "save empty array" (which the main handler treats as delete)
  // when an instance's queue drains to nothing and disappears from the map.
  // Without this, drained queues would leave stale entries on disk that
  // restore-on-startup would resurrect.
  private previouslyPersistedIds = new Set<string>();

  constructor() {
    effect(() => {
      // Wait until SettingsStore has actually loaded persisted values
      // (post-review R18). Without this guard, the FIRST effect run
      // happens at service-construction time — which is `inject()`
      // resolution at AppComponent field-init time, BEFORE
      // `await settingsStore.initialize()` in ngOnInit. The first run
      // would read DEFAULT_SETTINGS and could falsely-enable
      // persistence when the user actually has it disabled.
      if (!this.settings.isInitialized()) return;

      // Watch the message-queue signal; persist on changes when enabled.
      // Both gates are checked LIVE so toggling either setting takes
      // effect immediately without restart.
      if (!this.settings.get('pauseFeatureEnabled')) return;

      const queueMap = this.state.messageQueue();
      const enabled = this.settings.get('persistSessionContent');
      if (!enabled) return;

      untracked(() => {
        const currentIds = new Set(queueMap.keys());

        // Persist each instance's current queue (debounced per-instance).
        for (const [instanceId, queue] of queueMap.entries()) {
          this.scheduleSave(instanceId, queue);
          this.previouslyPersistedIds.add(instanceId);
        }

        // For any ID we previously persisted that no longer appears in the
        // map, send an explicit empty-array save so the main handler deletes
        // the disk entry.
        for (const id of [...this.previouslyPersistedIds]) {
          if (!currentIds.has(id)) {
            this.scheduleSave(id, []);
            this.previouslyPersistedIds.delete(id);
          }
        }
      });
    });

    // Initial-prompt listener registration is handled REACTIVELY by
    // PauseRendererController (post-review R18). When the kill switch
    // toggles on at runtime, the controller calls our public
    // `subscribeToInitialPrompts()` method. When it toggles off, the
    // controller calls `unsubscribeFromInitialPrompts()`. This avoids
    // the constructor-runs-too-early problem.
    // ... (no inline subscription here) ...

    // The listener installation lives in a separate method that can be
    // toggled from outside:
  }

  private initialPromptUnsubscribe: (() => void) | null = null;

  subscribeToInitialPrompts(): void {
    if (this.initialPromptUnsubscribe) return; // idempotent
    this.initialPromptUnsubscribe = this.ipc.onInstanceQueueInitialPrompt((payload: {
      instanceId: string;
      message: string;
      attachments?: Array<{ name: string; type: string; size: number; data: string }>;
      seededAlready: true;
    }) => {
      const hadAttachments = !!(payload.attachments && payload.attachments.length > 0);
      this.state.messageQueue.update((map) => {
        const newMap = new Map(map);
        const queue = newMap.get(payload.instanceId) || [];
        queue.push({
          message: payload.message,
          files: undefined,                   // attachments dropped at IPC boundary
          seededAlready: true,
          hadAttachmentsDropped: hadAttachments,
        });
        newMap.set(payload.instanceId, queue);
        return newMap;
      });
      if (hadAttachments) {
        console.warn('Initial-prompt attachments dropped for paused queueing', {
          instanceId: payload.instanceId,
          count: payload.attachments?.length,
        });
      }
    });
  }

  unsubscribeFromInitialPrompts(): void {
    if (this.initialPromptUnsubscribe) {
      this.initialPromptUnsubscribe();
      this.initialPromptUnsubscribe = null;
    }
  }

  /** Restore queues from main on app start. Must be called before any UI sendInput. */
  async restoreFromDisk(): Promise<void> {
    if (!this.settings.get('persistSessionContent')) return;
    const result = await this.ipc.instanceQueueLoadAll?.();
    if (!result?.success || !result.data) return;
    const queues = (result.data as { queues: Record<string, PersistedEntry[]> }).queues;
    this.state.messageQueue.update((map) => {
      const newMap = new Map(map);
      for (const [instanceId, entries] of Object.entries(queues)) {
        const restored: QueuedMessage[] = entries.map(e => ({
          message: e.message,
          retryCount: e.retryCount,
          seededAlready: e.seededAlready,
          hadAttachmentsDropped: e.hadAttachmentsDropped,
          kind: e.kind,        // post-review: preserve steering priority on restore
          files: undefined,
        }));
        newMap.set(instanceId, restored);
      }
      return newMap;
    });
  }

  private scheduleSave(instanceId: string, queue: QueuedMessage[]): void {
    const existing = this.debounceTimers.get(instanceId);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(instanceId, setTimeout(() => {
      this.debounceTimers.delete(instanceId);
      this.persistNow(instanceId, queue);
    }, DEBOUNCE_MS));
  }

  private persistNow(instanceId: string, queue: QueuedMessage[]): void {
    // Defense in depth for pending debounce timers: if the master kill switch
    // flipped off after scheduleSave() but before the timer fired, do not
    // write the queue namespace. PauseRendererController.stop() also clears
    // pending timers, but this keeps the persistence method correct on its own.
    if (!this.settings.isInitialized()) return;
    if (!this.settings.get('pauseFeatureEnabled')) return;
    if (!this.settings.get('persistSessionContent')) return;

    const payload: PersistedEntry[] = queue.map(q => ({
      message: q.message,
      hadAttachmentsDropped: !!(q.files && q.files.length > 0) || q.hadAttachmentsDropped === true,
      retryCount: q.retryCount,
      seededAlready: q.seededAlready,
      kind: q.kind,                // post-review: preserve steering priority
    }));
    this.ipc.instanceQueueSave?.(instanceId, payload);
  }

  clearPendingSaves(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
```

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit
npx vitest run src/renderer/app/core/state/instance/queue-persistence.service.spec.ts
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): renderer queue persistence (debounced save, restore, privacy-gated)
```

Test cases (using mocked IPC):
- enqueue 3 messages → after 250ms, exactly one `instanceQueueSave` call with all 3 entries (debounced)
- saved payload has `hadAttachmentsDropped: true` when files present and `false` otherwise
- saved payload contains NO `data:` URL substrings (privacy assertion)
- `persistSessionContent=false` → `restoreFromDisk()` returns early; no IPC call
- `INSTANCE_QUEUE_INITIAL_PROMPT` event appends to queue with `seededAlready: true`
- `restoreFromDisk` populates the renderer queue from main's load response
- **Drain-to-empty cleanup (post-review):** enqueue 1 message, drain it (queue map deletes the instance entry), assert `instanceQueueSave(instanceId, [])` was called so the disk entry is deleted; restart simulation should NOT restore the drained message.

---

# Phase 8 complete

The renderer side now: queues correctly when paused, drains correctly on resume, persists queues across crashes (subject to `persistSessionContent`), and handles initial-prompt routing.

---

# Phase 9 — UI components

---

### Task 28: Master pause-toggle (title-bar button)

**Files:**
- Create: `src/renderer/app/shared/components/pause-toggle/pause-toggle.component.ts`

- [ ] **Step 1: Implement standalone signal-driven component**

```typescript
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PauseStore } from '../../../core/state/pause/pause.store';

@Component({
  selector: 'app-pause-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      class="pause-toggle"
      [class.running]="!store.isPaused()"
      [class.auto]="store.source() === 'vpn'"
      [class.manual]="store.source() === 'user'"
      [class.both]="store.source() === 'both'"
      [class.error]="store.source() === 'detector-error'"
      [attr.aria-pressed]="store.isPaused()"
      [title]="tooltip()"
      (click)="onClick()"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        @if (store.isPaused()) {
          <rect x="6" y="4" width="4" height="16"/>
          <rect x="14" y="4" width="4" height="16"/>
        } @else {
          <path d="M6 4 L6 20 M14 4 L14 20" stroke="currentColor" stroke-width="2" fill="none"/>
        }
      </svg>
      @if (store.source() === 'vpn') { <span class="sub">AUTO</span> }
      @if (store.source() === 'both') { <span class="sub">+VPN</span> }
      @if (store.source() === 'detector-error') { <span class="sub">ERR</span> }
    </button>
  `,
  styles: [`
    .pause-toggle { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: none; border-radius: 4px; cursor: pointer; background: transparent; color: inherit; }
    .pause-toggle.running { color: var(--text-secondary); }
    .pause-toggle.auto { color: var(--warn-fg); background: var(--warn-bg); }
    .pause-toggle.manual, .pause-toggle.both { color: var(--danger-fg); background: var(--danger-bg); }
    .pause-toggle.error { color: var(--warn-fg); background: var(--warn-bg); cursor: not-allowed; }
    .sub { font-size: 9px; font-weight: 600; }
  `],
})
export class PauseToggleComponent {
  store = inject(PauseStore);

  tooltip = computed(() => {
    switch (this.store.source()) {
      case 'none': return 'Pause orchestrator';
      case 'vpn': return 'Auto-paused (VPN). Click to also hold paused after VPN drops.';
      case 'user': return 'Manually paused. Click to resume.';
      case 'both': return 'Manually paused (VPN also active). Click to release manual hold.';
      case 'detector-error': return 'Paused — VPN detection unavailable. Use the banner to resume.';
    }
  });

  async onClick(): Promise<void> {
    if (this.store.source() === 'detector-error') return; // banner handles this state
    const userActive = this.store.state().reasons.has('user');
    await this.store.setManual(!userActive);
  }
}
```

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): master pause-toggle component
```

---

### Task 29: Pause banner

**Files:**
- Create: `src/renderer/app/shared/components/pause-banner/pause-banner.component.ts`

- [ ] **Step 1: Implement standalone banner**

```typescript
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PauseStore } from '../../../core/state/pause/pause.store';
import { DetectorErrorModalComponent } from '../detector-error-modal/detector-error-modal.component';
import { Router } from '@angular/router';

@Component({
  selector: 'app-pause-banner',
  standalone: true,
  imports: [DetectorErrorModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.isPaused()) {
      <div class="pause-banner" [class.error]="store.source() === 'detector-error'">
        <span class="icon">⏸</span>
        <span class="title">{{ title() }}</span>
        <span class="body">{{ body() }}</span>
        @if (store.source() === 'detector-error') {
          <button (click)="modalOpen.set(true)">Resume…</button>
        } @else if (store.source() === 'vpn') {
          <a (click)="goToSettings()">Adjust pattern in Settings</a>
        }
      </div>
      @if (modalOpen()) {
        <app-detector-error-modal (cancel)="modalOpen.set(false)" (confirm)="onConfirmResume()"/>
      }
    }
  `,
  styles: [`
    .pause-banner { display: flex; gap: 12px; padding: 8px 16px; background: var(--danger-bg); color: var(--danger-fg); border-bottom: 1px solid var(--danger-fg); align-items: center; }
    .pause-banner.error { background: var(--warn-bg); color: var(--warn-fg); }
    .icon { font-size: 16px; }
    .title { font-weight: 600; }
    .body { flex: 1; }
    a { cursor: pointer; text-decoration: underline; }
  `],
})
export class PauseBannerComponent {
  store = inject(PauseStore);
  private router = inject(Router);
  modalOpen = signal(false);

  title = computed(() => {
    switch (this.store.source()) {
      case 'vpn': return 'Orchestrator paused — VPN detected';
      case 'user': return 'Manually paused';
      case 'both': return 'Manually paused (VPN also active)';
      case 'detector-error': return 'Paused — VPN detection unavailable';
      default: return '';
    }
  });

  body = computed(() => {
    const total = this.store.queuedTotal();
    const queued = total > 0 ? `${total} queued message${total === 1 ? '' : 's'}.` : '';
    switch (this.store.source()) {
      case 'vpn': return queued + ' Will auto-resume when VPN drops.';
      case 'user': return queued + ' Click the master pause button to resume.';
      case 'both': return queued + ' Will not auto-resume when VPN drops.';
      case 'detector-error': return 'Click Resume only if you have manually verified you are not on VPN.';
      default: return '';
    }
  });

  goToSettings(): void {
    this.router.navigate(['/settings'], { fragment: 'network' });
  }

  async onConfirmResume(): Promise<void> {
    await this.store.resumeAfterDetectorError();
    this.modalOpen.set(false);
  }
}
```

(Add `import { signal } from '@angular/core';` to the imports.)

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): top-of-app pause banner
```

---

### Task 30: Detector-error confirmation modal

**Files:**
- Create: `src/renderer/app/shared/components/detector-error-modal/detector-error-modal.component.ts`

- [ ] **Step 1: Implement modal**

```typescript
import { ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Output, ViewChild, AfterViewInit } from '@angular/core';

@Component({
  selector: 'app-detector-error-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overlay" (click)="cancel.emit()">
      <div class="dialog" (click)="$event.stopPropagation()" role="dialog" aria-labelledby="dem-title" aria-describedby="dem-body">
        <h2 id="dem-title">VPN detection is unavailable</h2>
        <p id="dem-body">
          The orchestrator cannot determine whether you are connected to your VPN.
        </p>
        <p>
          Resume only if you have manually verified you are not on VPN.
        </p>
        <div class="actions">
          <button #cancelBtn class="btn-cancel" (click)="cancel.emit()">Cancel</button>
          <button class="btn-confirm" (click)="confirm.emit()">I have verified — resume</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .dialog { background: var(--bg-primary); padding: 24px; border-radius: 8px; max-width: 480px; }
    h2 { margin-top: 0; }
    .actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 16px; }
    button { padding: 8px 16px; border-radius: 4px; cursor: pointer; }
    .btn-cancel { background: var(--bg-secondary); }
    .btn-confirm { background: var(--danger-bg); color: var(--danger-fg); }
  `],
})
export class DetectorErrorModalComponent implements AfterViewInit {
  @ViewChild('cancelBtn') cancelBtn!: ElementRef<HTMLButtonElement>;
  @Output() cancel = new EventEmitter<void>();
  @Output() confirm = new EventEmitter<void>();

  ngAfterViewInit(): void {
    // Default focus on Cancel — explicit safety choice from spec §7.4.
    queueMicrotask(() => this.cancelBtn.nativeElement.focus());
  }
}
```

- [ ] **Step 2: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): detector-error confirmation modal (default focus on cancel)
```

---

### Task 31: app.component — wire banner + toggle slots, banner stacking

**Files:**
- Modify: `src/renderer/app/app.component.html`
- Modify: `src/renderer/app/app.component.ts`

- [ ] **Step 1: Update template**

The pause UI must be hidden when the master kill switch is off (post-review): otherwise a visible toggle would let the user create a `user` pause reason that the IPC handler now rejects (Task 14), producing a confusing failure dialog. Wrap the toggle and banner in `@if (settingsStore.get('pauseFeatureEnabled')) { ... }` blocks.

Replace the title-bar overlay region in `app.component.html`:

```html
<div class="app-container" [class.macos]="isMacOS">
  <div class="title-bar-drag-area" [class.windows]="!isMacOS"></div>

  <div class="title-bar-overlay" [class.macos]="isMacOS">
    @if (settingsStore.get('pauseFeatureEnabled')) {
      <app-pause-toggle />
    }
    <app-provider-quota-chip />
  </div>

  <!-- Pause banner stacks ABOVE startup banner -->
  @if (settingsStore.get('pauseFeatureEnabled')) {
    <app-pause-banner />
  }

  @if (startupCapabilities() && startupCapabilities()!.status !== 'ready') {
    <div class="startup-banner" [class.failed]="startupCapabilities()!.status === 'failed'">
      <span class="startup-banner-title">Startup checks: {{ startupCapabilities()!.status }}</span>
      <span class="startup-banner-body">{{ startupCapabilitySummary() }}</span>
    </div>
  }

  <main class="app-main">
    <router-outlet />
  </main>
</div>
```

`settingsStore` should already be exposed on `AppComponent` for other UI; if not, add `protected readonly settingsStore = inject(SettingsStore);` alongside the other injected stores. The `get('pauseFeatureEnabled')` reads reactively (signal-backed), so the UI auto-updates when the setting flips.

- [ ] **Step 2: Wire imports + IPC subscription (ADDITIVE — preserve existing logic)**

**Important:** the existing `AppComponent` has platform detection, dev-service exposure, startup-capability listeners, settings-menu listeners, an `appReady()` call, a startup-capability fetch, and `OnDestroy` cleanup. The pause integration is **additive** — do NOT replace `ngOnInit` wholesale. Add the new imports, fields, and a single `await` early in the existing `ngOnInit` body.

(a) Add imports + injected fields alongside the existing ones:

```typescript
import { PauseToggleComponent } from './shared/components/pause-toggle/pause-toggle.component';
import { PauseBannerComponent } from './shared/components/pause-banner/pause-banner.component';
import { PauseStore } from './core/state/pause/pause.store';
import { PauseRendererController } from './core/state/pause/pause-renderer-controller.service';
import { SettingsStore } from './core/state/settings.store';

  // Inside the AppComponent class body, near the existing inject() calls.
  // pauseStore must be accessible from the template (Task 33 reads
  // `pauseStore.resumeEvents()` from app.component.html); under Angular's
  // strict template checking, private fields are not visible to templates.
  // Use `protected readonly`.
  protected readonly pauseStore = inject(PauseStore);
  // The controller owns reactive start/stop of pause renderer services.
  // Just inject it; bindReactive() is called once from ngOnInit below.
  private pauseRendererController = inject(PauseRendererController);
  // settingsStore must be accessible from the template (kill-switch @if).
  protected readonly settingsStore = inject(SettingsStore);
```

(b) Add components to the `imports` array (alongside the existing ones — do not remove others):

```typescript
@Component({
  // ... existing decorator ...
  imports: [
    // ... ALL existing entries preserved ...
    PauseToggleComponent,
    PauseBannerComponent,
  ],
})
```

(c) Inside the existing `ngOnInit` body, **before** any other async work that might trigger a renderer-side `sendInput`, add:

```typescript
    // CRITICAL ORDERING: SettingsStore is currently initialised lazily
    // from DashboardComponent, NOT at app root. Initialise it here first
    // so the kill-switch check below reads persisted values, not defaults.
    // (Sub-task makes initialize() idempotent so DashboardComponent's call
    // becomes a no-op; see step (c.bis) below.)
    //
    // Do not let settings IPC failure abort the root startup path. The
    // existing AppComponent still has to run platform detection, dev-service
    // exposure, menu listeners, appReady(), and startup capability fetches.
    // Pause services are gated by settingsStore.isInitialized(), so they stay
    // inactive until a later retry succeeds.
    try {
      await this.settingsStore.initialize();
    } catch (error) {
      console.warn('Settings initialization failed during app startup; pause feature will stay inactive until settings reload succeeds', error);
    }

    // Reactive kill-switch handling (post-review R18):
    // The kill switch can be toggled at runtime without restart. The
    // renderer must therefore react to `pauseFeatureEnabled` changes —
    // a one-shot read in ngOnInit would leave the renderer
    // half-disconnected if the user enables the feature later. An effect
    // tracks the setting and starts/stops the renderer-side pause
    // services accordingly.
    this.pauseRendererController.bindReactive();
```

The `pauseRendererController` is a small new injectable that owns start/stop of the renderer-side pause wiring (queue restore, IPC subscription, initial state fetch). It exists so that the start/stop logic isn't tangled into AppComponent itself, and so unsubscribe handles are managed in one place.

Add `protected readonly settingsStore = inject(SettingsStore);` alongside the other store fields if not already present (Task 31 already references it for the template `@if`).

The `QueuePersistenceService` itself also self-gates internally on `persistSessionContent` (verified in Task 27). With the kill-switch additionally gating renderer startup and the main-process disable path clearing `instance-message-queue`, no stale queued messages are restored or retained while the feature is off.

(c.0) **Add the renderer-side pause controller** (post-review R18). This service owns the start/stop of pause-related renderer wiring and reacts to `pauseFeatureEnabled` toggles at runtime.

`src/renderer/app/core/state/pause/pause-renderer-controller.service.ts`:

```typescript
import { Injectable, Injector, effect, inject } from '@angular/core';
import { SettingsStore } from '../settings.store';
import { PauseStore } from './pause.store';
import { QueuePersistenceService } from '../instance/queue-persistence.service';

@Injectable({ providedIn: 'root' })
export class PauseRendererController {
  private injector = inject(Injector);
  private settingsStore = inject(SettingsStore);
  private pauseStore = inject(PauseStore);
  private queuePersistence = inject(QueuePersistenceService);

  private pauseUnsubscribe: (() => void) | null = null;
  private bound = false;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private startGeneration = 0;

  /** Called once from AppComponent.ngOnInit AFTER settings are initialised. */
  bindReactive(): void {
    if (this.bound) return;
    this.bound = true;
    effect(
      () => {
        const shouldStart =
          this.settingsStore.isInitialized() && this.settingsStore.get('pauseFeatureEnabled');
        if (shouldStart) this.start();
        else this.stop();
      },
      { injector: this.injector },
    );
  }

  private start(): void {
    if (this.started || this.startPromise) return;
    const generation = ++this.startGeneration;
    this.startPromise = this.startAsync(generation)
      .catch((error) => {
        if (this.startGeneration === generation) {
          console.warn('PauseRendererController: failed to start pause services', error);
          this.stop();
        }
      })
      .finally(() => {
        if (this.startGeneration === generation) this.startPromise = null;
      });
  }

  private async startAsync(generation: number): Promise<void> {
    await this.queuePersistence.restoreFromDisk();
    if (!this.isStartCurrent(generation)) return;

    this.queuePersistence.subscribeToInitialPrompts();
    this.pauseUnsubscribe = this.pauseStore.onStateChanged();

    await this.pauseStore.refresh();
    if (!this.isStartCurrent(generation)) {
      this.pauseUnsubscribe?.();
      this.pauseUnsubscribe = null;
      this.queuePersistence.unsubscribeFromInitialPrompts();
      return;
    }

    this.started = true;
  }

  private stop(): void {
    this.startGeneration++;
    this.pauseUnsubscribe?.();
    this.pauseUnsubscribe = null;
    this.queuePersistence.unsubscribeFromInitialPrompts();
    this.queuePersistence.clearPendingSaves();
    this.pauseStore.reset();
    this.started = false;
    this.startPromise = null;
  }

  private isStartCurrent(generation: number): boolean {
    return (
      generation === this.startGeneration &&
      this.settingsStore.isInitialized() &&
      this.settingsStore.get('pauseFeatureEnabled')
    );
  }
}
```

The `bindReactive()` method is called once from AppComponent's `ngOnInit`. The effect re-runs whenever the `pauseFeatureEnabled` signal changes; `start()`/`stop()` keep their unsubscribe handles managed.

(c.bis) **Make `SettingsStore.initialize()` idempotent + add `isInitialized()` signal** (post-review). DashboardComponent currently calls it; AppComponent now also calls it. Both must be safe AND consumers (`PauseRendererController` above, `QueuePersistenceService`) need to know when init has actually completed successfully.

In `src/renderer/app/core/state/settings.store.ts`, add an internal flag, an `isInitialized()` signal, and short-circuit:

```typescript
  private _initialized = signal(false);
  readonly isInitialized = this._initialized.asReadonly();
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    if (this._initialized()) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().then(
      // Only mark initialized after a SUCCESSFUL load+listener-setup
      // (post-review R18). The existing implementation catches IPC errors
      // and resolves after storing _error — without this guard, a transient
      // failure would mark the store permanently initialized and consumers
      // would silently use defaults.
      () => {
        // doInitialize() must be modified to RETHROW on real failure so we
        // can tell success apart from error-stored-and-resolved. See below.
        if (this._error()) {
          // Failed: clear initPromise so future callers can retry.
          this.initPromise = null;
          throw new Error(this._error() ?? 'Settings load failed');
        }
        this._initialized.set(true);
      },
      (err) => {
        // Failed by exception: same retry path.
        this.initPromise = null;
        throw err;
      },
    );
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // ... existing initialisation body. NOTE: existing implementation
    // catches errors and stores in _error (lines 127-128, 149-150);
    // do NOT remove that — `_error` is consumed by the UI. Rely on the
    // wrapper above to detect non-empty `_error` after resolve. ...
    //
    // Also fix the existing silent-failure path: today initialize() only
    // applies settings when `response.success && response.data`, but does
    // nothing when IPC returns `{ success: false }`. With an initialized flag,
    // that would incorrectly mark DEFAULT_SETTINGS as trustworthy. Treat
    // `!response.success` or missing `response.data` as a real load failure:
    // set `_error` to `response.error?.message ?? 'Failed to load settings'`
    // and return/throw so the wrapper above clears `initPromise` and does NOT
    // set `_initialized`.
  }
```

Consumers can use `settingsStore.isInitialized()` reactively (e.g., `QueuePersistenceService` and `PauseRendererController` both gate on it).

Existing DashboardComponent call site stays unchanged; it becomes a no-op on second call. On a transient failure, the user gets the existing error UI; reloading or retrying calls `initialize()` again successfully.

Also update the existing optimistic-write rollback paths in `set()` and `update()`: today their `catch` blocks call `await this.initialize()` to reload after a failed save. Once `initialize()` is idempotent, that becomes a no-op after the first successful startup and can leave the renderer showing unsaved optimistic values. Change those catch blocks to call `await this.reload()` (or add a `forceReload()` helper that bypasses the idempotence guard). Keep `reload()` as a real main-process fetch that updates `_settings` even when `_initialized()` is already true.

(d) **Cleanup is now owned by the controller.** No additional `ngOnDestroy` change required — `PauseRendererController.stop()` handles unsubscribe. (If you want explicit cleanup at destroy time anyway, you could call a `controller.dispose()` method, but for `providedIn: 'root'` services the controller lives for the app lifetime so this is not strictly needed.)

Do NOT remove or alter any other line of the existing component. This is purely additive.

- [ ] **Step 3: Verify + checkpoint**

```bash
npm run build      # ensure renderer builds
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): wire pause-toggle + pause-banner into app shell
```

---

### Task 32: Per-instance queued indicator + input-panel hint

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-row.component.ts` (or wherever instance rows render)
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`

- [ ] **Step 1: Sidebar badge**

In the instance-row template, add (next to the instance name):

```html
@if (queuedCount() > 0) {
  <span class="queued-badge" [title]="queuedTooltip()">({{ queuedCount() }} queued)</span>
}
```

In the component class:

```typescript
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';

  private messaging = inject(InstanceMessagingStore);
  queuedCount = computed(() => this.messaging.getQueuedMessageCount(this.instance().id));
  queuedTooltip = computed(() => {
    const queue = this.messaging.getMessageQueue(this.instance().id);
    const dropped = queue.some((q: { hadAttachmentsDropped?: boolean }) => q.hadAttachmentsDropped);
    return dropped ? 'Some queued messages had attachments — reattach before resuming' : `${this.queuedCount()} message(s) queued`;
  });
```

- [ ] **Step 2: Input-panel hint when paused**

In `input-panel.component.html`:

```html
@if (pauseStore.isPaused() && lastSendQueued()) {
  <div class="queue-hint">
    Queued — will send when orchestrator resumes
    @if (queueAhead() > 0) { ({{ queueAhead() }} ahead of you) }
    @if (lastQueuedHadAttachments()) {
      <br/><em>This queued message had attachments; reattach before resuming.</em>
    }
  </div>
}
```

In `input-panel.component.ts`:

```typescript
  pauseStore = inject(PauseStore);
  // Track last send: if it queued (i.e., pause was on), show the hint.
  // Implementation: set a signal in the existing send handler — when sendInput
  // returns and pauseStore.isPaused() is true at that moment, set
  // lastSendQueued = true. Reset on next user input or on resume.
```

- [ ] **Step 3: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): per-instance queue indicators (sidebar badge + input hint)
```

---

### Task 33: Resume toast (renderer-side broadcast)

**Files:**
- Modify: `src/renderer/app/core/state/pause/pause.store.ts`
- Modify: appropriate top-level component that hosts toasts (likely `instance-detail.component.ts` per existing pattern, OR new app-level toast holder)

- [ ] **Step 1: Detect resume transition + emit toast**

Extend `PauseStore.applyState` to detect transitions and emit a one-shot signal:

```typescript
  readonly resumeEvents = signal<{ at: number; queuedTotal: number }[]>([]);

  applyState(payload: PauseStatePayload): void {
    const wasPaused = this._state().isPaused;
    this._state.set({ /* ... */ });
    const isPaused = payload.isPaused;
    if (wasPaused && !isPaused) {
      const total = this.queuedTotal();
      // Suppress toast when N=0 (silent resume)
      if (total > 0) {
        this.resumeEvents.update(arr => [...arr, { at: Date.now(), queuedTotal: total }]);
      }
    }
  }
```

- [ ] **Step 2: Render toast in app shell**

Add to `app.component.html`:

```html
@for (ev of pauseStore.resumeEvents(); track ev.at) {
  <div class="resume-toast">
    Resumed — sending {{ ev.queuedTotal }} queued message{{ ev.queuedTotal === 1 ? '' : 's' }}
  </div>
}
```

In `app.component.ts`, when a resume event is added, schedule auto-dismiss after 5s.

**First, ensure `effect` is in the `@angular/core` import.** Task 31 added pause-related fields/imports but did NOT add `effect`. The existing import is likely `import { Component, ... } from '@angular/core'`. Append `effect`:

```typescript
import { Component, OnInit, OnDestroy, effect, inject /* + existing names */ } from '@angular/core';
```

Then add the constructor (or merge into existing constructor if AppComponent already has one):

```typescript
  constructor() {
    effect(() => {
      const events = this.pauseStore.resumeEvents();
      if (events.length > 0) {
        const latest = events[events.length - 1];
        setTimeout(() => {
          this.pauseStore.resumeEvents.update(arr => arr.filter(e => e.at !== latest.at));
        }, 5000);
      }
    });
  }
```

If `AppComponent` already has a constructor, add the `effect(...)` body inside it (do not create a second constructor).

- [ ] **Step 3: Verify + checkpoint**

```bash
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): resume toast (suppressed when N=0)
```

---

### Task 34: Network settings tab + recent-events dialog

**Files:**
- Create: `src/renderer/app/features/settings/network-settings-tab.component.ts`
- Create: `src/renderer/app/features/settings/pause-detector-events-dialog.component.ts`
- Modify: `src/renderer/app/core/state/settings.store.ts`
- Modify: `src/renderer/app/features/settings/settings.component.ts`

- [ ] **Step 1: Add `networkSettings` computed to SettingsStore**

In `src/renderer/app/core/state/settings.store.ts`, alongside `generalSettings`/`orchestrationSettings`/etc.:

```typescript
  readonly networkSettings = computed(() =>
    SETTINGS_METADATA.filter(m => m.category === 'network')
  );
```

- [ ] **Step 2: Create `network-settings-tab.component.ts`**

```typescript
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import { PauseDetectorEventsDialogComponent } from './pause-detector-events-dialog.component';
import { DEFAULT_SETTINGS, type AppSettings } from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-network-settings-tab',
  standalone: true,
  imports: [SettingRowComponent, PauseDetectorEventsDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!store.get('pauseFeatureEnabled')) {
      @for (s of store.networkSettings(); track s.key) {
        @if (s.key === 'pauseFeatureEnabled') {
          <app-setting-row [setting]="s" [value]="store.get(s.key)" (valueChange)="onChange($event)"/>
        }
      }
      <p class="muted">When enabled, the orchestrator can detect VPN connections and automatically pause AI traffic. While disabled, no related code is active in the app — outbound traffic is not intercepted, no detector polls the network, and no UI elements appear.</p>
    } @else {
      @for (s of store.networkSettings(); track s.key) {
        <app-setting-row [setting]="s" [value]="store.get(s.key)" (valueChange)="onChange($event)"/>
      }
      <hr/>
      <h3>Diagnostics</h3>
      <button (click)="restoreDefaultPattern()">Restore default pattern</button>
      <button (click)="eventsOpen.set(true)">Show recent detection events</button>
      @if (eventsOpen()) {
        <app-pause-detector-events-dialog (close)="eventsOpen.set(false)"/>
      }
      <p class="muted">Detection events are stored locally and never exported. Probe target hosts are never recorded in detection logs (they are stored as a normal user setting in settings.json).</p>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: var(--spacing-md); }
    .muted { color: var(--text-secondary); font-size: 0.875rem; }
  `],
})
export class NetworkSettingsTabComponent {
  store = inject(SettingsStore);
  eventsOpen = signal(false);

  onChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }

  restoreDefaultPattern(): void {
    this.store.set('pauseVpnInterfacePattern', DEFAULT_SETTINGS.pauseVpnInterfacePattern);
  }
}
```

- [ ] **Step 3: Create `pause-detector-events-dialog.component.ts`**

```typescript
import { ChangeDetectionStrategy, Component, EventEmitter, Output, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';   // post-review: required for `| date:'...'` template usage
import { ElectronIpcService } from '../../core/services/ipc';
import type { DetectorEvent } from '../../../../preload/domains/pause.preload';

@Component({
  selector: 'app-pause-detector-events-dialog',
  standalone: true,
  imports: [DatePipe],                         // post-review: standalone components must declare pipes used in their template
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="overlay" (click)="close.emit()">
      <div class="dialog" (click)="$event.stopPropagation()">
        <h2>Recent VPN detection events</h2>
        @if (events().length === 0) {
          <p>No events recorded.</p>
        } @else {
          <table>
            <thead><tr><th>Time</th><th>Decision</th><th>+IFs</th><th>−IFs</th></tr></thead>
            <tbody>
              @for (e of events(); track e.at) {
                <tr>
                  <td>{{ e.at | date:'HH:mm:ss.SSS' }}</td>
                  <td>{{ e.decision }}</td>
                  <td>{{ e.interfacesAdded.join(', ') }}</td>
                  <td>{{ e.interfacesRemoved.join(', ') }}</td>
                </tr>
              }
            </tbody>
          </table>
        }
        <button (click)="close.emit()">Close</button>
      </div>
    </div>
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .dialog { background: var(--bg-primary); padding: 24px; border-radius: 8px; max-width: 720px; max-height: 80vh; overflow: auto; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--border); font-size: 0.875rem; }
  `],
})
export class PauseDetectorEventsDialogComponent implements OnInit {
  private ipc = inject(ElectronIpcService);
  @Output() close = new EventEmitter<void>();
  events = signal<DetectorEvent[]>([]);

  async ngOnInit(): Promise<void> {
    const result = await this.ipc.pauseDetectorRecentEvents?.();
    if (result?.success && result.data) {
      this.events.set((result.data as { events: DetectorEvent[] }).events);
    }
  }
}
```

- [ ] **Step 4: Wire into `settings.component.ts`**

Three additions to `src/renderer/app/features/settings/settings.component.ts`:

(a) Extend `SettingsTab` union (line 30-50):
```typescript
type SettingsTab =
  | 'general'
  | 'network'                  // ← NEW
  | 'orchestration'
  // ... existing ...
```

(b) Add to `NAV_ITEMS` (after `permissions` row):
```typescript
  { id: 'network', label: 'Network' },
```

(c) Add `@case ('network') { <app-network-settings-tab /> }` to the `@switch` and add `NetworkSettingsTabComponent` to the component's `imports`.

(d) **Read `ActivatedRoute.fragment`** so `/settings#network` lands on the Network tab (post-review). The pause banner navigates with `fragment: 'network'` and currently `activeTab` defaults to `'general'` regardless. Add to `SettingsComponent`:

```typescript
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

  private route = inject(ActivatedRoute);

  constructor() {
    // Map URL fragment → activeTab. Subscribes for the lifetime of the
    // component so re-navigating to /settings#X also switches.
    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((frag) => {
      if (!frag) return;
      // Cast through the union; ignore unknown fragments rather than throw.
      const known: SettingsTab[] = [
        'general', 'orchestration', 'connections', 'memory', 'display',
        'ecosystem', 'permissions', 'review', 'advanced', 'keyboard',
        'remote-nodes', 'cli-health', 'provider-quota', 'models', 'mcp',
        'hooks', 'worktrees', 'snapshots', 'archive', 'remote-config',
        'network',
      ];
      if (known.includes(frag as SettingsTab)) {
        this.activeTab.set(frag as SettingsTab);
      }
    });
  }
```

(The `known` array exists to validate against the `SettingsTab` union; alternatively, do a plain string comparison against the union via a type guard. Cast safety is the only goal.)

- [ ] **Step 5: Verify + checkpoint**

```bash
npm run build
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): Network settings tab + diagnostics dialog
```

---

# Phase 9 complete

---

# Phase 10 — Bootstrap wiring, integration tests, docs

---

### Task 35: Main bootstrap wiring (`src/main/index.ts`)

**Files:**
- Modify: `src/main/index.ts`

The bootstrap order matters because the interceptor must be installed before any provider service can construct an HTTP client.

- [ ] **Step 1: Wire bootstrap sequence**

Inside the main initialisation flow (after the WindowManager and SettingsManager exist, but BEFORE any service that might make a provider call):

```typescript
import { getPauseCoordinator } from './pause/pause-coordinator';
import { installNetworkPauseGate } from './network/install-network-pause-gate';
import { AllowedHostMatcher } from './network/allowed-hosts';
import { getVpnDetector, VpnDetector } from './network/vpn-detector';
import { getSettingsManager } from './core/config/settings-manager';

  // 1. Coordinator first — read persisted state.
  const coordinator = getPauseCoordinator();
  coordinator.bootstrap();

  // 2. Settings access.
  const settings = getSettingsManager();

  let uninstallInterceptor: (() => void) | null = null;
  let detectorStarted = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function installInterceptorIfNeeded(): void {
    if (uninstallInterceptor) return; // already installed
    const allowedHosts = new AllowedHostMatcher({
      allowPrivateRanges: settings.get('pauseAllowPrivateRanges'),
      extraAllowedHosts: [settings.get('remoteNodesServerHost')].filter(Boolean) as string[],
    });
    uninstallInterceptor = installNetworkPauseGate({ coordinator, allowedHosts });
  }

  function uninstallInterceptorIfNeeded(): void {
    if (uninstallInterceptor) {
      uninstallInterceptor();
      uninstallInterceptor = null;
    }
  }

  function startDetectorIfNeeded(): void {
    if (detectorStarted) return; // already running
    if (!settings.get('pauseOnVpnEnabled')) {
      // Auto-detection is off. Persisted vpn/detector-error reasons would
      // otherwise stay forever (no detector to ever clear them). Drop them
      // here so the app starts running unless the user reason is held.
      // Post-review fix.
      coordinator.removeReason('vpn');
      coordinator.removeReason('detector-error');
      return;
    }
    const detector = getVpnDetector({
      pattern: new RegExp(settings.get('pauseVpnInterfacePattern')),
      treatExistingAsVpn: settings.get('pauseTreatExistingVpnAsActive'),
      probeMode: settings.get('pauseReachabilityProbeMode'),
      probeHost: settings.get('pauseReachabilityProbeHost') || undefined,
      probeIntervalSec: settings.get('pauseReachabilityProbeIntervalSec'),
      forceFirstScanVpnTreatment: coordinator.needsFirstScanForceVpnTreatment(),
    });
    detector.on('vpn-up', () => {
      coordinator.addReason('vpn');
      coordinator.reconcileFirstEvaluation(true);
    });
    detector.on('vpn-down', () => {
      coordinator.removeReason('vpn');
      coordinator.reconcileFirstEvaluation(false);
    });
    detector.on('detector-error', () => coordinator.addReason('detector-error'));

    // Fail-closed reconciliation (post-review): if we booted with
    // `detector-error` (because persistence had `vpn` only, or the file was
    // corrupted), we MUST clear it once the detector has had a chance to
    // give us real information. Otherwise a clean restart leaves the app
    // paused under detector-error forever.
    //
    // The detector emits 'first-evaluation-complete' once the interface scan
    // has happened and, for probe configs, the first probe result has arrived.
    // `first-probe-completed` is also wired for probe-only reconciliation.
    detector.on('first-evaluation-complete', () => {
      coordinator.reconcileFirstEvaluation(detector.isVpnActive());
    });
    detector.on('first-probe-completed', () => {
      coordinator.reconcileFirstEvaluation(detector.isVpnActive());
    });

    // Single ownership of probe lifecycle (post-review): VpnDetector.start()
    // is responsible for kicking off the probe via startProbeIfConfigured()
    // internally (Task 9 step 2). Do NOT call startProbeIfConfigured()
    // again here — that would schedule the probe twice.
    detector.start();
    detectorStarted = true;

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (detectorStarted && detector.isHeartbeatStale()) {
          coordinator.addReason('detector-error');
        }
      }, 10_000);
      heartbeatTimer.unref?.();
    }
  }

  function stopDetectorIfNeeded(): void {
    if (!detectorStarted) return;
    getVpnDetector().stop();
    VpnDetector._resetForTesting();        // discard the singleton; next start makes a fresh one
    detectorStarted = false;
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function activatePauseFeature(): void {
    installInterceptorIfNeeded();
    startDetectorIfNeeded();
  }

  function deactivatePauseFeature(): void {
    stopDetectorIfNeeded();
    uninstallInterceptorIfNeeded();
    // Remove all reasons atomically — kill switch off means resumed.
    coordinator.clearAllReasons('pause-feature-disabled');
    clearPersistedInstanceQueues();
  }

  // Initial activation based on persisted setting value.
  //
  // Critical post-review correctness: if the kill switch is OFF at startup
  // but persistence indicated a paused state (vpn or detector-error reasons,
  // or corrupted file → fail-closed `detector-error`), the coordinator's
  // bootstrap() above has ALREADY put it in a paused state. We must
  // immediately clear those reasons; otherwise the adapter gate, IPC
  // backstop, and renderer queue would all refuse sends even though the
  // feature is supposed to be fully disabled.
  if (settings.get('pauseFeatureEnabled')) {
    activatePauseFeature();
  } else {
    // Feature disabled: discard any persisted paused state from a previous
    // session. deactivatePauseFeature() removes all reasons atomically.
    // (uninstallInterceptor and stopDetector are no-ops here since neither
    // was started, but calling them keeps the path symmetric and safe.)
    deactivatePauseFeature();
  }

  // Watch for kill-switch toggles at runtime. Read live values; do NOT
  // rely on the captured `featureEnabled` at startup.
  settings.on('setting:pauseFeatureEnabled', (value: unknown) => {
    if (value === true) activatePauseFeature();
    else if (value === false) deactivatePauseFeature();
  });

  // Watch for pauseOnVpnEnabled toggles — detector only (interceptor unaffected).
  settings.on('setting:pauseOnVpnEnabled', (value: unknown) => {
    // Always read live — the kill-switch status may have changed too.
    if (!settings.get('pauseFeatureEnabled')) return;
    if (value === false) {
      // Detector is being disabled; clear both vpn and detector-error.
      // Without removing detector-error too, a previously-errored detector
      // would leave the app paused even after the user explicitly turned
      // detection off.
      coordinator.removeReason('vpn');
      coordinator.removeReason('detector-error');
      stopDetectorIfNeeded();
    } else if (value === true) {
      startDetectorIfNeeded();
    }
  });

  // --- Runtime config listeners (post-review) ---
  //
  // The original wiring captured AllowedHostMatcher and detector config once
  // at activate time. Toggling allow-private-ranges, remoteNodesServerHost,
  // probe mode/host/interval, or treatExisting at runtime would NOT take
  // effect until a feature restart. Rebuild the affected component on each
  // setting change.

  function rebuildInterceptor(): void {
    if (!uninstallInterceptor) return;       // not installed; nothing to rebuild
    uninstallInterceptorIfNeeded();
    installInterceptorIfNeeded();
  }

  function rebuildDetector(): void {
    if (!detectorStarted) return;
    stopDetectorIfNeeded();
    // Clear detector-owned reasons before restarting (post-review): if the
    // OLD detector had emitted vpn-up under the old config but the NEW
    // config no longer matches, the old reason would persist forever
    // (no `vpn-down` from the fresh detector if it never sees a transition).
    // The fresh detector will re-add `vpn` on its first scan if conditions
    // still apply.
    coordinator.removeReason('vpn');
    coordinator.removeReason('detector-error');
    startDetectorIfNeeded();
  }

  // Interceptor allow-list inputs:
  settings.on('setting:pauseAllowPrivateRanges', () => rebuildInterceptor());
  settings.on('setting:remoteNodesServerHost', () => rebuildInterceptor());

  // Detector config inputs:
  settings.on('setting:pauseTreatExistingVpnAsActive', () => rebuildDetector());
  settings.on('setting:pauseReachabilityProbeMode', () => rebuildDetector());
  settings.on('setting:pauseReachabilityProbeHost', () => rebuildDetector());
  settings.on('setting:pauseReachabilityProbeIntervalSec', () => rebuildDetector());

  // Pattern changes also rebuild the detector (post-review). `updatePattern()`
  // alone doesn't re-filter the existing `activeVpnIfaces` set against the
  // new pattern, so a previously-matched interface that no longer matches
  // would still be tracked as VPN. Full rebuild is the simpler correct path:
  settings.on('setting:pauseVpnInterfacePattern', () => rebuildDetector());

  // (Pattern listener already added above in the runtime-config block.)
```

- [ ] **Step 2: Verify build + commit**

```bash
npm run build
npx tsc --noEmit
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): bootstrap wiring (coordinator → interceptor → detector → listeners)
```

---

### Task 36: User-facing docs (`docs/pause-on-vpn.md`)

**Files:**
- Create: `docs/pause-on-vpn.md`

- [ ] **Step 1: Author docs**

`docs/pause-on-vpn.md`:

```markdown
# Pause on VPN

When you connect to a VPN that you do not want AI traffic flowing over,
the orchestrator can pause itself: it stops sending new messages to the
provider APIs, interrupts any in-flight CLI turns, and refuses any other
outbound provider call. When you disconnect from the VPN (or release the
manual pause), it resumes seamlessly — your queued messages drain in
order, your conversations continue.

## How to use it

- **Auto-detection:** on by default. The orchestrator detects VPN
  connections via interface name (regex configurable in
  Settings → Network).
- **Manual override (master pause button):** the pause icon in the
  title bar. Click it any time to hold a manual pause. Click again to
  release. Independent of VPN auto-detection.
- **Master kill switch:** Settings → Network → "Enable VPN pause
  feature." Off = the feature is fully removed from the running
  process (no interceptor, no detector, no UI). Use this if the
  feature ever causes timeouts or false-pauses.

## Calibration playbook (run once with your work VPN)

1. App running, VPN disconnected. Open Settings → Network. Note the
   default interface pattern.
2. Enable **Verbose detection logging**.
3. Connect to your work VPN.
4. Open Settings → Network → **Show recent detection events**. Find
   the event with `decision: pause` and note the matching interface
   name. If the default pattern doesn't match, edit
   **Interface pattern (regex)** to match what you saw.
5. Disconnect. Verify a `decision: resume` event appears.
6. Repeat with the master pause button held — confirm the app does
   NOT auto-resume on VPN drop while the master is on.

## What pause guarantees

- Every user-typed message is queued, never silently dropped.
- The CLI sessions stay alive — on resume, fresh input flows normally.
- In-flight active turns are interrupted on pause; you lose the
  in-progress assistant reply for that turn.

## What pause cannot fully prevent

- A small in-flight window (~ms-to-seconds) of OS-level TCP buffers
  draining after `interrupt()` is issued. Mitigate by hitting the
  master pause button BEFORE you connect to VPN.
- VPNs that don't manifest as a new network interface — these go
  undetected by interface polling. Configure a reachability probe in
  Settings if you have one of these.

## Privacy notes

- Probe target hosts are stored in your local `settings.json` (not
  recorded in detection logs).
- Detection-event diagnostics live in `pause-state.json` (interface
  names and timestamps only — no IP addresses, no headers, no URLs).
- Queue persistence is gated by the existing
  `persistSessionContent` setting — when off, queues live only in
  memory and are lost on crash.

## Known intentional friction

After a detector error (rare — see logs), you'll see a confirmation
modal. The default focus is on Cancel; Resume requires explicit
click. This is by design — fail-closed semantics require explicit
confirmation when the system doesn't know its own state.
```

- [ ] **Step 2: Commit**

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: docs(pause): user-facing docs + calibration playbook
```

---

### Task 37: End-to-end seamless-resume integration test

**Files:**
- Create: `src/main/__tests__/pause-seamless-resume.integration.spec.ts`

- [ ] **Step 1: Implement the seamless-resume scenarios**

Cases the engineer must add (one `it()` each — uses MockCliAdapter):

- **Pause → queue 3 messages → resume → all 3 sent in insertion order, no duplicate user-bubbles.**
- **Pause → queue 0 messages → resume → no resume toast emitted, no spurious events to renderer.**
- **Long-pause CLI revival** — pause for a mocked 60 minutes; resume; assert next `sendInput` succeeds (existing stuck-process detector path may activate; that's fine).
- **Multi-instance fan-out** — 5 instances, each with 2 queued messages; resume; assert 10 total `sendInput` calls land per-instance in insertion order, with no thundering-herd.
- **Initial-prompt-while-paused** (full e2e) — `manager.createInstance({ initialPrompt: 'hello' })` while paused; instance stays in `idle`; renderer receives `INSTANCE_QUEUE_INITIAL_PROMPT`; resume; message sends with `isRetry=true` and main does NOT add a duplicate user bubble.
- **Kill-switch end-to-end** — `pauseFeatureEnabled=true`; verify all components active; toggle to `false`; assert `http.request` is back to identity-equal to the original; toggle back to `true`; assert the interceptor reinstalled cleanly.

- [ ] **Step 2: Verify + checkpoint**

```bash
npx vitest run src/main/__tests__/pause-seamless-resume.integration.spec.ts
# Checkpoint files: see the task file list above
Checkpoint marker: test(pause): seamless-resume + kill-switch integration tests
```

---

### Task 38: Manual playbook with the user's actual work VPN

**Files:** none — manual test.

- [ ] **Step 1: Run the calibration playbook**

Follow `docs/pause-on-vpn.md` "Calibration playbook" with the user's actual work VPN. Note the matched interface name; if it differs from the default regex, update `DEFAULT_SETTINGS.pauseVpnInterfacePattern` in `src/shared/types/settings.types.ts` and commit:

```bash
# Checkpoint files: see the task file list above
Checkpoint marker: feat(pause): default interface pattern based on calibration
```

- [ ] **Step 2: Restart app, verify auto-pause + auto-resume work as expected**

---

### Task 39: Final audit — full grep for missed remote-call surfaces

**Files:** none — sanity check.

- [ ] **Step 1: Re-run the audit grep**

```bash
grep -rEln "https?\.request|fetch\(|@anthropic-ai/sdk|@google/generative-ai|api\.openai|api\.anthropic|api\.cohere|api\.voyageai|api\.mistral|api\.groq|api\.exa|generativelanguage\.googleapis" src/main packages/contracts/src
```

For each result, confirm one of:
- It's an allow-listed local host (Ollama, localhost, etc.).
- It will be caught by the network interceptor (uses `fetch`, `http.request`, `http.get`, `https.request`, or `https.get`).
- It uses the Anthropic SDK (which goes through `globalThis.fetch`).

If you find ANY new file that uses a different mechanism (e.g., `undici.request` directly, raw sockets, native modules), open a follow-up to extend the interceptor before merge.

- [ ] **Step 2: Run full test suite**

```bash
npm run lint
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npx vitest run
```

All pass.

- [ ] **Step 3: Commit nothing (this is sign-off)**

---

# Phase 10 complete

The feature is implementation-complete: foundation, detection, settings, IPC, adapter gates, subsystem hooks, renderer state, UI, bootstrap, and integration tests are all in place. The kill switch is the safety release if anything misbehaves in production.

---

# Self-review

## Spec coverage

Spec sections vs plan tasks:

| Spec section | Tasks |
|---|---|
| §1 Goal — kill switch + 3-layer defense | T17–T19 (Layer 2), T6–T7 (Layer 3), T26 (Layer 1), T35 (kill switch) |
| §2 Architecture | T35 bootstrap wiring |
| §3 VpnDetector (interface alg + probe + debounce + probe-known) | T8–T9 |
| §4 PauseCoordinator + persistence + fail-closed restart + kill-switch lifecycle | T1–T4, T35 |
| §5.A renderer queue gates | T26 |
| §5.B queue persistence (incl. attachment stripping) | T13, T15, T27 |
| §5.C BaseCliAdapter template-method + RemoteCliAdapter special case | T17–T19 |
| §5.D InstanceManager pause listener | T21 |
| §5.E CrossModelReviewService | T22 |
| §5.F ProviderQuotaService (timers stay) | T23 |
| §5.G Network interceptor (5 primitives, allow-list, identity restore) | T5–T7 |
| §5.H Provider discovery / health probes — covered transitively by interceptor | T39 audit |
| §5.I Auto-compaction (transitive) | (no task — inherits adapter gate) |
| §5.J Renderer PauseStore | T25 |
| §6.1 9 new settings | T10 |
| §6.2 Settings UI (network tab + nav + switch) | T34 |
| §6.3 Settings validators | T11 |
| §6.4 Pause-state persistence | T2 |
| §6.5 Queue persistence + persistSessionContent gate | T15, T27 |
| §6.6 Diagnostic privacy | T8 (ring buffer redaction), T24 (export exclusion) |
| §7 UI (toggle, banner, modal, queued indicators, toast, settings tab) | T28–T34 |
| §8 Failure modes — most covered by tests in T1–T9, T20, T22, T23, T26, T37 |
| §8 Seamless-resume guarantees (subsection) | T37 integration tests |
| §9 Test plan | tests in each task; T37 integration |
| §10 Done definition | T38 (manual playbook), T39 (audit + full sweep) |
| §11 Files touched | matched by File Structure section above |

No gaps identified.

## Placeholder scan

Searched for "TBD", "TODO", "implement later", "fill in details", "Add appropriate error handling", and similar — none present in normative steps. Step bodies all contain actual code or specific instructions.

## Type consistency

- `OrchestratorPausedError` defined in T1; used in T6, T7, T15, T17 (template method), T19 (Remote), T20 (lifecycle), T26 (retry-disposition).
- `PauseReason` defined in T2; used in T3, T4, T11 (validators), T12 (Zod schema), T25 (PauseStore).
- `PauseStatePayload` from T12 schema; consumed by T16 (preload), T25 (PauseStore).
- `PersistedQueuedMessageSchema` defined in T13; consumed by T15 (handlers), T27 (renderer service).
- `getPauseCoordinator()` defined in T3; called from T6, T15, T17, T19, T20, T21, T22, T23, T35.
- `getVpnDetector()` defined in T8; called from T14 (handlers), T35 (bootstrap).
- `installNetworkPauseGate` defined in T6; called from T35.
- `AllowedHostMatcher` defined in T5; constructed in T35.
- `seededAlready`/`hadAttachmentsDropped` flow: declared in T13 schema → renderer queue type T26 → persistence service T27 → drain logic T26 (`skipUserBubble = seededAlready`) → main `isRetry` gate (existing).

All consistent. No method-name drift identified.

---

# Plan revision log

## R11 (2026-04-28, plan review — 7 P1 + 1 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | Plan told implementers to commit at every step (38 instances) and to checkpoint a known-broken intermediate state in Task 17 — both violate `CLAUDE.md` ("never commit unless explicitly asked") | Accepted — all git commands were converted to non-actionable checkpoint markers. Task 17 reworded so its broken-compilation state is never checkpointed; Tasks 17+18 are atomic. |
| 2 (P1) | `import * as http from 'http'` under CommonJS+esModuleInterop wraps the module in `__importStar` — assignments mutate the wrapper, not the singleton, so the interceptor would be silently broken | Accepted — interceptor switched to `import http = require('http')` (CommonJS-direct), which references the actual module exports. |
| 3 (P1) | Bootstrap `activatePauseFeature()` early-returns when interceptor is installed; `pauseOnVpnEnabled` toggle off→on never restarts the detector | Accepted — split into `installInterceptorIfNeeded`/`startDetectorIfNeeded`/`stopDetectorIfNeeded`/`uninstallInterceptorIfNeeded`. Toggles read live setting values. |
| 4 (P1) | Renderer code calls `this.ipc.pauseSetManual` and similar; `ElectronIpcService` is a facade and these methods don't exist | Accepted — added Task 16b: new `PauseIpcService`, queue methods on `InstanceIpcService`, facade bindings in `ElectronIpcService`, barrel re-export. |
| 5 (P1) | When a queue drains to empty, the map deletes the entry, the persistence effect doesn't see it, and the disk file keeps the stale entry — restart restores stale messages | Accepted — `previouslyPersistedIds` Set added; when an ID disappears from the map, schedule an empty-array save (which the main handler treats as delete). |
| 6 (P1) | AppComponent snippet replaced `ngOnInit`, dropping platform detection, dev-service exposure, capability listeners, settings menu listener, `appReady()`, capability fetch, and OnDestroy cleanup | Accepted — Task 31 step 2 rewritten as additive: keep all existing logic; insert restore + state subscription at the top of the existing body; add unsubscribe to existing `ngOnDestroy`. |
| 7 (P1) | `this.deps.queueInitialPromptForRenderer` was used but not declared in `LifecycleDependencies`; `InstanceManager` doesn't have a `WindowManager` field | Accepted — explicit dependency path: extend `LifecycleDependencies` with the field; pass `WindowManager` into `InstanceManager` constructor; supply the callback at the wiring site. |
| 8 (P2) | Initial-prompt-while-paused path silently dropped attachments without setting `hadAttachmentsDropped` | Accepted — renderer handler now detects payload attachments, drops them, marks `hadAttachmentsDropped: true`, and emits a console warning. UI's existing "reattach before resuming" hint then fires. |

No pushbacks Round 11. All eight verified codebase-anchored defects.

## R12 (2026-04-28, plan review — 4 P1 + 4 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | `electron-ipc.service.ts` is the LOW-LEVEL base IPC bridge in this repo, not the facade. Real facade is `IpcFacadeService` in `index.ts:92` (re-exported as `ElectronIpcService`). Adding domain injections to the base would create a DI cycle. | Accepted — Task 16b step 3 rewritten: bindings live on `IpcFacadeService` in `index.ts`. `InstanceIpcService` already injected as `readonly instance` (line 96); add `readonly pause = inject(PauseIpcService)` and forwarder methods. |
| 2 (P1) | IPC fallback objects had `error.code` and `error.timestamp` shape (main-process), but renderer `IpcResponse` (`electron-ipc.service.ts:14-17`) only allows `error: { message: string }`. Direct `window.electronAPI` access can throw in test mode. | Accepted — fallbacks now use `{ success: false, error: { message: 'Not in Electron' } }` (matches base service pattern). Domain services inject the concrete low-level `ElectronIpcService` from `./electron-ipc.service` for `getApi()` access; listeners are wrapped in `NgZone.run()` per existing pattern. |
| 3 (P1) | `QueuedMessage` import was from `instance-state.service.ts` (where it isn't exported); type lives in `instance.types.ts:146`. | Accepted — runtime queue extension moved to `instance.types.ts`; imports in messaging store and persistence service updated to `./instance.types`. |
| 4 (P1) | AppComponent declared `pauseStore` as `private`, but Task 33 template reads `pauseStore.resumeEvents()`. Angular strict templates can't access private members. | Accepted — changed to `protected readonly pauseStore = inject(PauseStore)`. Template access now compiles. |
| 5 (P2) | `PauseStore.queuedTotal` was a signal with a comment claiming `InstanceMessagingStore` would update it, but Task 26 never actually wired the update. Banner and resume-toast would always read 0. | Accepted — added Task 26 step 7 (new): effect in `instance-messaging.store.ts` that derives total from `messageQueue` and writes to `pauseStore.queuedTotal`. Test case added. |
| 6 (P2) | Cross-model review wiring used a parallel `activeAborters` Set + `{ skipped: true } as never` cast that didn't fit the existing `pendingReviews: Map<string, AbortController>` and `onInstanceIdle(): Promise<void>` signature. Also acknowledged abort doesn't terminate a running adapter. | Accepted — Task 22 rewritten to reuse existing `pendingReviews`; gate on `onInstanceIdle` returns `void` (matches existing); doc note about in-flight adapter limitation (covered by Layer 3 anyway). |
| 7 (P2) | Settings-export task added `EXCLUDED_NAMESPACES` to a loop that doesn't exist. `buildExportData()` reads `settings.getAll()` + explicit credStore/policyStore — no namespace iteration. | Accepted — Task 24 reframed as a regression test: pause-state and instance-message-queue are already absent from export by construction; tests lock that in place. |
| 8 (P2) | New `WindowManager` constructor arg on `InstanceManager` would break two test sites (`instance-manager.spec.ts`, `instance-manager.normalized-event.spec.ts`). | Accepted — `windowManager?: WindowManager` is **optional**; when missing, `queueInitialPromptForRenderer` logs a warning and no-ops. Production bootstrap passes the real WindowManager. New unit test verifies the optional path. |

No pushbacks Round 12. All eight verified codebase-anchored defects.

## R13 (2026-04-28, plan review — 5 P1 + 3 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | `PauseIpcService` imported `BaseIpcService` from `./electron-ipc.service`, but `BaseIpcService` is only a barrel alias from `index.ts`. Importing that from a domain service creates a circular import. The concrete symbol is `ElectronIpcService` with public `getApi()` / `getNgZone()` methods. | Accepted — switched to `import { ElectronIpcService, type IpcResponse } from './electron-ipc.service'`. Domain services use `this.base.getApi()` / `this.base.getNgZone()` via private getters that mirror `InstanceIpcService:31-41`. |
| 2 (P1) | `InstanceIpcService` snippet referenced `getApi()` and `zone` accessors that don't exist. Actual service has private getters `api` and `ngZone` (verified at `instance-ipc.service.ts:35-41`). | Accepted — rewritten to use `this.api?.foo` and `this.ngZone.run(...)` matching the surrounding file style. |
| 3 (P1) | Existing `QueuedMessage` interface has `kind?: 'queue' \| 'steer'` for steering priority. My snippet replaced the shape and dropped `kind`, breaking steer-message ordering. Persistence schema also dropped it, so a steer message restored from disk would lose priority. | Accepted — `QueuedMessage` extension is now strictly **additive**, preserving `kind`. `PersistedQueuedMessageSchema` adds `kind: z.enum(['queue', 'steer']).optional()`. Persistence service `persistNow` includes `kind: q.kind`; `restoreFromDisk` copies `kind: e.kind` back. |
| 4 (P1) | New `settings-export.spec.ts` imported `buildExportData()` without mocking `electron`, `getRLMDatabase()`, `ChannelCredentialStore`, `ChannelAccessPolicyStore`, `getSettingsManager()` — would throw or open real persistence. | Accepted — Task 24 step 2 now includes `vi.mock(...)` calls for all five dependencies up-front. Replaced literal-string assertions (`/pause-state/`) with shape-marker assertions (`/recentTransitions/`, `/hadAttachmentsDropped/`, `/seededAlready/`) since substring matches against settings JSON would risk false positives. |
| 5 (P1) | Task 33 resume-toast `effect()` in `AppComponent` constructor used `effect()` but Task 31 import update only added pause components/stores, not `effect`. | Accepted — Task 33 now explicitly says: append `effect` to the existing `@angular/core` import; if AppComponent already has a constructor, add the effect inside it (don't create a duplicate). |
| 6 (P2) | Quota service plan added `activeAborters` set and aborts-on-pause, but never instructed `refresh()` to register/deregister its local `ac = new AbortController()` (verified at `provider-quota-service.ts:102`). In-flight probes would not stop on pause. | Accepted — Task 23 step 2 now wires `this.activeAborters.add(ac)` after creation, with `try { ... } finally { this.activeAborters.delete(ac); }`. |
| 7 (P2) | Disabling `pauseOnVpnEnabled` removed only the `vpn` reason. If app was paused under `detector-error`, disabling auto-detection left it paused indefinitely. | Accepted — bootstrap listener now removes `detector-error` reason as well when `pauseOnVpnEnabled` toggles to false. `user` reason preserved. |
| 8 (P2) | `AllowedHostMatcher` and detector config were captured once at activate time. Runtime changes to `pauseAllowPrivateRanges`, `remoteNodesServerHost`, probe mode/host/interval, or `pauseTreatExistingVpnAsActive` would not take effect until restart. Only the interface pattern had a live-update listener. | Accepted — bootstrap now subscribes to all relevant settings and rebuilds the interceptor or detector on change. `rebuildInterceptor()` for allow-list inputs; `rebuildDetector()` for detection config inputs. Pattern listener consolidated into the same block. |

No pushbacks Round 13. All eight verified codebase-anchored defects.

## R14 (2026-04-29, plan review — 2 P1 + 4 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | Settings-export mock had wrong `getRLMDatabase` import path; returned object lacked `getRawDb()` (called at line 50); channel stores were plain objects but exporter constructs them with `new` (lines 51-52); electron mock missing `app.getVersion()` (called line 72). | Accepted — verified imports/calls; rewrote mocks: correct path `../../persistence/rlm-database`; `getRLMDatabase()` returns `{ getRawDb: vi.fn().mockReturnValue({}) }`; channel stores mocked as constructible (`vi.fn().mockImplementation(() => ({ getAll: ... }))`); electron mock now includes `app.getVersion`. |
| 2 (P1) | Bootstrap reads persisted pause state BEFORE checking `pauseFeatureEnabled`. If kill switch is false at startup but persistence had `vpn`/`detector-error`, coordinator stays paused — adapter gate, IPC backstop, and renderer queue all refuse sends despite the feature being "off." | Accepted — bootstrap now branches on `pauseFeatureEnabled` after coordinator init: if true, `activatePauseFeature()`; if false, `deactivatePauseFeature()` (which clears all reasons atomically). The kill-switch-off path now produces a clean running state regardless of persisted reasons. |
| 3 (P2) | `CrossModelReviewService.isPaused = false` initial value missed fail-closed-restart case — coordinator already paused before subsystem subscribed. Same for `ProviderQuotaService.isPaused`. | Accepted — both initialised from `getPauseCoordinator().isPaused()` (coordinator is bootstrapped before subsystem constructors run, so this reads the correct startup state). |
| 4 (P2) | `rebuildDetector()` stopped and recreated the detector but didn't clear detector-owned reasons. If the OLD detector emitted `vpn` under the old config but the new config doesn't match, the new detector emits no `vpn-down` and the reason persists forever. Pattern updates via `updatePattern()` also don't re-filter the existing `activeVpnIfaces` set. | Accepted — `rebuildDetector()` now removes `vpn` and `detector-error` reasons before restart; the fresh detector re-adds them on first scan if conditions still apply. Pattern changes route through `rebuildDetector()` (full rebuild), not `updatePattern()`. |
| 5 (P2) | Task 9 said `start()` calls `startProbeIfConfigured()` internally; bootstrap also called it — probe scheduled twice on startup/rebuild. | Accepted — bootstrap no longer calls `startProbeIfConfigured()` separately; the comment makes single ownership explicit. |
| 6 (P2) | Task 26 step 8 staged `instance-state.service.ts` but the `QueuedMessage` extension modifies `instance.types.ts`. Checkpoint workflow could leave the type change unstaged. | Accepted — checkpoint stage list now correctly references `instance.types.ts`. |

No pushbacks Round 14. All six verified codebase-anchored defects.

## R15 (2026-04-29, plan review — 3 P1 + 1 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | Settings-export mock paths were relative to the SUT, not the test file. From `src/main/core/config/__tests__/`, `../../persistence/...` resolves to `src/main/core/persistence/` (wrong); needs `../../../persistence/...`. SUT also imports `dialog` from `electron` (line 9) — mock must export it for the named-import to succeed. | Accepted — paths corrected to `../../../persistence/rlm-database`, `../../../channels/channel-credential-store`, `../../../channels/channel-access-policy-store`. `electron` mock now also exports `dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }`. Comments document the resolution from test file → SUT path. |
| 2 (P1) | App shell rendered `<app-pause-toggle />` and `<app-pause-banner />` unconditionally; `PAUSE_SET_MANUAL` IPC handler unconditionally added a `user` reason. With `pauseFeatureEnabled=false`, clicking the visible toggle could still pause the coordinator and make adapter/IPC gates refuse sends. | Accepted — template wraps both `app-pause-toggle` and `app-pause-banner` in `@if (settingsStore.get('pauseFeatureEnabled')) { ... }`. `PAUSE_SET_MANUAL` handler returns `{ success: false, error: { code: 'PAUSE_FEATURE_DISABLED' } }` when the kill switch is off. Defense in depth: even if a stale UI rendered the button, the main-side rejects. |
| 3 (P1) | When `pauseFeatureEnabled=true` but `pauseOnVpnEnabled=false`, persisted `vpn`/`detector-error` reasons weren't cleared by `activatePauseFeature()` because `startDetectorIfNeeded()` early-returned. App could stay paused forever with no detector to clear the reasons. | Accepted — `startDetectorIfNeeded()` now removes `vpn` and `detector-error` reasons in its early-return branch (when `pauseOnVpnEnabled=false`). `user` reason preserved. |
| 4 (P2) | `refresh()` catch block stored `ok: false` snapshot on any thrown error, including the abort that pause itself triggers. This contradicts the documented "leave the previous good snapshot, no new emit" behavior. | Accepted — added explicit catch branch: `if (ac.signal.aborted && this.isPaused) return null;` BEFORE the existing `storeSnapshot(errSnap)` call. Non-abort errors continue through the normal error path. |

No pushbacks Round 15. All four verified codebase-anchored defects.

## R16 (2026-04-29, plan review — 2 P1 + 2 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | Fail-closed-restart could leave app stuck under `detector-error` forever. Bootstrap wired `vpn-up`/`vpn-down`/`detector-error` events but never reconciled `detector-error` away after the first scan/probe completed. | Accepted — detector now emits `'first-evaluation-complete'`: immediately if probe disabled (interface scan IS the full evaluation), or on first probe result if probe configured. Bootstrap listens; on receipt, removes `detector-error` if currently held. The detector also emits `vpn-up` from init when matching interfaces are seeded — coordinator gets both reasons briefly, then `detector-error` drops, leaving clean `vpn` reason. |
| 2 (P1) | `PauseDetectorEventsDialogComponent` template uses `e.at \| date:'HH:mm:ss.SSS'` but the standalone component doesn't import `DatePipe` or `CommonModule`. Strict template compilation rejects unknown pipes. | Accepted — added `import { DatePipe } from '@angular/common';` and `imports: [DatePipe]` to the component decorator. |
| 3 (P2) | AppComponent injected `QueuePersistenceService` and called `restoreFromDisk()` BEFORE checking `pauseFeatureEnabled`. With kill switch off, stale persisted queues from a previous enabled session would still be restored. Pause state subscription also fired unnecessarily. | Accepted — restore + state subscription wrapped in `if (pauseFeatureOn)`. The on-disk file from a previous session remains until `persistSessionContent` flips off (Task 15 main-side clears it then) or the user re-enables the feature. |
| 4 (P2) | Task 20 step 4 checkpoint staged only `instance-lifecycle.ts` + `instance-communication.ts`, but R12 added required changes to `instance-manager.ts` (WindowManager constructor arg) and `src/main/index.ts` (passing it). Following the staged-files list literally would leave the branch broken. | Accepted — checkpoint stage list now includes both `instance-manager.ts` and `index.ts`. |

No pushbacks Round 16. All four verified codebase-anchored defects.

## R17 (2026-04-29, plan review — 2 P1 + 3 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | `SettingsStore.initialize()` is called from `DashboardComponent:168`, NOT app root. AppComponent's `pauseFeatureEnabled` check would read `DEFAULT_SETTINGS` (always `true`) before the store finishes loading. Persisted `pauseFeatureEnabled=false` would be ignored at this critical decision point. | Accepted — AppComponent now `await`s `this.settingsStore.initialize()` before the kill-switch check. Added a sub-task to make `SettingsStore.initialize()` idempotent (internal `initialized` flag + `initPromise` for concurrent callers); the existing DashboardComponent call becomes a no-op. |
| 2 (P2) | `QueuePersistenceService` constructor (runs at first inject) installs the `messageQueue` effect and `onInstanceQueueInitialPrompt` listener regardless of the kill switch. Wrapping `restoreFromDisk()` doesn't prevent the effect from later writing snapshots. | Accepted — `effect()` body now early-returns when `pauseFeatureEnabled=false` (live-checked, so toggling either kill switch or `persistSessionContent` works without restart). Initial-prompt listener also gates on the kill switch at subscription time. |
| 3 (P1) | `SettingsManager.update()`/`reset()`/`resetOne()` emit `setting-changed` and `settings-updated`/`settings-reset`, but **not** `setting:<key>`. The bootstrap's runtime listeners use `setting:<key>` exclusively, so a settings import or reset would NOT trigger interceptor/detector rebuilds — the kill switch could remain active until app restart. | Accepted — Task 11 step 4 extended: `update()`, `reset()`, and `resetOne()` now also emit `setting:${key}`. Validators applied per-key in `update()` too. |
| 4 (P2) | Pause banner navigates to `/settings#network` but `SettingsComponent.activeTab` is a local signal that defaults to `'general'` and never reads `ActivatedRoute.fragment`. The "Adjust pattern in Settings" link lands on the wrong tab. | Accepted — Task 34 step (d) added: `SettingsComponent` injects `ActivatedRoute`, subscribes to `route.fragment`, validates against the `SettingsTab` union, and updates `activeTab` accordingly. |
| 5 (P2) | Node's `URL.hostname` for IPv6 literals returns `'[::1]'` (with brackets); `AllowedHostMatcher` checks for `'::1'` (no brackets). `fetch('http://[::1]/')` would be blocked when paused even though loopback is allow-listed. | Accepted — `normaliseHostname()` helper strips bracketed IPv6 literals before matching. Applied in both `extractHostname()` (http/https paths) and the fetch wrapper. New test case asserts `fetch('http://[::1]:0/')` while paused does NOT throw `OrchestratorPausedError`. |

No pushbacks Round 17. All five verified codebase-anchored defects.

## R18 (2026-04-29, plan review — 1 P1 + 3 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | AppComponent reads `pauseFeatureEnabled` once in `ngOnInit`. With kill switch off at startup, no listeners ever register. Toggling the switch on later activates the main-process feature but leaves the renderer half-disconnected — contradicts the no-restart requirement. | Accepted — added a new `PauseRendererController` service that owns reactive start/stop of pause renderer wiring. AppComponent calls `bindReactive()` once after settings init; the controller's `effect()` watches `pauseFeatureEnabled` and calls `start()`/`stop()` accordingly. `start()` restores queues + subscribes to IPC + fetches initial state; `stop()` unsubscribes + resets PauseStore. |
| 2 (P2) | `QueuePersistenceService` constructor (Angular instantiates at first inject, before `await settingsStore.initialize()`) installs the `messageQueue` effect, which would run once with `DEFAULT_SETTINGS`. The initial-prompt listener registration also fired before settings were loaded. | Accepted — service's `effect()` now early-returns `if (!this.settings.isInitialized())`. Initial-prompt subscription moved out of constructor into public `subscribeToInitialPrompts()` / `unsubscribeFromInitialPrompts()` methods; `PauseRendererController.start()`/`stop()` call them at the right times. |
| 3 (P2) | The R17 idempotence wrapper marked `initialized = true` whenever `doInitialize()` resolved. The existing settings init catches IPC errors and resolves after storing `_error` — so a transient failure would mark the store permanently initialized; future `initialize()` calls would no-op and consumers stay on defaults. | Accepted — wrapper now checks `_error` after `doInitialize()` resolves; if non-empty, throws and clears `initPromise` so callers can retry. Only a successful load+listener-setup sets `_initialized` to `true`. Also exposed `isInitialized` as a signal so consumers can gate effects reactively. |
| 4 (P2) | Interceptor only checked `options.hostname`. Node's `http.request` accepts `options.host` as an alias, often with a `:port` suffix. `http.request({ host: '127.0.0.1' })` would be blocked when paused even though loopback is allow-listed. | Accepted — added `stripPort()` helper that handles IPv6 brackets correctly; `extractHostname()` falls back to `host` after `hostname`, with port-stripping + IPv6 normalisation. Three new test cases: `host: '127.0.0.1'`, `host: '127.0.0.1:8080'`, and `host: 'api.example.com'` (verifying public hosts via `host` alias are STILL gated). |

No pushbacks Round 18. All four verified codebase-anchored defects.

## R19 (2026-04-29, plan review — 3 P1 + 3 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | AppComponent snippet injected `PauseRendererController` and `SettingsStore` but did not import either, while importing now-unused `QueuePersistenceService`. | Accepted — Task 31 import block now imports `PauseRendererController` and `SettingsStore`; direct `QueuePersistenceService` import removed from AppComponent. |
| 2 (P1) | `PauseRendererController.bindReactive()` created an Angular `effect()` from `ngOnInit`, outside an injection context. | Accepted — controller now injects `Injector` and calls `effect(..., { injector: this.injector })`. |
| 3 (P1) | The new rejecting `SettingsStore.initialize()` could abort root startup before existing platform/menu/appReady/startup-capability wiring ran. | Accepted — AppComponent wraps the startup settings init in `try/catch`; pause services remain inactive until `isInitialized()` becomes true, while the rest of root startup continues. |
| 4 (P2) | Once `initialize()` is idempotent, existing optimistic-write rollback paths that call `await this.initialize()` would no-op after startup and leave unsaved local settings visible. | Accepted — Task 31 now explicitly changes SettingsStore `set()`/`update()` catch paths to call `reload()` or another force-reload helper that bypasses the idempotence guard. |
| 5 (P2) | Async renderer start could resume after stop and subscribe IPC listeners under the disabled kill switch. | Accepted — `PauseRendererController` now uses a `startGeneration` token and `isStartCurrent()` checks after awaits; `stop()` invalidates the generation. |
| 6 (P2) | Debounced queue-save timers could fire after the kill switch was disabled. | Accepted — QueuePersistenceService now exposes `clearPendingSaves()`, controller stop calls it, and `persistNow()` re-checks `isInitialized()`, `pauseFeatureEnabled`, and `persistSessionContent` before writing. |

No pushbacks Round 19. All six verified codebase-anchored defects.

## R20 (2026-04-29, plan review — 1 P1 + 3 P2)

| # | Item | Disposition |
|---|---|---|
| 1 (P1) | `SettingsStore.initialize()` still treated an IPC `{ success: false }` response as a resolved load with defaults, so `_initialized` could become true with untrusted DEFAULT_SETTINGS. | Accepted — Task 31 now requires `doInitialize()` to treat `!response.success` or missing data as a real load failure, set `_error`, and avoid setting `_initialized`. |
| 2 (P2) | Task 15 imported `PersistedQueuedMessageSchema` into `instance-handlers.ts` but never used it; the handler validates with `InstanceQueueSavePayloadSchema`. | Accepted — unused import removed from the planned snippet. |
| 3 (P2) | Task 15's main-side queue store type omitted the persisted `kind` field even though the schema and renderer round-trip it. | Accepted — `QueueStoreShape` now includes `kind?: 'queue' | 'steer'`. |
| 4 (P2) | Queue save/load handlers were gated only by `persistSessionContent`; a stale renderer call could still write/read the queue namespace after `pauseFeatureEnabled=false`. | Accepted — handlers now no-op save and return empty load when either `pauseFeatureEnabled=false` or `persistSessionContent=false`. |

Claude Code was invoked three times for independent read-only review (broad, narrowed, and file-only prompts). Each run produced no findings because the CLI did not return within the configured timeouts; local review continued and the resulting defects above were fixed.

---

# Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-28-pause-on-vpn.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because most tasks are independent within a phase and the cross-task type contracts are documented above.

**2. Inline Execution** — Execute tasks in this session using `executing-plans`, batch execution with checkpoints for review.

Which approach?
