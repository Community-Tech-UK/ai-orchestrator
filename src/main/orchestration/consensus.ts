/**
 * Consensus Manager
 * Multi-agent decision making with various consensus algorithms
 *
 * Supports multiple consensus mechanisms:
 * - Majority voting: Simple majority wins
 * - Supermajority: Requires threshold above 50%
 * - Weighted: Votes weighted by confidence or custom weights
 * - Ranked choice: Instant runoff voting
 * - Borda count: Ranked preference aggregation
 * - Approval: Multiple option approval
 * - Leader election: Select agent based on capabilities
 */

import { EventEmitter } from 'events';

export type ConsensusAlgorithm =
  | 'majority'
  | 'supermajority'
  | 'weighted'
  | 'ranked_choice'
  | 'borda_count'
  | 'approval'
  | 'leader_election';

export interface ConsensusConfig {
  algorithm: ConsensusAlgorithm;
  minimumParticipants: number;
  consensusThreshold: number; // 0-1, fraction needed for consensus
  timeoutMs: number;
  allowAbstention: boolean;
  weightByConfidence: boolean;
  requireUnanimity: boolean; // For critical decisions
  maxRounds: number; // For iterative consensus
}

export interface ConsensusOption {
  id: string;
  label: string;
  description?: string;
  proposedBy?: string;
}

export interface ConsensusProposal {
  id: string;
  topic: string;
  description: string;
  options: ConsensusOption[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  deadline?: number;
}

export interface ConsensusVote {
  voterId: string; // agentId
  proposalId: string;
  optionId: string | string[]; // Single for most, array for ranked choice
  weight: number; // For weighted voting
  confidence: number;
  reasoning?: string;
  timestamp: number;
}

export interface ConsensusResult {
  id: string;
  proposalId: string;
  algorithm: ConsensusAlgorithm;
  winner: ConsensusOption | null;
  votes: ConsensusVote[];
  tally: Map<string, number>;
  consensusReached: boolean;
  consensusStrength: number; // 0-1
  participationRate: number;
  rounds: number;
  duration: number;
  reasoning: string;
}

export interface LeaderElectionResult {
  leaderId: string;
  leaderScore: number;
  runnerUp?: string;
  electionMethod: string;
  participants: string[];
}

export interface ConsensusStats {
  totalProposals: number;
  consensusReached: number;
  consensusRate: number;
  avgConsensusStrength: number;
  avgParticipationRate: number;
  avgRounds: number;
  byAlgorithm: Map<ConsensusAlgorithm, {
    count: number;
    successRate: number;
  }>;
}

interface ProposalData {
  proposal: ConsensusProposal;
  votes: ConsensusVote[];
  closed: boolean;
  result?: ConsensusResult;
}

export class ConsensusManager extends EventEmitter {
  private static instance: ConsensusManager | null = null;
  private config: ConsensusConfig;
  private proposals: Map<string, ProposalData> = new Map();
  private stats: ConsensusStats;

  private defaultConfig: ConsensusConfig = {
    algorithm: 'majority',
    minimumParticipants: 2,
    consensusThreshold: 0.67, // 2/3 majority
    timeoutMs: 300000, // 5 minutes
    allowAbstention: true,
    weightByConfidence: true,
    requireUnanimity: false,
    maxRounds: 3,
  };

