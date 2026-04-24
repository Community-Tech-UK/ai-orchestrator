/**
 * GRPO Training Dashboard Component
 *
 * Displays self-improvement training metrics and insights:
 * - Task outcomes tracking
 * - Pattern effectiveness visualization
 * - Learning insights display
 * - Prompt enhancement recommendations
 * - A/B test results
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';

/** Task outcome from self-improvement tracking */
export interface TaskOutcome {
  id: string;
  instanceId: string;
  taskType: string;
  taskDescription: string;
  prompt: string;
  context?: string;
  agentUsed: string;
  modelUsed: string;
  workflowUsed?: string;
  toolsUsed: ToolUsageRecord[];
  tokensUsed: number;
  duration: number;
  success: boolean;
  completionScore?: number;
  userSatisfaction?: number;
  errorType?: string;
  errorMessage?: string;
  patterns: TaskPattern[];
  timestamp: number;
}

export interface ToolUsageRecord {
  tool: string;
  count: number;
  avgDuration: number;
  errorCount: number;
}

export interface TaskPattern {
  type: PatternType;
  value: string;
  effectiveness: number;
  sampleSize: number;
  lastUpdated: number;
}

export type PatternType =
  | 'tool_sequence'
  | 'agent_task_pairing'
  | 'model_task_pairing'
  | 'prompt_structure'
  | 'error_recovery'
  | 'context_selection'
  | 'workflow_shortcut';

export interface LearningInsight {
  id: string;
  type: 'pattern' | 'anti-pattern' | 'optimization' | 'recommendation';
  description: string;
  confidence: number;
  evidence: string[];
  taskTypes: string[];
  createdAt: number;
  appliedCount: number;
  successRate: number;
}

export interface Experience {
  id: string;
  taskType: string;
  description: string;
  successfulPatterns: TaskPattern[];
  failurePatterns: TaskPattern[];
  examplePrompts: ExamplePrompt[];
  sampleSize: number;
  avgSuccessRate: number;
  lastUpdated: number;
}

export interface ExamplePrompt {
  prompt: string;
  context?: string;
  outcome: 'success' | 'failure';
  lessonsLearned: string[];
}

export interface TrainingStats {
  totalOutcomes: number;
  successRate: number;
  patternCount: number;
  insightCount: number;
  experienceCount: number;
  topPatterns: TaskPattern[];
  recentInsights: LearningInsight[];
}

@Component({
  selector: 'app-grpo-dashboard',
  standalone: true,
  templateUrl: './grpo-dashboard.component.html',
  styleUrl: './grpo-dashboard.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GrpoDashboardComponent {
  /** Training stats */
  stats = input<TrainingStats | null>(null);

  /** All patterns */
  patterns = input<TaskPattern[]>([]);

  /** All insights */
  insights = input<LearningInsight[]>([]);

  /** All outcomes */
  outcomes = input<TaskOutcome[]>([]);

  /** Training active */
  isTrainingActive = input<boolean>(false);

  /** Events */
  refreshData = output<void>();
  exportData = output<void>();

  /** Pattern types */
  patternTypes: PatternType[] = [
    'tool_sequence',
    'agent_task_pairing',
    'model_task_pairing',
    'prompt_structure',
    'error_recovery',
    'context_selection',
    'workflow_shortcut',
  ];

  /** Filters */
  patternTypeFilter = signal<PatternType | ''>('');
  insightTypeFilter = signal<LearningInsight['type'] | ''>('');
  outcomeFilter = signal<'success' | 'failure' | ''>('');

  /** Selections */
  selectedOutcome = signal<TaskOutcome | null>(null);
  selectedInsight = signal<LearningInsight | null>(null);

  /** Filtered patterns */
  filteredPatterns = computed(() => {
    const filter = this.patternTypeFilter();
    let result = this.patterns();

    if (filter) {
      result = result.filter(p => p.type === filter);
    }

    return result.sort((a, b) => b.effectiveness - a.effectiveness).slice(0, 20);
  });

  /** Filtered insights */
  filteredInsights = computed(() => {
    const filter = this.insightTypeFilter();
    let result = this.insights();

    if (filter) {
      result = result.filter(i => i.type === filter);
    }

    return result.sort((a, b) => b.confidence - a.confidence).slice(0, 20);
  });

  /** Filtered outcomes */
  filteredOutcomes = computed(() => {
    const filter = this.outcomeFilter();
    let result = this.outcomes();

    if (filter === 'success') {
      result = result.filter(o => o.success);
    } else if (filter === 'failure') {
      result = result.filter(o => !o.success);
    }

    return result.sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  });

  getPatternTypeIcon(type: PatternType): string {
    switch (type) {
      case 'tool_sequence': return '🔧';
      case 'agent_task_pairing': return '🤖';
      case 'model_task_pairing': return '🧠';
      case 'prompt_structure': return '📝';
      case 'error_recovery': return '🔄';
      case 'context_selection': return '📋';
      case 'workflow_shortcut': return '⚡';
      default: return '❓';
    }
  }

  getInsightTypeIcon(type: LearningInsight['type']): string {
    switch (type) {
      case 'pattern': return '✅';
      case 'anti-pattern': return '⚠️';
      case 'optimization': return '🚀';
      case 'recommendation': return '💡';
      default: return '❓';
    }
  }

  formatPatternType(type: PatternType): string {
    return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '...';
  }

  onPatternFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.patternTypeFilter.set(target.value as PatternType | '');
  }

  onInsightFilterChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.insightTypeFilter.set(target.value as LearningInsight['type'] | '');
  }

  setOutcomeFilter(filter: 'success' | 'failure' | ''): void {
    this.outcomeFilter.set(filter);
  }

  selectOutcome(outcome: TaskOutcome): void {
    this.selectedOutcome.set(outcome);
    this.selectedInsight.set(null);
  }

  selectInsight(insight: LearningInsight): void {
    this.selectedInsight.set(insight);
    this.selectedOutcome.set(null);
  }

  clearOutcomeSelection(): void {
    this.selectedOutcome.set(null);
  }

  clearInsightSelection(): void {
    this.selectedInsight.set(null);
  }
}
