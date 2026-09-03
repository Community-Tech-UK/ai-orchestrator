/**
 * Consensus text synthesis and agreement scoring.
 *
 * Extracted from `consensus-coordinator.ts` so the coordinator stays inside
 * its LOC ceiling. Behaviour matches the previous private methods.
 */

import type {
  ConsensusProviderResponse,
  ConsensusProviderSpec,
  ConsensusResult,
  ConsensusStrategy,
} from './consensus.types';

export const MAX_CONSENSUS_RESPONSE_CHARS = 2_500;
export const MAX_RAW_CONSENSUS_CHARS = 8_000;

export function synthesizeConsensus(
  responses: ConsensusProviderResponse[],
  strategy: string,
  startTime: number,
  providerSpecs: ConsensusProviderSpec[],
  now: () => number = Date.now,
): ConsensusResult {
  const successful = responses.filter(r => r.success);
  const failed = responses.filter(r => !r.success);

  if (successful.length === 0) {
    return {
      consensus: 'Consensus query failed: All providers failed',
      agreement: 0,
      responses,
      dissent: [],
      edgeCases: [],
      totalDurationMs: now() - startTime,
      totalEstimatedCost: responses.reduce((sum, r) => sum + (r.estimatedCost || 0), 0),
      successCount: 0,
      failureCount: failed.length,
    };
  }

  if (strategy === 'all') {
    const rawConsensus = successful
      .map(r => `**[${r.provider}${r.model ? ` / ${r.model}` : ''}]:**\n${truncateContent(r.content, MAX_CONSENSUS_RESPONSE_CHARS)}`)
      .join('\n\n---\n\n');
    return {
      consensus: truncateContent(rawConsensus, MAX_RAW_CONSENSUS_CHARS),
      agreement: 0,
      responses,
      dissent: [],
      edgeCases: [],
      totalDurationMs: now() - startTime,
      totalEstimatedCost: responses.reduce((sum, r) => sum + (r.estimatedCost || 0), 0),
      successCount: successful.length,
      failureCount: failed.length,
    };
  }

  const { consensus, agreement, dissent, edgeCases } = buildConsensus(successful, strategy, providerSpecs);

  return {
    consensus,
    agreement,
    responses,
    dissent,
    edgeCases,
    totalDurationMs: now() - startTime,
    totalEstimatedCost: responses.reduce((sum, r) => sum + (r.estimatedCost || 0), 0),
    successCount: successful.length,
    failureCount: failed.length,
  };
}

export function synthesizeFromResponses(
  responses: ConsensusProviderResponse[],
  strategy: ConsensusStrategy = 'majority',
  providerSpecs: ConsensusProviderSpec[] = [],
): ConsensusResult {
  return synthesizeConsensus(responses, strategy, Date.now(), providerSpecs);
}

function buildConsensus(
  responses: ConsensusProviderResponse[],
  strategy: string,
  providerSpecs: ConsensusProviderSpec[],
): { consensus: string; agreement: number; dissent: string[]; edgeCases: string[] } {
  if (responses.length === 1) {
    return {
      consensus: truncateContent(responses[0].content, MAX_CONSENSUS_RESPONSE_CHARS),
      agreement: 1,
      dissent: [],
      edgeCases: [],
    };
  }

  const agreement = computeAgreementScore(responses);
  const edgeCases = extractEdgeCases(responses);
  const dissent = identifyDissent(responses, agreement);
  const consensus = strategy === 'weighted'
    ? buildWeightedConsensus(responses, agreement, edgeCases, providerSpecs)
    : buildMajorityConsensus(responses, agreement, edgeCases);

  return { consensus, agreement, dissent, edgeCases };
}

