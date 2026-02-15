import { getLogger } from '../logging/logger';
import { getObservationStore } from './observation-store';
import type { Reflection, ObservationConfig } from '../../shared/types/observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from '../../shared/types/observation.types';

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
  private static instance: PolicyAdapter;

  private logger = getLogger('PolicyAdapter');
  private config = { ...DEFAULT_OBSERVATION_CONFIG };

  static getInstance(): PolicyAdapter {
    if (!this.instance) {
      this.instance = new PolicyAdapter();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = undefined as unknown as PolicyAdapter;
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
    try {
      this.logger.debug('Building observation context', { instanceId, taskType });

      // Query for relevant reflections
      const reflections = await getObservationStore().queryRelevantReflections(taskContext, {
        topK: this.config.maxReflectionsPerPrompt,
        minConfidence: 0.5,
      });

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
        const estimatedTokens = reflectionText.length / 4;

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
          await getObservationStore().recordInjection(reflection.id, true);
        } catch (error) {
          // Don't fail the whole operation if injection recording fails
          this.logger.warn('Failed to record injection', {
            error,
            reflectionId: reflection.id,
          });
        }
      }

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
}

/**
 * Convenience getter for PolicyAdapter singleton
 */
export function getPolicyAdapter(): PolicyAdapter {
  return PolicyAdapter.getInstance();
}
