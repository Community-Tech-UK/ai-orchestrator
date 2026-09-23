/**
 * Early consensus ("AgentDropout") for CLI verification panels.
 *
 * Token/memory optimisation plan, Task 6 (retargeted 2026-09-23): the plan
 * aimed this at MultiVerifyCoordinator, but the live Verification dashboard
 * route is `VERIFICATION_START_CLI` -> CliVerificationCoordinator, so the logic
 * lives here and that coordinator calls it.
 *
 * Opt-in only (`DEFAULT_EARLY_TERMINATION.enabled === false`). When enabled,
 * the panel is watched as each agent settles; once the settled, non-error
 * answers agree strongly enough, the still-pending agents are terminated and
 * reported as dropped. Their partial spend is still counted by the caller —
 * nothing here estimates or reports "tokens saved".
 */

import type { ProviderAdapter } from '@sdk/provider-adapter';
import { getLogger } from '../logging/logger';
import type {
  AgentResponse,
  EarlyConsensusSummary,
  EarlyTerminationConfig,
} from '../../shared/types/verification.types';
import { getEmbeddingService } from './embedding-service';

export type { EarlyTerminationConfig } from '../../shared/types/verification.types';

const logger = getLogger('VerificationEarlyConsensus');

/** Error string stamped on an agent response that was terminated after early consensus. */
export const EARLY_CONSENSUS_DROP_ERROR = 'dropped: early consensus';

export const DEFAULT_EARLY_TERMINATION: EarlyTerminationConfig = {
  enabled: false,
  consensusThreshold: 0.8,
  minAgentsForConsensus: 2,
};

/** The two embedding-service methods consensus needs; injectable for tests. */
export interface ConsensusEmbedder {
  getEmbeddings(texts: string[]): Promise<number[][]>;
  cosineSimilarity(a: number[], b: number[]): number;
}

export interface EarlyConsensusCheck {
  reached: boolean;
  /** Mean pairwise cosine similarity of the considered answers (0 when not computed). */
  similarity: number;
  /** Number of answers that were compared. */
  consideredAgents: number;
}

/**
 * Sections every verification agent is told to emit (see the CLI verification
 * and debate prompts). Their headings, category tags and confidence scaffolding
 * are shared across all answers, so leaving them in inflates similarity and can
 * fake a consensus. Whole sections are removed; an answer that is nothing but
 * these sections is left empty and is not counted toward consensus.
 */
const BOILERPLATE_SECTION_NAMES = ['key points', 'overall confidence', 'reasoning summary'];

const HEADING_PATTERN = /^\s*(?:#{1,6}\s+(.+?)\s*#*\s*|\*\*(.+?)\*\*\s*:?\s*)$/;

export function stripVerificationBoilerplate(text: string): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      const name = (heading[1] ?? heading[2] ?? '').replace(/[:*]/g, '').trim().toLowerCase();
      skipping = BOILERPLATE_SECTION_NAMES.includes(name);
      if (skipping) continue;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').trim();
}