  static getInstance(): ConsensusManager {
    if (!this.instance) {
      this.instance = new ConsensusManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.stats = {
      totalProposals: 0,
      consensusReached: 0,
      consensusRate: 0,
      avgConsensusStrength: 0,
      avgParticipationRate: 0,
      avgRounds: 1,
      byAlgorithm: new Map(),
    };
  }

  // ============ Configuration ============

  configure(config: Partial<ConsensusConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', { config: this.config });
  }

  getConfig(): ConsensusConfig {
    return { ...this.config };
  }

  // ============ Proposal Management ============

  createProposal(
    topic: string,
    options: Omit<ConsensusOption, 'id'>[],
    description?: string
  ): ConsensusProposal {
    const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const proposal: ConsensusProposal = {
      id: proposalId,
      topic,
      description: description || topic,
      options: options.map((opt, idx) => ({
        ...opt,
        id: `option-${idx + 1}`,
      })),
      createdAt: Date.now(),
      deadline: this.config.timeoutMs > 0 ? Date.now() + this.config.timeoutMs : undefined,
    };

    this.proposals.set(proposalId, {
      proposal,
      votes: [],
      closed: false,
    });

    this.emit('proposal:created', { proposal });
    return proposal;
  }

  getProposal(proposalId: string): ConsensusProposal | undefined {
    return this.proposals.get(proposalId)?.proposal;
  }

  getActiveProposals(): ConsensusProposal[] {
    return Array.from(this.proposals.values())
      .filter(p => !p.closed)
      .map(p => p.proposal);
  }

  // ============ Voting ============

  submitVote(
    proposalId: string,
    vote: Omit<ConsensusVote, 'timestamp'>
  ): ConsensusVote {
    const proposalData = this.proposals.get(proposalId);

    if (!proposalData) {
      this.emit('vote:rejected', { proposalId, reason: 'Proposal not found' });
      throw new Error(`Proposal ${proposalId} not found`);
    }

    if (proposalData.closed) {
      this.emit('vote:rejected', { proposalId, reason: 'Proposal closed' });
      throw new Error(`Proposal ${proposalId} is closed`);
    }

    // Check deadline
    if (proposalData.proposal.deadline && Date.now() > proposalData.proposal.deadline) {
      this.closeProposal(proposalId);
      this.emit('vote:rejected', { proposalId, reason: 'Deadline passed' });
      throw new Error(`Proposal ${proposalId} deadline has passed`);
    }

    // Validate vote
    const optionIds = Array.isArray(vote.optionId) ? vote.optionId : [vote.optionId];
    for (const optionId of optionIds) {
      const validOption = proposalData.proposal.options.some(opt => opt.id === optionId);
      if (!validOption) {
        this.emit('vote:rejected', { proposalId, voterId: vote.voterId, reason: 'Invalid option' });
        throw new Error(`Invalid option ${optionId} for proposal ${proposalId}`);
      }
    }

    // Remove existing vote from same voter
    proposalData.votes = proposalData.votes.filter(v => v.voterId !== vote.voterId);

    const fullVote: ConsensusVote = {
      ...vote,
      timestamp: Date.now(),
    };

    proposalData.votes.push(fullVote);
    this.emit('vote:submitted', { proposalId, vote: fullVote });

    return fullVote;
  }

  submitRankedVote(
    proposalId: string,
    voterId: string,
    rankings: string[],
    confidence?: number
  ): ConsensusVote {
    const vote: Omit<ConsensusVote, 'timestamp'> = {
      voterId,
      proposalId,
      optionId: rankings,
      weight: 1.0,
      confidence: confidence ?? 0.8,
      reasoning: 'Ranked choice vote',
    };

    return this.submitVote(proposalId, vote);
  }

  // ============ Result Calculation ============

  calculateResult(proposalId: string): ConsensusResult {
    const proposalData = this.proposals.get(proposalId);

    if (!proposalData) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    const startTime = Date.now();
    let result: ConsensusResult;

    // Check minimum participation
    if (proposalData.votes.length < this.config.minimumParticipants) {
      result = this.createFailedResult(
        proposalId,
        proposalData.proposal,
        proposalData.votes,
        `Insufficient participation: ${proposalData.votes.length} < ${this.config.minimumParticipants}`,
        Date.now() - startTime
      );
      return result;
    }

    // Apply appropriate algorithm
    switch (this.config.algorithm) {
      case 'majority':
        result = this.runMajorityVoting(proposalData.proposal, proposalData.votes);
        break;
      case 'supermajority':
        result = this.runMajorityVoting(proposalData.proposal, proposalData.votes);
        break;
      case 'weighted':
        result = this.runWeightedVoting(proposalData.proposal, proposalData.votes);
        break;
      case 'ranked_choice':
        result = this.runRankedChoice(proposalData.proposal, proposalData.votes);
        break;
      case 'borda_count':
        result = this.runBordaCount(proposalData.proposal, proposalData.votes);
        break;
      case 'approval':
        result = this.runApprovalVoting(proposalData.proposal, proposalData.votes);
        break;
      default:
        result = this.runMajorityVoting(proposalData.proposal, proposalData.votes);
    }

    result.duration = Date.now() - startTime;
    return result;
  }

  // ============ Voting Algorithms ============

  runMajorityVoting(proposal: ConsensusProposal, votes: ConsensusVote[]): ConsensusResult {
    const tally = new Map<string, number>();

    // Count votes
    for (const vote of votes) {
      const optionId = Array.isArray(vote.optionId) ? vote.optionId[0] : vote.optionId;
      tally.set(optionId, (tally.get(optionId) || 0) + 1);
    }

    // Find winner
    let winner: ConsensusOption | null = null;
    let maxVotes = 0;
    let totalVotes = votes.length;

    for (const [optionId, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        winner = proposal.options.find(opt => opt.id === optionId) || null;
      }
    }

    const winnerVoteRatio = maxVotes / totalVotes;
    const threshold = this.config.algorithm === 'supermajority'
      ? this.config.consensusThreshold
      : 0.5;

    const consensusReached = this.config.requireUnanimity
      ? winnerVoteRatio === 1.0
      : winnerVoteRatio > threshold;

    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId: proposal.id,
      algorithm: this.config.algorithm,
      winner: consensusReached ? winner : null,
      votes,
      tally,
      consensusReached,
      consensusStrength: winnerVoteRatio,
      participationRate: 1.0, // All voters participated
      rounds: 1,
      duration: 0,
      reasoning: consensusReached
        ? `${winner?.label} won with ${maxVotes}/${totalVotes} votes (${Math.round(winnerVoteRatio * 100)}%)`
        : `No consensus reached. Highest: ${maxVotes}/${totalVotes} (${Math.round(winnerVoteRatio * 100)}%, threshold: ${Math.round(threshold * 100)}%)`,
    };
  }

