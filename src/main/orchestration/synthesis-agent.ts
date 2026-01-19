/**
 * Synthesis Agent
 * Synthesizes responses from multiple agents into a unified result
 */

import { EventEmitter } from 'events';

export interface AgentResponse {
  agentId: string;
  model: string;
  content: string;
  confidence: number;
  reasoning?: string;
  tokensUsed: number;
  duration: number;
}

export interface SynthesisResult {
  id: string;
  originalQuery: string;
  responses: AgentResponse[];
  synthesizedContent: string;
  confidence: number;
  agreements: AgreementPoint[];
  disagreements: DisagreementPoint[];
  methodology: string;
  tokensUsed: number;
  duration: number;
}

export interface AgreementPoint {
  topic: string;
  content: string;
  supportingAgents: string[];
  confidence: number;
}

export interface DisagreementPoint {
  topic: string;
  positions: Map<string, string>;
  resolution?: string;
  resolutionReasoning?: string;
}

export type SynthesisStrategy = 'consensus' | 'best-of' | 'merge' | 'debate';

export interface SynthesisConfig {
  strategy: SynthesisStrategy;
  minAgentAgreement: number; // Fraction of agents that must agree (0-1)
  preferHighConfidence: boolean;
  includeDisagreements: boolean;
  maxOutputTokens?: number;
}

export class SynthesisAgent extends EventEmitter {
  private static instance: SynthesisAgent;
  private config: SynthesisConfig;

  private defaultConfig: SynthesisConfig = {
    strategy: 'consensus',
    minAgentAgreement: 0.67, // 2/3 majority
    preferHighConfidence: true,
    includeDisagreements: true,
  };

