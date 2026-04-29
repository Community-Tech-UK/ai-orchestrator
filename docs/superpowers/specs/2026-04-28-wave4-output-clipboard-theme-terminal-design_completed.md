# Wave 4: Output, Clipboard, Theme, And Terminal Drawer — Design

**Date:** 2026-04-28
**Status:** Implemented
**Parent design:** [`docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`](./2026-04-28-cross-repo-usability-upgrades-design.md) (Track D — Operator Reliability And Local Tooling)
**Parent plan:** [`docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`](../plans/2026-04-28-cross-repo-usability-upgrades-plan.md) (Wave 4)
**Implementation plan (to follow):** `docs/superpowers/plans/2026-04-28-wave4-output-clipboard-theme-terminal-plan.md`

## Doc taxonomy in this repo

This spec is one of several artifacts in a multi-wave program. To prevent confusion and doc sprawl:

| Artifact | Folder | Filename pattern | Purpose |
|---|---|---|---|
| **Design / spec** | `docs/superpowers/specs/` | `YYYY-MM-DD-<topic>-design.md` | What we're building, why, how it fits, types & contracts |
| **Plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<topic>.md` (or `…-plan.md`) | Wave/task breakdown, files to read, exit criteria |
| **Master / roadmap plan** | `docs/superpowers/plans/` | `YYYY-MM-DD-<name>-master-plan.md` | Multi-feature umbrella spanning many specs/plans |
| **Completed**  | either folder | `…_completed.md` suffix | Archived after the work shipped |

This document is a **per-wave child design** of the parent program design. The relationship is:

```
parent design (cross-repo-usability-upgrades-design.md)
  ├── Track A → wave 1 spec (LANDED)
  ├── Track A → wave 2 spec (TBD)
  ├── Track B → wave 3 spec (TBD)
  ├── Track D → this wave 4 spec (CHILD — clipboard, theme, link detection, terminal scoping)
  ├── Track C → wave 5 spec (TBD)
  └── Track D → wave 6 spec (Doctor / diagnostics / artifacts)

parent plan (cross-repo-usability-upgrades-plan.md)
  └── Wave 4 task list  ←── implemented by this child spec
