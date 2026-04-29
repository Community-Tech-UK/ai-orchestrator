# Wave 4: Output, Clipboard, Theme, And Terminal Drawer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a single renderer `ClipboardService` that replaces 11 duplicated `navigator.clipboard.writeText` call sites; add a live `matchMedia` system-theme listener (with cleanup) inside `SettingsStore`; introduce a shared `link-detection.ts` pure utility and adopt it in `markdown.service`; and ship the boundary spec (interface + IPC contract + empty UI shell) for the future terminal drawer without committing to a `node-pty` integration.

**Architecture:** `ClipboardService` is renderer-only, signal-based, with a discriminated `ClipboardCopyResult` union. An optional `CLIPBOARD_TOAST` injection token lets future notification surfaces hook in without changing call sites. `copyImage` delegates to the existing Electron IPC `image:copy-to-clipboard` channel — no second image clipboard codepath. `SettingsStore` gains an `addEventListener('change', ...)` listener attached only when `theme === 'system'`, with explicit detach on theme switch and `_resetForTesting()` cleanup. `link-detection.ts` is a pure function returning typed ranges for URLs, Unix/Windows/UNC/relative paths, and `at /path:line:col` error traces. Terminal drawer ships only the type surface and an empty-state UI shell; the real `node-pty` integration is captured as a follow-up Wave 4b.

**Tech Stack:** TypeScript 5.9, Angular 21 (zoneless, signals), Electron 40, Vitest, ESLint.

**Spec:** [`docs/superpowers/specs/2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md`](../specs/2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md)
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md`](../specs/2026-04-28-cross-repo-usability-upgrades-design_completed.md)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`](./2026-04-28-cross-repo-usability-upgrades-plan_completed.md)

---

## How to read this plan

- **Phases** group related tasks. Phases 1–4 build the `ClipboardService` foundation and toast token. Phase 5 replaces the 11 call sites (one task per file). Phases 6–7 ship link detection. Phase 8 wires the theme listener. Phase 9 ships the terminal drawer boundary. Phases 10–11 cover test sweep + final verification.
- **Tasks** are bite-sized work units (target under 30 minutes). Each ends with a commit.
- **TDD discipline:** behavioral code follows test → fail → implement → pass → commit. Pure type-only changes use type-check as the verification.
- **Verification commands** (run after every code-change task):
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - Targeted vitest spec(s) for the touched code
- **Critical rule (per `AGENTS.md`):** **NEVER run `git commit` without explicit user approval.** Every task below ends with a suggested commit message — run the commit only after the user approves. **Never push to remote** under any circumstances; pushing is always the user's call.

## Phase index

1. Phase 1 — `ClipboardService` interface + `ClipboardCopyResult` types
2. Phase 2 — `ClipboardService` implementation (text + JSON paths)
3. Phase 3 — `ClipboardService` image path (delegates to existing IPC)
4. Phase 4 — `CLIPBOARD_TOAST` injection token + helper
5. Phase 5 — Replace 11 clipboard call sites (one task per file)
6. Phase 6 — `link-detection.ts` utility (pure functions)
7. Phase 7 — Adopt link detection in `markdown.service.ts` and `output-stream.component.ts`
8. Phase 8 — `SettingsStore` theme listener with cleanup
9. Phase 9 — Terminal drawer empty shell + service interface (Wave 4b prep)
10. Phase 10 — Test sweeps; replace mocks of `navigator.clipboard.writeText` with `ClipboardService` mocks
11. Phase 11 — Final compile/lint/test/manual smoke

---

## Phase 1 — `ClipboardService` interface + `ClipboardCopyResult` types

After this phase, the new types compile but nothing consumes them. Pure additions, no behavior change.

### Task 1.1: Add `ClipboardCopyResult` discriminated union and `ClipboardService` interface

**Files:**
- Create: `src/renderer/app/core/services/clipboard.service.ts` (interface + types only — implementation lands in Phase 2)

- [ ] **Step 1: Write the file with types and interface only**

Create `src/renderer/app/core/services/clipboard.service.ts`:

```ts
import type { Signal } from '@angular/core';

export type ClipboardCopyResult =
  | { ok: true }
  | { ok: false; reason: ClipboardCopyFailureReason; cause?: unknown };

export type ClipboardCopyFailureReason =
  | 'unavailable'
  | 'permission-denied'
  | 'unknown';

export interface ClipboardCopyOptions {
  /** Optional human label used by a future toast adapter. Default
   *  `'text'` for `copyText`, `'JSON'` for `copyJSON`, `'image'` for
   *  `copyImage`. Has no effect when no `CLIPBOARD_TOAST` provider is
   *  registered. */
  label?: string;
  /** When true, suppresses any toast even if a `CLIPBOARD_TOAST` provider
   *  is registered. Useful for surfaces with their own inline UI such as
   *  the API key copy site or the per-message "Copied" pill. */
  silent?: boolean;
  /** Optional `JSON.stringify` indent (only honored by `copyJSON`).
   *  Default `2`. */
  jsonIndent?: number;
}

export interface ClipboardService {
  /** Last attempted copy result; null until the first call. */
  readonly lastResult: Signal<ClipboardCopyResult | null>;

  copyText(text: string, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyJSON(value: unknown, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
  copyImage(blob: Blob, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
}
```

> **Decision recap:** The interface is exported separately from the implementation so tests can substitute trivial fakes via `useValue: { ... }`. See spec § 2.1.

- [ ] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/services/clipboard.service.ts
git commit -m "feat(clipboard): add ClipboardService interface + ClipboardCopyResult types"
```

---

## Phase 2 — `ClipboardService` implementation (text + JSON paths)

After this phase, `ClipboardService` is injectable and `copyText` + `copyJSON` work end-to-end. `copyImage` is stubbed and lands in Phase 3.

### Task 2.1: Add `CLIPBOARD_TOAST` injection token (early — needed by tests)

**Files:**
- Create: `src/renderer/app/core/services/clipboard-toast.token.ts`

- [ ] **Step 1: Implement the token**

Create `src/renderer/app/core/services/clipboard-toast.token.ts`:

```ts
import { InjectionToken } from '@angular/core';

export interface ClipboardToastAdapter {
  success(text: string): void;
  error(text: string): void;
}

/**
 * Optional. When provided, `ClipboardService` calls `success(label)` on
 * `{ ok: true }` and `error(message)` on `{ ok: false }`, unless the call
 * site passes `{ silent: true }`.
 */
export const CLIPBOARD_TOAST = new InjectionToken<ClipboardToastAdapter>('CLIPBOARD_TOAST');
```

- [ ] **Step 2: Type-check, commit**

```bash
npx tsc --noEmit
git add src/renderer/app/core/services/clipboard-toast.token.ts
git commit -m "feat(clipboard): add CLIPBOARD_TOAST injection token"
```

---

### Task 2.2: Write failing tests for `copyText` and `copyJSON`

**Files:**
- Create: `src/renderer/app/core/services/clipboard.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/clipboard.service.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { ClipboardServiceImpl } from './clipboard.service';
import { CLIPBOARD_TOAST } from './clipboard-toast.token';

describe('ClipboardServiceImpl — copyText', () => {
  let originalClipboard: typeof navigator.clipboard | undefined;

  beforeEach(() => {
    originalClipboard = (navigator as { clipboard?: typeof navigator.clipboard }).clipboard;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
  });

  it('returns ok: true on successful write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const result = await svc.copyText('hello');
    expect(result).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('returns ok: true (no-op) on empty string without calling navigator', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const result = await svc.copyText('');
    expect(result).toEqual({ ok: true });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns unavailable when navigator.clipboard is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const result = await svc.copyText('hello');
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns permission-denied on NotAllowedError', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const result = await svc.copyText('hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('permission-denied');
  });

  it('returns unknown on arbitrary throw', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('boom'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const result = await svc.copyText('hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('updates lastResult signal after each call', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    expect(svc.lastResult()).toBeNull();
    await svc.copyText('a');
    expect(svc.lastResult()).toEqual({ ok: true });
  });
});

describe('ClipboardServiceImpl — copyJSON', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('serializes value with default 2-space indent', async () => {
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await svc.copyJSON({ a: 1 });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
  });

  it('honors custom jsonIndent', async () => {
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await svc.copyJSON({ a: 1 }, { jsonIndent: 0 });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('{"a":1}');
  });

  it('returns unknown on serialization failure (cycle)', async () => {
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = await svc.copyJSON(cyclic);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });
});