  runWeightedVoting(proposal: ConsensusProposal, votes: ConsensusVote[]): ConsensusResult {
    const tally = new Map<string, number>();
    let totalWeight = 0;

    // Calculate weighted votes
    for (const vote of votes) {
      const optionId = Array.isArray(vote.optionId) ? vote.optionId[0] : vote.optionId;
      const weight = this.config.weightByConfidence
        ? vote.weight * vote.confidence
        : vote.weight;

      tally.set(optionId, (tally.get(optionId) || 0) + weight);
      totalWeight += weight;
    }

    // Find winner
    let winner: ConsensusOption | null = null;
    let maxWeight = 0;

    for (const [optionId, weight] of tally) {
      if (weight > maxWeight) {
        maxWeight = weight;
        winner = proposal.options.find(opt => opt.id === optionId) || null;
      }
    }

    const winnerWeightRatio = maxWeight / totalWeight;
    const consensusReached = this.config.requireUnanimity
      ? winnerWeightRatio === 1.0
      : winnerWeightRatio > this.config.consensusThreshold;

    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId: proposal.id,
      algorithm: 'weighted',
      winner: consensusReached ? winner : null,
      votes,
      tally,
      consensusReached,
      consensusStrength: winnerWeightRatio,
      participationRate: 1.0,
      rounds: 1,
      duration: 0,
      reasoning: consensusReached
        ? `${winner?.label} won with ${maxWeight.toFixed(2)}/${totalWeight.toFixed(2)} weighted votes (${Math.round(winnerWeightRatio * 100)}%)`
        : `No consensus reached. Highest: ${maxWeight.toFixed(2)}/${totalWeight.toFixed(2)} (${Math.round(winnerWeightRatio * 100)}%)`,
    };
  }