```

The parent design and plan remain authoritative for cross-track coupling, deferred ideas, and risks; this child design is authoritative for **everything required to implement Wave 4 end to end**, with one explicit hand-off: the actual `node-pty` terminal integration is deferred to a follow-up "Wave 4b" (or absorbed into Wave 6+). Wave 4 ships only the boundary spec for the terminal drawer.

---

## Goal

Stop duplicating clipboard, theme-listening, and link-detection logic across the renderer, and lay the typed boundary for the future terminal drawer without committing to a `node-pty` rebuild path inside this wave. Wave 4 ships:

1. A renderer **`ClipboardService`** that consolidates the 11 existing `navigator.clipboard.writeText` call sites (12 calls across the codebase) behind a single signal-based API. Image clipboard remains delegated through Electron IPC (`image:copy-to-clipboard`); the service exposes a thin `copyImage(blob, opts?)` that pass-throughs to the existing IPC and does not duplicate that codepath.
2. An optional **`CLIPBOARD_TOAST` injection token** so consumers that want zero-effort feedback get a free success/error toast, while sensitive call sites (API keys, the existing reveal/mask UX) keep full control over how they signal copy state.
3. A **live `matchMedia('(prefers-color-scheme: dark)')` listener** in `SettingsStore` when `theme === 'system'`, with an `addEventListener('change', ...)` + cleanup contract that doesn't leak listeners in tests, and re-attaches when the user toggles back to `system`.
4. A **shared `link-detection.ts` pure utility** in `src/shared/utils/` that returns typed ranges for absolute Unix paths, Windows paths, UNC paths, conservative relative paths (only when adjacent to a known file extension), bare URLs, and `at /path:line:col` error traces — adopted in `markdown.service.ts` and `output-stream.component.ts` as the minimum pilot.
5. A **terminal drawer scoping spec only**: `TerminalSession` interface, IPC contract for spawn/write/resize/kill, drawer UI shell with empty state. **No `node-pty` integration** in Wave 4 — that work is captured here as a follow-up wave (4b) and is out of scope for the implementation plan.

Wave 4 is intentionally narrow: foundation + adoption pilot, not full saturation. Adoption of `link-detection` in transcript/terminal/logs/diagnostics beyond the two pilot files is left to Wave 6.

## Decisions locked from brainstorming

| # | Decision | Rationale |
|---|---|---|
| 1 | **`ClipboardService` is renderer-only**, signal-based, with success/error event signals consumers can react to (not a global toast — toast integration is opt-in via injection token). | Matches the project's existing `*Service` pattern: single responsibility, signal-driven, host opts in to UI. Avoids forcing a notification surface into Wave 4 when one doesn't yet exist. |
| 2 | **API:** `copyText(text, opts?)`, `copyJSON(value, opts?)`, `copyImage(blob, opts?)` (delegates to existing IPC). Returns `Promise<{ ok: true } | { ok: false; reason: 'unavailable' \| 'permission-denied' \| 'unknown'; cause?: unknown }>`. | Three concrete ergonomic methods cover every existing call site. The discriminated union makes failures inspectable without try/catch sprawl. |
| 3 | **Toast contract = optional injection token** `CLIPBOARD_TOAST` providing `{ success(text): void; error(text): void }`. Consumers that opt in get free feedback; others handle inline. | DI-friendly (Angular `InjectionToken`), zero-cost when absent, doesn't presuppose a future toast service shape. |
| 4 | **API key copy site** (`api-key-manager.component.ts:801`) MUST keep its existing reveal-mask UX — `ClipboardService` is a drop-in but the calling code stays in charge of revealing/concealing. | Sensitive surface; we don't change UX as a side-effect of refactoring. |
| 5 | **Theme listener lives in `SettingsStore`** with explicit `addEventListener('change', ...)` + cleanup in `destroy()`. Add a `_resetForTesting()` cleanup hook so tests don't leak listeners. | Keeps the theme system in its existing owner; avoids a parallel ThemeService for one effect. |
| 6 | **Listener attached only when theme === 'system'**; detached when theme switches to explicit light/dark. Re-attached if user switches back to system. | Avoids waking matchMedia callbacks for users who've made an explicit choice; avoids zombie `data-theme` flips. |
| 7 | **Link detection = pure-function utility** in `src/shared/utils/link-detection.ts` (shared, no Angular deps). Returns ranges `[{ kind: 'url' \| 'file-path' \| 'error-trace'; start: number; end: number; meta?: ... }]`. No imperative DOM manipulation. | Pure-func is testable, reusable across renderer/main, future terminal drawer can adopt the same util without an Angular import path. |
| 8 | **Regexes covered:** absolute Unix paths, Windows paths (`[A-Z]:\\...`), UNC paths, relative paths (only when next to common file extensions), bare URLs (`http://`, `https://`), `at /path:line:col` error traces. | Matches the actual link surfaces operators have today (transcript, terminal output, logs, diagnostics) without false-positive bait. |
| 9 | **Terminal drawer scoping**: WAVE 4 SHIPS ONLY (a) service interface `TerminalSession`, (b) IPC contract for spawn/write/resize/kill, (c) drawer UI shell with empty state; NO `node-pty` integration. The deferred work is captured in a follow-up wave (Wave 4b or appended to Wave 6+). | `node-pty` would require a fresh native rebuild against Electron's ABI (per AGENTS.md packaging gotcha #2) and meaningful Electron lifecycle work; descoping protects Wave 4's ship date. |
| 10 | **No new `@contracts/schemas/*` subpath** for Wave 4 (clipboard/theme are renderer-only; link detection is pure util; terminal IPC will need one when implemented in 4b). | Avoids the four-place alias-sync (per AGENTS.md packaging gotcha #1) that's not load-bearing yet. The terminal drawer wave will pay that cost when it actually wires IPC. |

## Validation method

The decisions and call-site inventory in this spec were grounded by reading these files prior to drafting:

- Parent docs: `docs/superpowers/specs/2026-04-28-cross-repo-usability-upgrades-design.md`, `docs/superpowers/plans/2026-04-28-cross-repo-usability-upgrades-plan.md`
- Pattern reference: `docs/superpowers/specs/2026-04-28-wave1-command-registry-and-overlay-design.md`, `docs/superpowers/plans/2026-04-28-wave1-command-registry-and-overlay-plan.md`
- Renderer state: `src/renderer/app/core/state/settings.store.ts` (lines 75–235; theme one-shot at 226–235; constructor effect 79–89; `destroy()` 270–276)
- Markdown service: `src/renderer/app/core/services/markdown.service.ts` (lines 60–120; inline file-path regex at 76–77; codespan + link renderer)
- Output stream component: `src/renderer/app/features/instance-detail/output-stream.component.ts` (lines 579–587 + 599 for data-file-path delegation; 600–622 for the existing `copyMessageContent` flow with reset timer)
- 11 clipboard call sites: as listed in the Migration Table (§ 9). Each was opened and the surrounding context read to confirm whether the existing flow uses async-await, `.then/.catch`, or fire-and-forget.
- Image clipboard implementation: `src/renderer/app/shared/components/message-attachments/message-attachments.component.ts` (lines 481–500 — Electron IPC `image:copy-to-clipboard`; 530–554 — canvas WebP→PNG fallback). This is the pre-existing path Wave 4 must preserve.
- API key reveal UX: `src/renderer/app/features/verification/config/api-key-manager.component.ts` (lines 790–803 for `toggleKeyReveal` + `copyKey`).
- CSP header: `src/renderer/index.html:9` — Electron renderer's `clipboard-write` works without a CSP allowance grant; documented here so the implementation plan doesn't waste a step on it.
- Existing test mocks: `src/renderer/app/core/services/markdown.service.spec.ts`, `src/renderer/app/features/verification/results/export-panel.component.spec.ts`, `src/renderer/app/features/verification/results/verification-results.component.spec.ts` — all currently mock `navigator.clipboard.writeText` directly. Wave 4 swaps these for `ClipboardService` mocks via DI.
- Packaging gotchas: `AGENTS.md` (gotchas #1 alias-sync and #2 Electron ABI rebuild). The terminal drawer scoping decision (Locked Decision #9) is informed by gotcha #2; the no-new-contracts-subpath decision (Locked Decision #10) is informed by gotcha #1.
- Package surface: `package.json` — confirmed `xterm`, `xterm-addon-fit`, and `node-pty` are NOT current dependencies. All would be net-new in Wave 4b.

---

## 1. Type model

All new shared types either live in renderer-only files (clipboard) or in `src/shared/types/` and `src/shared/utils/` (link detection, terminal interface). Existing types are unchanged.

### 1.1 `ClipboardCopyResult` (discriminated union)

**Renderer-only file:** `src/renderer/app/core/services/clipboard.service.ts` (co-located with the service so consumers can `import` once).

```ts
export type ClipboardCopyResult =
  | { ok: true }
  | { ok: false; reason: ClipboardCopyFailureReason; cause?: unknown };

export type ClipboardCopyFailureReason =
  /** `navigator.clipboard` (or the Electron `image:copy-to-clipboard` IPC) is not available in this context. */
  | 'unavailable'
  /** The user denied permission or the page was unfocused at write time. */
  | 'permission-denied'
  /** Anything else — usually serialization (`copyJSON`) or an unexpected throw inside the IPC call. */
  | 'unknown';
```

The union is a structured failure rather than `boolean | throw` because every existing call site either silently logs an error (`console.error('Failed to copy …', err)`) or shows a transient inline UI; both behaviors map cleanly to a `result.ok === false` branch without forcing every caller to `try/catch`.

### 1.2 `ClipboardService` interface (3 methods)

```ts
export interface ClipboardCopyOptions {
  /** Optional human label used by the toast adapter. Default `"text"` for `copyText`,
   *  `"JSON"` for `copyJSON`, `"image"` for `copyImage`. Has no effect when no
   *  `CLIPBOARD_TOAST` provider is registered. */
  label?: string;
  /** When true, suppresses any toast even if a `CLIPBOARD_TOAST` provider is
   *  registered (useful for surfaces with their own inline UI such as the API
   *  key copy site or the per-message "Copied" pill in `output-stream`). */
  silent?: boolean;
  /** Optional `JSON.stringify` indent (only honored by `copyJSON`). Default `2`. */
  jsonIndent?: number;
}

export interface ClipboardService {
  /** Last attempted copy result; null until the first call. Useful for hosts
   *  that want to react to copy state without subscribing to every method. */
  readonly lastResult: Signal<ClipboardCopyResult | null>;

  /** Copy a UTF-8 string. Empty string is treated as a successful no-op
   *  (`{ ok: true }`) — many call sites guard with `if (!content) return;`
   *  but the service treats this defensively. */
  copyText(text: string, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;

  /** `JSON.stringify(value, null, opts.jsonIndent ?? 2)` then `copyText`. On
   *  serialization failure (cycles, BigInt, etc.) returns
   *  `{ ok: false, reason: 'unknown', cause }`. */
  copyJSON(value: unknown, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;

  /** Copy an image Blob via the existing Electron `image:copy-to-clipboard`
   *  IPC channel. The service performs the WebP→PNG canvas conversion when
   *  needed; callers do not need to repeat the logic from
   *  `message-attachments.component.ts`. When the IPC bridge is missing
   *  (e.g. browser context, tests without a mock), returns
   *  `{ ok: false, reason: 'unavailable' }`. */
  copyImage(blob: Blob, opts?: ClipboardCopyOptions): Promise<ClipboardCopyResult>;
}
```

The service is implemented as `@Injectable({ providedIn: 'root' })` on the **`ClipboardServiceImpl`** class. **`ClipboardService` is a TypeScript interface — it does not exist at runtime and CANNOT be used as a DI token directly.** Wave 4 ships an `InjectionToken<ClipboardService>` named `CLIPBOARD_SERVICE` (declared alongside the interface) for tests and consumers to use:

```ts
import { InjectionToken } from '@angular/core';

export const CLIPBOARD_SERVICE = new InjectionToken<ClipboardService>('CLIPBOARD_SERVICE');
```

Production providers register `{ provide: CLIPBOARD_SERVICE, useClass: ClipboardServiceImpl }` (or `useExisting: ClipboardServiceImpl` if `ClipboardServiceImpl` is also `providedIn: 'root'`). Consumers inject via `inject(CLIPBOARD_SERVICE)` — never `inject(ClipboardService)`, which would compile but throw at runtime because interfaces erase to nothing.

Test fakes use `{ provide: CLIPBOARD_SERVICE, useValue: fakeClipboard }` per § 11.

> **Note for Wave 5 consumers:** The Wave 5 plan currently writes `inject(ClipboardService)`. That is shorthand for `inject(CLIPBOARD_SERVICE)` and must be replaced with the token form before Wave 5 lands; Wave 4's verification step (Phase 5 final task) greps for `inject(ClipboardService)` and fails the build if any uses survive.

### 1.3 `CLIPBOARD_TOAST` injection token contract

```ts
import { InjectionToken } from '@angular/core';

export interface ClipboardToastAdapter {
  success(text: string): void;
  error(text: string): void;
}

/** Optional. When provided, `ClipboardService` calls `success(label)` on
 *  `{ ok: true }` and `error(message)` on `{ ok: false }`, unless the call
 *  site passes `{ silent: true }`. */
export const CLIPBOARD_TOAST = new InjectionToken<ClipboardToastAdapter>('CLIPBOARD_TOAST');
```

The token is resolved with `inject(CLIPBOARD_TOAST, { optional: true })`. There is no default provider in Wave 4 — sites that already render their own "Copied" UI continue to do so. A future toast service (likely landing as part of the "shared copy success/error UI contract" in Wave 4 of the parent design, or in a Wave 6 notification service) can register a provider once and the existing `ClipboardService` consumers pick it up automatically without code changes.

### 1.4 `LinkRange` type (link-detection utility)

**Shared file:** `src/shared/utils/link-detection.ts`.

```ts
export type LinkKind = 'url' | 'file-path' | 'error-trace';

export type FilePathFlavor =
  | 'unix-absolute'    // /Users/x/... or /var/...
  | 'windows-absolute' // C:\Users\... or D:/x/...
  | 'unc'              // \\server\share\...
  | 'relative';        // ./foo/bar.ts or src/x.ts (only matched when adjacent to a known file extension)

export interface FilePathMeta {
  flavor: FilePathFlavor;
  /** Optional `:line` parsed from path. */
  line?: number;
  /** Optional `:col` parsed from path. Only present when line is also present. */
  column?: number;
}

export interface ErrorTraceMeta {
  /** The path portion of the trace, normalized (see flavor below). */
  path: string;
  flavor: FilePathFlavor;
  line: number;
  column?: number;
}

export interface LinkRange {
  kind: LinkKind;
  /** Inclusive offset into the source string. */
  start: number;
  /** Exclusive offset into the source string. */
  end: number;
  /** The exact substring `source.slice(start, end)`. Convenience for callers
   *  that don't want to slice themselves. */
  text: string;
  meta?: FilePathMeta | ErrorTraceMeta;
}

export interface DetectLinksOptions {
  /** Override the default kind set. Defaults to `['url', 'file-path', 'error-trace']`. */
  kinds?: LinkKind[];
  /** Maximum input length to scan. Inputs longer than this are passed through
   *  with no detection (returning an empty array) so very large transcripts
   *  don't burn the main thread. Default 65_536. */
  maxLength?: number;
}

/**
 * Pure function. No DOM. No Angular. No Node.
 * Ranges are returned in source order, non-overlapping. When two regex hits
 * overlap, the longer-start-wins (URL beats path beats trace) tie-break is
 * applied so transcripts containing things like
 * `at https://example.com:443/foo:12:34` resolve to a single URL.
 */
export function detectLinks(source: string, opts?: DetectLinksOptions): LinkRange[];
```

The regex set is documented in § 3 below.

### 1.5 `TerminalSession` interface (Wave 4b scaffold — empty in Wave 4)

**Shared file:** `src/shared/types/terminal.types.ts` (new).

```ts
export type TerminalSessionId = string;

export interface TerminalSpawnOptions {
  /** Working directory. Required — the drawer must show *something* concrete. */
  cwd: string;
  /** Override the user's default shell. When undefined, main resolves
   *  `$SHELL` (or `cmd.exe` on Windows). */
  shell?: string;
  /** Optional environment overlay, merged on top of `process.env`. Sensitive
   *  keys (e.g. `ANTHROPIC_API_KEY`) are redacted before logging. */
  env?: Record<string, string>;
  /** Initial size. Default 80x24. */
  cols?: number;
  rows?: number;
}

export type TerminalLifecycleEvent =
  | { kind: 'spawned';   sessionId: TerminalSessionId; pid: number }
  | { kind: 'data';      sessionId: TerminalSessionId; data: string }
  | { kind: 'exited';    sessionId: TerminalSessionId; code: number | null; signal: string | null }
  | { kind: 'error';     sessionId: TerminalSessionId; message: string };

export interface TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }>;
  write(sessionId: TerminalSessionId, data: string): Promise<void>;
  resize(sessionId: TerminalSessionId, cols: number, rows: number): Promise<void>;
  kill(sessionId: TerminalSessionId, signal?: NodeJS.Signals): Promise<void>;
  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void;
}
```

Wave 4 ships only the interface and a stub renderer service that throws `NotImplementedError` from every method except `subscribe()` (which immediately calls the listener with a synthetic `error` event). Wave 4b will replace the stub with a real `node-pty` implementation behind an Electron IPC bridge, plus the matching contracts schema and four-place alias sync.

### 1.6 IPC contract for terminal (declared, not implemented)

The future channels are documented here so Wave 4b inherits the surface without a redesign. Wave 4 itself does not register any of these handlers.

| Channel | Direction | Payload | Response |
|---|---|---|---|
| `TERMINAL_SPAWN` | renderer → main | `TerminalSpawnOptions` | `{ sessionId, pid }` |
| `TERMINAL_WRITE` | renderer → main | `{ sessionId, data }` | `{ ok: true }` |
| `TERMINAL_RESIZE` | renderer → main | `{ sessionId, cols, rows }` | `{ ok: true }` |
| `TERMINAL_KILL` | renderer → main | `{ sessionId, signal? }` | `{ ok: true }` |
| `TERMINAL_EVENT` | main → renderer (event) | `TerminalLifecycleEvent` | — |

When 4b lands, the schemas live at `packages/contracts/src/schemas/terminal.schemas.ts` and require the four-place alias sync per AGENTS.md packaging gotcha #1.

---

## 2. `ClipboardService` — implementation contract

### 2.1 Provider tree placement

```ts
@Injectable({ providedIn: 'root' })
export class ClipboardServiceImpl implements ClipboardService {
  private readonly toast = inject(CLIPBOARD_TOAST, { optional: true });
  private readonly ipc = inject(IpcService); // existing renderer IPC wrapper
  private _lastResult = signal<ClipboardCopyResult | null>(null);
  readonly lastResult = this._lastResult.asReadonly();

