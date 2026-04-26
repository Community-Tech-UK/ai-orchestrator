/**
 * Root Application Component
 */

import { ChangeDetectionStrategy, Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { ElectronIpcService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService, type WorkspaceBenchmarkHarness, type BenchmarkPresetName } from './core/services/workspace-bench.service';
import { ProviderQuotaChipComponent } from './shared/components/provider-quota-chip/provider-quota-chip.component';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';

declare global {
  interface Window {
    __perfService?: PerfInstrumentationService;
    __stressFixtures?: StressFixturesService;
    __workspaceBench?: WorkspaceBenchmarkHarness;
  }
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ProviderQuotaChipComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  private ipcService = inject(ElectronIpcService);
  private router = inject(Router);
  private perfService = inject(PerfInstrumentationService);
  private stressFixtures = inject(StressFixturesService);
  private workspaceBench = inject(WorkspaceBenchService);

  private menuListenerCleanup: (() => void) | null = null;

  isMacOS = false;
  readonly startupCapabilities = signal<StartupCapabilityReport | null>(null);

  async ngOnInit(): Promise<void> {
    // Check platform - use Electron API if available, fallback to navigator
    const electronPlatform = this.ipcService.platform;
    if (electronPlatform && electronPlatform !== 'browser') {
      this.isMacOS = electronPlatform === 'darwin';
    } else {
      // Fallback detection for when Electron API isn't available
      this.isMacOS = navigator.platform?.toLowerCase().includes('mac') ?? false;
    }

    // Expose dev tools on window for console access (referenced in workspace-benchmarks.md)
    window.__perfService = this.perfService;
    window.__stressFixtures = this.stressFixtures;
    window.__workspaceBench = this.workspaceBench;

    this.ipcService.onStartupCapabilities((report) => {
      this.startupCapabilities.set(report);
    });

    // Open Settings when triggered from the macOS app menu (Cmd+,).
    this.menuListenerCleanup = this.ipcService.on('menu:open-settings', () => {
      void this.router.navigate(['/settings']);
    });

    // Signal app ready
    await this.ipcService.appReady();
    if (!this.startupCapabilities()) {
      const report = await this.ipcService.getStartupCapabilities();
      if (report) {
        this.startupCapabilities.set(report);
      }
    }
  }

  ngOnDestroy(): void {
    this.menuListenerCleanup?.();
    this.menuListenerCleanup = null;
  }

  startupCapabilitySummary(): string {
    const report = this.startupCapabilities();
    if (!report) {
      return '';
    }

    const degradedChecks = report.checks.filter((check) => check.status !== 'ready' && check.status !== 'disabled');
    if (degradedChecks.length === 0) {
      return 'All optional startup checks passed.';
    }

    return degradedChecks
      .slice(0, 3)
      .map((check) => `${check.label}: ${check.summary}`)
      .join(' ');
  }
}

// Re-export for consumers that import these types from app.component
export type { BenchmarkPresetName, WorkspaceBenchmarkHarness };