export function buildMajorityConsensus(
  responses: ConsensusProviderResponse[],
  agreement: number,
  edgeCases: string[],
): string {
  const parts: string[] = [];

  if (agreement >= 0.7) {
    parts.push(`## Consensus (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);
  } else {
    parts.push(`## Multi-Model Analysis (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);
    parts.push('*Note: Providers showed significant disagreement. Review individual responses carefully.*\n');
  }

  const sharedTerms = extractSharedTerms(responses);
  if (sharedTerms.length > 0) {
    parts.push('### Key Themes (mentioned by majority)');
    parts.push(sharedTerms.map(t => `- ${t}`).join('\n'));
    parts.push('');
  }

  parts.push('### Provider Responses\n');
  for (const r of responses) {
    const label = `**${r.provider}${r.model ? ` (${r.model})` : ''}**`;
    const summary = truncateToFirstParagraph(r.content, 500);
    parts.push(`${label}: ${summary}`);
    parts.push('');
  }

  if (edgeCases.length > 0) {
    parts.push('### Edge Cases & Caveats');
    for (const ec of edgeCases) {
      parts.push(`- ${ec}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function buildWeightedConsensus(
  responses: ConsensusProviderResponse[],
  agreement: number,
  edgeCases: string[],
  providerSpecs: ConsensusProviderSpec[],
): string {
  const weightMap = new Map<string, number>();
  for (const spec of providerSpecs) {
    weightMap.set(spec.provider, spec.weight ?? 1);
  }

  const sorted = [...responses].sort((a, b) =>
    (weightMap.get(b.provider) ?? 1) - (weightMap.get(a.provider) ?? 1)
  );

  const primary = sorted[0];
  const supporting = sorted.slice(1);
  const primaryWeight = weightMap.get(primary.provider) ?? 1;

  const parts: string[] = [];
  parts.push(`## Weighted Consensus (${responses.length} providers, ${Math.round(agreement * 100)}% agreement)\n`);

  const primaryLabel = `${primary.provider}${primary.model ? ` (${primary.model})` : ''}`;
  parts.push(`### Primary: ${primaryLabel} (weight: ${primaryWeight})\n`);
  parts.push(truncateContent(primary.content, MAX_CONSENSUS_RESPONSE_CHARS));
  parts.push('');

  if (supporting.length > 0) {
    parts.push('### Supporting Views\n');
    for (const r of supporting) {
      const w = weightMap.get(r.provider) ?? 1;
      const label = `**${r.provider}${r.model ? ` (${r.model})` : ''}** (weight: ${w})`;
      const summary = truncateToFirstParagraph(r.content, 400);
      parts.push(`${label}: ${summary}`);
      parts.push('');
    }
  }

  if (edgeCases.length > 0) {
    parts.push('### Edge Cases & Caveats');
    for (const ec of edgeCases) {
      parts.push(`- ${ec}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function extractEdgeCases(responses: ConsensusProviderResponse[]): string[] {
  const edgeCases: string[] = [];
  for (const r of responses) {
    const matches = r.content.matchAll(
      /(?:edge case|caveat|risk|warning|gotcha|pitfall|however|but note|be aware|careful|watch out)[:\s]([^\n.]+[.\n])/gi
    );
    for (const match of matches) {
      const edgeCase = match[1].trim();
      if (edgeCase && !edgeCases.some(ec => ec.toLowerCase() === edgeCase.toLowerCase())) {
        edgeCases.push(edgeCase);
      }
    }
  }
  return edgeCases;
}

export function identifyDissent(responses: ConsensusProviderResponse[], agreement: number): string[] {
  const dissent: string[] = [];
  if (agreement < 0.9 && responses.length >= 2) {
    const lengths = responses.map(r => r.content.length);
    const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const maxDiff = Math.max(...lengths.map(l => Math.abs(l - avgLen) / avgLen));

    if (maxDiff > 0.5) {
      dissent.push('Responses varied significantly in depth/detail');
    }

    if (agreement < 0.5) {
      dissent.push('Low vocabulary overlap suggests fundamentally different perspectives');
    }
  }
  return dissent;
}

export function extractSharedTerms(responses: ConsensusProviderResponse[]): string[] {
  const threshold = Math.ceil(responses.length / 2);

  const perResponse = responses.map(r => {
    const words = r.content
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 5);
    return new Set(words);
  });

  const termCounts = new Map<string, number>();
  for (const wordSet of perResponse) {
    for (const word of wordSet) {
      termCounts.set(word, (termCounts.get(word) ?? 0) + 1);
    }
  }

  return [...termCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([term]) => term);
}

export function truncateToFirstParagraph(content: string, maxChars: number): string {
  const paragraphEnd = content.indexOf('\n\n');
  const firstParagraph = paragraphEnd > 0 && paragraphEnd < maxChars
    ? content.slice(0, paragraphEnd)
    : content.slice(0, maxChars);

  if (firstParagraph.length < content.length) {
    return firstParagraph.trimEnd() + '...';
  }
  return firstParagraph;
}

export function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars).trimEnd()}...`;
}

export function computeAgreementScore(responses: ConsensusProviderResponse[]): number {
  if (responses.length < 2) return 1;

  const tokenSets = responses.map(r => {
    const words = r.content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    return new Set(words);
  });

  let totalSimilarity = 0;
  let pairs = 0;

  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const intersection = new Set([...tokenSets[i]].filter(w => tokenSets[j].has(w)));
      const union = new Set([...tokenSets[i], ...tokenSets[j]]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;
      totalSimilarity += similarity;
      pairs++;
    }
  }

  return pairs > 0 ? totalSimilarity / pairs : 0;
}