  // … methods below …
}
```

Tests register `{ provide: CLIPBOARD_SERVICE, useClass: FakeClipboardService }` (or `useValue: { copyText: vi.fn().mockResolvedValue({ ok: true }), … }`). `ClipboardService` is a TypeScript interface and cannot be a DI token (interfaces erase to nothing at runtime); `CLIPBOARD_SERVICE` is the `InjectionToken<ClipboardService>` exported alongside the interface (see § 1.2). The previous practice of mocking `navigator.clipboard.writeText` globally is replaced by component-level provider overrides via the token — see § 11.

### 2.2 `copyText` flow

```ts
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
```

`finish()` updates `_lastResult` and calls the toast adapter (when present and `!opts.silent`). All three methods funnel through it.

### 2.3 `copyJSON` flow

```ts
async copyJSON(value: unknown, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
  let text: string;
  try {
    text = JSON.stringify(value, null, opts.jsonIndent ?? 2);
  } catch (cause) {
    return this.finish({ ok: false, reason: 'unknown', cause }, opts.label ?? 'JSON', opts);
  }
  return this.copyText(text, { label: 'JSON', ...opts });
}
```

### 2.4 `copyImage` flow — pass-through to existing IPC

```ts
async copyImage(blob: Blob, opts: ClipboardCopyOptions = {}): Promise<ClipboardCopyResult> {
  if (!this.ipc?.invoke) {
    return this.finish({ ok: false, reason: 'unavailable' }, opts.label ?? 'image', opts);
  }
  const dataUrl = await blobToClipboardCompatibleDataUrl(blob);
  if (!dataUrl) {
    return this.finish({ ok: false, reason: 'unknown', cause: new Error('Failed to encode image') }, opts.label ?? 'image', opts);
  }
  const res = await this.ipc.invoke('image:copy-to-clipboard', { dataUrl });
  if (res?.success) {
    return this.finish({ ok: true }, opts.label ?? 'image', opts);
  }
  return this.finish({ ok: false, reason: 'unknown', cause: res?.error }, opts.label ?? 'image', opts);
}
```

`blobToClipboardCompatibleDataUrl` is extracted from `message-attachments.component.ts`'s existing `toClipboardCompatibleDataUrl` (lines 530–554). The original component method becomes a thin wrapper that calls into the shared util; the existing component flow continues to work, but new sites can call `ClipboardService.copyImage` directly without re-implementing canvas conversion.

> **Critical:** Do NOT introduce a second image clipboard codepath using the Async Clipboard API's `ClipboardItem`/`navigator.clipboard.write` — keep delegating to the existing Electron IPC. The existing IPC handles the reveal-and-paste UX inside the OS native menu, which the renderer-only path does not.

---

## 3. Link detection — regex set & ordering

### 3.1 Patterns

| Kind | Pattern (high-level) | Notes |
|---|---|---|
| URL | `https?://[^\s)>"']+` (trailing-punctuation trim) | Trim trailing `.,;:)]>"'` from match end. |
| Unix abs path | `(?<!\w)/[A-Za-z0-9_\-./]+(?::\d+(?::\d+)?)?` | Negative-look-behind on word char prevents partial matching of `key/value`. |
| Windows abs path | `(?<!\w)[A-Z]:[\\/][^\s<>"']+(?::\d+(?::\d+)?)?` | Drive letter required; both `\` and `/` separators accepted. |
| UNC path | `(?<!\w)\\\\[^\s<>"']+\\[^\s<>"']+` | Two leading backslashes, server, share. |
| Relative path | `(?:\./|\.\./)?[A-Za-z0-9_\-]+(?:[/\\][A-Za-z0-9_\-]+)*\.(ts\|tsx\|js\|jsx\|md\|json\|html\|css\|scss\|yml\|yaml\|py\|java\|go\|rs\|rb\|sh)` | Conservative: only matches when ending in a known extension. |
| Error trace | `at\s+([^\s]+):(\d+):(\d+)?` | Captures `at /path:line:col` and `at /path:line` from typical Node/JS stacks. |

### 3.2 Combination strategy

A single combined regex with named alternation groups is the implementation default. Each alternative is matched against the input, and ranges are emitted in source order. When two ranges overlap (e.g. an error-trace contains an absolute path), the **longer match wins**, with URL > error-trace > path > relative as the tie-break order. The overlap resolution runs in O(n) after the initial regex pass.

Performance budget: detection on a 64 KiB transcript chunk should complete in < 5 ms on a 2024-class laptop. The `maxLength` option (default 65_536) is a hard cap; transcripts longer than that bypass detection entirely (returning `[]`) rather than blocking the main thread. Larger chunks are the responsibility of the caller (e.g. `output-stream` already chunks display items per cycle).

### 3.3 What the utility does NOT do

- Render. The utility returns ranges; the caller decides whether to wrap them in `<a>`, `<code class="file-path">`, or attach DOM listeners. `markdown.service.ts` will continue to use `marked`'s renderer for HTML emission; it just consumes `detectLinks` for the codespan path detection.
- Open. Path-opening is delegated to existing IPC (`openPath` / `external-editor`) — see § 4 below.
- Cache. Each call recomputes. Memoization is the caller's choice when needed (e.g. `output-stream` could memoize per display item by `(itemId, lastContentHash)`, but Wave 4 does not implement that).

---

## 4. Pilot adoption of `link-detection`

Wave 4 adopts the utility in **two** files only. Broader adoption (terminal output, log views, diagnostic panels) is queued for Wave 6 to keep this wave's diff small and reviewable.

### 4.1 `markdown.service.ts` — replace inline regex

**Today:** lines 76–77 use a one-off Unix-only regex inside `renderer.codespan`:

```ts
const isFilePath = /^\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+$/.test(text) ||
                   /^\/[a-zA-Z0-9_\-./]+$/.test(text) && text.includes('/');
```

**Wave 4:** call `detectLinks(text, { kinds: ['file-path'] })`. If exactly one range is returned and it spans the entire `text`, render with `data-file-path` and the existing click-to-open behavior. Otherwise render as plain inline code (no link). This expands coverage to Windows + UNC + relative without touching the click handler.

### 4.2 `output-stream.component.ts` — call util in display path

**Today:** lines 579–587 + 599 attach `data-file-path` clicks delegated to an IPC `openPath` channel. The actual path detection happens inside `markdown.service` (above). After § 4.1 lands, no change is required in `output-stream` for *codespan* paths.

**What Wave 4 *does* change in `output-stream`:** the existing click delegation (`onClickInOutput` checking `target.getAttribute('data-file-path')`) is widened to also handle `data-link-kind="error-trace"` and `data-link-kind="url"` once Wave 6 expands rendering. **Wave 4 ships only the renderer-side classifier hook** (`classifyLinkTarget(target: HTMLElement): LinkKind | null`) so the click handler is ready for the broader rollout. No URL or error-trace HTML is emitted yet — that's Wave 6.

This split is intentional: Wave 4 ships the detection utility + minimal markdown adoption; Wave 6 adds the rendering and richer click behavior across diagnostics/terminal.

---

## 5. Theme listener — `SettingsStore`

### 5.1 Today

`src/renderer/app/core/state/settings.store.ts`:

- Constructor (lines 79–89) registers an `effect()` that calls `applyTheme(this._settings().theme)` on every settings change.
- `applyTheme` (lines 226–235) reads `window.matchMedia('(prefers-color-scheme: dark)').matches` once when `theme === 'system'` and sets `data-theme` to either `dark` or `light`. It never listens for changes.
- `destroy()` (lines 270–276) only cleans up the IPC subscription.

### 5.2 Wave 4 design

Add a private field `_systemThemeMql: MediaQueryList | null` and a private method `_systemThemeListener` (bound class member, not arrow-in-constructor — easier to remove).

```ts
private _systemThemeMql: MediaQueryList | null = null;

private _onSystemThemeChange = (event: MediaQueryListEvent): void => {
  // Only act if the user is still on 'system'. Defensive — the listener
  // should be detached when theme changes, but a slow OS callback could
  // race with a setting update.
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

Inside `applyTheme(theme)`:

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

`destroy()` calls `this._detachSystemThemeListener()` after the existing `unsubscribe()` cleanup.

### 5.3 Test cleanup hook

Add `_resetForTesting()` at the bottom of the class:

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

The pattern matches existing singletons in the project (per AGENTS.md's "Common Patterns: Testing singletons" note).

### 5.4 Edge cases

| Scenario | Behavior |
|---|---|
| User opens app with `theme === 'dark'` | Listener never attached; explicit theme honored. |
| User flips to `system` | Listener attached on next `applyTheme` call (driven by the existing settings effect). |
| User flips back to `dark` | Listener detached; OS theme changes are ignored. |
| OS theme flips while app open in `system` mode | `data-theme` attribute updates immediately. No setting write — the user's choice (`system`) is preserved. |
| App close while in `system` mode | `destroy()` removes the listener. |
| `matchMedia` unavailable (jsdom in some test contexts) | `_attachSystemThemeListener` early-returns; theme falls back to whatever `data-theme` was set last. |

---

## 6. UI flows

### 6.1 Copy with toast adapter (opt-in)

```
Component               ClipboardService              CLIPBOARD_TOAST (optional)
   │                            │                              │
   │ copyText("hello", {})      │                              │
   ├───────────────────────────►│                              │
   │                            │ navigator.clipboard.writeText│
   │                            ├──┐                           │
   │                            │  │ resolves                  │
   │                            │◄─┘                           │
   │                            │ finish({ ok: true })         │
   │                            ├─────────────────────────────►│
   │                            │                              │ success("text")
   │ ◄── { ok: true } ──────────┤                              │
```

### 6.2 Copy without toast (caller-handled UI, e.g. existing 2 s "Copied" pill)

```
OutputStreamComponent       ClipboardService
        │                          │
        │ copyText(content, { silent: true })
        ├─────────────────────────►│
        │                          │ … awaits …
        │ ◄── { ok: true } ────────┤
        │
        │ (caller sets copiedMessageId; resets after 2 s)
        │
```

The existing 2 s timer logic in `output-stream.component.ts:610–617` stays; the only change is `navigator.clipboard.writeText(content).then(…).catch(…)` becomes `await this.clipboard.copyText(content, { silent: true })` and the success branch runs when `result.ok`.

### 6.3 System theme change while app open

```
OS theme change        matchMedia('(prefers-color-scheme: dark)')   document
       │                              │                                │
       ├─────────────────────────────►│                                │
       │                              │ change event                   │
       │                              ├──► _onSystemThemeChange()      │
       │                              │      └─► setAttribute(...)     │
       │                              │                                ├──► CSS recomputed
```

If `theme !== 'system'`, the listener is detached so the change event simply isn't observed — even if the OS fires it, `_systemThemeMql` is `null`.

### 6.4 Link click in transcript (existing behavior preserved)

```
User clicks .file-path span                Output click handler      IPC
        │                                          │                  │
        ├─────────────────────────────────────────►│                  │
        │                                          │ getAttribute     │
        │                                          │ 'data-file-path' │
        │                                          ├─────────────────►│ openPath(path)
```

After § 4.1 lands, the same DOM contract is upheld; the only difference is which inputs *produce* a `data-file-path` attribute (now: Windows, UNC, relative + the previous Unix abs).

---

## 7. Service signatures with examples

### 7.1 `ClipboardService.copyText`

```ts
// Replaces 7 of the 11 call sites verbatim.
private readonly clipboard = inject(CLIPBOARD_SERVICE);

async onCopyMessage(content: string, messageId: string): Promise<void> {
  const result = await this.clipboard.copyText(content, { silent: true, label: 'message' });
  if (result.ok) {
    this.copiedMessageId.set(messageId);
    window.setTimeout(() => this.copiedMessageId.set(null), 2000);
  } else {
    console.error('Copy failed:', result.reason, result.cause);
  }
}
```

### 7.2 `ClipboardService.copyJSON`

```ts
// Used when the source data is still an object and should be serialized
// uniformly by the service.
async exportRaw(): Promise<void> {
  const result = await this.clipboard.copyJSON(this.payload(), { label: 'export' });
  if (!result.ok) this.exportError.set(result.reason);
}
```

`export-panel.component.ts` keeps copying `generateExport()` through `copyText`
because the user-selected export format may be Markdown, HTML, PDF/Markdown, or
JSON. Converting that path to `copyJSON` would change the existing copy button's
behavior from "copy the selected export preview" to "copy an internal object".

### 7.3 `ClipboardService.copyImage`

```ts
// Replaces the inline path inside message-attachments.component.ts.
async copyImageToClipboard(): Promise<void> {
  const att = this.previewAttachment();
  if (!att?.dataBlob) return;
  const result = await this.clipboard.copyImage(att.dataBlob, { label: 'image' });
  // Existing console-only logging is preserved.
  if (result.ok) console.log('Image copied to clipboard');
  else console.error('Failed to copy image:', result.reason);
}
```

### 7.4 `detectLinks`

```ts
// Replaces the markdown.service inline regex.
const ranges = detectLinks(text, { kinds: ['file-path'] });
const fullSpan = ranges.length === 1 && ranges[0].start === 0 && ranges[0].end === text.length;
if (fullSpan) {
  return `<code class="inline-code file-path" data-file-path="${escapedText}" title="Click to open file">${escapedText}</code>`;
}
return `<code class="inline-code">${escapedText}</code>`;
```

### 7.5 `TerminalSession` (stub form for Wave 4)

```ts
// terminal-session.service.ts (Wave 4 stub)
export const TERMINAL_SESSION = new InjectionToken<TerminalSession>('TERMINAL_SESSION', {
  providedIn: 'root',
  factory: () => inject(TerminalSessionStub),
});

@Injectable({ providedIn: 'root' })
export class TerminalSessionStub implements TerminalSession {
  spawn(opts: TerminalSpawnOptions): Promise<{ sessionId: TerminalSessionId; pid: number }> {
    void opts;
    return Promise.reject(new Error('spawn: TerminalSession is not yet implemented (Wave 4b).'));
  }
  subscribe(listener: (event: TerminalLifecycleEvent) => void): () => void {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        listener({ kind: 'error', sessionId: '__terminal_stub__', message: 'Terminal drawer is not yet implemented (Wave 4b).' });
      }
    });
    return () => { active = false; };
  }
}
```

The drawer UI shell uses `subscribe()` to render its empty state, so the stub's synthetic error is what produces the placeholder text.

---

## 8. Drawer UI shell (Wave 4 boundary only)

### 8.1 Component layout

**New file:** `src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts`.

```ts
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
          <p class="terminal-drawer__empty">Terminal sessions land in Wave 4b. The drawer shell, IPC contract, and link detection are ready; node-pty wiring is the next step.</p>
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
    .terminal-drawer__empty { color: var(--text-muted); font-size: 12px; }
  `],
})
export class TerminalDrawerComponent {
  private terminal = inject(TerminalSession as ProviderToken<TerminalSession>);
  open = input<boolean>(false);
  close = output<void>();
  protected lastError = signal<string | null>(null);

  constructor() {
    this.terminal.subscribe(event => {
      if (event.kind === 'error') this.lastError.set(event.message);
    });
  }
}
```

