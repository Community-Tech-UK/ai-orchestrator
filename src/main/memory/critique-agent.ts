/**
 * Critique Agent
 * Self-critique capabilities for improving agent responses and decisions
 * Enables reflection and iterative refinement
 */

import { EventEmitter } from 'events';

export interface CritiqueConfig {
  enableSelfCritique: boolean;
  maxIterations: number;
  minConfidenceThreshold: number;
  critiqueDimensions: CritiqueDimension[];
  enableReflection: boolean;
}

export type CritiqueDimension =
  | 'accuracy'
  | 'completeness'
  | 'relevance'
  | 'clarity'
  | 'safety'
  | 'efficiency'
  | 'consistency';

export interface CritiqueRequest {
  id: string;
  content: string;
  context?: string;
  dimensions?: CritiqueDimension[];
  taskId?: string;
}

export interface CritiqueResult {
  id: string;
  requestId: string;
  overallScore: number;
  dimensionScores: Map<CritiqueDimension, DimensionScore>;
  issues: CritiqueIssue[];
  suggestions: string[];
  shouldRevise: boolean;
  reasoning: string;
  timestamp: number;
}

export interface DimensionScore {
  dimension: CritiqueDimension;
  score: number; // 0-1
  feedback: string;
  issues: string[];
}

export interface CritiqueIssue {
  severity: 'low' | 'medium' | 'high' | 'critical';
  dimension: CritiqueDimension;
  description: string;
  location?: string; // Reference to specific part of content
  suggestion?: string;
}

export interface RevisionRequest {
  original: string;
  critique: CritiqueResult;
  maxIterations?: number;
}

export interface RevisionResult {
  revised: string;
  iterations: number;
  improvements: string[];
  finalScore: number;
  history: RevisionIteration[];
}

export interface RevisionIteration {
  iteration: number;
  content: string;
  critique: CritiqueResult;
  changes: string[];
}

export interface ReflectionResult {
  insights: string[];
  patterns: string[];
  improvements: string[];
  confidence: number;
}

export class CritiqueAgent extends EventEmitter {
  private static instance: CritiqueAgent;
  private config: CritiqueConfig;
  private critiqueHistory: CritiqueResult[] = [];
  private maxHistorySize = 500;

  private defaultConfig: CritiqueConfig = {
    enableSelfCritique: true,
    maxIterations: 3,
    minConfidenceThreshold: 0.7,
    critiqueDimensions: ['accuracy', 'completeness', 'relevance', 'clarity'],
    enableReflection: true,
  };

