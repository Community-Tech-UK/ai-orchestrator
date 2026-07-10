/**
 * Pure response-analysis helpers for CLI multi-agent verification.
 *
 * Split out of cli-verification-extension.ts to keep the coordinator focused on
 * spawning/collecting agent responses. These are stateless functions over the
 * collected AgentResponse set (agreement clustering, disagreement detection,
 * ranking, outlier detection).
 */
import type { AgentResponse } from '../../shared/types/verification.types';

export function pointSimilarity(left: string, right: string): number {
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const a = words(left);
  const b = words(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Find agreement points across responses
 */
export function findAgreements(responses: AgentResponse[]): any[] {
  const clusters: Array<{ point: any; agents: string[]; confidences: number[] }> = [];

  for (const response of responses) {
    for (const point of response.keyPoints) {
      const existing = clusters.find((cluster) => pointSimilarity(cluster.point.content, point.content) >= 0.7);
      if (existing) {
        if (!existing.agents.includes(response.agentId)) {
          existing.agents.push(response.agentId);
          existing.confidences.push(point.confidence);
        }
      } else {
        clusters.push({ point, agents: [response.agentId], confidences: [point.confidence] });
      }
    }
  }

  return clusters
    .filter(p => p.agents.length >= 2)
    .map(p => ({
      point: p.point.content,
      category: p.point.category,
      agentIds: p.agents,
      strength: p.agents.length / responses.length,
      combinedConfidence: p.confidences.reduce((sum, value) => sum + value, 0) / p.confidences.length,
    }));
}

/**
 * Find disagreement points
 */
export function findDisagreements(responses: AgentResponse[]): any[] {
  const recommendations = responses.flatMap(r =>
    r.keyPoints
      .filter(p => p.category === 'recommendation')
      .map(p => ({ ...p, agentId: r.agentId }))
  );

  if (recommendations.length <= 1) return [];

  const unique = new Set(recommendations.map(r => r.content.toLowerCase()));
  if (unique.size > 1) {
    return [{
      topic: 'Recommendations differ across agents',
      positions: recommendations.map(r => ({
        agentId: r.agentId,
        position: r.content,
        confidence: r.confidence,
      })),
      requiresHumanReview: true,
    }];
  }

  return [];
}

/**
 * Rank responses by quality
 */
export function rankResponses(responses: AgentResponse[]): any[] {
  return responses
    .map(r => {
      const completeness = Math.min(1, r.keyPoints.length / 5);
      const accuracy = r.confidence;
      const score = completeness * 0.3 + accuracy * 0.7;

      return {
        agentId: r.agentId,
        rank: 0,
        score,
        criteria: { completeness, accuracy },
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/**
 * Detect outlier agents
 */
export function detectOutliers(responses: AgentResponse[], agreements: any[]): string[] {
  const outliers: string[] = [];
  const majorityPoints = new Set(
    agreements.filter(a => a.strength >= 0.5).map(a => a.point.toLowerCase())
  );

  for (const response of responses) {
    const agentPoints = new Set(response.keyPoints.map(p => p.content.toLowerCase()));
    const overlap = [...agentPoints].filter(p => majorityPoints.has(p)).length;

    if (majorityPoints.size > 0 && overlap / majorityPoints.size < 0.3) {
      outliers.push(response.agentId);
    }
  }

  return outliers;
}