### 8.2 What ships and what doesn't

| Item | Ships in Wave 4? |
|---|---|
| `TerminalSession` interface in `src/shared/types/terminal.types.ts` | Yes |
| `TerminalSessionStub` (renderer service) | Yes |
| `TerminalDrawerComponent` (UI shell, empty state) | Yes |
| Drawer toggle wired into a top-level container | **No** — Wave 4b decides the host (could be `AppComponent`, could be a side panel). |
| `node-pty` dependency | No |
| `xterm` / `xterm-addon-fit` dependencies | No |
| `TERMINAL_*` IPC channels registered in `src/main/index.ts` | No |
| `terminal.schemas.ts` + four-place alias sync | No (4b) |
| Native ABI rebuild (`npm run rebuild:native`) | No (4b — the new `node-pty` install will trigger it) |

### 8.3 Acceptance for the boundary

- The drawer component compiles, renders an empty state, and emits `close` on the button click.
- `TerminalSessionStub` is the only injection bound to the `TerminalSession` token in Wave 4. Wave 4b swaps the binding to a real implementation without changing any consumer.
- A test renders the drawer and asserts the empty-state text is present.

---

## 9. Migration table — 11 clipboard call-site replacements

Each row maps the existing call to the new service call, the suggested `label`, and any per-site UX preservation note.

