import { detectUsedLessons } from '../memory/retrieval-eval/lesson-use-detector';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import { getObservationStore } from './observation-store';
import type { Reflection, ObservationConfig } from './observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from './observation.types';

/**
 * PolicyAdapter - Queries the ObservationStore for relevant reflections and formats
 * them for injection into agent prompts.
 *
 * This component bridges the observation system and agent instances by:
 * 1. Querying for contextually relevant reflections
 * 2. Filtering by task type applicability
 * 3. Respecting token budgets
 * 4. Formatting as readable markdown
 * 5. Recording injection events for feedback tracking
 */
export class PolicyAdapter {
  private static instance: PolicyAdapter | null = null;

  private logger = getLogger('PolicyAdapter');
  private readonly surfaced = new Map<string, { lessons: { id: string; text: string }[]; replies: Set<string> }>();
  private config = { ...DEFAULT_OBSERVATION_CONFIG };

  static getInstance(): PolicyAdapter {
    if (!this.instance) {
      this.instance = new PolicyAdapter();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    this.logger.debug('PolicyAdapter initialized');
  }

  /**
   * Configure the policy adapter with custom settings
   */
  configure(config: Partial<ObservationConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.debug('PolicyAdapter configured', { config: this.config });
  }

  /**
   * Build observation context by querying for relevant reflections and formatting them.
   * This method is called during instance creation to inject learned knowledge.
   *
   * @param taskContext - The task description or context to match against
   * @param instanceId - Optional instance ID for logging
   * @param taskType - Optional task type to filter reflections by applicability
   * @returns Formatted markdown string to inject into agent prompt, or empty string on error
   */
  async buildObservationContext(
    taskContext: string,
    instanceId?: string,
    taskType?: string
  ): Promise<string> {
    if (instanceId) this.surfaced.delete(instanceId);
    if (!this.config.enabled) return '';
    try {
      this.logger.debug('Building observation context', { instanceId, taskType });

      // Query for relevant reflections
      const reflections = await getObservationStore().queryRelevantReflections(taskContext, {
        topK: this.config.maxReflectionsPerPrompt,
        minConfidence: 0.5,
      });

      if (!this.config.enabled) return '';
      if (reflections.length === 0) {
        this.logger.debug('No relevant reflections found');
        return '';
      }

      // Filter by task type applicability if specified
      let filtered = reflections;
      if (taskType) {
        filtered = reflections.filter((r) =>
          r.applicability?.includes(taskType)
        );
        this.logger.debug('Filtered reflections by task type', {
          taskType,
          before: reflections.length,
          after: filtered.length,
        });
      }

      if (filtered.length === 0) {
        this.logger.debug('No reflections matched task type filter');
        return '';
      }

      // Respect token budget - accumulate reflections until budget would be exceeded
      const budget = this.config.policyTokenBudget;
      const selected: Reflection[] = [];
      let currentTokens = 0;

      // Account for header overhead (estimate ~50 tokens)
      const headerOverhead = 200; // characters (50 tokens * 4 chars/token)
      currentTokens += headerOverhead / 4;

      for (const reflection of filtered) {
        // Estimate tokens for this reflection (including formatting)
        const reflectionText = `- **${reflection.title}** (confidence: ${Math.round(reflection.confidence * 100)}%): ${reflection.insight}\n`;
        const estimatedTokens = sharedEstimateTokens(reflectionText);

        if (currentTokens + estimatedTokens > budget) {
          this.logger.debug('Token budget reached, stopping reflection selection', {
            currentTokens,
            budget,
            selectedCount: selected.length,
          });
          break;
        }

        selected.push(reflection);
        currentTokens += estimatedTokens;
      }

      if (selected.length === 0) {
        this.logger.debug('No reflections fit within token budget');
        return '';
      }

      // Format as markdown
      const lines = [
        '## Learned Observations',
        '',
        'The following insights were learned from previous sessions:',
        '',
      ];

      for (const reflection of selected) {
        const confidencePercent = Math.round(reflection.confidence * 100);
        lines.push(`- **${reflection.title}** (confidence: ${confidencePercent}%): ${reflection.insight}`);

        // Record injection
        try {
          await getObservationStore().recordShown(reflection.id);
        } catch (error) {
          // Don't fail the whole operation if injection recording fails
          this.logger.warn('Failed to record injection', {
            error,
            reflectionId: reflection.id,
          });
        }
      }

      if (instanceId) this.surfaced.set(instanceId, { lessons: selected.map(r => ({ id: r.id, text: r.insight })), replies: new Set() });
      lines.push(''); // Trailing newline

      const formatted = lines.join('\n');
      this.logger.info('Built observation context', {
        instanceId,
        taskType,
        reflectionCount: selected.length,
        estimatedTokens: Math.round(currentTokens),
      });

      return formatted;
    } catch (error) {
      this.logger.warn('Failed to build observation context, returning empty string', {
        error,
        instanceId,
        taskType,
      });
      return '';
    }
  }

  cleanupInstance(instanceId: string): void { this.surfaced.delete(instanceId); }

  noteOutput(instanceId: string, message: Pick<OutputMessage, 'id' | 'type' | 'content'>): void {
    const entry = this.surfaced.get(instanceId);
    if (!entry || message.type !== 'assistant' || !message.content?.trim()) return;
    if (!entry.replies.has(message.id) && entry.replies.size >= 3) {
      this.surfaced.delete(instanceId);
      return;
    }
    // Providers update the same message as it streams; count replies, not chunks.
    entry.replies.add(message.id);
    const used = new Set(detectUsedLessons(message.content, entry.lessons));
    for (const id of used) {
      try { getObservationStore().recordUse(id); }
      catch (error) { this.logger.warn('Failed to record observation use', { reflectionId: id, error }); }
    }
    entry.lessons = entry.lessons.filter(lesson => !used.has(lesson.id));
    if (!entry.lessons.length) this.surfaced.delete(instanceId);
  }

}

/**
 * Convenience getter for PolicyAdapter singleton
 */
export function getPolicyAdapter(): PolicyAdapter {
  return PolicyAdapter.getInstance();
}