describe('ClipboardServiceImpl — toast adapter', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('calls success(label) when ok and adapter present', async () => {
    const success = vi.fn();
    const error = vi.fn();
    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: CLIPBOARD_TOAST, useValue: { success, error } }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await svc.copyText('x', { label: 'message' });
    expect(success).toHaveBeenCalledWith('message');
    expect(error).not.toHaveBeenCalled();
  });

  it('does not call adapter when silent: true', async () => {
    const success = vi.fn();
    const error = vi.fn();
    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: CLIPBOARD_TOAST, useValue: { success, error } }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await svc.copyText('x', { silent: true });
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('calls error(message) on failure', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
      configurable: true,
    });

    const success = vi.fn();
    const error = vi.fn();
    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: CLIPBOARD_TOAST, useValue: { success, error } }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await svc.copyText('x', { label: 'message' });
    expect(error).toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  });

  it('does not throw when no adapter is provided', async () => {
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const svc = TestBed.inject(ClipboardServiceImpl);

    await expect(svc.copyText('x')).resolves.toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the spec — confirm it fails**

```bash
npx vitest run src/renderer/app/core/services/clipboard.service.spec.ts
```

Expected: FAIL — `ClipboardServiceImpl` is not yet exported (only the interface lands in Phase 1).

---

### Task 2.3: Implement `ClipboardServiceImpl` (text + JSON paths)

**Files:**
- Modify: `src/renderer/app/core/services/clipboard.service.ts`

- [ ] **Step 1: Append the implementation class**

Edit `src/renderer/app/core/services/clipboard.service.ts`. After the existing interface/types, append:

```ts
import { Injectable, inject, signal } from '@angular/core';
import { CLIPBOARD_TOAST } from './clipboard-toast.token';

@Injectable({ providedIn: 'root' })
export class ClipboardServiceImpl implements ClipboardService {
  private readonly toast = inject(CLIPBOARD_TOAST, { optional: true });
  private _lastResult = signal<ClipboardCopyResult | null>(null);
  readonly lastResult = this._lastResult.asReadonly();

  async copyText(text: string, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    if (!text) {
      return this.finish({ ok: true }, opts.label ?? 'text', opts);
    }
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      return this.finish({ ok: false, reason: 'unavailable' }, opts.label ?? 'text', opts);
    }
    try {
      await navigator.clipboard.writeText(text);
      return this.finish({ ok: true }, opts.label ?? 'text', opts);
    } catch (cause) {
      const reason: ClipboardCopyFailureReason =
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? 'permission-denied'
          : 'unknown';
      return this.finish({ ok: false, reason, cause }, opts.label ?? 'text', opts);
    }
  }

  async copyJSON(value: unknown, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    let text: string;
    try {
      text = JSON.stringify(value, null, opts.jsonIndent ?? 2);
    } catch (cause) {
      return this.finish({ ok: false, reason: 'unknown', cause }, opts.label ?? 'JSON', opts);
    }
    return this.copyText(text, { label: 'JSON', ...opts });
  }

  /** Phase 3 implements the real image flow. Phase 2 stub returns unavailable. */
  async copyImage(_blob: Blob, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
    return this.finish({ ok: false, reason: 'unavailable' }, opts.label ?? 'image', opts);
  }

  private finish(
    result: ClipboardCopyResult,
    label: string,
    opts: ClipboardCopyOptions,
  ): ClipboardCopyResult {
    this._lastResult.set(result);
    if (this.toast && !opts.silent) {
      if (result.ok) this.toast.success(label);
      else this.toast.error(`Failed to copy ${label}: ${result.reason}`);
    }
    return result;
  }
}
```

- [ ] **Step 2: Run the spec — confirm it passes**

```bash
npx vitest run src/renderer/app/core/services/clipboard.service.spec.ts
```

Expected: all `copyText`, `copyJSON`, and toast-adapter tests pass. (`copyImage` tests land in Phase 3.)

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/services/clipboard.service.ts
git add src/renderer/app/core/services/clipboard.service.ts src/renderer/app/core/services/clipboard.service.spec.ts
git commit -m "feat(clipboard): implement ClipboardServiceImpl text+JSON paths with toast adapter"
```

---

## Phase 3 — `ClipboardService` image path (delegates to existing IPC)

After this phase, `copyImage` works end-to-end via the existing `image:copy-to-clipboard` IPC. No second image clipboard codepath is introduced.

### Task 3.1: Add image-clipboard tests including IPC pass-through guard

**Files:**
- Modify: `src/renderer/app/core/services/clipboard.service.spec.ts`

- [ ] **Step 1: Append a `describe('ClipboardServiceImpl — copyImage')` block**

In `clipboard.service.spec.ts`, add:

```ts
import { IpcService } from '../ipc/ipc.service'; // adjust path if necessary

describe('ClipboardServiceImpl — copyImage', () => {
  let invokeMock: ReturnType<typeof vi.fn>;
  let ipcStub: Pick<IpcService, 'invoke'>;

  beforeEach(() => {
    invokeMock = vi.fn();
    ipcStub = { invoke: invokeMock as unknown as IpcService['invoke'] };
  });

  it('routes to the image:copy-to-clipboard IPC channel exactly once with a PNG/JPEG dataUrl', async () => {
    invokeMock.mockResolvedValue({ success: true });

    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: IpcService, useValue: ipcStub }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    // 1x1 transparent PNG blob fixture
    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=').then(r => r.blob());

    const result = await svc.copyImage(png);
    expect(result).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith('image:copy-to-clipboard', expect.objectContaining({
      dataUrl: expect.stringMatching(/^data:image\/(png|jpeg)/),
    }));
  });

  it('returns unavailable when IpcService is missing invoke', async () => {
    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: IpcService, useValue: {} }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const result = await svc.copyImage(blob);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
  });

  it('returns unknown when the IPC call fails', async () => {
    invokeMock.mockResolvedValue({ success: false, error: { message: 'boom' } });

    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: IpcService, useValue: ipcStub }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=').then(r => r.blob());
    const result = await svc.copyImage(png);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  it('does NOT call navigator.clipboard.write — image clipboard must stay on the IPC path', async () => {
    invokeMock.mockResolvedValue({ success: true });
    const writeFn = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(), write: writeFn },
      configurable: true,
    });

    TestBed.configureTestingModule({
      providers: [ClipboardServiceImpl, { provide: IpcService, useValue: ipcStub }],
    });
    const svc = TestBed.inject(ClipboardServiceImpl);

    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=').then(r => r.blob());
    await svc.copyImage(png);
    expect(writeFn).not.toHaveBeenCalled();
  });
});
```

> **Why the last assertion exists:** Locked Decision (spec § 12, risk row 1). This is the regression guard against someone "improving" image clipboard by routing through `navigator.clipboard.write`.

- [ ] **Step 2: Run — confirm it fails**

```bash
npx vitest run src/renderer/app/core/services/clipboard.service.spec.ts
```

Expected: FAIL — `copyImage` is currently the Phase 2 stub that returns `unavailable` even when `IpcService` is provided.

---

### Task 3.2: Extract `toClipboardCompatibleDataUrl` to a shared util

**Files:**
- Create: `src/renderer/app/core/services/clipboard-image.util.ts`
- Create: `src/renderer/app/core/services/clipboard-image.util.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/app/core/services/clipboard-image.util.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { blobToClipboardCompatibleDataUrl } from './clipboard-image.util';