| # | File | Line(s) | Today | Wave 4 replacement | Notes |
|---|---|---|---|---|---|
| 1 | `src/renderer/app/core/services/markdown.service.ts` | 241 | `await navigator.clipboard.writeText(code)` | `await this.clipboard.copyText(code, { label: 'code' })` | Markdown service is `@Injectable`; constructor-inject `ClipboardService`. Tests in `markdown.service.spec.ts` swap to a `ClipboardService` provider. |
| 2 | `src/renderer/app/features/instance-detail/output-stream.component.ts` | 608–609 | `.then/.catch` chain with 2 s reset timer | `await this.clipboard.copyText(content, { silent: true, label: 'message' })`; on `result.ok`, drive the existing `copiedMessageId` + timer. | Keep the local "Copied" pill; pass `silent: true` so the toast adapter (when added later) doesn't double-render. |
| 3 | `src/renderer/app/features/instance-detail/output-stream.component.ts` | 703 | Context-menu copy of message content | Same replacement as row 2; reuse the same per-component handler. | Single shared handler — don't duplicate. |
| 4 | `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` | 492 | Enrollment token copy | `await this.clipboard.copyText(token, { label: 'enrollment token' })` | Settings tab already shows transient inline state; pass `silent: true` if that pattern continues. |
| 5 | `src/renderer/app/features/instance-list/instance-list.component.ts` | 712 | Instance ID copy | `await this.clipboard.copyText(id, { label: 'instance id' })` | Allow toast for this site (low-noise). |
| 6 | `src/renderer/app/features/thinking/components/extended-thinking-panel.component.ts` | 569 | Thinking-block copy | `await this.clipboard.copyText(block, { label: 'thinking block' })` | Allow toast. |
| 7 | `src/renderer/app/features/codebase/search-results.component.ts` | 401 | Search-result snippet copy | `await this.clipboard.copyText(snippet, { label: 'search result' })` | Allow toast. |
| 8 | `src/renderer/app/features/rlm/rlm-context-browser.component.ts` | 537 | RLM context copy | `await this.clipboard.copyText(ctx, { label: 'context' })` | Allow toast. |
| 9 | `src/renderer/app/features/verification/config/api-key-manager.component.ts` | 801 | Full API key copy (sensitive!) | `await this.clipboard.copyText(key.keyFull, { silent: true, label: 'API key' })` | **MUST keep `silent: true`** — the calling code stays in charge of revealing/concealing the key per Locked Decision #4. Existing `toggleKeyReveal` flow is unchanged. |
| 10 | `src/renderer/app/features/verification/results/export-panel.component.ts` | 717 | Selected generated export string | `await this.clipboard.copyText(this.generateExport(), { label: 'export' })` | Preserves the existing "copy the selected export preview" UX across Markdown, JSON, HTML, and PDF/Markdown formats. |
| 11 | `src/renderer/app/features/verification/results/verification-results.component.ts` | 198–199 | Synthesized response copy | `await this.clipboard.copyText(response, { label: 'verification response' })` | Allow toast. |

