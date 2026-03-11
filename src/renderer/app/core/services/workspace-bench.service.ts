/**
 * Workspace Benchmark Harness Service
 *
 * Provides a dev-console-accessible benchmark harness for measuring workspace
 * performance: thread switching, transcript paint, and preset load times.
 *
 * Exposed on window.__workspaceBench in ngOnInit of AppComponent.
 */

import { inject, Injectable } from '@angular/core';
import type { Instance } from '../../core/state/instance/instance.types';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { PerfInstrumentationService } from './perf-instrumentation.service';
import { StressFixturesService } from './stress-fixtures.service';

export type BenchmarkPresetName = 'light' | 'medium' | 'heavy-markdown' | 'heavy-tools' | 'extreme';

export interface WorkspaceBenchmarkHarness {
  clear(): void;
  loadPreset(preset?: BenchmarkPresetName): Promise<Record<string, unknown>>;
  runThreadSwitchBenchmark(iterations?: number): Promise<Record<string, unknown>>;
  runWorkspaceBaseline(preset?: BenchmarkPresetName, iterations?: number): Promise<Record<string, unknown>>;
}

@Injectable({ providedIn: 'root' })
export class WorkspaceBenchService implements WorkspaceBenchmarkHarness {
  private perfService = inject(PerfInstrumentationService);
  private stressFixtures = inject(StressFixturesService);
  private instanceState = inject(InstanceStateService);

  clear(): void {
    for (const instanceId of Array.from(this.instanceState.state().instances.keys())) {
      if (instanceId.startsWith('benchmark:')) {
        this.instanceState.removeInstance(instanceId);
      }
    }
    this.instanceState.setSelectedInstance(null);
    this.perfService.clear();
  }

  async loadPreset(preset: BenchmarkPresetName = 'medium'): Promise<Record<string, unknown>> {
    const instanceId = `benchmark:${preset}`;
    const messages = this.generatePresetMessages(preset);
    this.ensureBenchmarkInstance(instanceId, preset);

    this.perfService.enable();
    this.perfService.clear();
    this.instanceState.updateInstance(instanceId, {
      outputBuffer: messages,
      lastActivity: Date.now(),
    });
    this.instanceState.setSelectedInstance(instanceId);
    await this.waitForPaint();

    return {
      preset,
      instanceId,
      messageCount: messages.length,
      summaries: this.perfService.getAllSummaries(),
      budgets: this.perfService.checkBudgets(),
    };
  }

  async runThreadSwitchBenchmark(iterations = 12): Promise<Record<string, unknown>> {
    const firstInstanceId = 'benchmark:switch-a';
    const secondInstanceId = 'benchmark:switch-b';

    this.ensureBenchmarkInstance(firstInstanceId, 'light');
    this.ensureBenchmarkInstance(secondInstanceId, 'medium');

    this.instanceState.updateInstance(firstInstanceId, {
      outputBuffer: this.generatePresetMessages('light'),
      lastActivity: Date.now(),
    });
    this.instanceState.updateInstance(secondInstanceId, {
      outputBuffer: this.generatePresetMessages('medium'),
      lastActivity: Date.now(),
    });

    this.perfService.enable();
    this.perfService.clear();
    this.instanceState.setSelectedInstance(firstInstanceId);
    await this.waitForPaint();

    for (let i = 0; i < iterations; i += 1) {
      this.instanceState.setSelectedInstance(secondInstanceId);
      await this.waitForPaint();
      this.instanceState.setSelectedInstance(firstInstanceId);
      await this.waitForPaint();
    }

    return {
      iterations,
      summaries: this.perfService.getAllSummaries(),
      budgets: this.perfService.checkBudgets(),
    };
  }

  async runWorkspaceBaseline(
    preset: BenchmarkPresetName = 'heavy-markdown',
    iterations = 12
  ): Promise<Record<string, unknown>> {
    await this.loadPreset(preset);
    return this.runThreadSwitchBenchmark(iterations);
  }

  private ensureBenchmarkInstance(instanceId: string, preset: BenchmarkPresetName): void {
    if (this.instanceState.getInstance(instanceId)) {
      return;
    }

    const messages = this.generatePresetMessages(preset);
    const now = Date.now();
    const instance: Instance = {
      id: instanceId,
      displayName: `Benchmark ${preset}`,
      createdAt: now,
      parentId: null,
      childrenIds: [],
      agentId: 'build',
      agentMode: 'build',
      provider: 'claude',
      status: 'idle',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: now,
      sessionId: instanceId,
      workingDirectory: '/benchmark',
      yoloMode: false,
      currentModel: 'benchmark',
      outputBuffer: messages,
    };

    this.instanceState.addInstance(instance);
  }

  private generatePresetMessages(preset: BenchmarkPresetName) {
    switch (preset) {
      case 'light':
        return this.stressFixtures.generateTranscript(50);
      case 'medium':
        return this.stressFixtures.generateTranscript(200, {
          includeCodeBlocks: true,
          includeToolCalls: true,
        });
      case 'heavy-markdown':
        return this.stressFixtures.generateLongMarkdownTranscript(500);
      case 'heavy-tools':
        return this.stressFixtures.generateToolHeavyTranscript(500);
      case 'extreme':
        return this.stressFixtures.generateMixedHeavyTranscript(2000);
    }
  }

  private async waitForPaint(): Promise<void> {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
  }
}
