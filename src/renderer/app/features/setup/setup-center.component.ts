/**
 * Setup Center - a guided view of environment and provider readiness.
 *
 * copilot_todo.md item 14: turns the raw startup-capability report into a
 * friendly, grouped readiness checklist with next-step actions. The detailed
 * diagnostics still live in the Doctor settings tab; this page is the calm
 * first-run / recovery surface that points there when something needs fixing.
 */

import {
  ChangeDetectionStrategy,
  Component,
  type OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { IpcFacadeService } from '../../core/services/ipc';
import { FirstRunService } from '../../core/services/first-run.service';
import type {
  StartupCapabilityCategory,
  StartupCapabilityCheck,
  StartupCapabilityReport,
} from '../../../../shared/types/startup-capability.types';

interface CheckGroup {
  category: StartupCapabilityCategory;
  label: string;
  description: string;
  checks: StartupCapabilityCheck[];
}

const CATEGORY_META: Record<StartupCapabilityCategory, { label: string; description: string }> = {
  native: {
    label: 'Native modules',
    description: 'Bundled binaries the app relies on to run.',
  },
  provider: {
    label: 'AI providers',
    description: 'CLI providers used to run and verify agents.',
  },
  subsystem: {
    label: 'Subsystems',
    description: 'Optional features and integrations.',
  },
};

const CATEGORY_ORDER: StartupCapabilityCategory[] = ['provider', 'native', 'subsystem'];

@Component({
  selector: 'app-setup-center',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './setup-center.component.html',
  styleUrl: './setup-center.component.scss',
})
export class SetupCenterComponent implements OnInit {
  private readonly ipc = inject(IpcFacadeService);
  private readonly router = inject(Router);
  private readonly firstRunService = inject(FirstRunService);

  readonly report = signal<StartupCapabilityReport | null>(null);
  readonly loading = signal(true);

  readonly groups = computed<CheckGroup[]>(() => {
    const report = this.report();
    if (!report) {
      return [];
    }
    return CATEGORY_ORDER.map((category) => ({
      category,
      label: CATEGORY_META[category].label,
      description: CATEGORY_META[category].description,
      checks: report.checks.filter((check) => check.category === category),
    })).filter((group) => group.checks.length > 0);
  });

  readonly totalCount = computed(() => this.report()?.checks.length ?? 0);
  readonly readyCount = computed(
    () => this.report()?.checks.filter((check) => check.status === 'ready').length ?? 0,
  );
  readonly attentionCount = computed(
    () =>
      this.report()?.checks.filter(
        (check) => check.status === 'degraded' || check.status === 'unavailable',
      ).length ?? 0,
  );
  readonly progressPercent = computed(() => {
    const total = this.totalCount();
    return total === 0 ? 0 : Math.round((this.readyCount() / total) * 100);
  });

  readonly heroStatus = computed(() => this.report()?.status ?? 'unknown');

  readonly heroTitle = computed(() => {
    switch (this.heroStatus()) {
      case 'ready':
        return "You're all set";
      case 'degraded':
        return 'A few things need attention';
      case 'failed':
        return 'Setup needs your attention';
      default:
        return 'Setup status';
    }
  });

  readonly heroSummary = computed(() => {
    const report = this.report();
    if (!report) {
      return 'Readiness checks are not available in this environment.';
    }
    if (report.status === 'ready') {
      return 'Every startup check passed. The orchestrator is ready to run agents.';
    }
    const attention = this.attentionCount();
    return `${attention} check${attention === 1 ? '' : 's'} need attention before everything works smoothly.`;
  });

  async ngOnInit(): Promise<void> {
    // Reaching the setup center — via first-run auto-open or the title-bar
    // chip — counts as completing first-run, so it is never force-opened
    // again no matter how the user leaves (goToWorkspace, a Doctor deep-link…).
    this.firstRunService.markCompleted();
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    try {
      const report = await this.ipc.getStartupCapabilities();
      this.report.set(report ?? null);
    } catch {
      this.report.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /** True for checks the user can act on (degraded or unavailable). */
  needsAttention(check: StartupCapabilityCheck): boolean {
    return check.status === 'degraded' || check.status === 'unavailable';
  }

  openDoctor(check: StartupCapabilityCheck): void {
    void this.router.navigate(['/settings'], {
      queryParams: { tab: 'doctor', section: this.doctorSectionForCheck(check) },
    });
  }

  goToWorkspace(): void {
    this.firstRunService.markCompleted();
    void this.router.navigate(['/']);
  }

  private doctorSectionForCheck(check: StartupCapabilityCheck): string {
    if (check.id.startsWith('provider.')) {
      return 'provider-health';
    }
    if (check.id === 'subsystem.browser-automation') {
      return 'browser-automation';
    }
    return 'startup-capabilities';
  }
}
