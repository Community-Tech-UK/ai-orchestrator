/**
 * Council Run Service (WS-B6) — progressive Ask Council with synthesis.
 *
 * The synchronous `MultiProviderCompareService.compare()` awaits every
 * provider before returning anything. This service runs the SAME per-provider
 * one-shot invocation (`invokeProviderOneShot`) but resolves each member
 * independently: queued -> running -> succeeded|failed|cancelled, emitting a
 * `run-updated` event (the full run snapshot) after every transition so a
 * renderer can reveal the first answer while others are still running.
 *
 * Runs are persisted after every transition via `CouncilRunStore` so a
 * renderer reload or app restart can re-fetch the latest run and see
 * whichever members had already completed.
 *
 * Synthesis (`synthesizeRun`) routes the run's completed answers through
 * AIO's existing consensus/debate machinery or a single chosen provider —
 * see council-synthesis.ts for the attributed prompt/attribution contract.
 */

import { EventEmitter } from 'events';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
import type {
  CouncilMember,
  CouncilRun,
  CouncilSynthesisMethod,
  CouncilSynthesisResult,
} from '@contracts/schemas/command';
import { getLogger } from '../logging/logger';
import { KNOWN_PROVIDERS, MAX_PROVIDERS } from './multi-provider-compare-service';
import {
  DEFAULT_PROVIDER_INVOKE_DEPS,
  invokeProviderOneShot,
  type ProviderInvokeDeps,
} from './council-provider-invoke';
import { CouncilRunStore, getCouncilRunStore } from './council-run-store';
import {
  buildAttribution,
  buildProviderSynthesisPrompt,
  describeAbsentMembers,
  succeededMembers,
} from './council-synthesis';
import { getConsensusCoordinator } from '../orchestration/consensus-coordinator';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import type { ConsensusProviderResponse } from '../orchestration/consensus.types';
import type { DebateContribution } from '../../shared/types/debate.types';

const logger = getLogger('CouncilRunService');

export interface CouncilRunStoreLike {
  getRun(runId: string): CouncilRun | null;
  getLatest(): CouncilRun | null;
  saveRun(run: CouncilRun): void;
  loadAll(): CouncilRun[];
}

export interface CouncilSynthesisDeps {
  consensusSynthesize(responses: ConsensusProviderResponse[]): { consensus: string };
  debateSynthesize(
    query: string,
    contributions: DebateContribution[],
    context?: string,
  ): Promise<{ synthesis: string }>;
  invokeProvider(
    provider: string,
    prompt: string,
    workingDirectory?: string,
  ): Promise<{ ok: boolean; answer?: string; error?: string }>;
}

export interface CouncilRunServiceDeps {
  invoke: ProviderInvokeDeps;
  store: CouncilRunStoreLike;
  synthesis: CouncilSynthesisDeps;
}

const DEFAULT_SYNTHESIS_DEPS: CouncilSynthesisDeps = {
  consensusSynthesize: (responses) => getConsensusCoordinator().synthesizeFromResponses(responses),
  debateSynthesize: (query, contributions, context) =>
    getDebateCoordinator().synthesizeContributions(query, contributions, context),
  invokeProvider: async (provider, prompt, workingDirectory) => {
    const result = await invokeProviderOneShot(DEFAULT_PROVIDER_INVOKE_DEPS, provider, prompt, { workingDirectory });
    return result;
  },
};

export class CouncilRunService extends EventEmitter {
  private readonly deps: CouncilRunServiceDeps;
  private readonly runs = new Map<string, CouncilRun>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly liveAdapters = new Map<string, Map<string, CliAdapter>>();

  constructor(deps: Partial<CouncilRunServiceDeps> = {}) {
    super();
    this.deps = {
      invoke: deps.invoke ?? DEFAULT_PROVIDER_INVOKE_DEPS,
      store: deps.store ?? getCouncilRunStore(),
      synthesis: deps.synthesis ?? DEFAULT_SYNTHESIS_DEPS,
    };
    for (const run of this.deps.store.loadAll()) {
      this.runs.set(run.id, run);
    }
  }

  /** Start a progressive run: returns immediately with all members queued. */
  startRun(prompt: string, providers: string[], options: { workingDirectory?: string } = {}): CouncilRun {
    const trimmed = (prompt ?? '').trim();
    if (!trimmed) {
      throw new Error('Prompt is required');
    }
    const selected = [...new Set(providers)]
      .filter((p) => KNOWN_PROVIDERS.includes(p as CliType))
      .slice(0, MAX_PROVIDERS);
    if (selected.length === 0) {
      throw new Error('At least one known provider is required');
    }

    const run: CouncilRun = {
      id: `council-${this.deps.invoke.now()}-${Math.random().toString(36).slice(2, 9)}`,
      prompt: trimmed,
      workingDirectory: options.workingDirectory,
      createdAt: this.deps.invoke.now(),
      members: selected.map((provider) => ({ provider, status: 'queued' as const })),
      cancelled: false,
    };
    this.putRun(run);

    const abort = new AbortController();
    this.abortControllers.set(run.id, abort);
    this.liveAdapters.set(run.id, new Map());

    for (const provider of selected) {
      void this.runMember(run.id, provider, abort).catch((error) => {
        logger.error('Council member run crashed', error instanceof Error ? error : undefined, {
          runId: run.id,
          provider,
        });
      });
    }

    return run;
  }

