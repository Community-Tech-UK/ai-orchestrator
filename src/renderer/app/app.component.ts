/**
 * Root Application Component
 */

import { ChangeDetectionStrategy, Component, effect, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { Router, RouterOutlet } from '@angular/router';
import { ElectronIpcService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService, type WorkspaceBenchmarkHarness, type BenchmarkPresetName } from './core/services/workspace-bench.service';
import { UsageStore } from './core/state/usage.store';
import { PromptHistoryStore } from './core/state/prompt-history.store';
import { ProviderQuotaChipComponent } from './shared/components/provider-quota-chip/provider-quota-chip.component';
import { CliUpdatePillComponent } from './features/title-bar/cli-update-pill.component';
import { SettingsStore } from './core/state/settings.store';
import { PauseRendererController } from './core/state/pause/pause-renderer-controller.service';
import { PauseStore, type ResumeEvent } from './core/state/pause/pause.store';
import { PauseToggleComponent } from './core/state/pause/pause-toggle.component';
import { PauseBannerComponent } from './core/state/pause/pause-banner.component';
import { PauseDetectorErrorModalComponent } from './core/state/pause/pause-detector-error-modal.component';
import type {
  StartupCapabilityCheck,
  StartupCapabilityReport,
} from '../../shared/types/startup-capability.types';
import type { DoctorSectionId } from '../../shared/types/diagnostics.types';

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
  imports: [
    RouterOutlet,
    CliUpdatePillComponent,
    ProviderQuotaChipComponent,
    PauseToggleComponent,
    PauseBannerComponent,
    PauseDetectorErrorModalComponent,
  ],
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
  private usageStore = inject(UsageStore);
  private promptHistoryStore = inject(PromptHistoryStore);
  protected readonly settingsStore = inject(SettingsStore);
  protected readonly pauseStore = inject(PauseStore);
  private pauseRendererController = inject(PauseRendererController);

  private menuListenerCleanup: (() => void) | null = null;
  private resumeToastTimer: ReturnType<typeof setTimeout> | null = null;

  isMacOS = false;
  readonly startupCapabilities = signal<StartupCapabilityReport | null>(null);
  protected readonly resumeToast = signal<ResumeEvent | null>(null);

  constructor() {
    effect(() => {
      const latest = this.pauseStore.resumeEvents().at(-1);
      if (!latest) return;
      this.resumeToast.set(latest);
      if (this.resumeToastTimer) clearTimeout(this.resumeToastTimer);
      this.resumeToastTimer = setTimeout(() => {
        if (this.resumeToast()?.id === latest.id) {
          this.resumeToast.set(null);
        }
      }, 4500);
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.settingsStore.initialize();
    } catch {
      // SettingsStore records the load error; keep the rest of root startup alive.
    }
    this.pauseRendererController.bindReactive();

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
    void this.usageStore.init();
    void this.promptHistoryStore.init();

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
    if (this.resumeToastTimer) clearTimeout(this.resumeToastTimer);
    this.resumeToastTimer = null;
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

  openDoctorForBanner(): void {
    const report = this.startupCapabilities();
    const check = report ? this.pickHighestSeverityFailingCheck(report.checks) : null;
    void this.router.navigate(['/settings'], {
      queryParams: {
        tab: 'doctor',
        section: check ? this.doctorSectionForCheck(check.id) : 'startup-capabilities',
      },
    });
  }

  private pickHighestSeverityFailingCheck(
    checks: StartupCapabilityCheck[],
  ): StartupCapabilityCheck | null {
    const rank: Record<StartupCapabilityCheck['status'], number> = {
      unavailable: 4,
      degraded: 3,
      disabled: 2,
      ready: 1,
    };
    return checks
      .filter((check) => check.status !== 'ready' && check.status !== 'disabled')
      .sort((a, b) => rank[b.status] - rank[a.status] || Number(b.critical) - Number(a.critical))[0] ?? null;
  }

  private doctorSectionForCheck(checkId: string): DoctorSectionId {
    if (checkId.startsWith('provider.')) return 'provider-health';
    if (checkId === 'subsystem.browser-automation') return 'browser-automation';
    return 'startup-capabilities';
  }
}

// Re-export for consumers that import these types from app.component
export type { BenchmarkPresetName, WorkspaceBenchmarkHarness };
