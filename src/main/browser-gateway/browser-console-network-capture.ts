import {
  redactBrowserText,
  redactBrowserUrl,
  redactHeaders,
} from './browser-redaction';

/**
 * Structured console entry read from an extension-driven (shared Chrome) tab.
 * `stack` is present for uncaught exceptions / rejections so an error can be
 * pinned to `file:line` without a screenshot (see the console-read prompt, req
 * #3). Shapes stay compatible with the managed-profile `BrowserConsoleEntry`
 * while adding the richer fields the extension capture provides.
 */
export interface BrowserCapturedConsoleEntry {
  /** 'error' | 'warn' | other console level. */
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  stack?: string;
  /** Monotonic per-tab sequence — lets a caller poll for only-new entries. */
  seq?: number;
  timestamp: number;
}

export interface BrowserCapturedNetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  /** Present when the request failed (network error, abort, resource error). */
  failureText?: string;
  durationMs?: number;
  seq?: number;
  timestamp: number;
}

/**
 * Distinct capability-error reasons. These must NEVER be reported as the generic
 * `profile_target_or_url_not_found` (console-read prompt, req #4): that reads as
 * "wrong ids" and sends the caller into a pointless retry / re-share loop, which
 * is exactly the failure this work fixes.
 */
export const CONSOLE_CAPTURE_UNSUPPORTED_REASON = 'console_capture_unsupported_for_driver';
export const NETWORK_CAPTURE_UNSUPPORTED_REASON = 'network_capture_unsupported_for_driver';

const MAX_ENTRIES = 200;
const MAX_TEXT_LENGTH = 4_000;
const MAX_STACK_LENGTH = 4_000;

/**
 * An older extension / bridge that predates the capture commands rejects them
 * from its `default:` switch arm ("Unsupported browser command: …"). Detect that
 * so the gateway can surface a capability error rather than a raw command
 * failure or, worse, a misleading not-found.
 */
export function isUnsupportedCaptureCommandError(message: string): boolean {
  return /unsupported browser command/i.test(message);
}

function clampText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The extension command returns `{ kind, installed, entries: [...] }`. Pull the
 * raw entries array out of whatever shape came back (tolerating a bare array or
 * a missing/legacy field) without throwing.
 */
export function extractCapturedEntries(result: unknown): unknown[] {
  if (Array.isArray(result)) {
    return result;
  }
  if (result && typeof result === 'object') {
    const entries = (result as Record<string, unknown>)['entries'];
    if (Array.isArray(entries)) {
      return entries;
    }
  }
  return [];
}

/** True when the capture buffer reported itself as not installed on the tab. */
export function captureReportedNotInstalled(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      (result as Record<string, unknown>)['installed'] === false,
  );
}

/**
 * Normalize + redact raw console capture entries from the extension. Redaction
 * runs here (not just in-page) so a compromised/limited page script cannot leak
 * secrets past the gateway boundary — the same defense-in-depth the managed
 * driver applies.
 */
export function normalizeCapturedConsoleEntries(result: unknown): BrowserCapturedConsoleEntry[] {
  return extractCapturedEntries(result)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .slice(-MAX_ENTRIES)
    .map((entry) => {
      const location = entry['location'];
      const normalized: BrowserCapturedConsoleEntry = {
        type: typeof entry['type'] === 'string' ? entry['type'] : 'log',
        text: redactBrowserText(clampText(entry['text'], MAX_TEXT_LENGTH)),
        timestamp: asFiniteNumber(entry['timestamp']) ?? 0,
      };
      if (location && typeof location === 'object' && !Array.isArray(location)) {
        const loc = location as Record<string, unknown>;
        const url = typeof loc['url'] === 'string' ? redactBrowserUrl(loc['url']) : undefined;
        const lineNumber = asFiniteNumber(loc['lineNumber']);
        const columnNumber = asFiniteNumber(loc['columnNumber']);
        if (url !== undefined || lineNumber !== undefined || columnNumber !== undefined) {
          normalized.location = {
            ...(url !== undefined ? { url } : {}),
            ...(lineNumber !== undefined ? { lineNumber } : {}),
            ...(columnNumber !== undefined ? { columnNumber } : {}),
          };
        }
      }
      if (typeof entry['stack'] === 'string' && entry['stack']) {
        normalized.stack = redactBrowserText(clampText(entry['stack'], MAX_STACK_LENGTH));
      }
      const seq = asFiniteNumber(entry['seq']);
      if (seq !== undefined) {
        normalized.seq = seq;
      }
      return normalized;
    });
}

/**
 * Normalize + redact raw network capture entries from the extension. URL query
 * params, credentials, and sensitive header names are stripped here.
 */
export function normalizeCapturedNetworkEntries(result: unknown): BrowserCapturedNetworkEntry[] {
  return extractCapturedEntries(result)
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .slice(-MAX_ENTRIES)
    .map((entry) => {
      const normalized: BrowserCapturedNetworkEntry = {
        url: typeof entry['url'] === 'string' ? redactBrowserUrl(entry['url']) : '',
        method: typeof entry['method'] === 'string' ? entry['method'].toUpperCase().slice(0, 16) : 'GET',
        resourceType: typeof entry['resourceType'] === 'string' ? entry['resourceType'] : 'other',
        timestamp: asFiniteNumber(entry['timestamp']) ?? 0,
      };
      const status = asFiniteNumber(entry['status']);
      if (status !== undefined) {
        normalized.status = status;
      }
      if (typeof entry['statusText'] === 'string' && entry['statusText']) {
        normalized.statusText = clampText(entry['statusText'], 256);
      }
      if (typeof entry['ok'] === 'boolean') {
        normalized.ok = entry['ok'];
      }
      if (typeof entry['failureText'] === 'string' && entry['failureText']) {
        normalized.failureText = redactBrowserText(clampText(entry['failureText'], MAX_TEXT_LENGTH));
      }
      const durationMs = asFiniteNumber(entry['durationMs']);
      if (durationMs !== undefined) {
        normalized.durationMs = durationMs;
      }
      const headers = entry['headers'];
      if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
        const stringHeaders = Object.fromEntries(
          Object.entries(headers as Record<string, unknown>)
            .filter(([, value]) => typeof value === 'string') as [string, string][],
        );
        if (Object.keys(stringHeaders).length > 0) {
          (normalized as BrowserCapturedNetworkEntry & { headers: Record<string, string> }).headers =
            redactHeaders(stringHeaders);
        }
      }
      const seq = asFiniteNumber(entry['seq']);
      if (seq !== undefined) {
        normalized.seq = seq;
      }
      return normalized;
    });
}