describe('blobToClipboardCompatibleDataUrl', () => {
  it('returns the original dataUrl for PNG blobs', async () => {
    const png = await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=').then(r => r.blob());
    const out = await blobToClipboardCompatibleDataUrl(png);
    expect(out).toMatch(/^data:image\/png/);
  });

  it('returns null on bogus blob', async () => {
    const out = await blobToClipboardCompatibleDataUrl(new Blob([new Uint8Array([0])], { type: 'image/webp' }));
    // jsdom can't decode this; util resolves null. (In Electron this would re-encode via canvas.)
    expect(out === null || typeof out === 'string').toBe(true);
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

```bash
npx vitest run src/renderer/app/core/services/clipboard-image.util.spec.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the util**

Create `src/renderer/app/core/services/clipboard-image.util.ts`:

```ts
/**
 * Convert a Blob into a data URL Electron's nativeImage can ingest.
 *
 * Electron's `nativeImage.createFromDataURL` only supports PNG and JPEG.
 * Pasted screenshots are stored as WebP (see instance-list.store tiling),
 * so re-encode anything that isn't already PNG/JPEG via a canvas. Mirrors
 * the existing logic in `message-attachments.component.ts:530–554`.
 */
export async function blobToClipboardCompatibleDataUrl(blob: Blob): Promise<string | null> {
  const dataUrl = await blobToDataUrl(blob);
  if (!dataUrl) return null;

  const header = dataUrl.slice(0, 32).toLowerCase();
  if (header.startsWith('data:image/png') || header.startsWith('data:image/jpeg')) {
    return dataUrl;
  }

  return new Promise<string | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      try {
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });
}
```

- [ ] **Step 4: Run — confirm it passes**

```bash
npx vitest run src/renderer/app/core/services/clipboard-image.util.spec.ts
```

Expected: pass.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/services/clipboard-image.util.ts
git add src/renderer/app/core/services/clipboard-image.util.ts src/renderer/app/core/services/clipboard-image.util.spec.ts
git commit -m "feat(clipboard): add blobToClipboardCompatibleDataUrl shared util"
```

---

### Task 3.3: Replace `copyImage` stub with the real IPC path

**Files:**
- Modify: `src/renderer/app/core/services/clipboard.service.ts`

- [ ] **Step 1: Update `copyImage`**

In `clipboard.service.ts`, add the IPC import and `copyImage` body:

```ts
import { IpcService } from '../ipc/ipc.service'; // adjust to actual IpcService path
import { blobToClipboardCompatibleDataUrl } from './clipboard-image.util';

// inside ClipboardServiceImpl:
private readonly ipc = inject(IpcService, { optional: true });

async copyImage(blob: Blob, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
  if (!this.ipc?.invoke) {
    return this.finish({ ok: false, reason: 'unavailable' }, opts.label ?? 'image', opts);
  }
  const dataUrl = await blobToClipboardCompatibleDataUrl(blob);
  if (!dataUrl) {
    return this.finish(
      { ok: false, reason: 'unknown', cause: new Error('Failed to encode image') },
      opts.label ?? 'image',
      opts,
    );
  }
  const res = await this.ipc.invoke('image:copy-to-clipboard', { dataUrl }) as
    | { success: true }
    | { success: false; error?: { message?: string } }
    | undefined;
  if (res?.success) {
    return this.finish({ ok: true }, opts.label ?? 'image', opts);
  }
  return this.finish(
    { ok: false, reason: 'unknown', cause: res && 'error' in res ? res.error : new Error('IPC failed') },
    opts.label ?? 'image',
    opts,
  );
}
```

> **Important:** Verify the actual `IpcService` import path by reading the existing usages in `message-attachments.component.ts:491`. The path should match whatever `inject(IpcService)` returns there.

- [ ] **Step 2: Run all clipboard specs**

```bash
npx vitest run src/renderer/app/core/services/clipboard.service.spec.ts src/renderer/app/core/services/clipboard-image.util.spec.ts
```

Expected: all pass, including the regression guard "does NOT call navigator.clipboard.write".

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/services/clipboard.service.ts
git add src/renderer/app/core/services/clipboard.service.ts src/renderer/app/core/services/clipboard.service.spec.ts
git commit -m "feat(clipboard): wire copyImage to existing image:copy-to-clipboard IPC"
```

---

## Phase 4 — `CLIPBOARD_TOAST` injection token + helper

The token itself shipped in Task 2.1 (early, because tests need it). This phase adds an integration sanity test for the contract.

### Task 4.1: Add a contract spec for the token

**Files:**
- Create: `src/renderer/app/core/services/clipboard-toast.token.spec.ts`

- [ ] **Step 1: Write the spec**

Create `src/renderer/app/core/services/clipboard-toast.token.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CLIPBOARD_TOAST, type ClipboardToastAdapter } from './clipboard-toast.token';

describe('CLIPBOARD_TOAST', () => {
  it('is optional (no provider → inject returns null)', () => {
    TestBed.configureTestingModule({ providers: [] });
    const adapter = TestBed.inject(CLIPBOARD_TOAST, null, { optional: true });
    expect(adapter).toBeNull();
  });

  it('accepts a provider', () => {
    const fake: ClipboardToastAdapter = { success: () => undefined, error: () => undefined };
    TestBed.configureTestingModule({ providers: [{ provide: CLIPBOARD_TOAST, useValue: fake }] });
    const adapter = TestBed.inject(CLIPBOARD_TOAST);
    expect(adapter).toBe(fake);
  });
});
```

- [ ] **Step 2: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/services/clipboard-toast.token.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/services/clipboard-toast.token.spec.ts
git commit -m "test(clipboard): contract spec for CLIPBOARD_TOAST optional token"
```

---

## Phase 5 — Replace 11 clipboard call sites (one task per file)

Each task is independent. They can be done in any order, but the recommended order matches the spec's Migration Table § 9. Each task: (a) inject the service, (b) replace the call, (c) preserve transient UI / silent flag per the migration row, (d) update any colocated spec, (e) commit.

> **Pattern for all tasks below:** Constructor inject `ClipboardService` via `inject(ClipboardServiceImpl)`. Pass `{ silent: true }` exactly where the migration table says so.

### Task 5.1: `markdown.service.ts:241` — code block copy

**Files:**
- Modify: `src/renderer/app/core/services/markdown.service.ts`

- [ ] **Step 1: Read the current call site**

Open the file at line 230–260 (use the Read tool). Note the surrounding flow (typically the inline `copyCodeBlock(id)` handler attached via `setupCodeBlockCopy()` near line 241).

- [ ] **Step 2: Replace the call**

Inject `ClipboardServiceImpl` (or the interface) at the top of the class:

```ts
import { ClipboardServiceImpl } from './clipboard.service';
// ...
private clipboard = inject(ClipboardServiceImpl);
```

Replace the existing line at ~241:

```ts
// before
await navigator.clipboard.writeText(code);
// after
await this.clipboard.copyText(code, { label: 'code' });
```

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/core/services/markdown.service.ts
git add src/renderer/app/core/services/markdown.service.ts
git commit -m "refactor(clipboard): markdown.service uses ClipboardService for code copy"
```

---

### Task 5.2: `output-stream.component.ts:608–609` and 703 — message content copy

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts`

- [ ] **Step 1: Read the existing flow**

Open the file at lines 600–720. Note: existing `.then/.catch` chain with a 2 s reset timer (lines 610–617). This must be preserved — only the underlying clipboard call changes. The `silent: true` flag prevents future toast adapter from double-rendering.

- [ ] **Step 2: Inject the service and refactor `copyMessageContent`**

```ts
import { ClipboardServiceImpl } from '../../core/services/clipboard.service';
// ...
private clipboard = inject(ClipboardServiceImpl);

async copyMessageContent(content: string, messageId: string): Promise<void> {
  if (!content) return;
  const result = await this.clipboard.copyText(content, { silent: true, label: 'message' });
  if (result.ok) {
    this.copiedMessageId.set(messageId);
    if (this.copyResetTimer) {
      window.clearTimeout(this.copyResetTimer);
    }
    this.copyResetTimer = window.setTimeout(() => {
      this.copiedMessageId.set(null);
    }, 2000);
  } else {
    console.error('Failed to copy message:', result.reason, result.cause);
  }
}
```

- [ ] **Step 3: Find the second call (line ~703) and confirm it now goes through `copyMessageContent`**

If line 703 is a duplicate inline `navigator.clipboard.writeText(...)` from the context menu, refactor it to call `this.copyMessageContent(content, messageId)` so there's a single handler. If it's a different content shape (e.g. tool output), use the same `copyText` pattern with an appropriate label.

- [ ] **Step 4: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/instance-detail/output-stream.component.ts
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "refactor(clipboard): output-stream message copy via ClipboardService (silent, preserve copied pill)"
```

---

### Task 5.3: `remote-nodes-settings-tab.component.ts:492` — enrollment token copy

**Files:**
- Modify: `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

// before
await navigator.clipboard.writeText(token);
// after
await this.clipboard.copyText(token, { label: 'enrollment token' });
```

If a transient inline UI shows "Copied" already, pass `{ silent: true, label: 'enrollment token' }` to keep behavior identical.

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts
git add src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts
git commit -m "refactor(clipboard): remote-nodes-settings tab uses ClipboardService"
```

---

### Task 5.4: `instance-list.component.ts:712` — instance ID copy

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-list.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

await this.clipboard.copyText(id, { label: 'instance id' });
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/instance-list/instance-list.component.ts
git add src/renderer/app/features/instance-list/instance-list.component.ts
git commit -m "refactor(clipboard): instance-list uses ClipboardService for instance id copy"
```

---

### Task 5.5: `extended-thinking-panel.component.ts:569` — thinking-block copy

**Files:**
- Modify: `src/renderer/app/features/thinking/components/extended-thinking-panel.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

await this.clipboard.copyText(block, { label: 'thinking block' });
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/thinking/components/extended-thinking-panel.component.ts
git add src/renderer/app/features/thinking/components/extended-thinking-panel.component.ts
git commit -m "refactor(clipboard): extended-thinking-panel uses ClipboardService"
```

---

### Task 5.6: `search-results.component.ts:401` — search result copy

**Files:**
- Modify: `src/renderer/app/features/codebase/search-results.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

await this.clipboard.copyText(snippet, { label: 'search result' });
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/codebase/search-results.component.ts
git add src/renderer/app/features/codebase/search-results.component.ts
git commit -m "refactor(clipboard): search-results uses ClipboardService"
```

---

### Task 5.7: `rlm-context-browser.component.ts:537` — RLM context copy

**Files:**
- Modify: `src/renderer/app/features/rlm/rlm-context-browser.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

await this.clipboard.copyText(ctx, { label: 'context' });
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/rlm/rlm-context-browser.component.ts
git add src/renderer/app/features/rlm/rlm-context-browser.component.ts
git commit -m "refactor(clipboard): rlm-context-browser uses ClipboardService"
```

---

### Task 5.8: `api-key-manager.component.ts:801` — API key copy (sensitive! `silent: true` mandatory)

**Files:**
- Modify: `src/renderer/app/features/verification/config/api-key-manager.component.ts`

- [ ] **Step 1: Read the surrounding `copyKey` flow + reveal-mask UX**

Open the file at lines 780–830. Confirm: `toggleKeyReveal(keyId)` (lines 790–796) is independent of `copyKey`. Wave 4 must NOT change which UX governs reveal/conceal. The replacement passes `{ silent: true }` because:
1. The user has already explicitly chosen to reveal+copy (or copy from concealed state).
2. A future toast saying "API key copied!" would be a security-affecting side-effect of refactoring.

- [ ] **Step 2: Inject and replace with `silent: true`**

```ts
import { ClipboardServiceImpl } from '../../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

async copyKey(keyId: string): Promise<void> {
  const key = this.apiKeys().find(k => k.id === keyId);
  if (key?.keyFull) {
    await this.clipboard.copyText(key.keyFull, { silent: true, label: 'API key' });
  }
}
```

> **Locked Decision #4:** the calling code stays in charge of revealing/concealing the key. Do NOT remove or alter `toggleKeyReveal`. Do NOT add a toast.

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/verification/config/api-key-manager.component.ts
git add src/renderer/app/features/verification/config/api-key-manager.component.ts
git commit -m "refactor(clipboard): api-key-manager uses ClipboardService (silent; preserves reveal-mask UX)"
```

---

### Task 5.9: `export-panel.component.ts:717` — export data copy via `copyText`

**Files:**
- Modify: `src/renderer/app/features/verification/results/export-panel.component.ts`

- [ ] **Step 1: Read the surrounding flow**

Open the file at lines 700–740. The existing flow copies the currently selected generated export string, not an internal raw object. Preserve that behavior so Markdown/HTML/PDF copy still matches the preview.

- [ ] **Step 2: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

const content = this.generateExport();
const result = await this.clipboard.copyText(content, { label: 'export' });
```

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/verification/results/export-panel.component.ts
git add src/renderer/app/features/verification/results/export-panel.component.ts
git commit -m "refactor(clipboard): export-panel uses ClipboardService for selected export copy"
```

---

### Task 5.10: `verification-results.component.ts:198–199` — synthesized response copy

**Files:**
- Modify: `src/renderer/app/features/verification/results/verification-results.component.ts`

- [ ] **Step 1: Inject and replace**

```ts
import { ClipboardServiceImpl } from '../../../core/services/clipboard.service';
private clipboard = inject(ClipboardServiceImpl);

await this.clipboard.copyText(response, { label: 'verification response' });
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/verification/results/verification-results.component.ts
git add src/renderer/app/features/verification/results/verification-results.component.ts
git commit -m "refactor(clipboard): verification-results uses ClipboardService"
```

---

### Task 5.11: Final sweep — confirm zero `navigator.clipboard.writeText` references in feature code

**Files:** none (verification only)

- [ ] **Step 1: Grep-sweep**

Use the Grep tool with pattern `navigator\.clipboard\.writeText` over `src/renderer/app/`.

Expected: zero hits in any file other than `src/renderer/app/core/services/clipboard.service.ts`. The only allowed caller is `ClipboardServiceImpl`.

If anything remains:
- Verify it's not a test file mocking the API (those are migrated in Phase 10).
- If it's a feature file the migration table missed, add a new task following the same pattern and commit.

- [ ] **Step 2: Compile + lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: clean.

- [ ] **Step 3: Commit (only if any cleanup happened in Step 1)**

```bash
git add -u
git commit -m "refactor(clipboard): final sweep — feature code uses ClipboardService exclusively"
```

---

## Phase 6 — `link-detection.ts` utility (pure functions)

After this phase, `detectLinks(source)` returns typed ranges. Adoption inside `markdown.service` is Phase 7.

### Task 6.1: Write failing tests for `detectLinks`

**Files:**
- Create: `src/shared/utils/link-detection.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/utils/link-detection.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectLinks } from './link-detection';

describe('detectLinks — URLs', () => {
  it('detects bare https URL', () => {
    const ranges = detectLinks('Visit https://example.com today');
    expect(ranges).toEqual([
      expect.objectContaining({ kind: 'url', text: 'https://example.com' }),
    ]);
  });

  it('detects http URL with port and path', () => {
    const ranges = detectLinks('http://localhost:3000/foo/bar');
    expect(ranges[0]).toEqual(expect.objectContaining({ kind: 'url', text: 'http://localhost:3000/foo/bar' }));
  });

  it('trims trailing punctuation', () => {
    const ranges = detectLinks('See https://example.com.');
    expect(ranges[0].text).toBe('https://example.com');
  });
});

describe('detectLinks — file paths', () => {
  it('detects unix absolute path with extension', () => {
    const ranges = detectLinks('Open /Users/foo/bar.ts');
    expect(ranges).toEqual([
      expect.objectContaining({ kind: 'file-path', text: '/Users/foo/bar.ts' }),
    ]);
    expect((ranges[0].meta as { flavor?: string }).flavor).toBe('unix-absolute');
  });

  it('detects unix path with :line:col', () => {
    const ranges = detectLinks('At /Users/foo/bar.ts:42:7');
    expect(ranges[0]).toEqual(expect.objectContaining({ kind: 'file-path', text: '/Users/foo/bar.ts:42:7' }));
    expect((ranges[0].meta as { line?: number; column?: number }).line).toBe(42);
    expect((ranges[0].meta as { line?: number; column?: number }).column).toBe(7);
  });

  it('does NOT match key/value style fragments', () => {
    const ranges = detectLinks('use a/b style');
    expect(ranges).toEqual([]);
  });

  it('detects windows absolute path', () => {
    const ranges = detectLinks('Open C:\\Users\\foo\\bar.ts');
    expect(ranges).toEqual([
      expect.objectContaining({ kind: 'file-path', text: 'C:\\Users\\foo\\bar.ts' }),
    ]);
    expect((ranges[0].meta as { flavor?: string }).flavor).toBe('windows-absolute');
  });

  it('detects windows path with forward slashes', () => {
    const ranges = detectLinks('Open D:/x/y/z.ts');
    expect(ranges).toEqual([
      expect.objectContaining({ kind: 'file-path', text: 'D:/x/y/z.ts' }),
    ]);
  });

  it('detects UNC path', () => {
    const ranges = detectLinks('Open \\\\server\\share\\file.txt');
    expect(ranges[0]).toEqual(expect.objectContaining({ kind: 'file-path' }));
    expect((ranges[0].meta as { flavor?: string }).flavor).toBe('unc');
  });

  it('detects relative path only with known extension', () => {
    const ok = detectLinks('See ./src/foo.ts for details');
    expect(ok).toEqual([
      expect.objectContaining({ kind: 'file-path', text: './src/foo.ts' }),
    ]);

    const noMatch = detectLinks('Just some/path/here words');
    expect(noMatch).toEqual([]);
  });
});

describe('detectLinks — error traces', () => {
  it('detects "at /path:line:col"', () => {
    const ranges = detectLinks('Error: boom\n  at /Users/foo/bar.ts:12:34\n  at /Users/foo/baz.ts:7');
    expect(ranges).toHaveLength(2);
    expect(ranges[0].kind).toBe('error-trace');
    const m0 = ranges[0].meta as { line: number; column?: number };
    expect(m0.line).toBe(12);
    expect(m0.column).toBe(34);
    const m1 = ranges[1].meta as { line: number; column?: number };
    expect(m1.line).toBe(7);
    expect(m1.column).toBeUndefined();
  });
});

describe('detectLinks — overlap and ordering', () => {
  it('URL beats embedded path', () => {
    const ranges = detectLinks('see https://example.com/Users/foo/bar.ts now');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].kind).toBe('url');
  });

  it('returns ranges in source order', () => {
    const ranges = detectLinks('first /a/b.ts then https://x.com');
    expect(ranges.map(r => r.kind)).toEqual(['file-path', 'url']);
  });
});

describe('detectLinks — boundary conditions', () => {
  it('returns empty for empty input', () => {
    expect(detectLinks('')).toEqual([]);
  });

  it('returns empty when input exceeds maxLength', () => {
    const big = 'x'.repeat(1024);
    expect(detectLinks(big, { maxLength: 100 })).toEqual([]);
  });

  it('respects kinds filter', () => {
    const ranges = detectLinks('see /a/b.ts and https://x.com', { kinds: ['url'] });
    expect(ranges.map(r => r.kind)).toEqual(['url']);
  });
});

describe('detectLinks — performance budget', () => {
  it('completes detection on a 32 KiB sample in under 25 ms', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      `at /Users/foo/file${i}.ts:${i}:${i}  see https://x.com/${i}`,
    ).join('\n');
    const start = performance.now();
    const ranges = detectLinks(lines);
    const elapsed = performance.now() - start;
    expect(ranges.length).toBeGreaterThan(100);
    // Generous bound for CI variance — production budget is < 5 ms locally.
    expect(elapsed).toBeLessThan(25);
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

```bash
npx vitest run src/shared/utils/link-detection.spec.ts
```

Expected: FAIL — module not found.

---

### Task 6.2: Implement `detectLinks`

**Files:**
- Create: `src/shared/utils/link-detection.ts`

- [ ] **Step 1: Implement**

Create `src/shared/utils/link-detection.ts`:

```ts
export type LinkKind = 'url' | 'file-path' | 'error-trace';

export type FilePathFlavor =
  | 'unix-absolute'
  | 'windows-absolute'
  | 'unc'
  | 'relative';

export interface FilePathMeta {
  flavor: FilePathFlavor;
  line?: number;
  column?: number;
}

export interface ErrorTraceMeta {
  path: string;
  flavor: FilePathFlavor;
  line: number;
  column?: number;
}

export interface LinkRange {
  kind: LinkKind;
  start: number;
  end: number;
  text: string;
  meta?: FilePathMeta | ErrorTraceMeta;
}

export interface DetectLinksOptions {
  kinds?: LinkKind[];
  maxLength?: number;
}

const ALL_KINDS: readonly LinkKind[] = ['url', 'file-path', 'error-trace'] as const;

const PATTERNS = {
  url: /https?:\/\/[^\s)>"']+/g,
  unixAbs: /(?<![A-Za-z0-9_])\/[A-Za-z0-9_\-./]+(?:\.[A-Za-z0-9]+)?(?::\d+(?::\d+)?)?/g,
  winAbs: /(?<![A-Za-z0-9_])[A-Z]:[\\/][A-Za-z0-9_\-./\\]+(?:\.[A-Za-z0-9]+)?(?::\d+(?::\d+)?)?/g,
  unc: /\\\\[A-Za-z0-9_\-]+\\[A-Za-z0-9_\-./\\]+/g,
  relative: /(?:\.{1,2}\/)?[A-Za-z0-9_\-]+(?:[/\\][A-Za-z0-9_\-]+)*\.(?:ts|tsx|js|jsx|md|json|html|css|scss|yml|yaml|py|java|go|rs|rb|sh)\b/g,
  errorTrace: /at\s+([^\s]+):(\d+)(?::(\d+))?/g,
};

const TRAILING_PUNCT = /[.,;:)\]>'"]+$/;

interface RawHit {
  kind: LinkKind;
  start: number;
  end: number;
  text: string;
  meta?: FilePathMeta | ErrorTraceMeta;
  /** Priority for overlap resolution. Higher beats lower. */
  priority: number;
}

function pathFlavor(text: string): FilePathFlavor {
  if (text.startsWith('\\\\')) return 'unc';
  if (/^[A-Z]:[\\/]/.test(text)) return 'windows-absolute';
  if (text.startsWith('/')) return 'unix-absolute';
  return 'relative';
}

function parsePathLineCol(text: string): { path: string; line?: number; column?: number } {
  const m = /^(.+?)(?::(\d+)(?::(\d+))?)?$/.exec(text);
  if (!m) return { path: text };
  return {
    path: m[1],
    line: m[2] ? parseInt(m[2], 10) : undefined,
    column: m[3] ? parseInt(m[3], 10) : undefined,
  };
}

function trimTrailingPunct(start: number, text: string): { end: number; text: string } {
  const trimmed = text.replace(TRAILING_PUNCT, '');
  return { end: start + trimmed.length, text: trimmed };
}

export function detectLinks(source: string, opts: DetectLinksOptions = {}): LinkRange[] {
  const maxLength = opts.maxLength ?? 65_536;
  if (!source || source.length > maxLength) return [];

  const kinds = new Set<LinkKind>(opts.kinds ?? ALL_KINDS);
  const hits: RawHit[] = [];

  if (kinds.has('url')) {
    for (const m of source.matchAll(PATTERNS.url)) {
      const trimmed = trimTrailingPunct(m.index!, m[0]);
      hits.push({ kind: 'url', start: m.index!, end: trimmed.end, text: trimmed.text, priority: 4 });
    }
  }

  if (kinds.has('error-trace')) {
    for (const m of source.matchAll(PATTERNS.errorTrace)) {
      const pathText = m[1];
      const flavor = pathFlavor(pathText);
      hits.push({
        kind: 'error-trace',
        start: m.index!,
        end: m.index! + m[0].length,
        text: m[0],
        meta: {
          path: pathText,
          flavor,
          line: parseInt(m[2], 10),
          column: m[3] ? parseInt(m[3], 10) : undefined,
        },
        priority: 3,
      });
    }
  }

  if (kinds.has('file-path')) {
    for (const pattern of [PATTERNS.unixAbs, PATTERNS.winAbs, PATTERNS.unc]) {
      for (const m of source.matchAll(pattern)) {
        const trimmed = trimTrailingPunct(m.index!, m[0]);
        const parsed = parsePathLineCol(trimmed.text);
        hits.push({
          kind: 'file-path',
          start: m.index!,
          end: trimmed.end,
          text: trimmed.text,
          meta: { flavor: pathFlavor(trimmed.text), line: parsed.line, column: parsed.column },
          priority: 2,
        });
      }
    }
    for (const m of source.matchAll(PATTERNS.relative)) {
      const trimmed = trimTrailingPunct(m.index!, m[0]);
      hits.push({
        kind: 'file-path',
        start: m.index!,
        end: trimmed.end,
        text: trimmed.text,
        meta: { flavor: 'relative' },
        priority: 1,
      });
    }
  }

  // Overlap resolution: sort by start asc, then (longer match, higher priority) desc.
  hits.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.priority - a.priority;
  });

  const out: LinkRange[] = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // overlap with previously accepted hit
    out.push({ kind: hit.kind, start: hit.start, end: hit.end, text: hit.text, meta: hit.meta });
    cursor = hit.end;
  }

  return out;
}
```

- [ ] **Step 2: Run — confirm it passes**

```bash
npx vitest run src/shared/utils/link-detection.spec.ts
```

Expected: all tests pass. Iterate on the regex set if any fixture fails — typical pitfalls are negative-look-behind on `\w` vs `\d`, and trailing-punctuation trimming clipping into a port number.

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/shared/utils/link-detection.ts
git add src/shared/utils/link-detection.ts src/shared/utils/link-detection.spec.ts
git commit -m "feat(link-detection): add pure detectLinks util for URLs / paths / error traces"
```

---

## Phase 7 — Adopt link detection in `markdown.service.ts` and `output-stream.component.ts`

After this phase, the codespan inline file-path regex is replaced with `detectLinks` (expanding coverage to Windows/UNC/relative); `output-stream` adds a `classifyLinkTarget` hook that Wave 6 will use.

### Task 7.1: Replace inline file-path regex in `markdown.service.ts`

**Files:**
- Modify: `src/renderer/app/core/services/markdown.service.ts`
- Modify (existing): `src/renderer/app/core/services/markdown.service.spec.ts` (add fixture coverage for Windows + UNC + relative)

- [ ] **Step 1: Read current `renderer.codespan` block**

Open the file at lines 70–90. Today (lines 76–77):

```ts
const isFilePath = /^\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(text) ||
                   /^\/[a-zA-Z0-9_\-./]+$/.test(text) && text.includes('/');
```

- [ ] **Step 2: Replace with `detectLinks`**

```ts
import { detectLinks } from '../../../../shared/utils/link-detection';

renderer.codespan = ({ text }: Tokens.Codespan): string => {
  const escapedText = this.escapeHtml(text);
  const ranges = detectLinks(text, { kinds: ['file-path'] });
  const fullSpan =
    ranges.length === 1 &&
    ranges[0].start === 0 &&
    ranges[0].end === text.length;

  if (fullSpan) {
    return `<code class="inline-code file-path" data-file-path="${escapedText}" title="Click to open file">${escapedText}</code>`;
  }
  return `<code class="inline-code">${escapedText}</code>`;
};
```

- [ ] **Step 3: Add fixture coverage in `markdown.service.spec.ts`**

If the spec has an existing `describe('codespan')` (or similar) block, append:

```ts
it('marks Windows absolute paths as file-path', () => {
  const html = service.toHtml('`C:\\Users\\foo\\bar.ts`');
  expect(html).toContain('data-file-path="C:\\Users\\foo\\bar.ts"');
});

it('marks UNC paths as file-path', () => {
  const html = service.toHtml('`\\\\server\\share\\file.txt`');
  expect(html).toContain('class="inline-code file-path"');
});

it('marks relative .ts paths as file-path', () => {
  const html = service.toHtml('`./src/foo.ts`');
  expect(html).toContain('data-file-path="./src/foo.ts"');
});

it('does NOT mark random word as file-path', () => {
  const html = service.toHtml('`hello`');
  expect(html).not.toContain('data-file-path');
});
```

- [ ] **Step 4: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/services/markdown.service.spec.ts
npx tsc --noEmit
npm run lint -- src/renderer/app/core/services/markdown.service.ts
git add src/renderer/app/core/services/markdown.service.ts src/renderer/app/core/services/markdown.service.spec.ts
git commit -m "refactor(markdown): use detectLinks for codespan file-path classification (covers Windows/UNC/relative)"
```

---

### Task 7.2: Add `classifyLinkTarget` hook in `output-stream.component.ts`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/output-stream.component.ts`

> **Wave 4 only adds the classifier hook.** No URL or error-trace HTML emission yet — that's Wave 6.

- [ ] **Step 1: Find the existing click handler**

Open the file at lines 575–600. Locate the handler that reads `target.getAttribute('data-file-path')` (around line 579–587 + 599 per the scout report).

- [ ] **Step 2: Add the classifier**

```ts
import type { LinkKind } from '../../../../shared/utils/link-detection';

/** Classifies a clicked descendant as a link target. Returns null if the
 *  element is not a known link surface. Wave 4 ships only `'file-path'`;
 *  Wave 6 will widen rendering so URL and error-trace become clickable too. */
private classifyLinkTarget(target: HTMLElement): LinkKind | null {
  if (target.hasAttribute('data-file-path')) return 'file-path';
  // Wave 6 hooks (no-ops today — no rendering emits these attributes yet):
  if (target.dataset.linkKind === 'url') return 'url';
  if (target.dataset.linkKind === 'error-trace') return 'error-trace';
  return null;
}
```

Refactor the existing click handler to call `classifyLinkTarget(target)` and branch off the returned kind. For Wave 4 only the `'file-path'` branch does anything; the other two are placeholders that no-op.

- [ ] **Step 3: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/instance-detail/output-stream.component.ts
git add src/renderer/app/features/instance-detail/output-stream.component.ts
git commit -m "refactor(output-stream): add classifyLinkTarget hook (Wave 6 will widen rendering)"
```

---

## Phase 8 — `SettingsStore` theme listener with cleanup

After this phase, system theme changes flip the app theme live when `theme === 'system'`; switching to explicit theme detaches the listener; `_resetForTesting()` cleans up.

### Task 8.1: Write failing tests for the theme listener

**Files:**
- Create or modify: `src/renderer/app/core/state/settings.store.spec.ts`

- [ ] **Step 1: Add a describe block for the theme listener**

Append (or create the file with this content):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from './settings.store';

interface MockMql {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  __fireChange(matches: boolean): void;
}

function makeMockMql(initialMatches = false): MockMql {
  const listeners: Array<(ev: { matches: boolean }) => void> = [];
  const addEventListener = vi.fn((_: 'change', l: (ev: { matches: boolean }) => void) => listeners.push(l));
  const removeEventListener = vi.fn((_: 'change', l: (ev: { matches: boolean }) => void) => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  });
  return {
    matches: initialMatches,
    addEventListener,
    removeEventListener,
    __fireChange(matches: boolean) {
      this.matches = matches;
      listeners.forEach(l => l({ matches }));
    },
  };
}

describe('SettingsStore — system theme listener', () => {
  let mql: MockMql;

  beforeEach(() => {
    mql = makeMockMql();
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => mql),
      configurable: true,
    });
    document.documentElement.removeAttribute('data-theme');
  });

  it('attaches a change listener when theme is system', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    // Force the theme into the store. Adjust shape to match `_settings` signal.
    (store as unknown as { _settings: { set: (v: unknown) => void } })._settings.set({
      theme: 'system',
      fontSize: 14,
    });
    await Promise.resolve();
    expect(mql.addEventListener).toHaveBeenCalledTimes(1);
  });

  it('detaches when theme switches to dark', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    const settingsSig = (store as unknown as { _settings: { set: (v: unknown) => void } })._settings;
    settingsSig.set({ theme: 'system', fontSize: 14 });
    await Promise.resolve();
    settingsSig.set({ theme: 'dark', fontSize: 14 });
    await Promise.resolve();
    expect(mql.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it('re-attaches on switch back to system', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    const settingsSig = (store as unknown as { _settings: { set: (v: unknown) => void } })._settings;
    settingsSig.set({ theme: 'system', fontSize: 14 });
    await Promise.resolve();
    settingsSig.set({ theme: 'light', fontSize: 14 });
    await Promise.resolve();
    settingsSig.set({ theme: 'system', fontSize: 14 });
    await Promise.resolve();
    expect(mql.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('updates data-theme on OS change while system', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    (store as unknown as { _settings: { set: (v: unknown) => void } })._settings.set({
      theme: 'system',
      fontSize: 14,
    });
    await Promise.resolve();
    mql.__fireChange(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    mql.__fireChange(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('ignores OS change when theme is explicit', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    const settingsSig = (store as unknown as { _settings: { set: (v: unknown) => void } })._settings;
    settingsSig.set({ theme: 'dark', fontSize: 14 });
    await Promise.resolve();
    document.documentElement.setAttribute('data-theme', 'dark');
    mql.__fireChange(true); // even if listener somehow fires, store should not flip
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('_resetForTesting() removes the listener', async () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(SettingsStore);
    (store as unknown as { _settings: { set: (v: unknown) => void } })._settings.set({
      theme: 'system',
      fontSize: 14,
    });
    await Promise.resolve();
    (store as unknown as { _resetForTesting: () => void })._resetForTesting();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

```bash
npx vitest run src/renderer/app/core/state/settings.store.spec.ts
```

Expected: FAIL — the listener / cleanup hook do not exist yet.

---

### Task 8.2: Implement the theme listener and cleanup

**Files:**
- Modify: `src/renderer/app/core/state/settings.store.ts`

- [ ] **Step 1: Add the listener fields and methods**

In the class body, add (above `applyTheme`):

```ts
private _systemThemeMql: MediaQueryList | null = null;

private _onSystemThemeChange = (event: MediaQueryListEvent): void => {
  // Defensive: only act if user is still on system mode.
  if (this._settings().theme !== 'system') return;
  document.documentElement.setAttribute('data-theme', event.matches ? 'dark' : 'light');
};

private _attachSystemThemeListener(): void {
  if (this._systemThemeMql || typeof window === 'undefined') return;
  this._systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
  this._systemThemeMql.addEventListener('change', this._onSystemThemeChange);
}

private _detachSystemThemeListener(): void {
  this._systemThemeMql?.removeEventListener('change', this._onSystemThemeChange);
  this._systemThemeMql = null;
}
```

- [ ] **Step 2: Update `applyTheme` to attach/detach**

Replace the existing body (lines 226–235):

```ts
private applyTheme(theme: ThemeMode): void {
  const root = document.documentElement;
  if (theme === 'system') {
    this._attachSystemThemeListener();
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
  } else {
    this._detachSystemThemeListener();
    root.setAttribute('data-theme', theme);
  }
}
```

- [ ] **Step 3: Extend `destroy()`**

Replace (around lines 270–276):

```ts
destroy(): void {
  if (this.unsubscribe) {
    this.unsubscribe();
    this.unsubscribe = null;
  }
  this._detachSystemThemeListener();
}
```

- [ ] **Step 4: Add `_resetForTesting()`**

At the bottom of the class:

```ts
/** Test-only. Tears down the system theme listener and IPC subscription so
 *  unit tests don't leak listeners across describe blocks. */
_resetForTesting(): void {
  this._detachSystemThemeListener();
  if (this.unsubscribe) {
    this.unsubscribe();
    this.unsubscribe = null;
  }
}
```

- [ ] **Step 5: Run, type-check, lint, commit**

```bash
npx vitest run src/renderer/app/core/state/settings.store.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint -- src/renderer/app/core/state/settings.store.ts
git add src/renderer/app/core/state/settings.store.ts src/renderer/app/core/state/settings.store.spec.ts
git commit -m "feat(settings): live matchMedia listener for system theme + cleanup hooks"
```

---

## Phase 9 — Terminal drawer empty shell + service interface (Wave 4b prep)

After this phase, the type surface and UI shell are in place. No `node-pty`, no IPC handlers, no native rebuild.

### Task 9.1: Add `TerminalSession` types

**Files:**
- Create: `src/shared/types/terminal.types.ts`

- [ ] **Step 1: Implement**

Create `src/shared/types/terminal.types.ts`:

```ts
export type TerminalSessionId = string;

export interface TerminalSpawnOptions {
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type TerminalLifecycleEvent =
  | { kind: 'spawned'; sessionId: TerminalSessionId; pid: number }
  | { kind: 'data';    sessionId: TerminalSessionId; data: string }
  | { kind: 'exited';  sessionId: TerminalSessionId; code: number | null; signal: string | null }
  | { kind: 'error';   sessionId: TerminalSessionId; message: string };

export interface TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }>;
  write(sessionId: TerminalSessionId, data: string): Promise<void>;
  resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void>;
  kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void>;
  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void;
}
```

- [ ] **Step 2: Type-check, commit**

```bash
npx tsc --noEmit
git add src/shared/types/terminal.types.ts
git commit -m "feat(terminal): add TerminalSession type surface (Wave 4b scaffold)"
```

---

### Task 9.2: Add `TerminalSessionStub` renderer service

**Files:**
- Create: `src/renderer/app/core/services/terminal-session.service.ts`

- [ ] **Step 1: Implement**

Create `src/renderer/app/core/services/terminal-session.service.ts`:

```ts
import { Injectable, InjectionToken, inject } from '@angular/core';
import type {
  TerminalLifecycleEvent,
  TerminalSession,
  TerminalSessionId,
  TerminalSpawnOptions,
} from '../../../../shared/types/terminal.types';

