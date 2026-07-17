/**
 * Target-app persistence sentinel (reliability hardening, 2026-07-17).
 *
 * The gateway used to report a mutation as `succeeded` when the CDP dispatch
 * succeeded — even while the target SPA was showing "You got disconnected" /
 * "Changes failed to save" and silently rejecting every XHR save (observed
 * live on Google Ads: an hour of form entry rolled back with no error).
 *
 * After every app-state mutation on a shared existing tab, this module scans
 * the page's alert surfaces for the app's OWN failure signals via the
 * extension `evaluate` command with a fixed, hardcoded expression (never
 * caller input), and classifies the target as ok / save_failed /
 * session_stale. It also gates the FIRST write after a channel disconnect on
 * a fresh scan, so writes are refused into a stale in-page session instead of
 * fired blind.
 *
 * Privacy: the scan returns only which built-in pattern matched — never page
 * text, values, or URLs.
 */

import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserExtensionSendCommandRequest } from './browser-extension-command-store';
import { browserExtensionQueueKeyForNode } from './browser-extension-command-store';

export type BrowserTargetPersistenceState =
  | 'ok'
  | 'save_failed'
  | 'session_stale'
  | 'unknown';

export interface BrowserTargetPersistenceScan {
  state: BrowserTargetPersistenceState;
  /** The built-in pattern that matched (never page text). */
  matchedPattern?: string;
  checkedAt: number;
}

export type BrowserSentinelSendCommand = (
  request: BrowserExtensionSendCommandRequest,
) => Promise<unknown>;

/** Commands that mutate the target APP's state (vs. browser/tab state). */
const APP_STATE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'click',
  'type',
  'fill_form',
  'select',
  'upload_file',
  'evaluate',
]);

export function isAppStateMutatingCommand(command: string): boolean {
  return APP_STATE_MUTATING_COMMANDS.has(command);
}

const SCAN_TIMEOUT_MS = 8_000;
const SCAN_EXECUTION_MS = 6_000;

/**
 * High-precision signals that the app's in-page session died. Keep these
 * specific — a false positive blocks writes until the caller reloads.
 */
const SESSION_STALE_PATTERNS: readonly string[] = [
  'you got disconnected',
  'you have been disconnected',
  'session expired',
  'your session has expired',
  'session has ended',
  'session timed out',
  'sign in again',
  'log in again',
  'you have been signed out',
  'you have been logged out',
];

/** High-precision signals that the app failed to persist changes. */
const SAVE_FAILED_PATTERNS: readonly string[] = [
  'changes failed to save',
  'failed to save',
  "couldn't save",
  'could not be saved',
  'could not save',
  'unable to save',
  'error saving',
  'your changes were not saved',
];

/**
 * Per-site additions keyed by origin substring. The generic sets already
 * cover the observed Google Ads banners; this hook exists so future
 * site-specific phrasings can be added without touching the scan logic.
 */
const ORIGIN_PATTERN_ADAPTERS: ReadonlyArray<{
  originIncludes: string;
  sessionStale?: readonly string[];
  saveFailed?: readonly string[];
}> = [
  {
    originIncludes: 'ads.google.com',
    saveFailed: ['changes may not be saved'],
  },
];

function patternsForOrigin(origin: string): {
  sessionStale: string[];
  saveFailed: string[];
} {
  const sessionStale = [...SESSION_STALE_PATTERNS];
  const saveFailed = [...SAVE_FAILED_PATTERNS];
  for (const adapter of ORIGIN_PATTERN_ADAPTERS) {
    if (origin.includes(adapter.originIncludes)) {
      sessionStale.push(...(adapter.sessionStale ?? []));
      saveFailed.push(...(adapter.saveFailed ?? []));
    }
  }
  return { sessionStale, saveFailed };
}

/**
 * Fixed scan expression: reads only alert-ish surfaces (role=alert/status,
 * aria-live regions, snackbar/toast/banner-ish class names) plus the document
 * title, lowercases the bounded text, and reports the first matching built-in
 * pattern. Session-stale wins over save-failed when both are present.
 */
export function buildPersistenceScanExpression(origin: string): string {
  const { sessionStale, saveFailed } = patternsForOrigin(origin);
  return `(() => {
  const stale = ${JSON.stringify(sessionStale)};
  const save = ${JSON.stringify(saveFailed)};
  const parts = [];
  const sel = '[role="alert"],[role="status"],[aria-live],[class*="snackbar" i],[class*="toast" i],[class*="banner" i],[class*="notification" i]';
  try {
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length && parts.length < 40; i++) {
      const el = nodes[i];
      if (!el.getClientRects().length) continue;
      const t = el.innerText || el.textContent || '';
      if (t && t.trim()) parts.push(t.slice(0, 500));
    }
  } catch (e) {}
  parts.push(document.title || '');
  const hay = parts.join('\\n').toLowerCase();
  for (let i = 0; i < stale.length; i++) {
    if (hay.includes(stale[i])) return { s: 'session_stale', m: stale[i] };
  }
  for (let i = 0; i < save.length; i++) {
    if (hay.includes(save[i])) return { s: 'save_failed', m: save[i] };
  }
  return { s: 'ok' };
})()`;
}

