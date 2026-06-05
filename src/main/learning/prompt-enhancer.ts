/**
 * Prompt Enhancer
 * Automatically enhances user prompts based on learned patterns and context
 *
 * Features:
 * - Context injection based on task type
 * - Pattern application from successful outcomes
 * - Error prevention based on known failure patterns
 * - Prompt structure improvement
 */

import { EventEmitter } from 'events';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import {
  PromptEnhancement,
  EnhancementApplied,
  EnhancementType,
  TaskPattern,
  LearningInsight,
  Experience,
  SelfImprovementConfig,
} from '../../shared/types/self-improvement.types';
import { OutcomeTracker } from './outcome-tracker';
import { StrategyLearner } from './strategy-learner';

interface EnhancementRule {
  type: EnhancementType;
  condition: (context: EnhancementContext) => boolean;
  apply: (context: EnhancementContext) => EnhancementResult | null;
  priority: number; // Higher = applied first
}

interface EnhancementContext {
  originalPrompt: string;
  taskType?: string;
  context?: string;
  experience?: Experience;
  insights: LearningInsight[];
  successPatterns: TaskPattern[];
  failurePatterns: TaskPattern[];
}

interface EnhancementResult {
  type: EnhancementType;
  description: string;
  insertedText: string;
  source?: string;
}

export class PromptEnhancer extends EventEmitter {
  private static instance: PromptEnhancer | null = null;
  private outcomeTracker: OutcomeTracker;
  private strategyLearner: StrategyLearner;
  private rules: EnhancementRule[] = [];
  private config: SelfImprovementConfig;

