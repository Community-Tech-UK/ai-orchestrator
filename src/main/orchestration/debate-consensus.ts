/**
 * Pure consensus-analysis helpers for the debate coordinator.
 *
 * Split out of debate-coordinator.ts to keep the coordinator focused on
 * orchestrating debate rounds. These are stateless functions over debate data.
 */
import type {
  ActiveDebate,
  ConsensusAgreement,
  ConsensusAnalysis,
  ConsensusDisagreement,
  DebateContribution,
  DebateSessionRound,
} from '../../shared/types/debate.types';

export function calculateConsensus(contributions: DebateContribution[]): number {
  if (contributions.length <= 1) return 1.0;

  // Simple text similarity-based consensus
  let totalSimilarity = 0;
  let comparisons = 0;

  for (let i = 0; i < contributions.length; i++) {
    for (let j = i + 1; j < contributions.length; j++) {
      totalSimilarity += textSimilarity(contributions[i].content, contributions[j].content);
      comparisons++;
    }
  }

  return comparisons > 0 ? totalSimilarity / comparisons : 0;
}

export function analyzeConsensus(debate: ActiveDebate): ConsensusAnalysis {
  const lastRound = getFinalSubstantiveRound(debate);
  const positions = new Map(lastRound.contributions.map((contribution) => [
    contribution.agentId,
    contribution.content,
  ]));
  const agreements: ConsensusAgreement[] = lastRound.consensusScore >= debate.config.convergenceThreshold
    ? [{
        topic: 'Agents reached the configured convergence threshold',
        confidence: lastRound.consensusScore,
        supportingAgents: [...positions.keys()],
      }]
    : [];
  const disagreements: ConsensusDisagreement[] = positions.size > 1 && agreements.length === 0
    ? [{
        topic: 'Final agent positions require moderator resolution',
        positions,
        severity: lastRound.consensusScore < 0.5 ? 'high' : 'medium',
      }]
    : [];

  return {
    overallScore: lastRound.consensusScore,
    agreements,
    disagreements,
    undecided: [],
  };
}

export function getFinalSubstantiveRound(debate: ActiveDebate): DebateSessionRound {
  return [...debate.rounds].reverse().find((round) => round.type !== 'synthesis')
    ?? debate.rounds[debate.rounds.length - 1];
}

function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}