function meanPairwiseSimilarity(embeddings: number[][], embed: ConsensusEmbedder): number {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      total += embed.cosineSimilarity(embeddings[i], embeddings[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 0 : total / pairs;
}

/**
 * Decide whether the answers collected so far already agree.
 *
 * Only successful answers with substantive (non-boilerplate) text count. At
 * least two answers are always required, whatever `minAgentsForConsensus` says,
 * because a single answer cannot agree with anything.
 */
export async function checkEarlyConsensus(
  responses: readonly AgentResponse[],
  cfg: EarlyTerminationConfig | undefined,
  embed: ConsensusEmbedder = getEmbeddingService(),
): Promise<EarlyConsensusCheck> {
  const notReached = (consideredAgents: number): EarlyConsensusCheck => ({
    reached: false,
    similarity: 0,
    consideredAgents,
  });
  if (!cfg?.enabled) return notReached(0);

  const texts = responses
    .filter((response) => !response.error)
    .map((response) => stripVerificationBoilerplate(response.response))
    .filter((text) => text.length > 0);
  if (texts.length < Math.max(2, cfg.minAgentsForConsensus)) return notReached(texts.length);

  // One call, so every vector shares the same (growing) TF-IDF vocabulary.
  const embeddings = await embed.getEmbeddings(texts);
  const similarity = meanPairwiseSimilarity(embeddings, embed);
  return { reached: similarity >= cfg.consensusThreshold, similarity, consideredAgents: texts.length };
}

export interface EarlyConsensusRaceResult {
  /** Every agent's response, in the original agent order. */
  responses: AgentResponse[];
  earlyConsensus?: EarlyConsensusSummary;
}

/**
 * Await every agent, checking for consensus each time one settles.
 *
 * When disabled this is exactly `Promise.all`. When consensus is reached while
 * agents are still running, `onConsensus` is called once with their indexes;
 * the caller is responsible for ending those agents so their promises settle
 * (with an `EARLY_CONSENSUS_DROP_ERROR` response). All promises are still
 * awaited, so no agent is left running unobserved.
 */
export async function raceWithEarlyConsensus(
  promises: readonly Promise<AgentResponse>[],
  cfg: EarlyTerminationConfig | undefined,
  onConsensus: (pendingIndexes: number[], check: EarlyConsensusCheck) => Promise<void> | void,
  embed?: ConsensusEmbedder,
): Promise<EarlyConsensusRaceResult> {
  if (!cfg?.enabled || promises.length < 2) {
    return { responses: await Promise.all(promises) };
  }

  const settled = new Map<number, AgentResponse>();
  const pendingIndexes = (): number[] => promises.map((_, index) => index).filter((index) => !settled.has(index));
  let summary: EarlyConsensusSummary | undefined;
  let checks: Promise<void> = Promise.resolve();

  const evaluate = async (): Promise<void> => {
    if (summary || pendingIndexes().length === 0) return;
    const check = await checkEarlyConsensus([...settled.values()], cfg, embed);
    // Agents may have settled while the embeddings were computed.
    const pending = pendingIndexes();
    if (!check.reached || pending.length === 0 || summary) return;
    summary = {
      similarity: check.similarity,
      threshold: cfg.consensusThreshold,
      consideredAgents: check.consideredAgents,
      droppedAgentIndexes: pending,
    };
    await onConsensus(pending, check);
  };

  promises.forEach((promise, index) => {
    promise.then(
      (response) => {
        settled.set(index, response);
        checks = checks.then(evaluate).catch((error: unknown) => {
          logger.warn('Early consensus check failed; waiting for every agent', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      () => undefined, // surfaced by Promise.all below
    );
  });

  // Each per-promise handler above was attached before Promise.all's, so by the
  // time it resolves every settle has queued its check; drain them.
  const responses = await Promise.all(promises);
  await checks;
  return { responses, ...(summary ? { earlyConsensus: summary } : {}) };
}

/** Mutable per-verification state the drop marks; the coordinator's ActiveSession. */
export interface EarlyDropSession {
  dropped?: Set<number>;
}

/**
 * Mark the pending agents as dropped, announce it, and force-terminate them.
 * Marking happens first so an `idle` status fired by the termination itself is
 * not mistaken for a completed answer. Does NOT set `cancelled`, which means a
 * user cancellation.
 */
export async function dropPendingAgents(
  session: EarlyDropSession,
  agents: readonly { provider: Pick<ProviderAdapter, 'terminate'> }[],
  pendingIndexes: readonly number[],
  announce: (payload: { droppedAgentIndexes: number[]; similarity: number; consideredAgents: number }) => void,
  check: EarlyConsensusCheck,
): Promise<void> {
  const dropped = session.dropped ?? new Set<number>();
  session.dropped = dropped;
  for (const index of pendingIndexes) dropped.add(index);
  announce({
    droppedAgentIndexes: [...pendingIndexes],
    similarity: check.similarity,
    consideredAgents: check.consideredAgents,
  });
  await Promise.allSettled(pendingIndexes.map(async (index) => {
    try {
      await agents[index]?.provider.terminate(false);
    } catch (error) {
      logger.warn('Failed to terminate agent dropped after early consensus', {
        index,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));
}