After replacement, `grep -rn "navigator.clipboard.writeText" src/renderer/app/` should return zero hits in feature/component code. The `ClipboardServiceImpl` is the only allowed caller.

---

## 10. Terminal drawer boundary — what's in Wave 4 vs deferred

### In Wave 4

- **`src/shared/types/terminal.types.ts`** — `TerminalSession`, `TerminalSpawnOptions`, `TerminalLifecycleEvent`, `TerminalSessionId`. Pure types, no runtime cost.
- **`src/renderer/app/core/services/terminal-session.service.ts`** — `TerminalSession` injection token + `TerminalSessionStub` `@Injectable({ providedIn: 'root' })` whose methods reject with `NotImplementedError` and whose `subscribe()` emits a synthetic error explaining the stub state.
- **`src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts`** — empty UI shell rendering the drawer chrome and the stub's synthetic error message.
- **`src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts`** — snapshot of the empty-state markup.
- **Documentation** — § 1.5, § 1.6, § 8 of this spec capture the IPC contract and intended Wave 4b shape.

### Deferred to Wave 4b (or absorbed into Wave 6+)

- `node-pty` dependency add + native rebuild guard (will piggy-back on existing `scripts/verify-native-abi.js`).
- `xterm` / `xterm-addon-fit` dependency add + style imports.
- Replace `TerminalSessionStub` with a real renderer-side `TerminalSessionImpl` that talks to `electronAPI.invoke('terminal:spawn', ...)`.
- Main-process `TerminalManager` singleton (per the project's singleton pattern), persisting active sessions and emitting lifecycle events through the IPC bridge.
- `packages/contracts/src/schemas/terminal.schemas.ts` + four-place alias sync (`tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`).
- Drawer host wiring (which top-level container hosts the drawer; toggle keybinding; persistence of "is drawer open" across reloads).
- Link detection adoption inside the terminal output renderer (now possible because `link-detection.ts` ships in Wave 4).
- Tabs, split panes, working-directory defaults, and per-instance terminal binding from the parent design's Track D acceptance criteria.

### Why this split

`node-pty` is a native module. Per AGENTS.md packaging gotcha #2, native modules require an Electron-ABI rebuild any time Electron is bumped *or* a new native module is added. The rebuild is guarded by `scripts/verify-native-abi.js`, but the work to add `node-pty`, exercise the rebuild, and ship a packaged DMG that boots is non-trivial. Bundling that with clipboard/theme/link-detection in a single wave would either delay the wave by weeks or ship a half-broken terminal. Splitting protects both.

---

## 11. Testing strategy

### 11.1 Unit tests — new

| Path | Coverage |
|---|---|
| `src/renderer/app/core/services/clipboard.service.spec.ts` | `copyText` ok / unavailable / permission-denied / unknown; `copyJSON` ok and serialization-fail; `copyImage` ok / unavailable / IPC error; `lastResult` signal updates after each call; toast adapter called with correct label / not called when `silent: true` / not called when `CLIPBOARD_TOAST` is unprovided. |
| `src/shared/utils/link-detection.spec.ts` | URL detection (basic, with port, with query, trailing punctuation trim). Unix abs path with and without `:line:col`. Windows abs path with `\` and `/` separators. UNC path. Relative path matched only with allowed extensions. Error trace `at /path:line:col` with and without col. Overlap resolution (URL beats path). `maxLength` cutoff returns `[]`. Empty string returns `[]`. |
| `src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts` | Renders empty-state text from the stub's synthetic error event; emits `close` on button click. |

### 11.2 Test seam migration — replace `navigator.clipboard.writeText` mocks

| Path | Today | After Wave 4 |
|---|---|---|
| `src/renderer/app/core/services/markdown.service.spec.ts` | mocks `navigator.clipboard.writeText` directly | overrides `ClipboardService` provider with `{ copyText: vi.fn().mockResolvedValue({ ok: true }), … }` |
| `src/renderer/app/features/verification/results/export-panel.component.spec.ts` | same | overrides `ClipboardService` for `copyText` assertions |
| `src/renderer/app/features/verification/results/verification-results.component.spec.ts` | same | overrides `ClipboardService` for `copyText` assertions |

Pattern (`TestBed.configureTestingModule`):

```ts
import { CLIPBOARD_SERVICE, type ClipboardService, type ClipboardCopyResult } from '../core/services/clipboard.service';

const fakeClipboard: ClipboardService = {
  lastResult: signal<ClipboardCopyResult | null>(null).asReadonly(),
  copyText: vi.fn().mockResolvedValue({ ok: true }),
  copyJSON: vi.fn().mockResolvedValue({ ok: true }),
  copyImage: vi.fn().mockResolvedValue({ ok: true }),
};
TestBed.configureTestingModule({
  // CLIPBOARD_SERVICE is the InjectionToken<ClipboardService>; the
  // ClipboardService interface itself cannot be a DI token (interfaces erase).
  providers: [{ provide: CLIPBOARD_SERVICE, useValue: fakeClipboard }],
});
```

### 11.3 Integration test — image clipboard pass-through

A dedicated spec verifies that `ClipboardServiceImpl.copyImage(blob)` calls the existing `image:copy-to-clipboard` IPC channel exactly once, with a PNG-or-JPEG data URL payload (i.e. WebP→PNG conversion happened before the IPC call). This is the **only** way to detect a future regression where someone tries to "improve" the service by routing images through `navigator.clipboard.write` — that change would silently break the OS native menu paste flow.

### 11.4 Theme listener tests — `settings.store.spec.ts`

| Case | Setup | Assertion |
|---|---|---|
| Listener attached on `system` | Set theme to `'system'` | `window.matchMedia(...).addEventListener` called once. |
| Listener detached on `light` | Theme `system` → `light` | `removeEventListener` called once; `_systemThemeMql` is null. |
| Re-attached on switch back | `light` → `system` | `addEventListener` called a second time on a fresh MQL handle. |
| OS change while system | Fire a synthetic `change` event with `matches: true` | `data-theme` attribute is `'dark'`. |
| OS change while light | Theme `light`; fire `change` | `data-theme` remains `'light'`. |
| Cleanup on `_resetForTesting` | Listener attached; call `_resetForTesting()` | `removeEventListener` called; `_systemThemeMql` null. |

`vitest` provides a `matchMedia` polyfill via the project's existing test setup; if not, the spec uses a manual `Object.defineProperty(window, 'matchMedia', { value: vi.fn(...) })` fixture.

### 11.5 Manual verification (UI smoke after the wave)

- Press copy on each of the 11 sites; confirm the system clipboard holds the expected text/JSON/image.
- API key copy: reveal off, click copy, confirm reveal does NOT toggle on as a side-effect.
- Settings → theme → System; flip the OS to Dark/Light from System Settings; the app theme follows live without a reload.
- Settings → theme → Dark; flip the OS to Light; app remains Dark (no zombie listener).
- Open the empty terminal drawer; confirm the placeholder copy reads as expected.
- Hover a `/Users/...` path inside a code block in transcript; click → existing IPC openPath fires (regression check).
- Hover a `C:\Users\...` path in a code block (paste a fixture into a chat) → `data-file-path` attribute present after § 4.1 lands.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Image clipboard regresses because the new `copyImage` is mistakenly routed through `navigator.clipboard.write` | Med | High | § 11.3 dedicated integration test; doc note in `clipboard.service.ts` warning against it; reviewer checklist item. |
| Async clipboard rejection silently dropped (window focus loss, permission denied) | Med | Med | `ClipboardCopyResult` is structured failure; service catches all and returns `{ ok: false, reason }`. Sites that ignore the return value still behave like today. |
| `matchMedia` listener leak in tests | Med | Low | `_resetForTesting()` removes listener; spec asserts `removeEventListener` is called. CI runs vitest in single-worker mode (per existing config) so leaked listeners surface as warnings. |
| Existing transient "Copied" UI per call site disappears in the refactor | Low | Med | Migration table § 9 explicitly notes which sites pass `silent: true`. PR review checklist includes "transient UI preserved or intentionally removed". |
| Adding Windows / UNC / relative path detection causes false-positive open-file attempts | Low | Low | The renderer-side click handler already swallows `openPath` failures; main-process `openPath` returns `{ success: false, error }` instead of throwing. Worst case: a click does nothing. |
| Link-detection regex performance regresses on large transcripts | Low | Low | `maxLength` default 65_536 hard-cap; unit perf assertion in `link-detection.spec.ts` (e.g. < 10 ms on a 32 KiB sample). |
| API key copy site silently loses the reveal-mask UX during migration | Low | High | Locked Decision #4; explicit Migration Table note (row 9); spec test asserts `toggleKeyReveal` is not called from inside the new copy flow. |
| Future `CLIPBOARD_TOAST` provider double-renders on sites that already show local UI | Low | Low | `silent: true` opt-out documented and applied to the two sites that already render their own UI (rows 2, 3, 9). |
| Wave 4b discovers the IPC contract here is wrong | Low | Med | Contract was drafted from existing `node-pty` integrations in similar Electron apps and reviewed against AGENTS.md packaging gotchas. Wave 4b is allowed to amend the contract; the type lives in `src/shared/types/terminal.types.ts` (not yet a contracts schema), so the cost of revision is low. |
| Terminal drawer empty shell becomes "always-on" UI debt that confuses users | Low | Low | Drawer is not wired into any host in Wave 4 — it only ships as a component file + spec. Wave 4b decides the host. |

---

## 13. Non-goals

- No actual `node-pty` / `xterm` integration in Wave 4. (See § 10.)
- No notification / toast service in Wave 4 — only an injection token contract. The actual toast UI is Wave 6 territory (or whenever a notification surface lands; see Wave 1's § 7.3 for the same deferral).
- No saturating `link-detection.ts` adoption across all renderer surfaces. Wave 4 covers `markdown.service` and the click-classifier hook in `output-stream`; Wave 6 expands.
- No URL/error-trace HTML emission from `markdown.service`. Wave 4 adds the detection plumbing only.
- No `@contracts/schemas/*` subpath in Wave 4 (saves the four-place alias-sync; Wave 4b pays it).
- No changes to `image:copy-to-clipboard` or `image:context-menu` Electron IPC handlers. Wave 4 is a renderer-only wave for clipboard.

---

## 14. File-by-file change inventory

### Created

| Path | Purpose |
|---|---|
| `src/renderer/app/core/services/clipboard.service.ts` | `ClipboardService` interface + `ClipboardServiceImpl` |
| `src/renderer/app/core/services/clipboard.service.spec.ts` | Service unit tests |
| `src/renderer/app/core/services/clipboard-toast.token.ts` | `CLIPBOARD_TOAST` injection token |
| `src/shared/utils/link-detection.ts` | `detectLinks` pure-function utility |
| `src/shared/utils/link-detection.spec.ts` | Detection unit tests |
| `src/shared/types/terminal.types.ts` | `TerminalSession`, `TerminalSpawnOptions`, `TerminalLifecycleEvent`, `TerminalSessionId` |
| `src/renderer/app/core/services/terminal-session.service.ts` | `TerminalSession` token + `TerminalSessionStub` |
| `src/renderer/app/features/terminal-drawer/terminal-drawer.component.ts` | UI shell with empty state |
| `src/renderer/app/features/terminal-drawer/terminal-drawer.component.spec.ts` | Empty-state render test |

### Modified

| Path | Change |
|---|---|
| `src/renderer/app/core/services/markdown.service.ts` | Inject `ClipboardService`; replace `navigator.clipboard.writeText` (line 241); replace inline file-path regex (lines 76–77) with `detectLinks`. |
| `src/renderer/app/features/instance-detail/output-stream.component.ts` | Inject `ClipboardService`; replace lines 608–609 + 703; add `classifyLinkTarget` hook; widen click handler stub for future `data-link-kind` attributes (no rendering changes yet). |
| `src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts` | Inject `ClipboardService`; replace line 492. |
| `src/renderer/app/features/instance-list/instance-list.component.ts` | Inject `ClipboardService`; replace line 712. |
| `src/renderer/app/features/thinking/components/extended-thinking-panel.component.ts` | Inject `ClipboardService`; replace line 569. |
| `src/renderer/app/features/codebase/search-results.component.ts` | Inject `ClipboardService`; replace line 401. |
| `src/renderer/app/features/rlm/rlm-context-browser.component.ts` | Inject `ClipboardService`; replace line 537. |
| `src/renderer/app/features/verification/config/api-key-manager.component.ts` | Inject `ClipboardService`; replace line 801 with `silent: true` per Locked Decision #4. |
| `src/renderer/app/features/verification/results/export-panel.component.ts` | Inject `ClipboardService`; replace line 717 with `copyText(generateExport())` to preserve selected-format copy behavior. |
| `src/renderer/app/features/verification/results/verification-results.component.ts` | Inject `ClipboardService`; replace lines 198–199. |
| `src/renderer/app/core/state/settings.store.ts` | Add `_systemThemeMql`, `_onSystemThemeChange`, `_attachSystemThemeListener`, `_detachSystemThemeListener`; modify `applyTheme`; extend `destroy()`; add `_resetForTesting()`. |
| `src/renderer/app/shared/components/message-attachments/message-attachments.component.ts` | Optional follow-up: extract `toClipboardCompatibleDataUrl` into a shared util and call it from `ClipboardService.copyImage`. The component's own usage stays. |
| `src/renderer/app/core/services/markdown.service.spec.ts` | Replace `navigator.clipboard.writeText` mock with `ClipboardService` provider override. |
| `src/renderer/app/features/verification/results/export-panel.component.spec.ts` | Same. |
| `src/renderer/app/features/verification/results/verification-results.component.spec.ts` | Same. |

### Removed

None. Backwards compat is preserved everywhere.

---

## 15. Acceptance criteria

The wave is shippable when **all** of the following hold:

1. `npx tsc --noEmit` passes.
2. `npx tsc --noEmit -p tsconfig.spec.json` passes.
3. `npm run lint` passes with no new warnings.
4. New unit specs (§ 11.1) pass; existing markdown / verification specs still pass after the test-seam migration (§ 11.2).
5. `grep -rn "navigator.clipboard.writeText" src/renderer/app/` returns zero hits in feature/component code (the only allowed caller is `ClipboardServiceImpl`).
6. Image clipboard integration test (§ 11.3) passes: `image:copy-to-clipboard` IPC is invoked with a PNG/JPEG data URL.
7. `SettingsStore` theme listener: setting `system` attaches; switching to explicit theme detaches; switching back re-attaches; `_resetForTesting()` cleans up.
8. `markdown.service.ts` codespan path detection now matches Unix, Windows, UNC, and relative paths (verified by spec fixtures); existing `data-file-path` click flow still opens via IPC.
9. `terminal-drawer.component` renders the placeholder; spec asserts the empty-state copy.
10. The packaged DMG starts (smoke run) — no native rebuild was required, since Wave 4 adds no native deps.

---

## 16. Follow-ups for downstream waves

These are flagged here so subsequent specs reuse the foundation cleanly:

- **Wave 4b** (or absorbed into Wave 6+): full terminal drawer — `node-pty`, `xterm`, real `TerminalSessionImpl`, main-process `TerminalManager`, `terminal.schemas.ts` + four-place alias sync, drawer host wiring, tabs/split panes/per-instance binding. The `link-detection.ts` utility from this wave is the natural fit for terminal output rendering.
- **Wave 6** (Doctor / diagnostics / artifacts):
  - Adopt `link-detection` in diagnostics, log views, and child-diagnostic panels.
  - Adopt `link-detection` for error-trace rendering (the click-classifier hook from § 4.2 is ready).
  - Optional: ship a notification service that registers a `CLIPBOARD_TOAST` provider; existing `ClipboardService` consumers automatically get toasts without code changes.
- **Cleanup pass after Wave 4b**: once `TerminalSessionImpl` lands, remove the stub's synthetic error and update `terminal-drawer.component.spec.ts` to mount the real session.

---

## Appendix A — Cross-link with parent design

This child design implements the following items from the parent design's **Track D — Operator Reliability And Local Tooling** section:

- "Shared renderer clipboard service with success/error state, fallback messaging, and optional toast integration" → § 1, § 2, § 7
- "Live `matchMedia('(prefers-color-scheme: dark)')` listener with cleanup in `SettingsStore`" → § 5
- "Shared link detection utility for transcript, terminal, logs, and diagnostics" → § 1.4, § 3, § 4 (pilot adoption only)
- "Terminal drawer as a larger feature: named tabs, split panes, link detection, and project/instance working directory defaults" → § 1.5, § 1.6, § 8, § 10 (boundary only; full feature deferred)

It does **not** implement (deferred to Wave 6 or Wave 4b):

- Doctor entrypoint and CLI update pill → Wave 6
- Config/command/skill diagnostics report → Wave 6
- Local operator artifact JSONL/bundle export → Wave 6
- Saturating link-detection adoption beyond the markdown pilot → Wave 6
- Real `node-pty`-backed terminal sessions → Wave 4b

## Appendix B — Cross-link with parent plan

This child design provides the architectural detail for **Wave 4** of the parent plan. Each task in the parent plan's Wave 4 section maps to:

| Parent plan task | This spec § |
|---|---|
| Add a renderer `ClipboardService` for text, JSON, and image-copy status | § 1.1, § 1.2, § 2 |
| Replace direct `navigator.clipboard.writeText` calls with the service | § 9 |
| Add a shared copy success/error UI contract | § 1.3 (token); § 2.1 (resolution); future toast service is Wave 6 |
| Add a live `matchMedia('(prefers-color-scheme: dark)')` listener with cleanup when theme is `system` | § 5 |
| Extract link detection for file paths, URLs, and command output into a shared utility | § 1.4, § 3, § 4 |
| Scope terminal drawer requirements: tabs, split panes, working directory defaults, transcript link detection, lifecycle cleanup | § 1.5, § 1.6, § 8, § 10 (scoped, full implementation deferred to 4b) |
| Implement terminal drawer only after the service boundary is clear | § 10 (boundary only — implementation explicitly out of scope) |