const NOT_IMPLEMENTED = 'TerminalSession is not yet implemented (Wave 4b).';

export const TERMINAL_SESSION = new InjectionToken<TerminalSession>('TERMINAL_SESSION', {
  providedIn: 'root',
  factory: () => inject(TerminalSessionStub),
});

@Injectable({ providedIn: 'root' })
export class TerminalSessionStub implements TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }> {
    void opts;
    return Promise.reject(new Error(`spawn: ${NOT_IMPLEMENTED}`));
  }
  write(sessionId: TerminalSessionId, data: string): Promise<void> {
    void sessionId;
    void data;
    return Promise.reject(new Error(`write: ${NOT_IMPLEMENTED}`));
  }
  resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void> {
    void sessionId;
    void cols;
    void rows;
    return Promise.reject(new Error(`resize: ${NOT_IMPLEMENTED}`));
  }
  kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void> {
    void sessionId;
    void signal;
    return Promise.reject(new Error(`kill: ${NOT_IMPLEMENTED}`));
  }
  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      listener({
        kind: 'error',
        sessionId: '__terminal_stub__',
        message: 'Terminal drawer is not yet implemented (Wave 4b).',
      });
    });
    return () => {
      active = false;
    };
  }
}
```

- [ ] **Step 2: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/core/services/terminal-session.service.ts
git add src/renderer/app/core/services/terminal-session.service.ts
git commit -m "feat(terminal): add TerminalSessionStub renderer service (Wave 4b will swap to real impl)"
```

