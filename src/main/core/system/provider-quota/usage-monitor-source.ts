/**
 * UsageMonitorSource — optional interop with the standalone token-usage-monitor.
 *
 * Power users who run the full standalone monitor (the one with the mitmproxy)
 * get extras Harness's native pollers don't cover yet — notably Codex's real-time
 * WS deltas and Cursor. That monitor persists its merged view to
 * `~/.usage/state.json`. When that file is present *and fresh*, this source
 * reads it and exposes per-provider quota windows so Harness can layer those extras
 * on top of its own polling.
 *
 * Design rules (from the plan):
 *   • Pure enhancement — Harness must degrade cleanly when the file is absent,
 *     stale, or malformed. Every failure path returns `null`, never throws.
 *   • Precedence — the native poll is the source of truth; `state.json` only
 *     fills providers the native pollers don't cover. The {@link StateJsonProbe}
 *     wrapper enforces that by only consulting this source as a fallback.
 *
 * The on-disk schema is treated leniently because it is owned by a separate
 * tool. We accept either a top-level `providers` map or provider keys at the
 * root, and per-window `resets_at`/`resetsAt` and snake/camel field names.
 */

import { readFile as fsReadFile } from 'fs/promises';
import { stat as fsStat } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
  QuotaKind,
  QuotaUnit,
} from '../../../../shared/types/provider-quota.types';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('UsageMonitorSource');

/** Default staleness ceiling — older than this and we ignore the file. */
const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** Provider keys we'll accept from state.json. Mirrors token-usage-monitor. */
const KNOWN_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor'];

type FileReader = (filePath: string) => Promise<string>;
type FileStat = (filePath: string) => Promise<{ mtimeMs: number }>;

export interface UsageMonitorSourceOptions {
  /** Override the state file path. Defaults to `~/.usage/state.json`. */
  statePath?: string;
  /** Max age before the file is considered stale. Defaults to 5 min. */
  maxAgeMs?: number;
  /** Injected reader (tests). Defaults to fs/promises.readFile. */
  readFile?: FileReader;
  /** Injected stat (tests). Defaults to fs/promises.stat. */
  statFile?: FileStat;
  /** Clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/** Lenient per-window shape from the external tool. */
interface RawWindow {
  id?: string;
  label?: string;
  unit?: string;
  kind?: string;
  used?: number;
  used_percent?: number;
  usedPercent?: number;
  limit?: number;
  remaining?: number;
  reset_at?: number | string | null;
  resets_at?: number | string | null;
  resetsAt?: number | string | null;
}

interface RawProviderEntry {
  plan?: string;
  windows?: RawWindow[];
}

interface RawState {
  updated_at?: number | string;
  updatedAt?: number | string;
  providers?: Record<string, RawProviderEntry>;
  [key: string]: unknown;
}

export class UsageMonitorSource {
  private readonly statePath: string;
  private readonly maxAgeMs: number;
  private readonly readFile: FileReader;
  private readonly statFile: FileStat;
  private readonly now: () => number;

  constructor(opts: UsageMonitorSourceOptions = {}) {
    this.statePath = opts.statePath ?? path.join(os.homedir(), '.usage', 'state.json');
    this.maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.readFile = opts.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.statFile = opts.statFile ?? (async (p) => fsStat(p));
    this.now = opts.now ?? Date.now;
  }

  /** True when the file exists and is within the freshness window. */
  async isFresh(): Promise<boolean> {
    try {
      const { mtimeMs } = await this.statFile(this.statePath);
      return this.now() - mtimeMs <= this.maxAgeMs;
    } catch {
      return false;
    }
  }

  /**
   * Read and parse the whole state file. Returns a map of provider → snapshot,
   * or `null` when the file is absent / stale / malformed.
   */
  async read(): Promise<Map<ProviderId, ProviderQuotaSnapshot> | null> {
    if (!(await this.isFresh())) return null;

    let raw: string;
    try {
      raw = await this.readFile(this.statePath);
    } catch {
      return null;
    }

    let parsed: RawState;
    try {
      parsed = JSON.parse(raw) as RawState;
    } catch {
      logger.debug('~/.usage/state.json is not valid JSON — ignoring');
      return null;
    }

    const takenAt = coerceEpochMs(parsed.updated_at ?? parsed.updatedAt) ?? this.now();
    const providers = parsed.providers ?? (parsed as Record<string, RawProviderEntry>);

    const out = new Map<ProviderId, ProviderQuotaSnapshot>();
    for (const provider of KNOWN_PROVIDERS) {
      const entry = providers[provider];
      if (!entry || !Array.isArray(entry.windows)) continue;
      const windows = entry.windows
        .map((w) => normalizeWindow(provider, w))
        .filter((w): w is ProviderQuotaWindow => w !== null);
      if (windows.length === 0) continue;
      out.set(provider, {
        provider,
        takenAt,
        source: 'inferred',
        ok: true,
        plan: typeof entry.plan === 'string' ? entry.plan : undefined,
        windows,
      });
    }

    return out.size > 0 ? out : null;
  }

  /** Convenience: snapshot for a single provider, or null. */
  async readProvider(provider: ProviderId): Promise<ProviderQuotaSnapshot | null> {
    const all = await this.read();
    return all?.get(provider) ?? null;
  }
}

// ─── parsing helpers ───────────────────────────────────────────────────────

function normalizeWindow(provider: ProviderId, w: RawWindow): ProviderQuotaWindow | null {
  const percent = typeof w.used_percent === 'number'
    ? w.used_percent
    : typeof w.usedPercent === 'number'
      ? w.usedPercent
      : null;
  const hasNumericWindow = typeof w.used === 'number' && typeof w.limit === 'number';
  if (!hasNumericWindow && typeof percent !== 'number') return null;

  const used = hasNumericWindow ? w.used! : clampPct(percent!);
  const limit = hasNumericWindow ? w.limit! : 100;
  const remaining =
    typeof w.remaining === 'number'
      ? w.remaining
      : limit > 0
        ? limit - used
        : Number.NaN;
  return {
    kind: coerceKind(w.kind),
    id: typeof w.id === 'string' && w.id.length > 0 ? w.id : `${provider}.${slug(w.label)}`,
    label: typeof w.label === 'string' && w.label.length > 0 ? w.label : 'usage',
    unit: coerceUnit(w.unit),
    used,
    limit,
    remaining,
    resetsAt: coerceEpochMs(w.reset_at ?? w.resets_at ?? w.resetsAt),
  };
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function coerceKind(value: unknown): QuotaKind {
  const known: QuotaKind[] = ['rolling-window', 'calendar-period', 'rate-limit', 'context-window'];
  return typeof value === 'string' && (known as string[]).includes(value)
    ? (value as QuotaKind)
    : 'rolling-window';
}

function coerceUnit(value: unknown): QuotaUnit {
  const known: QuotaUnit[] = ['requests', 'messages', 'tokens', 'usd'];
  return typeof value === 'string' && (known as string[]).includes(value)
    ? (value as QuotaUnit)
    : 'requests';
}

/** Accept epoch seconds, epoch ms, or an ISO-8601 string. */
function coerceEpochMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Heuristic: < 1e12 is almost certainly seconds, not ms.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function slug(label: string | undefined): string {
  if (!label) return 'window';
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'window';
}