  static getInstance(): SynthesisAgent {
    if (!this.instance) {
      this.instance = new SynthesisAgent();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<SynthesisConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Synthesis Process ============

  async synthesize(
    query: string,
    responses: AgentResponse[],
    config?: Partial<SynthesisConfig>
  ): Promise<SynthesisResult> {
    const startTime = Date.now();
    const mergedConfig = { ...this.config, ...config };

    this.emit('synthesis:started', { query, responseCount: responses.length });

    // Analyze responses
    const analysis = this.analyzeResponses(responses);

    // Apply synthesis strategy
    let synthesizedContent: string;
    switch (mergedConfig.strategy) {
      case 'consensus':
        synthesizedContent = this.synthesizeConsensus(analysis, mergedConfig);
        break;
      case 'best-of':
        synthesizedContent = this.synthesizeBestOf(responses, analysis);
        break;
      case 'merge':
        synthesizedContent = this.synthesizeMerge(analysis, mergedConfig);
        break;
      case 'debate':
        synthesizedContent = await this.synthesizeDebate(responses, analysis);
        break;
      default:
        synthesizedContent = this.synthesizeConsensus(analysis, mergedConfig);
    }

    const result: SynthesisResult = {
      id: `synthesis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      originalQuery: query,
      responses,
      synthesizedContent,
      confidence: this.calculateOverallConfidence(analysis),
      agreements: analysis.agreements,
      disagreements: analysis.disagreements,
      methodology: mergedConfig.strategy,
      tokensUsed: responses.reduce((sum, r) => sum + r.tokensUsed, 0),
      duration: Date.now() - startTime,
    };

    this.emit('synthesis:completed', { resultId: result.id, confidence: result.confidence });

    return result;
  }

  // ============ Response Analysis ============

  private analyzeResponses(responses: AgentResponse[]): {
    agreements: AgreementPoint[];
    disagreements: DisagreementPoint[];
    themes: Map<string, string[]>;
    keyPoints: Map<string, Set<string>>;
  } {
    const themes = this.extractThemes(responses);
    const keyPoints = this.extractKeyPoints(responses);
    const agreements = this.findAgreements(responses, themes, keyPoints);
    const disagreements = this.findDisagreements(responses, themes, keyPoints);

    return { agreements, disagreements, themes, keyPoints };
  }

  private extractThemes(responses: AgentResponse[]): Map<string, string[]> {
    const themes = new Map<string, string[]>();

    for (const response of responses) {
      // Simple theme extraction based on paragraphs and headers
      const paragraphs = response.content.split(/\n\n+/);

      for (const paragraph of paragraphs) {
        // Extract potential theme from first sentence or header
        const firstLine = paragraph.split('\n')[0].trim();
        if (firstLine.length > 10 && firstLine.length < 200) {
          const theme = this.normalizeTheme(firstLine);
          const existing = themes.get(theme) || [];
          existing.push(response.agentId);
          themes.set(theme, existing);
        }
      }
    }

    return themes;
  }

  private extractKeyPoints(responses: AgentResponse[]): Map<string, Set<string>> {
    const keyPoints = new Map<string, Set<string>>();

    for (const response of responses) {
      // Extract bullet points, numbered lists, and emphasized text
      const bulletPoints = response.content.match(/^[\s]*[-*•]\s+(.+)$/gm) || [];
      const numberedPoints = response.content.match(/^[\s]*\d+\.\s+(.+)$/gm) || [];
      const emphasizedPoints = response.content.match(/\*\*(.+?)\*\*/g) || [];

      const allPoints = [...bulletPoints, ...numberedPoints, ...emphasizedPoints];

      for (const point of allPoints) {
        const normalized = this.normalizePoint(point);
        if (normalized.length > 5) {
          const existing = keyPoints.get(normalized) || new Set();
          existing.add(response.agentId);
          keyPoints.set(normalized, existing);
        }
      }
    }

    return keyPoints;
  }

  private normalizeTheme(text: string): string {
    return text
      .toLowerCase()
      .replace(/[#*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  private normalizePoint(text: string): string {
    return text
      .replace(/^[\s]*[-*•\d.]+\s*/, '')
      .replace(/\*\*/g, '')
      .toLowerCase()
      .trim();
  }

  private findAgreements(
    responses: AgentResponse[],
    themes: Map<string, string[]>,
    keyPoints: Map<string, Set<string>>
  ): AgreementPoint[] {
    const agreements: AgreementPoint[] = [];
    const threshold = Math.ceil(responses.length * this.config.minAgentAgreement);

    // Find themes with majority agreement
    for (const [theme, agents] of themes) {
      if (agents.length >= threshold) {
        agreements.push({
          topic: theme,
          content: theme,
          supportingAgents: agents,
          confidence: agents.length / responses.length,
        });
      }
    }

    // Find key points with majority agreement
    for (const [point, agents] of keyPoints) {
      if (agents.size >= threshold) {
        agreements.push({
          topic: point.slice(0, 50),
          content: point,
          supportingAgents: Array.from(agents),
          confidence: agents.size / responses.length,
        });
      }
    }

    return agreements;
  }

  private findDisagreements(
    responses: AgentResponse[],
    themes: Map<string, string[]>,
    keyPoints: Map<string, Set<string>>
  ): DisagreementPoint[] {
    const disagreements: DisagreementPoint[] = [];

    // Find themes with minority support (potential disagreements)
    for (const [theme, agents] of themes) {
      if (agents.length > 0 && agents.length < responses.length * 0.5) {
        const positions = new Map<string, string>();
        for (const response of responses) {
          if (agents.includes(response.agentId)) {
            positions.set(response.agentId, 'supports');
          } else {
            positions.set(response.agentId, 'does not mention');
          }
        }

        disagreements.push({
          topic: theme,
          positions,
        });
      }
    }

    return disagreements.slice(0, 10); // Limit to top 10 disagreements
  }

  // ============ Synthesis Strategies ============

  private synthesizeConsensus(
    analysis: { agreements: AgreementPoint[]; disagreements: DisagreementPoint[] },
    config: SynthesisConfig
  ): string {
    const parts: string[] = [];

    // Sort agreements by confidence
    const sortedAgreements = [...analysis.agreements].sort((a, b) => b.confidence - a.confidence);

    parts.push('## Synthesized Response\n');
    parts.push('Based on analysis of multiple agent responses, here are the key findings:\n');

    // Include high-confidence agreements
    if (sortedAgreements.length > 0) {
      parts.push('### Key Points (Consensus)\n');
      for (const agreement of sortedAgreements.slice(0, 10)) {
        const supportPercent = Math.round(agreement.confidence * 100);
        parts.push(`- ${agreement.content} (${supportPercent}% agreement)`);
      }
    }

    // Optionally include disagreements
    if (config.includeDisagreements && analysis.disagreements.length > 0) {
      parts.push('\n### Areas of Divergence\n');
      for (const disagreement of analysis.disagreements.slice(0, 5)) {
        parts.push(`- ${disagreement.topic}`);
      }
    }

    return parts.join('\n');
  }

  private synthesizeBestOf(
    responses: AgentResponse[],
    analysis: { agreements: AgreementPoint[] }
  ): string {
    // Select the response with highest confidence that aligns with agreements
    let bestResponse = responses[0];
    let bestScore = 0;

    for (const response of responses) {
      let score = response.confidence;

      // Bonus for alignment with agreements
      for (const agreement of analysis.agreements) {
        if (agreement.supportingAgents.includes(response.agentId)) {
          score += agreement.confidence * 0.1;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestResponse = response;
      }
    }

    return `## Best Response (from ${bestResponse.agentId})\n\n${bestResponse.content}`;
  }

  private synthesizeMerge(
    analysis: { agreements: AgreementPoint[]; disagreements: DisagreementPoint[] },
    config: SynthesisConfig
  ): string {
    const parts: string[] = [];

    parts.push('## Merged Response\n');

    // Group agreements by similarity and merge
    const groupedAgreements = this.groupSimilarAgreements(analysis.agreements);

    for (const [topic, agreements] of groupedAgreements) {
      parts.push(`### ${topic}\n`);
      for (const agreement of agreements) {
        parts.push(agreement.content);
      }
      parts.push('');
    }

    if (config.includeDisagreements && analysis.disagreements.length > 0) {
      parts.push('### Additional Perspectives\n');
      for (const disagreement of analysis.disagreements.slice(0, 3)) {
        parts.push(`**${disagreement.topic}**: Different viewpoints exist on this topic.`);
      }
    }

    return parts.join('\n');
  }

  private async synthesizeDebate(
    responses: AgentResponse[],
    analysis: { agreements: AgreementPoint[]; disagreements: DisagreementPoint[] }
  ): Promise<string> {
    // Placeholder for debate-style synthesis
    // Would involve multiple rounds of critique and defense
    const parts: string[] = [];

    parts.push('## Debate Synthesis\n');
    parts.push(`Analyzed ${responses.length} perspectives:\n`);

    // Summarize each position
    for (const response of responses) {
      parts.push(`**${response.agentId}** (confidence: ${Math.round(response.confidence * 100)}%):`);
      parts.push(response.content.slice(0, 200) + '...\n');
    }

    // Final synthesis
    parts.push('### Synthesis\n');
    parts.push(this.synthesizeConsensus(analysis, this.config));

    return parts.join('\n');
  }

  private groupSimilarAgreements(agreements: AgreementPoint[]): Map<string, AgreementPoint[]> {
    const groups = new Map<string, AgreementPoint[]>();

    for (const agreement of agreements) {
      // Simple grouping by first few words
      const groupKey = agreement.topic.split(' ').slice(0, 3).join(' ');
      const existing = groups.get(groupKey) || [];
      existing.push(agreement);
      groups.set(groupKey, existing);
    }

    return groups;
  }

  // ============ Confidence Calculation ============

  private calculateOverallConfidence(analysis: {
    agreements: AgreementPoint[];
    disagreements: DisagreementPoint[];
  }): number {
    if (analysis.agreements.length === 0) return 0;

    const avgAgreementConfidence =
      analysis.agreements.reduce((sum, a) => sum + a.confidence, 0) / analysis.agreements.length;

    // Penalize for disagreements
    const disagreementPenalty = Math.min(0.3, analysis.disagreements.length * 0.05);

    return Math.max(0, avgAgreementConfidence - disagreementPenalty);
  }
}

// Export singleton getter
export function getSynthesisAgent(): SynthesisAgent {
  return SynthesisAgent.getInstance();
}