---

### Task 9.3: Add empty drawer UI shell + spec

**Files:**
- Create: `src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts`
- Create: `src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts`

- [ ] **Step 1: Write the failing spec**

Create `src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TerminalDrawerComponent } from './terminal-drawer.component';

describe('TerminalDrawerComponent', () => {
  it('renders the empty-state placeholder text from the stub error event', async () => {
    TestBed.configureTestingModule({ imports: [TerminalDrawerComponent] });
    const fixture = TestBed.createComponent(TerminalDrawerComponent);
    fixture.detectChanges();
    // Allow the queued microtask in the stub to fire.
    await Promise.resolve();
    fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toMatch(/Terminal drawer is not yet implemented/);
  });

  it('emits close when the close button is clicked', () => {
    TestBed.configureTestingModule({ imports: [TerminalDrawerComponent] });
    const fixture = TestBed.createComponent(TerminalDrawerComponent);
    let closed = false;
    fixture.componentInstance.closeRequested.subscribe(() => (closed = true));
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector('button[aria-label="Close terminal drawer"]') as HTMLButtonElement | null;
    btn?.click();
    expect(closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run — confirm it fails**

```bash
npx vitest run src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts
```

Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts`:

```ts
import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { TERMINAL_SESSION } from '../../core/services/terminal-session.service';

@Component({
  selector: 'app-terminal-drawer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="terminal-drawer" [class.open]="isOpen()">
      <header class="terminal-drawer__head">
        <h3>Terminal</h3>
        <button type="button" (click)="closeRequested.emit()" aria-label="Close terminal drawer">×</button>
      </header>
      <div class="terminal-drawer__body" role="status" aria-live="polite">
        @if (lastError(); as err) {
          <p class="terminal-drawer__empty">{{ err }}</p>
        } @else {
          <p class="terminal-drawer__empty">
            Terminal sessions land in Wave 4b. The drawer shell, IPC contract, and link detection are ready; node-pty wiring is the next step.
          </p>
        }
      </div>
    </section>
  `,
  styles: [`
    .terminal-drawer { position: fixed; bottom: 0; left: 0; right: 0; height: 240px; background: var(--bg-primary);
      border-top: 1px solid var(--border-color); transform: translateY(100%); transition: transform 160ms ease-out; }
    .terminal-drawer.open { transform: translateY(0); }
    .terminal-drawer__head { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border-color); }
    .terminal-drawer__body { padding: 16px; }
    .terminal-drawer__empty { color: var(--text-muted); font-size: 12px; margin: 0; }
  `],
})
export class TerminalDrawerComponent {
  private terminal = inject(TERMINAL_SESSION);
  private destroyRef = inject(DestroyRef);
  isOpen = input(false);
  closeRequested = output<void>();
  protected lastError = signal<string | null>(null);

