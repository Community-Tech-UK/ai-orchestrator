/**
 * Multi-provider compare (backlog #11).
 *
 * The one orchestrator-only superpower a single CLI can't do: ask the SAME
 * prompt to N providers at once and diff the answers. Each provider runs as an
 * ephemeral one-shot (createAdapter + sendMessage — the same path magic-prompts
 * and auto-title use), so this needs no interactive instance and never touches
 * instance-manager.
 *
 * Provider/adapter plumbing is injected so the fan-out + error handling are
 * unit-testable without spawning real CLIs.
 */

import { resolveCliType, type CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { isCliAvailable, type CliType } from '../cli/cli-detection';
import { isProviderNotice } from '../cli/provider-notice';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';

const logger = getLogger('MultiCompare');

const COMPARE_TIMEOUT = 60_000;

/** Providers we know how to spawn as one-shots. */
const KNOWN_PROVIDERS: readonly CliType[] = ['claude', 'gemini', 'copilot', 'codex', 'cursor'];

/** Hard cap on fan-out width to avoid spawning an unbounded number of CLIs. */
const MAX_PROVIDERS = 8;

export interface CompareCell {
  provider: string;
  ok: boolean;
  model?: string;
  answer?: string;
  error?: string;
  durationMs: number;
}

export interface CompareResult {
  prompt: string;
  results: CompareCell[];
}

export interface MultiProviderCompareDeps {
  /** Resolve a SPECIFIC provider (no preference fallback). null if unavailable. */
  resolveProvider(provider: string): Promise<CliType | null>;
  createAdapter(cliType: CliType, options: UnifiedSpawnOptions): CliAdapter;
  /** Monotonic clock for durations. Injectable for deterministic tests. */
  now(): number;
}

type SendMessageAdapter = CliAdapter & {
  sendMessage: (message: CliMessage) => Promise<CliResponse>;
};

function hasSendMessage(adapter: CliAdapter): adapter is SendMessageAdapter {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

async function defaultResolveProvider(provider: string): Promise<CliType | null> {
  try {
    const info = await isCliAvailable(provider as CliType);
    if (info.installed) return await resolveCliType(provider as CliType);
  } catch {
    // treat as unavailable
  }
  return null;
}

const DEFAULT_DEPS: MultiProviderCompareDeps = {
  resolveProvider: defaultResolveProvider,
  createAdapter: (cliType, options) => getProviderRuntimeService().createAdapter({ cliType, options }),
  now: () => Date.now(),
};

export class MultiProviderCompareService {
  private readonly deps: MultiProviderCompareDeps;

  constructor(deps: Partial<MultiProviderCompareDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /** Which known providers are currently installed. */
  async listAvailableProviders(): Promise<string[]> {
    const checks = await Promise.all(
      KNOWN_PROVIDERS.map(async (p) => ({ p, type: await this.deps.resolveProvider(p) })),
    );
    return checks.filter((c) => c.type !== null).map((c) => c.p);
  }

  async compare(
    prompt: string,
    providers: string[],
    options: { workingDirectory?: string } = {},
  ): Promise<CompareResult> {
    const trimmed = (prompt ?? '').trim();
    if (!trimmed) {
      return { prompt: '', results: [] };
    }
    // De-dupe while preserving order, and bound the fan-out.
    const unique = [...new Set(providers)].filter((p) => KNOWN_PROVIDERS.includes(p as CliType));
    const selected = unique.slice(0, MAX_PROVIDERS);
    if (selected.length < unique.length) {
      logger.warn('Compare fan-out capped', { requested: unique.length, cap: MAX_PROVIDERS });
    }

    const results = await Promise.all(
      selected.map((provider) => this.runOne(trimmed, provider, options.workingDirectory)),
    );
    return { prompt: trimmed, results };
  }

  private async runOne(
    prompt: string,
    provider: string,
    workingDirectory?: string,
  ): Promise<CompareCell> {
    const started = this.deps.now();
    const elapsed = () => this.deps.now() - started;

    const cliType = await this.deps.resolveProvider(provider);
    if (!cliType) {
      return { provider, ok: false, error: 'Provider is not available', durationMs: elapsed() };
    }

    const model = resolveModelForTier('balanced', cliType);
    let adapter: CliAdapter;
    try {
      adapter = this.deps.createAdapter(cliType, {
        workingDirectory: workingDirectory ?? process.cwd(),
        model,
        yoloMode: false,
        timeout: COMPARE_TIMEOUT,
      });
    } catch (error) {
      return { provider, ok: false, model, error: this.msg(error), durationMs: elapsed() };
    }

    if (!hasSendMessage(adapter)) {
      return { provider, ok: false, model, error: 'Provider does not support one-shot prompts', durationMs: elapsed() };
    }

    try {
      const response = await adapter.sendMessage({ role: 'user', content: prompt });
      const raw = (response.content ?? '').trim();
      if (raw.length === 0) {
        return { provider, ok: false, model, error: 'Empty response', durationMs: elapsed() };
      }
      if (isProviderNotice(raw)) {
        return { provider, ok: false, model, error: 'Provider returned a status/limit notice', durationMs: elapsed() };
      }
      return { provider, ok: true, model, answer: raw, durationMs: elapsed() };
    } catch (error) {
      return { provider, ok: false, model, error: this.msg(error), durationMs: elapsed() };
    }
  }

  private msg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

let singleton: MultiProviderCompareService | null = null;

export function getMultiProviderCompareService(): MultiProviderCompareService {
  singleton ??= new MultiProviderCompareService();
  return singleton;
}

export function _resetMultiProviderCompareServiceForTesting(): void {
  singleton = null;
}