export interface BrowserTargetPersistenceSentinelOptions {
  now?: () => number;
}

export class BrowserTargetPersistenceSentinel {
  private static instance: BrowserTargetPersistenceSentinel | null = null;
  private readonly now: () => number;
  /** targetId → last time a scan of this target came back 'ok'. */
  private readonly lastOkByTarget = new Map<string, number>();

  constructor(options: BrowserTargetPersistenceSentinelOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  static getInstance(): BrowserTargetPersistenceSentinel {
    if (!this.instance) {
      this.instance = new BrowserTargetPersistenceSentinel();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Scan the target's alert surfaces for app-reported failure signals.
   * Degrades to `unknown` on any scan-infrastructure failure — the sentinel
   * must never block a write because the scan itself broke.
   */
  async scan(
    attachment: BrowserExistingTabAttachment,
    sendCommand: BrowserSentinelSendCommand,
  ): Promise<BrowserTargetPersistenceScan> {
    const checkedAt = this.now();
    try {
      const raw = await sendCommand({
        ...(attachment.nodeId
          ? { queueKey: browserExtensionQueueKeyForNode(attachment.nodeId) }
          : {}),
        command: 'evaluate',
        target: {
          profileId: attachment.profileId,
          targetId: attachment.targetId,
          tabId: attachment.tabId,
          windowId: attachment.windowId,
        },
        payload: {
          expression: buildPersistenceScanExpression(attachment.origin),
          awaitPromise: false,
        },
        timeoutMs: SCAN_TIMEOUT_MS,
        executionTimeoutMs: SCAN_EXECUTION_MS,
        undeliveredWaitMs: SCAN_TIMEOUT_MS,
      });
      const scan = normalizeScanResult(raw, checkedAt);
      if (scan.state === 'ok') {
        this.lastOkByTarget.set(attachment.targetId, checkedAt);
      }
      return scan;
    } catch {
      return { state: 'unknown', checkedAt };
    }
  }

  /**
   * True when the channel this attachment rides on has disconnected since the
   * target's last known-good scan — i.e. the in-page session may have been
   * invalidated and must be re-verified BEFORE the next write.
   */
  needsPreWriteCheck(
    attachment: BrowserExistingTabAttachment,
    lastChannelDisconnectAt: number | undefined,
  ): boolean {
    if (lastChannelDisconnectAt === undefined) {
      return false;
    }
    const lastOkAt = this.lastOkByTarget.get(attachment.targetId);
    return lastOkAt === undefined || lastOkAt < lastChannelDisconnectAt;
  }

  forgetTarget(targetId: string): void {
    this.lastOkByTarget.delete(targetId);
  }
}

function normalizeScanResult(
  raw: unknown,
  checkedAt: number,
): BrowserTargetPersistenceScan {
  // The extension's evaluate returns the expression value, possibly wrapped
  // in a { result } envelope depending on the driver path.
  const value = raw && typeof raw === 'object' && 'result' in (raw as Record<string, unknown>)
    ? (raw as Record<string, unknown>)['result']
    : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { state: 'unknown', checkedAt };
  }
  const record = value as Record<string, unknown>;
  const state = record['s'];
  if (state === 'ok') {
    return { state: 'ok', checkedAt };
  }
  if (state === 'save_failed' || state === 'session_stale') {
    const matched = record['m'];
    return {
      state,
      ...(typeof matched === 'string' ? { matchedPattern: matched.slice(0, 120) } : {}),
      checkedAt,
    };
  }
  return { state: 'unknown', checkedAt };
}

export function getBrowserTargetPersistenceSentinel(): BrowserTargetPersistenceSentinel {
  return BrowserTargetPersistenceSentinel.getInstance();
}

/** Error message (reason code + advice) for a write refused/failed by state. */
export function persistenceFailureError(
  state: 'save_failed' | 'session_stale',
  phase: 'pre_write' | 'post_write',
  matchedPattern: string | undefined,
): Error {
  const matched = matchedPattern ? ` — the page shows "${matchedPattern}"` : '';
  if (state === 'session_stale') {
    return new Error(
      `browser_target_session_stale (the tab's in-page session looks disconnected or expired${matched}; `
      + (phase === 'pre_write'
        ? 'this write was NOT executed. '
        : 'the write fired but the app has likely rejected it. ')
      + 'Reload the tab, re-verify login/state, then re-acquire and retry deliberately — do not blind-retry)',
    );
  }
  return new Error(
    `browser_target_save_rejected (the app reports it is failing to persist changes${matched}; `
    + (phase === 'pre_write'
      ? 'this write was NOT executed because earlier changes are already failing to save. '
      : 'the write fired in the DOM but the app is rejecting saves, so treat it as NOT persisted. ')
    + 'Reload the page, use browser.assert_persisted / browser.write_journal to see what actually '
    + 'persisted, and re-enter unsaved data — do not blind-retry)',
  );
}