  /** Specific run by id, or (with no id) the most recently started run — used to rehydrate after reload/restart. */
  getRun(runId?: string): CouncilRun | null {
    if (runId) {
      return this.runs.get(runId) ?? this.deps.store.getRun(runId) ?? null;
    }
    const latestInMemory = [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
    return latestInMemory ?? this.deps.store.getLatest() ?? null;
  }

  /** Terminates any in-flight member calls and marks queued/running members cancelled. Idempotent. */
  cancelRun(runId: string): CouncilRun {
    const run = this.mustGetRun(runId);
    if (run.cancelled) return run;

    this.abortControllers.get(runId)?.abort('cancelled by user');
    const adapters = this.liveAdapters.get(runId);
    if (adapters) {
      for (const adapter of adapters.values()) {
        void adapter.terminate(false).catch(() => { /* best-effort teardown */ });
      }
      adapters.clear();
    }

    const members = run.members.map((m): CouncilMember =>
      m.status === 'queued' || m.status === 'running' ? { ...m, status: 'cancelled' } : m,
    );
    const updated: CouncilRun = { ...run, cancelled: true, members };
    this.putRun(updated);
    return updated;
  }

  /** Synthesize the run's completed answers via consensus, debate, or a single chosen provider. */
  async synthesizeRun(runId: string, method: CouncilSynthesisMethod): Promise<CouncilRun> {
    const run = this.mustGetRun(runId);
    const succeeded = succeededMembers(run.members);
    if (succeeded.length < 2) {
      throw new Error('Synthesis needs at least 2 council members with a completed answer');
    }

    const attribution = buildAttribution(run.members);
    let synthesis: CouncilSynthesisResult;
    try {
      const text = await this.runSynthesisMethod(run, method, succeeded);
      synthesis = { method, text, attribution, generatedAt: this.deps.invoke.now() };
    } catch (error) {
      synthesis = {
        method,
        text: '',
        attribution,
        generatedAt: this.deps.invoke.now(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const updated: CouncilRun = { ...run, synthesis };
    this.putRun(updated);
    return updated;
  }

  private async runMember(runId: string, provider: string, abort: AbortController): Promise<void> {
    if (abort.signal.aborted) return;
    this.patchMember(runId, provider, { status: 'running', startedAt: this.deps.invoke.now() });

    const run = this.runs.get(runId);
    const result = await invokeProviderOneShot(this.deps.invoke, provider, run?.prompt ?? '', {
      workingDirectory: run?.workingDirectory,
      signal: abort.signal,
      onAdapterCreated: (adapter) => this.liveAdapters.get(runId)?.set(provider, adapter),
    });
    this.liveAdapters.get(runId)?.delete(provider);

    if (abort.signal.aborted) {
      this.patchMember(runId, provider, { status: 'cancelled', durationMs: result.durationMs });
      return;
    }
    if (result.ok) {
      this.patchMember(runId, provider, {
        status: 'succeeded',
        model: result.model,
        answer: result.answer,
        durationMs: result.durationMs,
      });
    } else {
      this.patchMember(runId, provider, {
        status: 'failed',
        model: result.model,
        error: result.error,
        durationMs: result.durationMs,
      });
    }
  }

  private async runSynthesisMethod(
    run: CouncilRun,
    method: CouncilSynthesisMethod,
    succeeded: CouncilMember[],
  ): Promise<string> {
    if (method === 'consensus') {
      const responses: ConsensusProviderResponse[] = run.members.map((m) => ({
        provider: m.provider,
        model: m.model,
        content: m.answer ?? '',
        success: m.status === 'succeeded' && !!m.answer,
        error: m.error,
        durationMs: m.durationMs ?? 0,
      }));
      return this.deps.synthesis.consensusSynthesize(responses).consensus;
    }

    if (method === 'debate') {
      const contributions: DebateContribution[] = succeeded.map((m) => ({
        agentId: m.provider,
        content: m.answer ?? '',
        confidence: 1,
        reasoning: 'Ask Council answer',
      }));
      const absentLine = describeAbsentMembers(run.members);
      const context = absentLine
        ? `Council members with no answer (excluded from synthesis): ${absentLine}.`
        : undefined;
      const { synthesis } = await this.deps.synthesis.debateSynthesize(run.prompt, contributions, context);
      return synthesis;
    }

    // { providerId }: route the attributed synthesis prompt through this compare service's own invocation path.
    const prompt = buildProviderSynthesisPrompt(run.prompt, run.members);
    const result = await this.deps.synthesis.invokeProvider(method.providerId, prompt, run.workingDirectory);
    if (!result.ok || !result.answer) {
      throw new Error(result.error ?? `Provider ${method.providerId} returned no answer`);
    }
    return result.answer;
  }

  private patchMember(runId: string, provider: string, patch: Partial<CouncilMember>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const members = run.members.map((m) => (m.provider === provider ? { ...m, ...patch } : m));
    this.putRun({ ...run, members });
  }

  private putRun(run: CouncilRun): void {
    this.runs.set(run.id, run);
    this.deps.store.saveRun(run);
    this.emit('run-updated', run);
  }

  private mustGetRun(runId: string): CouncilRun {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Unknown council run: ${runId}`);
    return run;
  }
}

let singleton: CouncilRunService | null = null;

export function getCouncilRunService(): CouncilRunService {
  singleton ??= new CouncilRunService();
  return singleton;
}

export function _resetCouncilRunServiceForTesting(): void {
  singleton = null;
  CouncilRunStore._resetForTesting();
}
