/**
 * A/B Testing Component
 * Manage and monitor prompt experiments
 */

import {
  Component,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule, DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronIpcService } from '../../core/services/ipc';

// ============================================
// Types
// ============================================

interface Variant {
  id: string;
  name: string;
  template: string;
  weight: number;
  metadata?: Record<string, unknown>;
}

interface Experiment {
  id: string;
  name: string;
  description?: string;
  taskType: string;
  variants: Variant[];
  status: 'draft' | 'running' | 'paused' | 'completed';
  startedAt?: number;
  endedAt?: number;
  minSamples: number;
  confidenceThreshold: number;
  createdAt: number;
  updatedAt: number;
}

interface ExperimentResult {
  variantId: string;
  samples: number;
  successes: number;
  successRate: number;
  avgDuration: number;
  avgTokens: number;
  totalDuration: number;
  totalTokens: number;
}

interface ExperimentWinner {
  variant: Variant;
  confidence: number;
  improvement: number;
}

interface ExperimentStats {
  totalExperiments: number;
  running: number;
  completed: number;
  draft: number;
  paused: number;
  totalOutcomes: number;
}

interface NewVariant {
  name: string;
  template: string;
  weight: number;
}

// ============================================
// Component
// ============================================

@Component({
  selector: 'app-ab-testing',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, DecimalPipe, PercentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ab-testing.component.html',
  styleUrl: './ab-testing.component.scss',
})
export class ABTestingComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);

  // State
  experiments = signal<Experiment[]>([]);
  experimentResults = signal<Map<string, ExperimentResult[]>>(new Map());
  experimentWinners = signal<Map<string, ExperimentWinner>>(new Map());
  stats = signal<ExperimentStats | null>(null);
  statusFilter = signal<'all' | Experiment['status']>('all');
  selectedExperiment = signal<Experiment | null>(null);

  // Computed
  filteredExperiments = computed(() => {
    const filter = this.statusFilter();
    const exps = this.experiments();
    if (filter === 'all') return exps;
    return exps.filter((e) => e.status === filter);
  });

  // Dialog state
  showCreateDialog = false;
  showResultsDialog = false;
  editingExperiment: Experiment | null = null;

  // New experiment form
  newExperiment = this.getEmptyExperiment();

  // Lifecycle
  private refreshInterval: ReturnType<typeof setInterval> | null = null;

  private get api() {
    return this.ipc.getApi();
  }

  ngOnInit(): void {
    this.refreshData();
    // Auto-refresh every 30 seconds for running experiments
    this.refreshInterval = setInterval(() => this.refreshData(), 30000);
  }

  ngOnDestroy(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
  }

  // Data Loading
  async refreshData(): Promise<void> {
    await Promise.all([this.loadExperiments(), this.loadStats()]);
  }

  async loadExperiments(): Promise<void> {
    try {
      const response = await this.api?.abListExperiments() as { success: boolean; data?: Experiment[] } | undefined;
      if (response?.success && response.data) {
        this.experiments.set(response.data);

        // Load results and winners for each experiment
        for (const exp of response.data) {
          await this.loadExperimentResults(exp.id);
          if (exp.status === 'completed' || exp.status === 'running') {
            await this.loadExperimentWinner(exp.id);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load experiments:', error);
    }
  }

  async loadExperimentResults(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abGetResults(experimentId) as { success: boolean; data?: ExperimentResult[] } | undefined;
      if (response?.success && response.data) {
        const current = this.experimentResults();
        const newMap = new Map(current);
        newMap.set(experimentId, response.data);
        this.experimentResults.set(newMap);
      }
    } catch (error) {
      console.error('Failed to load experiment results:', error);
    }
  }

  async loadExperimentWinner(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abGetWinner(experimentId) as { success: boolean; data?: ExperimentWinner | null } | undefined;
      if (response?.success && response.data) {
        const current = this.experimentWinners();
        const newMap = new Map(current);
        newMap.set(experimentId, response.data);
        this.experimentWinners.set(newMap);
      }
    } catch (error) {
      console.error('Failed to load experiment winner:', error);
    }
  }

  async loadStats(): Promise<void> {
    try {
      const response = await this.api?.abGetStats() as { success: boolean; data?: ExperimentStats } | undefined;
      if (response?.success && response.data) {
        this.stats.set(response.data);
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  }

  // Experiment Actions
  async startExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abStartExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to start experiment:', error);
    }
  }

  async pauseExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abPauseExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to pause experiment:', error);
    }
  }

  async completeExperiment(experimentId: string): Promise<void> {
    try {
      const response = await this.api?.abCompleteExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to complete experiment:', error);
    }
  }

  async deleteExperiment(experimentId: string): Promise<void> {
    if (!confirm('Are you sure you want to delete this experiment?')) return;

    try {
      const response = await this.api?.abDeleteExperiment(experimentId) as { success: boolean } | undefined;
      if (response?.success) {
        await this.refreshData();
      }
    } catch (error) {
      console.error('Failed to delete experiment:', error);
    }
  }

  // Dialog Management
  editExperiment(experiment: Experiment): void {
    this.editingExperiment = experiment;
    this.newExperiment = {
      name: experiment.name,
      description: experiment.description || '',
      taskType: experiment.taskType,
      minSamples: experiment.minSamples,
      confidenceThreshold: experiment.confidenceThreshold,
      variants: experiment.variants.map((v) => ({
        name: v.name,
        template: v.template,
        weight: v.weight,
      })),
    };
    this.showCreateDialog = true;
  }

  viewResults(experiment: Experiment): void {
    this.selectedExperiment.set(experiment);
    this.showResultsDialog = true;
  }

  closeDialog(): void {
    this.showCreateDialog = false;
    this.editingExperiment = null;
    this.newExperiment = this.getEmptyExperiment();
  }

  closeResultsDialog(): void {
    this.showResultsDialog = false;
    this.selectedExperiment.set(null);
  }

  // Form Management
  getEmptyExperiment(): {
    name: string;
    description: string;
    taskType: string;
    minSamples: number;
    confidenceThreshold: number;
    variants: NewVariant[];
  } {
    return {
      name: '',
      description: '',
      taskType: '',
      minSamples: 30,
      confidenceThreshold: 0.95,
      variants: [
        { name: 'Control', template: '', weight: 0.5 },
        { name: 'Variant B', template: '', weight: 0.5 },
      ],
    };
  }

  addVariant(): void {
    const letter = this.getVariantLetter(this.newExperiment.variants.length);
    this.newExperiment.variants.push({
      name: `Variant ${letter}`,
      template: '',
      weight: 0.5,
    });
  }

  removeVariant(index: number): void {
    if (this.newExperiment.variants.length > 2) {
      this.newExperiment.variants.splice(index, 1);
    }
  }

  getVariantLetter(index: number): string {
    return String.fromCharCode(65 + index); // A, B, C, ...
  }

  isFormValid(): boolean {
    return (
      this.newExperiment.name.trim() !== '' &&
      this.newExperiment.taskType.trim() !== '' &&
      this.newExperiment.variants.length >= 2 &&
      this.newExperiment.variants.every(
        (v) => v.name.trim() !== '' && v.template.trim() !== ''
      )
    );
  }

  async saveExperiment(): Promise<void> {
    if (!this.isFormValid()) return;

    try {
      if (this.editingExperiment) {
        await this.api?.abUpdateExperiment({
          experimentId: this.editingExperiment.id,
          updates: {
            name: this.newExperiment.name,
            description: this.newExperiment.description,
            minSamples: this.newExperiment.minSamples,
            confidenceThreshold: this.newExperiment.confidenceThreshold,
          },
        });
      } else {
        await this.api?.abCreateExperiment({
          name: this.newExperiment.name,
          description: this.newExperiment.description,
          taskType: this.newExperiment.taskType,
          minSamples: this.newExperiment.minSamples,
          confidenceThreshold: this.newExperiment.confidenceThreshold,
          variants: this.newExperiment.variants,
        });
      }

      this.closeDialog();
      await this.refreshData();
    } catch (error) {
      console.error('Failed to save experiment:', error);
    }
  }

  // Helpers
  getVariantResult(experimentId: string, variantId: string): ExperimentResult | null {
    const results = this.experimentResults().get(experimentId);
    return results?.find((r) => r.variantId === variantId) || null;
  }

  isWinningVariant(experimentId: string, variantId: string): boolean {
    const winner = this.experimentWinners().get(experimentId);
    return winner?.variant.id === variantId;
  }
}