  static getInstance(): CritiqueAgent {
    if (!this.instance) {
      this.instance = new CritiqueAgent();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<CritiqueConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Critique Generation ============

  async critique(request: CritiqueRequest): Promise<CritiqueResult> {
    const startTime = Date.now();

    this.emit('critique:started', { requestId: request.id });

    const dimensions = request.dimensions || this.config.critiqueDimensions;

    // Score each dimension
    const dimensionScores = new Map<CritiqueDimension, DimensionScore>();
    const allIssues: CritiqueIssue[] = [];

    for (const dimension of dimensions) {
      const score = await this.scoreDimension(request.content, dimension, request.context);
      dimensionScores.set(dimension, score);
      allIssues.push(...score.issues.map(issue => this.createIssue(dimension, issue)));
    }

    // Calculate overall score (weighted average)
    const overallScore = this.calculateOverallScore(dimensionScores);

    // Generate suggestions
    const suggestions = this.generateSuggestions(allIssues, dimensionScores);

    // Determine if revision is needed
    const shouldRevise = overallScore < this.config.minConfidenceThreshold || allIssues.some(i => i.severity === 'critical');

    const result: CritiqueResult = {
      id: `critique-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      requestId: request.id,
      overallScore,
      dimensionScores,
      issues: allIssues,
      suggestions,
      shouldRevise,
      reasoning: this.generateReasoning(dimensionScores, allIssues),
      timestamp: startTime,
    };

    // Record in history
    this.recordCritique(result);

    this.emit('critique:completed', {
      resultId: result.id,
      overallScore,
      issueCount: allIssues.length,
      shouldRevise,
    });

    return result;
  }

  private async scoreDimension(
    content: string,
    dimension: CritiqueDimension,
    context?: string
  ): Promise<DimensionScore> {
    // Dimension-specific scoring (placeholder - actual impl uses LLM)
    const scorer = this.getDimensionScorer(dimension);
    return scorer(content, context);
  }

  private getDimensionScorer(
    dimension: CritiqueDimension
  ): (content: string, context?: string) => DimensionScore {
    const scorers: Record<CritiqueDimension, (content: string, context?: string) => DimensionScore> = {
      accuracy: this.scoreAccuracy.bind(this),
      completeness: this.scoreCompleteness.bind(this),
      relevance: this.scoreRelevance.bind(this),
      clarity: this.scoreClarity.bind(this),
      safety: this.scoreSafety.bind(this),
      efficiency: this.scoreEfficiency.bind(this),
      consistency: this.scoreConsistency.bind(this),
    };

    return scorers[dimension] || this.defaultScorer.bind(this);
  }

  // ============ Dimension Scorers ============

  private scoreAccuracy(content: string, _context?: string): DimensionScore {
    const issues: string[] = [];

    // Check for hedging language that might indicate uncertainty
    const hedgingPatterns = /\b(might|maybe|possibly|could be|uncertain|not sure)\b/gi;
    const hedgingCount = (content.match(hedgingPatterns) || []).length;

    if (hedgingCount > 3) {
      issues.push('High uncertainty detected - consider verifying claims');
    }

    // Check for contradictions (simple heuristic)
    if (content.includes('not') && content.includes('is')) {
      const sentences = content.split(/[.!?]/);
      // Simple contradiction detection
      if (sentences.some(s => s.includes('is not') && s.length < 50)) {
        issues.push('Potential contradiction detected');
      }
    }

    const score = Math.max(0.3, 1 - hedgingCount * 0.1 - issues.length * 0.15);

    return {
      dimension: 'accuracy',
      score,
      feedback:
        score > 0.8
          ? 'Content appears accurate and well-supported'
          : 'Consider verifying accuracy of claims',
      issues,
    };
  }

  private scoreCompleteness(content: string, context?: string): DimensionScore {
    const issues: string[] = [];

    // Check content length
    if (content.length < 100) {
      issues.push('Response may be too brief');
    }

    // Check for incomplete sentences
    if (content.endsWith('...') || content.endsWith(',')) {
      issues.push('Response appears incomplete');
    }

    // Check if context questions are addressed (if provided)
    if (context) {
      const questionWords = context.match(/\b(what|why|how|when|where|who)\b/gi) || [];
      if (questionWords.length > 2 && content.length < 200) {
        issues.push('Multiple questions may not be fully addressed');
      }
    }

    const score = Math.max(0.3, 1 - issues.length * 0.2);

    return {
      dimension: 'completeness',
      score,
      feedback:
        score > 0.8 ? 'Response appears comprehensive' : 'Response may benefit from more detail',
      issues,
    };
  }

  private scoreRelevance(content: string, context?: string): DimensionScore {
    const issues: string[] = [];

    if (!context) {
      return {
        dimension: 'relevance',
        score: 0.8, // Assume relevant if no context
        feedback: 'Unable to assess relevance without context',
        issues: [],
      };
    }

    // Extract keywords from context
    const contextKeywords = this.extractKeywords(context);
    const contentKeywords = this.extractKeywords(content);

    // Calculate overlap
    const overlap = [...contextKeywords].filter(k => contentKeywords.has(k)).length;
    const relevanceRatio = overlap / Math.max(contextKeywords.size, 1);

    if (relevanceRatio < 0.2) {
      issues.push('Response may not adequately address the context');
    }

    const score = Math.min(1, relevanceRatio + 0.3);

    return {
      dimension: 'relevance',
      score,
      feedback:
        score > 0.7 ? 'Response is relevant to the context' : 'Consider addressing the context more directly',
      issues,
    };
  }

  private scoreClarity(content: string, _context?: string): DimensionScore {
    const issues: string[] = [];

    // Check sentence length
    const sentences = content.split(/[.!?]/);
    const longSentences = sentences.filter(s => s.trim().split(/\s+/).length > 30);

    if (longSentences.length > 2) {
      issues.push('Some sentences are too long - consider breaking them up');
    }

    // Check for jargon/complexity
    const complexWords = content.match(/\b\w{12,}\b/g) || [];
    if (complexWords.length > 5) {
      issues.push('Consider simplifying complex terminology');
    }

    // Check for structure
    const hasStructure = content.includes('\n') || content.includes('- ') || content.includes('1.');
    if (content.length > 500 && !hasStructure) {
      issues.push('Long response could benefit from better structure');
    }

    const score = Math.max(0.4, 1 - issues.length * 0.15);

    return {
      dimension: 'clarity',
      score,
      feedback:
        score > 0.8 ? 'Response is clear and well-structured' : 'Consider improving clarity',
      issues,
    };
  }

  private scoreSafety(content: string, _context?: string): DimensionScore {
    const issues: string[] = [];

    // Check for potentially harmful patterns
    const harmfulPatterns = [
      /\b(hack|exploit|bypass|vulnerability)\b/i,
      /\b(password|credential|secret|key)\b/i,
    ];

    for (const pattern of harmfulPatterns) {
      if (pattern.test(content)) {
        issues.push('Content may contain sensitive security-related information');
        break;
      }
    }

    // Check for potential PII patterns
    const piiPatterns = [
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/, // Email
      /\b\d{3}-\d{2}-\d{4}\b/, // SSN-like
    ];

    for (const pattern of piiPatterns) {
      if (pattern.test(content)) {
        issues.push('Content may contain personally identifiable information');
        break;
      }
    }

    const score = issues.length === 0 ? 1 : Math.max(0.5, 1 - issues.length * 0.25);

    return {
      dimension: 'safety',
      score,
      feedback: score > 0.9 ? 'No safety concerns detected' : 'Review for potential safety issues',
      issues,
    };
  }

  private scoreEfficiency(content: string, _context?: string): DimensionScore {
    const issues: string[] = [];

    // Check for redundancy
    const sentences = content.split(/[.!?]/);
    const uniqueSentences = new Set(sentences.map(s => s.trim().toLowerCase()));

    if (sentences.length - uniqueSentences.size > 2) {
      issues.push('Response contains redundant content');
    }

    // Check for verbosity
    const wordCount = content.split(/\s+/).length;
    const charPerWord = content.length / wordCount;

    if (charPerWord > 7 && wordCount > 100) {
      issues.push('Consider using more concise language');
    }

    const score = Math.max(0.5, 1 - issues.length * 0.2);

    return {
      dimension: 'efficiency',
      score,
      feedback: score > 0.8 ? 'Response is concise and efficient' : 'Consider making response more concise',
      issues,
    };
  }

  private scoreConsistency(content: string, _context?: string): DimensionScore {
    const issues: string[] = [];

    // Check for tense consistency
    const pastTense = (content.match(/\b\w+ed\b/g) || []).length;
    const presentTense = (content.match(/\b(is|are|has|have|does|do)\b/gi) || []).length;

    if (pastTense > 5 && presentTense > 5) {
      const ratio = Math.min(pastTense, presentTense) / Math.max(pastTense, presentTense);
      if (ratio > 0.6) {
        issues.push('Inconsistent tense usage detected');
      }
    }

    const score = Math.max(0.6, 1 - issues.length * 0.2);

    return {
      dimension: 'consistency',
      score,
      feedback:
        score > 0.8 ? 'Response maintains consistency' : 'Consider reviewing for consistency',
      issues,
    };
  }

  private defaultScorer(_content: string, _context?: string): DimensionScore {
    return {
      dimension: 'accuracy',
      score: 0.7,
      feedback: 'Default scoring applied',
      issues: [],
    };
  }

  // ============ Revision ============

  async revise(request: RevisionRequest): Promise<RevisionResult> {
    const maxIterations = request.maxIterations || this.config.maxIterations;
    const history: RevisionIteration[] = [];
    let current = request.original;
    let currentCritique = request.critique;

    this.emit('revision:started', { iterations: maxIterations });

    for (let i = 0; i < maxIterations; i++) {
      if (!currentCritique.shouldRevise) {
        break;
      }

      // Generate revision based on critique
      const revised = await this.generateRevision(current, currentCritique);

      // Critique the revision
      const newCritique = await this.critique({
        id: `revision-${i + 1}`,
        content: revised,
        dimensions: [...currentCritique.dimensionScores.keys()],
      });

      const changes = this.identifyChanges(current, revised);

      history.push({
        iteration: i + 1,
        content: revised,
        critique: newCritique,
        changes,
      });

      // Check if we've improved enough
      if (newCritique.overallScore >= this.config.minConfidenceThreshold && !newCritique.shouldRevise) {
        current = revised;
        currentCritique = newCritique;
        break;
      }

      // Check if we've stopped improving
      if (newCritique.overallScore <= currentCritique.overallScore) {
        break; // Stop if not improving
      }

      current = revised;
      currentCritique = newCritique;
    }

    const improvements = history.flatMap(h => h.changes);

    this.emit('revision:completed', {
      iterations: history.length,
      finalScore: currentCritique.overallScore,
      improvements: improvements.length,
    });

    return {
      revised: current,
      iterations: history.length,
      improvements,
      finalScore: currentCritique.overallScore,
      history,
    };
  }

  private async generateRevision(content: string, critique: CritiqueResult): Promise<string> {
    // Placeholder - actual impl uses LLM to revise based on critique
    let revised = content;

    // Apply simple heuristic revisions based on issues
    for (const issue of critique.issues) {
      if (issue.severity === 'critical' || issue.severity === 'high') {
        revised = this.applyHeuristicFix(revised, issue);
      }
    }

    return revised;
  }

  private applyHeuristicFix(content: string, issue: CritiqueIssue): string {
    // Simple heuristic fixes
    if (issue.description.includes('too long')) {
      // Simplify long sentences
      return content.replace(/([^.!?]{100,}[.!?])/g, match => {
        const parts = match.split(/, /);
        if (parts.length > 2) {
          return parts.slice(0, 2).join(', ') + '.';
        }
        return match;
      });
    }

    return content;
  }

  private identifyChanges(original: string, revised: string): string[] {
    const changes: string[] = [];

    if (original.length !== revised.length) {
      changes.push(
        revised.length < original.length
          ? `Reduced length by ${original.length - revised.length} characters`
          : `Expanded by ${revised.length - original.length} characters`
      );
    }

    // Count sentence changes
    const origSentences = original.split(/[.!?]/).length;
    const revSentences = revised.split(/[.!?]/).length;

    if (origSentences !== revSentences) {
      changes.push(`Sentence count changed from ${origSentences} to ${revSentences}`);
    }

    return changes;
  }

  // ============ Reflection ============

  async reflect(taskId: string, content: string, outcome: { success: boolean; score: number }): Promise<ReflectionResult> {
    if (!this.config.enableReflection) {
      return {
        insights: [],
        patterns: [],
        improvements: [],
        confidence: 0,
      };
    }

    this.emit('reflection:started', { taskId });

    const insights: string[] = [];
    const patterns: string[] = [];
    const improvements: string[] = [];

    // Analyze past critiques for this content type
    const relevantCritiques = this.critiqueHistory.filter(c =>
      this.calculateContentSimilarity(c.requestId, content) > 0.5
    );

    // Extract patterns from critique history
    if (relevantCritiques.length >= 3) {
      const commonIssues = this.findCommonIssues(relevantCritiques);
      patterns.push(...commonIssues.map(issue => `Recurring issue: ${issue}`));
    }

    // Generate insights based on outcome
    if (outcome.success) {
      insights.push('Successful approach - consider reinforcing similar patterns');
    } else {
      insights.push('Unsuccessful outcome - review critique feedback for improvements');

      // Find highest-severity issues from recent critiques
      const recentIssues = relevantCritiques
        .flatMap(c => c.issues)
        .filter(i => i.severity === 'high' || i.severity === 'critical');

      improvements.push(...recentIssues.slice(0, 3).map(i => i.description));
    }

    const confidence = relevantCritiques.length >= 3 ? 0.8 : 0.5;

    const result: ReflectionResult = {
      insights,
      patterns,
      improvements,
      confidence,
    };

    this.emit('reflection:completed', { taskId, insights: insights.length, patterns: patterns.length });

    return result;
  }

  private findCommonIssues(critiques: CritiqueResult[]): string[] {
    const issueCounts = new Map<string, number>();

    for (const critique of critiques) {
      for (const issue of critique.issues) {
        const key = issue.dimension + ':' + issue.severity;
        issueCounts.set(key, (issueCounts.get(key) || 0) + 1);
      }
    }

    return Array.from(issueCounts.entries())
      .filter(([, count]) => count >= 2)
      .map(([key]) => key);
  }

  private calculateContentSimilarity(_id: string, _content: string): number {
    // Placeholder - would use actual content comparison
    return 0.3;
  }

  // ============ Utilities ============

  private createIssue(dimension: CritiqueDimension, description: string): CritiqueIssue {
    return {
      severity: this.assessSeverity(description),
      dimension,
      description,
    };
  }

  private assessSeverity(description: string): CritiqueIssue['severity'] {
    const criticalPatterns = /\b(critical|security|harmful|dangerous)\b/i;
    const highPatterns = /\b(error|incorrect|wrong|missing)\b/i;
    const mediumPatterns = /\b(consider|improve|could|should)\b/i;

    if (criticalPatterns.test(description)) return 'critical';
    if (highPatterns.test(description)) return 'high';
    if (mediumPatterns.test(description)) return 'medium';
    return 'low';
  }

  private calculateOverallScore(scores: Map<CritiqueDimension, DimensionScore>): number {
    if (scores.size === 0) return 0;

    const weights: Record<CritiqueDimension, number> = {
      accuracy: 0.25,
      safety: 0.2,
      relevance: 0.2,
      completeness: 0.15,
      clarity: 0.1,
      consistency: 0.05,
      efficiency: 0.05,
    };

    let weightedSum = 0;
    let totalWeight = 0;

    for (const [dimension, score] of scores) {
      const weight = weights[dimension] || 0.1;
      weightedSum += score.score * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  private generateSuggestions(
    issues: CritiqueIssue[],
    _scores: Map<CritiqueDimension, DimensionScore>
  ): string[] {
    const suggestions: string[] = [];

    // Prioritize high/critical issues
    const prioritized = [...issues].sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    for (const issue of prioritized.slice(0, 5)) {
      if (issue.suggestion) {
        suggestions.push(issue.suggestion);
      } else {
        suggestions.push(`Address: ${issue.description}`);
      }
    }

    return suggestions;
  }

  private generateReasoning(
    scores: Map<CritiqueDimension, DimensionScore>,
    issues: CritiqueIssue[]
  ): string {
    const parts: string[] = [];

    parts.push(`Analyzed ${scores.size} dimensions.`);

    const strongDimensions = [...scores.entries()].filter(([, s]) => s.score > 0.8);
    if (strongDimensions.length > 0) {
      parts.push(`Strong areas: ${strongDimensions.map(([d]) => d).join(', ')}`);
    }

    const weakDimensions = [...scores.entries()].filter(([, s]) => s.score < 0.6);
    if (weakDimensions.length > 0) {
      parts.push(`Areas for improvement: ${weakDimensions.map(([d]) => d).join(', ')}`);
    }

    parts.push(`Found ${issues.length} issues (${issues.filter(i => i.severity === 'critical' || i.severity === 'high').length} high priority)`);

    return parts.join(' ');
  }

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
      'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
      'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or',
      'but', 'if', 'this', 'that', 'it', 'as',
    ]);

    return new Set(
      text
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w))
    );
  }

  // ============ History ============

  private recordCritique(result: CritiqueResult): void {
    this.critiqueHistory.push(result);

    if (this.critiqueHistory.length > this.maxHistorySize) {
      this.critiqueHistory = this.critiqueHistory.slice(-this.maxHistorySize);
    }
  }

  getCritiqueHistory(limit?: number): CritiqueResult[] {
    const history = [...this.critiqueHistory];
    return limit ? history.slice(-limit) : history;
  }

  getStats(): {
    totalCritiques: number;
    avgScore: number;
    revisionRate: number;
    issuesByDimension: Record<string, number>;
  } {
    const totalCritiques = this.critiqueHistory.length;
    const avgScore =
      totalCritiques > 0
        ? this.critiqueHistory.reduce((sum, c) => sum + c.overallScore, 0) / totalCritiques
        : 0;

    const revisionRate =
      totalCritiques > 0
        ? this.critiqueHistory.filter(c => c.shouldRevise).length / totalCritiques
        : 0;

    const issuesByDimension: Record<string, number> = {};
    for (const critique of this.critiqueHistory) {
      for (const issue of critique.issues) {
        issuesByDimension[issue.dimension] = (issuesByDimension[issue.dimension] || 0) + 1;
      }
    }

    return { totalCritiques, avgScore, revisionRate, issuesByDimension };
  }
}

// Export singleton getter
export function getCritiqueAgent(): CritiqueAgent {
  return CritiqueAgent.getInstance();
}