  runRankedChoice(proposal: ConsensusProposal, votes: ConsensusVote[]): ConsensusResult {
    const tally = new Map<string, number>();
    let remainingVotes = [...votes];
    let eliminatedOptions = new Set<string>();
    let rounds = 0;
    const maxRounds = proposal.options.length - 1;

    while (rounds < maxRounds) {
      rounds++;
      tally.clear();

      // Count first-choice votes
      for (const vote of remainingVotes) {
        const rankings = Array.isArray(vote.optionId) ? vote.optionId : [vote.optionId];
        const firstChoice = rankings.find(id => !eliminatedOptions.has(id));

        if (firstChoice) {
          tally.set(firstChoice, (tally.get(firstChoice) || 0) + 1);
        }
      }

      // Check for majority winner
      const totalVotes = remainingVotes.length;
      for (const [optionId, count] of tally) {
        if (count > totalVotes / 2) {
          const winner = proposal.options.find(opt => opt.id === optionId) || null;
          return {
            id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            proposalId: proposal.id,
            algorithm: 'ranked_choice',
            winner,
            votes,
            tally,
            consensusReached: true,
            consensusStrength: count / totalVotes,
            participationRate: 1.0,
            rounds,
            duration: 0,
            reasoning: `${winner?.label} won by instant runoff in round ${rounds} with ${count}/${totalVotes} votes`,
          };
        }
      }

      // No majority, eliminate option with fewest votes
      let minVotes = Infinity;
      let toEliminate: string | null = null;

      for (const [optionId, count] of tally) {
        if (count < minVotes) {
          minVotes = count;
          toEliminate = optionId;
        }
      }

      if (toEliminate) {
        eliminatedOptions.add(toEliminate);
      } else {
        break;
      }
    }

    // Return highest vote getter if no majority reached
    let winner: ConsensusOption | null = null;
    let maxVotes = 0;

    for (const [optionId, count] of tally) {
      if (count > maxVotes) {
        maxVotes = count;
        winner = proposal.options.find(opt => opt.id === optionId) || null;
      }
    }

    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId: proposal.id,
      algorithm: 'ranked_choice',
      winner,
      votes,
      tally,
      consensusReached: false,
      consensusStrength: maxVotes / remainingVotes.length,
      participationRate: 1.0,
      rounds,
      duration: 0,
      reasoning: `No majority after ${rounds} rounds of instant runoff. Highest: ${winner?.label} with ${maxVotes} votes`,
    };
  }

  runBordaCount(proposal: ConsensusProposal, votes: ConsensusVote[]): ConsensusResult {
    const tally = new Map<string, number>();
    const optionCount = proposal.options.length;

    // Calculate Borda scores
    for (const vote of votes) {
      const rankings = Array.isArray(vote.optionId) ? vote.optionId : [vote.optionId];

      rankings.forEach((optionId, rank) => {
        const points = optionCount - rank - 1; // Top choice gets most points
        tally.set(optionId, (tally.get(optionId) || 0) + points);
      });
    }

    // Find winner
    let winner: ConsensusOption | null = null;
    let maxPoints = 0;
    let totalPoints = 0;

    for (const [optionId, points] of tally) {
      totalPoints += points;
      if (points > maxPoints) {
        maxPoints = points;
        winner = proposal.options.find(opt => opt.id === optionId) || null;
      }
    }

    const consensusStrength = maxPoints / totalPoints;
    const consensusReached = consensusStrength > this.config.consensusThreshold;

    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId: proposal.id,
      algorithm: 'borda_count',
      winner: consensusReached ? winner : null,
      votes,
      tally,
      consensusReached,
      consensusStrength,
      participationRate: 1.0,
      rounds: 1,
      duration: 0,
      reasoning: consensusReached
        ? `${winner?.label} won with ${maxPoints} Borda points (${Math.round(consensusStrength * 100)}% of total)`
        : `No consensus reached. Highest: ${winner?.label} with ${maxPoints}/${totalPoints} points (${Math.round(consensusStrength * 100)}%)`,
    };
  }

  runApprovalVoting(proposal: ConsensusProposal, votes: ConsensusVote[]): ConsensusResult {
    const tally = new Map<string, number>();

    // Count approvals (votes can approve multiple options)
    for (const vote of votes) {
      const optionIds = Array.isArray(vote.optionId) ? vote.optionId : [vote.optionId];

      for (const optionId of optionIds) {
        tally.set(optionId, (tally.get(optionId) || 0) + 1);
      }
    }

    // Find winner
    let winner: ConsensusOption | null = null;
    let maxApprovals = 0;

    for (const [optionId, count] of tally) {
      if (count > maxApprovals) {
        maxApprovals = count;
        winner = proposal.options.find(opt => opt.id === optionId) || null;
      }
    }

    const approvalRate = maxApprovals / votes.length;
    const consensusReached = approvalRate > this.config.consensusThreshold;

    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId: proposal.id,
      algorithm: 'approval',
      winner: consensusReached ? winner : null,
      votes,
      tally,
      consensusReached,
      consensusStrength: approvalRate,
      participationRate: 1.0,
      rounds: 1,
      duration: 0,
      reasoning: consensusReached
        ? `${winner?.label} won with ${maxApprovals}/${votes.length} approvals (${Math.round(approvalRate * 100)}%)`
        : `No consensus reached. Highest: ${winner?.label} with ${maxApprovals}/${votes.length} approvals (${Math.round(approvalRate * 100)}%)`,
    };
  }

  // ============ Leader Election ============

  electLeader(
    candidates: string[],
    voterWeights?: Map<string, number>
  ): LeaderElectionResult {
    if (candidates.length === 0) {
      throw new Error('No candidates provided for leader election');
    }

    const scores = new Map<string, number>();

    // Simple scoring: each candidate gets base score + voter weights
    for (const candidate of candidates) {
      let score = 1.0; // Base score

      // Add weights if provided
      if (voterWeights) {
        score += voterWeights.get(candidate) || 0;
      }

      scores.set(candidate, score);
    }

    // Find leader
    let leaderId = candidates[0];
    let leaderScore = scores.get(leaderId) || 0;
    let runnerUp: string | undefined;
    let runnerUpScore = 0;

    for (const [candidateId, score] of scores) {
      if (score > leaderScore) {
        runnerUp = leaderId;
        runnerUpScore = leaderScore;
        leaderId = candidateId;
        leaderScore = score;
      } else if (!runnerUp || score > runnerUpScore) {
        runnerUp = candidateId;
        runnerUpScore = score;
      }
    }

    const result: LeaderElectionResult = {
      leaderId,
      leaderScore,
      runnerUp,
      electionMethod: 'weighted_score',
      participants: candidates,
    };

    this.emit('leader:elected', result);
    return result;
  }

  // ============ Proposal Closure ============

  closeProposal(proposalId: string): ConsensusResult | null {
    const proposalData = this.proposals.get(proposalId);

    if (!proposalData || proposalData.closed) {
      return null;
    }

    proposalData.closed = true;

    // Calculate final result
    const result = this.calculateResult(proposalId);
    proposalData.result = result;

    // Update statistics
    this.updateStats(result);

    this.emit('proposal:closed', { proposalId, result });

    if (result.consensusReached) {
      this.emit('consensus:reached', { proposalId, result });
    } else {
      this.emit('consensus:failed', { proposalId, result });
    }

    return result;
  }

  // ============ Statistics ============

  private updateStats(result: ConsensusResult): void {
    const n = this.stats.totalProposals;
    this.stats.totalProposals++;

    if (result.consensusReached) {
      this.stats.consensusReached++;
    }

    this.stats.consensusRate = this.stats.consensusReached / this.stats.totalProposals;
    this.stats.avgConsensusStrength =
      (this.stats.avgConsensusStrength * n + result.consensusStrength) / (n + 1);
    this.stats.avgParticipationRate =
      (this.stats.avgParticipationRate * n + result.participationRate) / (n + 1);
    this.stats.avgRounds =
      (this.stats.avgRounds * n + result.rounds) / (n + 1);

    // Update algorithm-specific stats
    const algoStats = this.stats.byAlgorithm.get(result.algorithm) || {
      count: 0,
      successRate: 0,
    };

    const algoSuccesses = algoStats.successRate * algoStats.count;
    algoStats.count++;
    algoStats.successRate =
      (algoSuccesses + (result.consensusReached ? 1 : 0)) / algoStats.count;

    this.stats.byAlgorithm.set(result.algorithm, algoStats);
  }

  getStats(): ConsensusStats {
    return {
      ...this.stats,
      byAlgorithm: new Map(this.stats.byAlgorithm),
    };
  }

  // ============ Utility Methods ============

  private createFailedResult(
    proposalId: string,
    proposal: ConsensusProposal,
    votes: ConsensusVote[],
    reason: string,
    duration: number
  ): ConsensusResult {
    return {
      id: `result-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      proposalId,
      algorithm: this.config.algorithm,
      winner: null,
      votes,
      tally: new Map(),
      consensusReached: false,
      consensusStrength: 0,
      participationRate: votes.length / this.config.minimumParticipants,
      rounds: 0,
      duration,
      reasoning: reason,
    };
  }

  // ============ Cleanup ============

  destroy(): void {
    this.proposals.clear();
    this.removeAllListeners();
  }
}

// Export singleton getter
export function getConsensusManager(): ConsensusManager {
  return ConsensusManager.getInstance();
}
