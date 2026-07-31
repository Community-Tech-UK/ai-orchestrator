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
 *
 * `compare()` awaits every provider (`Promise.all`) and only ever returns a
 * fully-settled result — nothing is usable until the slowest provider
 * finishes. WS-B6's `CouncilRunService` (`council-run-service.ts`) is the
 * progressive sibling: same provider set, same one-shot invocation
 * (`invokeProviderOneShot` in `council-provider-invoke.ts`, extracted from
 * this file's old `runOne`), but each member resolves independently with
 * live progress, cancellation, and durable recovery.
 */

import type { CliType } from '../cli/cli-detection';
import { getLogger } from '../logging/logger';
import {
  DEFAULT_PROVIDER_INVOKE_DEPS,
  invokeProviderOneShot,
  type ProviderInvokeDeps,
} from './council-provider-invoke';

const logger = getLogger('MultiCompare');

/** Providers we know how to spawn as one-shots. Shared with the WS-B6 Council run engine. */
export const KNOWN_PROVIDERS: readonly CliType[] = ['claude', 'gemini', 'antigravity', 'copilot', 'codex', 'cursor'];

/** Hard cap on fan-out width to avoid spawning an unbounded number of CLIs. */
export const MAX_PROVIDERS = 8;

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

/** Re-exported so existing importers (and tests) keep working unchanged. */
export type MultiProviderCompareDeps = ProviderInvokeDeps;

const DEFAULT_DEPS: MultiProviderCompareDeps = DEFAULT_PROVIDER_INVOKE_DEPS;

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

  /** De-dupe while preserving order, keep only known providers, and bound the fan-out. */
  selectProviders(providers: string[]): string[] {
    const unique = [...new Set(providers)].filter((p) => KNOWN_PROVIDERS.includes(p as CliType));
    const selected = unique.slice(0, MAX_PROVIDERS);
    if (selected.length < unique.length) {
      logger.warn('Compare fan-out capped', { requested: unique.length, cap: MAX_PROVIDERS });
    }
    return selected;
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
    const selected = this.selectProviders(providers);

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
    const result = await invokeProviderOneShot(this.deps, provider, prompt, { workingDirectory });
    return { provider, ...result };
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