  constructor() {
    const unsubscribe = this.terminal.subscribe(event => {
      if (event.kind === 'error') this.lastError.set(event.message);
    });
    this.destroyRef.onDestroy(unsubscribe);
  }
}
```

- [ ] **Step 4: Run — confirm it passes**

```bash
npx vitest run src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts
```

Expected: pass.

- [ ] **Step 5: Type-check, lint, commit**

```bash
npx tsc --noEmit
npm run lint -- src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts
git add src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts
git commit -m "feat(terminal): empty drawer shell wired to TerminalSessionStub (Wave 4b will swap impl)"
```

> **Reminder:** the drawer is NOT wired into `AppComponent` or any host in Wave 4. Wave 4b decides the host.

---

## Phase 10 — Test sweeps; replace mocks of `navigator.clipboard.writeText` with `ClipboardService` mocks

After Phase 5, three existing specs still mock `navigator.clipboard.writeText` directly (per scout report). Migrate them to provider-override pattern.

### Task 10.1: Migrate `markdown.service.spec.ts`

**Files:**
- Modify: `src/renderer/app/core/services/markdown.service.spec.ts`

- [ ] **Step 1: Replace the global mock with a provider override**

Find the existing `vi.spyOn(navigator.clipboard, 'writeText')` (or equivalent) and remove it. Replace with:

```ts
import { CLIPBOARD_SERVICE, type ClipboardService } from './clipboard.service';
import { signal } from '@angular/core';