  static getInstance(): PromptEnhancer {
    if (!this.instance) {
      this.instance = new PromptEnhancer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    super();
    this.outcomeTracker = OutcomeTracker.getInstance();
    this.strategyLearner = StrategyLearner.getInstance();
    this.config = this.outcomeTracker.getConfig();
    this.initializeRules();
  }

  private initializeRules(): void {
    // Add rules in priority order (highest first)
    this.rules = [
      // Error prevention (highest priority)
      {
        type: 'error_prevention',
        priority: 100,
        condition: ctx => ctx.failurePatterns.length > 0,
        apply: ctx => this.applyErrorPrevention(ctx),
      },

      // Structure improvement
      {
        type: 'structure_improvement',
        priority: 90,
        condition: ctx => this.needsStructureImprovement(ctx.originalPrompt),
        apply: ctx => this.applyStructureImprovement(ctx),
      },

      // Constraint addition
      {
        type: 'constraint_addition',
        priority: 80,
        condition: ctx => !!ctx.taskType && !ctx.originalPrompt.toLowerCase().includes('constraint'),
        apply: ctx => this.applyConstraints(ctx),
      },

      // Pattern application
      {
        type: 'pattern_application',
        priority: 70,
        condition: ctx => ctx.successPatterns.length > 0,
        apply: ctx => this.applySuccessPatterns(ctx),
      },

      // Context injection
      {
        type: 'context_injection',
        priority: 60,
        condition: ctx => !!ctx.context || !!ctx.experience,
        apply: ctx => this.applyContextInjection(ctx),
      },

      // Example injection (lowest priority)
      {
        type: 'example_injection',
        priority: 50,
        condition: ctx => !!(ctx.experience?.examplePrompts && ctx.experience.examplePrompts.length > 0),
        apply: ctx => this.applyExampleInjection(ctx),
      },
    ];

    // Sort by priority (descending)
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  // ============ Main Enhancement Method ============

  enhance(prompt: string, taskType?: string, context?: string): PromptEnhancement {
    if (!this.config.enableAutoEnhancement) {
      return {
        originalPrompt: prompt,
        enhancedPrompt: prompt,
        enhancements: [],
        estimatedImpact: 0,
      };
    }

    // Gather context
    const experience = taskType ? this.outcomeTracker.getExperience(taskType) : undefined;
    const insights = this.outcomeTracker.getInsights(taskType, 0.7);

    const successPatterns = experience?.successfulPatterns || [];
    const failurePatterns = experience?.failurePatterns || [];

    const enhancementContext: EnhancementContext = {
      originalPrompt: prompt,
      taskType,
      context,
      experience,
      insights,
      successPatterns,
      failurePatterns,
    };

    // Apply rules
    const enhancements: EnhancementApplied[] = [];
    let enhancedPrompt = prompt;
    let totalTokensAdded = 0;
    const maxTokens = this.config.maxEnhancementTokens;

    for (const rule of this.rules) {
      if (totalTokensAdded >= maxTokens) break;

      if (rule.condition(enhancementContext)) {
        const result = rule.apply({
          ...enhancementContext,
          originalPrompt: enhancedPrompt,
        });

        if (result) {
          const tokenEstimate = this.estimateTokens(result.insertedText);

          if (totalTokensAdded + tokenEstimate <= maxTokens) {
            enhancedPrompt = this.insertEnhancement(enhancedPrompt, result);
            totalTokensAdded += tokenEstimate;

            enhancements.push({
              type: result.type,
              description: result.description,
              insertedText: result.insertedText,
              source: result.source,
            });
          }
        }
      }
    }

    const enhancement: PromptEnhancement = {
      originalPrompt: prompt,
      enhancedPrompt,
      enhancements,
      estimatedImpact: this.calculateImpact(enhancements, experience),
    };

    this.emit('prompt:enhanced', enhancement);
    return enhancement;
  }

  // ============ Enhancement Rules Implementation ============

  private applyErrorPrevention(ctx: EnhancementContext): EnhancementResult | null {
    // Find the most common failure patterns to warn about
    const relevantFailures = ctx.failurePatterns
      .filter(p => p.type === 'error_recovery' && p.sampleSize >= 3)
      .slice(0, 2);

    if (relevantFailures.length === 0) return null;

    const warnings = relevantFailures.map(p => {
      const [, errorType] = p.value.split(':');
      return this.getErrorPreventionAdvice(errorType);
    });

    const insertedText = `\n\n[Note: Based on past experiences, please be mindful of: ${warnings.join('; ')}]`;

    return {
      type: 'error_prevention',
      description: 'Added warning based on common failure patterns',
      insertedText,
      source: relevantFailures[0]?.value,
    };
  }

  private getErrorPreventionAdvice(errorType: string): string {
    const advice: Record<string, string> = {
      timeout: 'keeping responses focused to avoid timeouts',
      context_overflow: 'focusing on the most relevant files to avoid context overflow',
      permission: 'checking tool permissions before use',
      syntax_error: 'verifying syntax carefully',
      type_error: 'ensuring type safety',
      undefined_reference: 'checking for undefined variables',
    };

    return advice[errorType] || `avoiding ${errorType} issues`;
  }

  private needsStructureImprovement(prompt: string): boolean {
    // Check if prompt lacks structure
    const hasSteps = /step|first|then|finally/i.test(prompt);
    const hasConstraints = /must|should|don't|avoid/i.test(prompt);
    const isLong = prompt.length > 200;

    return isLong && !hasSteps && !hasConstraints;
  }

  private applyStructureImprovement(ctx: EnhancementContext): EnhancementResult | null {
    // Suggest a structured approach
    const insertedText =
      '\n\nPlease approach this task systematically:\n1. First understand the requirements\n2. Then explore the relevant code\n3. Finally implement the changes';

    return {
      type: 'structure_improvement',
      description: 'Added systematic approach suggestion',
      insertedText,
    };
  }

  private applyConstraints(ctx: EnhancementContext): EnhancementResult | null {
    // Add task-specific constraints
    const constraints = this.getTaskConstraints(ctx.taskType);
    if (!constraints) return null;

    const insertedText = `\n\nPlease ensure: ${constraints}`;

    return {
      type: 'constraint_addition',
      description: `Added ${ctx.taskType} constraints`,
      insertedText,
    };
  }

  private getTaskConstraints(taskType?: string): string | null {
    const constraints: Record<string, string> = {
      'feature-development': 'code follows existing patterns, includes tests, and updates documentation',
      'bug-fix': 'the fix addresses root cause, not just symptoms, and includes regression tests',
      refactor: 'behavior is preserved and all existing tests pass',
      'security-review': 'all potential vulnerabilities are documented with severity and remediation steps',
      'code-review': 'feedback is actionable, specific, and includes code examples where helpful',
      testing: 'tests cover edge cases and are maintainable',
    };

    return constraints[taskType || ''] || null;
  }

  private applySuccessPatterns(ctx: EnhancementContext): EnhancementResult | null {
    // Apply the most effective prompt structure patterns
    const promptPatterns = ctx.successPatterns
      .filter(p => p.type === 'prompt_structure' && p.effectiveness > 0.7)
      .slice(0, 2);

    if (promptPatterns.length === 0) return null;

    const patternSuggestions = promptPatterns.map(p => this.getPatternSuggestion(p.value)).filter(Boolean);

    if (patternSuggestions.length === 0) return null;

    const insertedText = `\n\n${patternSuggestions.join('\n')}`;

    return {
      type: 'pattern_application',
      description: 'Applied successful prompt patterns',
      insertedText,
      source: promptPatterns[0]?.value,
    };
  }

  private getPatternSuggestion(patternValue: string): string | null {
    const suggestions: Record<string, string> = {
      'step-by-step': 'Please work through this step by step.',
      'think-through': 'Think through the implications carefully before implementing.',
      'first-then-sequence': '', // Already implied in structure improvement
      'precision-request': 'Please be precise and specific in your implementation.',
      'example-included': '', // Handled by example injection
      'constraints-specified': '', // Handled by constraint addition
      'negative-constraints': 'Avoid making unnecessary changes beyond the scope of this task.',
    };

    return suggestions[patternValue] || null;
  }

  private applyContextInjection(ctx: EnhancementContext): EnhancementResult | null {
    if (!ctx.context && !ctx.experience) return null;

    const contextParts: string[] = [];

    // Add relevant context
    if (ctx.context) {
      const truncatedContext = ctx.context.slice(0, 500);
      contextParts.push(`Context: ${truncatedContext}`);
    }

    // Add experience-based context
    if (ctx.experience && ctx.experience.avgSuccessRate > 0) {
      const rate = Math.round(ctx.experience.avgSuccessRate * 100);
      contextParts.push(
        `Historical success rate for this task type: ${rate}% (${ctx.experience.sampleSize} attempts)`
      );
    }

    if (contextParts.length === 0) return null;

    const insertedText = `\n\n[${contextParts.join('\n')}]`;

    return {
      type: 'context_injection',
      description: 'Injected relevant context',
      insertedText,
    };
  }

  private applyExampleInjection(ctx: EnhancementContext): EnhancementResult | null {
    if (!ctx.experience?.examplePrompts) return null;

    // Find a successful example
    const successfulExample = ctx.experience.examplePrompts.find(e => e.outcome === 'success');

    if (!successfulExample) return null;

    const insertedText = `\n\n[Reference: A similar successful task used this approach: "${successfulExample.prompt.slice(0, 200)}..."]`;

    return {
      type: 'example_injection',
      description: 'Added reference to successful example',
      insertedText,
      source: ctx.experience.id,
    };
  }

  // ============ Helpers ============

  private insertEnhancement(prompt: string, result: EnhancementResult): string {
    // Most enhancements go at the end
    return prompt + result.insertedText;
  }

  private calculateImpact(enhancements: EnhancementApplied[], experience?: Experience): number {
    if (enhancements.length === 0) return 0;

    // Base impact from number of enhancements
    let impact = Math.min(0.3, enhancements.length * 0.1);

    // Additional impact if we have experience data
    if (experience && experience.avgSuccessRate > 0) {
      // Higher impact if current success rate is low
      impact += (1 - experience.avgSuccessRate) * 0.2;
    }

    // Boost for error prevention
    if (enhancements.some(e => e.type === 'error_prevention')) {
      impact += 0.1;
    }

    return Math.min(1, impact);
  }

  private estimateTokens(text: string): number {
    return sharedEstimateTokens(text);
  }

  // ============ Manual Enhancement API ============

  addCustomEnhancement(prompt: string, enhancement: string, position: 'start' | 'end' = 'end'): string {
    return position === 'start' ? enhancement + '\n\n' + prompt : prompt + '\n\n' + enhancement;
  }

  // ============ Configuration ============

  setEnabled(enabled: boolean): void {
    this.config.enableAutoEnhancement = enabled;
  }

  setMaxTokens(maxTokens: number): void {
    this.config.maxEnhancementTokens = maxTokens;
  }

  isEnabled(): boolean {
    return this.config.enableAutoEnhancement;
  }

  // ============ Analysis ============

  analyzePrompt(prompt: string): {
    hasStructure: boolean;
    hasConstraints: boolean;
    hasExamples: boolean;
    estimatedTokens: number;
    suggestions: string[];
  } {
    const hasStructure = /step|first|then|finally|1\.|2\./i.test(prompt);
    const hasConstraints = /must|should|don't|avoid|ensure/i.test(prompt);
    const hasExamples = /example|for instance|such as|like this/i.test(prompt);

    const suggestions: string[] = [];

    if (!hasStructure && prompt.length > 100) {
      suggestions.push('Consider adding step-by-step structure');
    }

    if (!hasConstraints) {
      suggestions.push('Consider specifying constraints or requirements');
    }

    if (!hasExamples && prompt.length > 200) {
      suggestions.push('Consider adding examples for clarity');
    }

    return {
      hasStructure,
      hasConstraints,
      hasExamples,
      estimatedTokens: this.estimateTokens(prompt),
      suggestions,
    };
  }
}

export function getPromptEnhancer(): PromptEnhancer {
  return PromptEnhancer.getInstance();
}