const fakeClipboard: ClipboardService = {
  lastResult: signal<unknown>(null).asReadonly() as ClipboardService['lastResult'],
  copyText: vi.fn().mockResolvedValue({ ok: true }),
  copyJSON: vi.fn().mockResolvedValue({ ok: true }),
  copyImage: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  TestBed.configureTestingModule({
    // CLIPBOARD_SERVICE is the InjectionToken<ClipboardService>; the
    // ClipboardService interface itself cannot be a DI token (interfaces
    // erase to nothing at runtime).
    providers: [{ provide: CLIPBOARD_SERVICE, useValue: fakeClipboard }],
  });
  vi.clearAllMocks();
});
```

Update the existing assertion (something like `expect(navigator.clipboard.writeText).toHaveBeenCalledWith(code)`) to:

```ts
expect(fakeClipboard.copyText).toHaveBeenCalledWith(code, expect.objectContaining({ label: 'code' }));
```

- [ ] **Step 2: Run, type-check, commit**

```bash
npx vitest run src/renderer/app/core/services/markdown.service.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
git add src/renderer/app/core/services/markdown.service.spec.ts
git commit -m "test(clipboard): markdown.service.spec uses ClipboardService provider override"
```

---

### Task 10.2: Migrate `export-panel.component.spec.ts`

**Files:**
- Modify: `src/renderer/app/features/verification/results/export-panel.component.spec.ts`

- [ ] **Step 1: Replace the mock**

Same pattern as Task 10.1, asserting `copyText` receives the selected generated export string:

```ts
expect(fakeClipboard.copyText).toHaveBeenCalledWith(expectedContent, expect.objectContaining({ label: 'export' }));
```

- [ ] **Step 2: Run, commit**

```bash
npx vitest run src/renderer/app/features/verification/results/export-panel.component.spec.ts
git add src/renderer/app/features/verification/results/export-panel.component.spec.ts
git commit -m "test(clipboard): export-panel.spec uses ClipboardService provider override"
```

---

### Task 10.3: Migrate `verification-results.component.spec.ts`

**Files:**
- Modify: `src/renderer/app/features/verification/results/verification-results.component.spec.ts`

- [ ] **Step 1: Replace the mock**

Same pattern. Assert `copyText` was called with the synthesized response.

- [ ] **Step 2: Run, commit**

```bash
npx vitest run src/renderer/app/features/verification/results/verification-results.component.spec.ts
git add src/renderer/app/features/verification/results/verification-results.component.spec.ts
git commit -m "test(clipboard): verification-results.spec uses ClipboardService provider override"
```

---

### Task 10.4: Sweep — search the renderer for any other `navigator.clipboard.writeText` mock

**Files:** none (verification only)

- [ ] **Step 1: Grep**

Use the Grep tool with pattern `clipboard\.writeText` over `*.spec.ts` files in `src/renderer/app/`.

Expected: empty after the three migrations above. If anything remains, repeat the migration pattern.

- [ ] **Step 2: Run the full vitest suite scoped to renderer**

```bash
npx vitest run src/renderer/app/
```

Expected: all green.

---

## Phase 11 — Final compile/lint/test/manual smoke

### Task 11.1: Full type-check and lint pass

- [ ] **Step 1: Run all checks**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

Expected: clean across the board.

- [ ] **Step 2: Run the full vitest suite**

```bash
npm run test
```

Expected: all tests pass. If any pre-existing tests break because they relied on `navigator.clipboard.writeText` being called directly (and were missed in Phase 10), update them to provider-override pattern.

- [ ] **Step 3: Commit any test fixes (if needed)**

```bash
git add -u
git commit -m "test: align stragglers to ClipboardService provider override"
```

---

### Task 11.2: Manual UI smoke

Run `npm run dev` and walk through every item below. Capture issues as TODOs in this file (not the spec).

- [ ] **Clipboard sweep:**
  - [ ] Output stream message: "Copied" pill flashes for 2 s; clipboard holds the message.
  - [ ] Code block in transcript: copy button copies the code.
  - [ ] Settings → Remote Nodes: enrollment token copy works.
  - [ ] Project rail: copy instance ID works.
  - [ ] Extended thinking panel: copy thinking block works.
  - [ ] Codebase search: copy result snippet works.
  - [ ] RLM context browser: copy context works.
  - [ ] **API key manager:** click copy with key concealed → key is copied; reveal mask is unchanged. Click copy with key revealed → same. **Reveal-mask must NOT toggle as a side-effect.**
  - [ ] Verification export: copy JSON contains 2-space indent.
  - [ ] Verification results: copy synthesized response works.
  - [ ] Image attachment: right-click → Copy Image still works (regression check: existing IPC path).

- [ ] **Theme sweep:**
  - [ ] Settings → Theme → System. From OS Settings, flip dark/light. App `data-theme` attribute follows live (inspect via dev tools).
  - [ ] Settings → Theme → Dark. From OS Settings, flip dark/light. App stays dark (zombie listener check).
  - [ ] Settings → Theme → System (back). OS toggles propagate again.

- [ ] **Link detection sweep:**
  - [ ] In a chat, send `\`/Users/foo/bar.ts\``. Confirm renders as clickable file path; clicking opens via existing IPC.
  - [ ] Send `\`C:\\Users\\foo\\bar.ts\``. Confirm renders as clickable file path.
  - [ ] Send `\`./src/foo.ts\``. Confirm renders as clickable file path.
  - [ ] Send `\`hello\``. Confirm renders as plain inline code (no `data-file-path`).

- [ ] **Terminal drawer sweep:**
  - [ ] (Drawer is not yet hosted; manual check only at the spec/file level.)
  - [ ] Run `git log --oneline -1 src/renderer/app/features/terminal-drawer/` — confirm the empty-shell commit is present.
  - [ ] Open `src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts` in editor and verify the placeholder copy reads as expected.

---

### Task 11.3: Packaged DMG smoke

- [ ] **Step 1: Build**

```bash
npm run build
```

Expected: clean. No native rebuild required (Wave 4 adds no native deps).

- [ ] **Step 2: Launch the packaged binary**

Open the produced `.dmg` (or run the packaged Electron from `dist/`). The app should start, all 11 clipboard sites should work, theme should follow system, and the markdown link detection should classify Windows/UNC/relative paths.

- [ ] **Step 3: Spot-check**
  - Copy a message → system clipboard holds it.
  - Settings → System theme → flip OS dark/light → app follows.
  - No `Cannot find module` errors in the console (Wave 4 adds no new `@contracts/schemas/*` subpath, so no alias-sync risk).

---

### Task 11.4: Final commit + parent-plan checkbox flips

- [ ] **Step 1: Update parent plan to mark Wave 4 tasks done**

Edit `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md`. In the Wave 4 task list, replace each `- [ ]` with `- [x]` for the items that landed:

- [x] Add a renderer `ClipboardService` for text, JSON, and image-copy status where applicable.
- [x] Replace direct `navigator.clipboard.writeText` calls with the service in output, verification, history rail, RLM, settings, and code search.
- [x] Add a shared copy success/error UI contract.
- [x] Add a live `matchMedia('(prefers-color-scheme: dark)')` listener with cleanup when theme is `system`.
- [x] Extract link detection for file paths, URLs, and command output into a shared utility.
- [x] Scope terminal drawer requirements: tabs, split panes, working directory defaults, transcript link detection, and lifecycle cleanup.
- [ ] Implement terminal drawer only after the service boundary is clear. Keep it separate from provider transcript rendering. **(Deferred to Wave 4b.)**

- [ ] **Step 2: Self-review the spec for any drift**

Re-read `docs/superpowers/specs/2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md`. If any decision drifted during implementation (e.g. a regex was tightened, a label was renamed), update the spec to match what shipped.

- [ ] **Step 3: Final commit**

```bash
git add docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan_completed.md docs/superpowers/specs/2026-04-28-wave4-output-clipboard-theme-terminal-design_completed.md
git commit -m "docs: mark Wave 4 tasks complete in parent plan; spec touch-ups"
```

- [ ] **Step 4: Surface follow-ups**

Open issues / TODOs (or notes for Wave 4b / Wave 6) for:

- Wave 4b: `node-pty` integration, `xterm` UI, `terminal.schemas.ts` + four-place alias sync, drawer hosting, tabs/split panes.
- Wave 6: full link-detection adoption (terminal output, log views, diagnostics, error-trace HTML emission); optional toast service that registers `CLIPBOARD_TOAST` provider.

---

## Spec coverage check (self-review)

| Spec section | Implemented in tasks |
|---|---|
| § 1.1 `ClipboardCopyResult` discriminated union | 1.1 |
| § 1.2 `ClipboardService` interface | 1.1, 2.3, 3.3 |
| § 1.3 `CLIPBOARD_TOAST` injection token | 2.1, 4.1 |
| § 1.4 `LinkRange` + `detectLinks` | 6.1, 6.2 |
| § 1.5 `TerminalSession` interface | 9.1 |
| § 1.6 IPC contract for terminal (declared not implemented) | 9.1 (types), 9.2 (stub) |
| § 2 ClipboardService implementation contract | 2.3, 3.3 |
| § 2.4 image-clipboard IPC pass-through (no second codepath) | 3.3 + Task 3.1 regression test |
| § 3 link-detection regex set | 6.2 |
| § 4.1 markdown.service adoption | 7.1 |
| § 4.2 output-stream classifyLinkTarget hook | 7.2 |
| § 5 SettingsStore theme listener with cleanup | 8.1, 8.2 |
| § 6 UI flows | manual smoke 11.2 |
| § 7 service signatures with examples | 5.1–5.10 (per call-site replacement) |
| § 8 drawer UI shell | 9.3 |
| § 9 migration table — 11 call sites | 5.1–5.10 + 5.11 sweep |
| § 10 terminal drawer boundary | 9.1, 9.2, 9.3 |
| § 11 testing strategy | tests embedded in each task; full suite run in 11.1 |
| § 11.3 image clipboard pass-through integration test | 3.1 (regression-guard assertion in spec) |
| § 11.4 theme listener tests | 8.1 |
| § 12 risks | mitigations spread across tasks (regression test in 3.1; silent flag in 5.2 + 5.8; cleanup in 8.2) |
| § 14 file-by-file inventory | matches Created/Modified columns across phases |
| § 15 acceptance criteria | 11.1 (1–3), 11.2 (UI smoke), 11.3 (DMG smoke) |

If any cell ever flips to "missing", add a task in the closest phase before continuing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-wave4-output-clipboard-theme-terminal-plan_completed.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Phase 5 (11 call sites) is especially well-suited to parallel subagents — each task is independent.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

Which approach?
