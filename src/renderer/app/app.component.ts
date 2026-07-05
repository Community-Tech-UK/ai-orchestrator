/**
 * Root Application Component
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ToastService } from './core/services/toast.service';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { ElectronIpcService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService, type WorkspaceBenchmarkHarness, type BenchmarkPresetName } from './core/services/workspace-bench.service';
import { UsageStore } from './core/state/usage.store';
import { PromptHistoryStore } from './core/state/prompt-history.store';
import { ProviderQuotaChipComponent } from './shared/components/provider-quota-chip/provider-quota-chip.component';
import { CliUpdatePillComponent } from './features/title-bar/cli-update-pill.component';
import { TerminalDrawerComponent } from './features/terminal-drawer/terminal-drawer.component';
import { SettingsStore } from './core/state/settings.store';
import { PauseRendererController } from './core/state/pause/pause-renderer-controller.service';
import { PauseStore, type ResumeEvent } from './core/state/pause/pause.store';
import { PauseToggleComponent } from './core/state/pause/pause-toggle.component';
import { PauseBannerComponent } from './core/state/pause/pause-banner.component';
import { PauseDetectorErrorModalComponent } from './core/state/pause/pause-detector-error-modal.component';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';
import { FirstRunService } from './core/services/first-run.service';
import { ScratchDirectoryService } from './core/services/scratch-directory.service';
import { RemoteNodeStore } from './core/state/remote-node.store';

const STARTUP_BANNER_DISMISSAL_STORAGE_KEY = 'startup-capabilities-banner:dismissed-fingerprint';

declare global {
  interface Window {
    __perfService?: PerfInstrumentationService;
    __stressFixtures?: StressFixturesService;
    __workspaceBench?: WorkspaceBenchmarkHarness;
  }

  /**
   * Window Controls Overlay API (Electron `titleBarOverlay` on Windows/Linux).
   * Exposes the exact rectangle of the draggable title-bar area that is NOT
   * covered by the native minimise/maximise/close buttons, plus a geometry
   * change event. Not present on macOS (`hiddenInset`) or when unsupported.
   */
  interface WindowControlsOverlay extends EventTarget {
    readonly visible: boolean;
    getTitlebarAreaRect(): DOMRect;
    addEventListener(type: 'geometrychange', listener: (event: Event) => void): void;
    removeEventListener(type: 'geometrychange', listener: (event: Event) => void): void;
  }

  interface Navigator {
    readonly windowControlsOverlay?: WindowControlsOverlay;
  }
}

/**
 * Fallback width (px) reserved on the right edge of the title bar for the native
 * window controls when the Window Controls Overlay geometry is unavailable.
 * Windows caption buttons are ~46px each (3 × 46 = 138) plus a small gap.
 */
const WINDOW_CONTROLS_FALLBACK_INSET = 150;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    RouterOutlet,
    ProviderQuotaChipComponent,
    CliUpdatePillComponent,
    PauseToggleComponent,
    PauseBannerComponent,
    PauseDetectorErrorModalComponent,
    TerminalDrawerComponent,
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
  protected readonly toastService = inject(ToastService);
  private readonly firstRunService = inject(FirstRunService);
  private readonly scratchDirectory = inject(ScratchDirectoryService);
  private readonly remoteNodeStore = inject(RemoteNodeStore);

  private menuListenerCleanup: (() => void) | null = null;
  private resumeToastTimer: ReturnType<typeof setTimeout> | null = null;
  private routerEventsSubscription: { unsubscribe(): void } | null = null;

  isMacOS = false;
  protected readonly currentRouteUrl = signal(this.router.url || '/');
  protected readonly showRouteBackstop = computed(() => this.isNonDashboardRoute(this.currentRouteUrl()));

  /**
   * Right-edge inset (px) for the title-bar status cluster so it always clears
   * the native window controls on Windows/Linux. Driven by the live Window
   * Controls Overlay geometry; falls back to a safe constant. 0 on macOS (the
   * cluster is positioned from the left of the traffic lights via SCSS instead).
   */
  protected readonly titleBarControlsInset = signal(WINDOW_CONTROLS_FALLBACK_INSET);
  private windowControlsOverlayCleanup: (() => void) | null = null;

  readonly startupCapabilities = signal<StartupCapabilityReport | null>(null);
  private readonly dismissedStartupBannerFingerprint = signal<string | null>(
    this.readDismissedStartupBannerFingerprint(),
  );
  protected readonly startupBannerReport = computed(() => {
    const report = this.startupCapabilities();
    if (!report || report.status === 'ready') {
      return null;
    }

    const fingerprint = this.startupCapabilityReportFingerprint(report);
    return fingerprint === this.dismissedStartupBannerFingerprint() ? null : report;
  });

  /**
   * Always-visible title-bar chip: shown as soon as a capabilities report is
   * available, regardless of status. The chip is green when healthy so /setup
   * is always reachable even on a clean install.
   */
  protected readonly startupStatusChipReport = computed(() => this.startupCapabilities());

  protected readonly resumeToast = signal<ResumeEvent | null>(null);

  /** C2: remote-terminal drawer visibility (xterm.js ⇄ node-pty on a worker). */
  protected readonly terminalOpen = signal(false);

  /**
   * The remote-terminal feature is useless without a connected worker node — the
   * drawer auto-picks the only connected node and refuses to open otherwise. So
   * only surface the title-bar toggle when at least one worker is connected. An
   * already-open drawer keeps its toggle so it can always be closed again.
   */
  protected readonly showRemoteTerminalButton = computed(
    () => this.remoteNodeStore.connectedNodes().length > 0 || this.terminalOpen(),
  );

  protected toggleTerminal(): void {
    this.terminalOpen.update((open) => !open);
  }

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

    effect(() => {
      if (this.startupCapabilities()?.status === 'ready' && this.dismissedStartupBannerFingerprint()) {
        this.clearDismissedStartupBannerFingerprint();
      }
    });
  }

  async ngOnInit(): Promise<void> {
    this.bindRouteBackstop();

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

    // On Windows/Linux the native caption buttons live top-right via Electron's
    // titleBarOverlay. Track their exact geometry so the status cluster never
    // ends up underneath the maximise/close buttons.
    if (!this.isMacOS) {
      this.bindWindowControlsOverlay();
    }

    // Expose dev tools on window for console access (referenced in workspace-benchmarks.md)
    window.__perfService = this.perfService;
    window.__stressFixtures = this.stressFixtures;
    window.__workspaceBench = this.workspaceBench;
    void this.usageStore.init();
    void this.promptHistoryStore.init();
    void this.scratchDirectory.init();
    // Populate worker-node state up front: the title bar (always mounted) gates
    // the Remote Terminal toggle on a connected worker. initialize() is idempotent.
    void this.remoteNodeStore.initialize();

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

    // First-run: navigate to /setup exactly once (cleared by SetupCenterComponent).
    if (!this.firstRunService.isCompleted()) {
      void this.router.navigate(['/setup']);
    }
  }

  /**
   * Subscribe to the Window Controls Overlay geometry and keep
   * {@link titleBarControlsInset} in sync with the real caption-button strip.
   * Recomputes on `geometrychange` (maximise/restore/resize/DPI change) and on
   * window resize as a belt-and-braces fallback for environments that don't
   * fire `geometrychange` reliably.
   */
  private bindWindowControlsOverlay(): void {
    const recompute = () => this.updateWindowControlsInset();
    recompute();

    const overlay = navigator.windowControlsOverlay;
    overlay?.addEventListener('geometrychange', recompute);
    window.addEventListener('resize', recompute);

    this.windowControlsOverlayCleanup = () => {
      overlay?.removeEventListener('geometrychange', recompute);
      window.removeEventListener('resize', recompute);
    };
  }

  private updateWindowControlsInset(): void {
    const overlay = navigator.windowControlsOverlay;
    if (!overlay?.visible) {
      this.titleBarControlsInset.set(WINDOW_CONTROLS_FALLBACK_INSET);
      return;
    }

    const rect = overlay.getTitlebarAreaRect();
    // The titlebar area rect excludes the caption buttons. On Windows the
    // controls sit to the right, so the reserved strip is everything past the
    // area's right edge. A 12px gap keeps the cluster visually clear of them.
    const controlsWidth = Math.max(0, window.innerWidth - (rect.x + rect.width));
    const inset = controlsWidth > 0 ? controlsWidth + 12 : WINDOW_CONTROLS_FALLBACK_INSET;
    this.titleBarControlsInset.set(inset);
  }

  ngOnDestroy(): void {
    if (this.resumeToastTimer) clearTimeout(this.resumeToastTimer);
    this.resumeToastTimer = null;
    this.routerEventsSubscription?.unsubscribe();
    this.routerEventsSubscription = null;
    this.menuListenerCleanup?.();
    this.menuListenerCleanup = null;
    this.windowControlsOverlayCleanup?.();
    this.windowControlsOverlayCleanup = null;
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

  openSetupCenter(): void {
    void this.router.navigate(['/setup']);
  }

  protected goToDashboard(): void {
    void this.router.navigate(['/']);
  }

  private bindRouteBackstop(): void {
    this.currentRouteUrl.set(this.router.url || '/');
    this.routerEventsSubscription?.unsubscribe();
    this.routerEventsSubscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.currentRouteUrl.set(event.urlAfterRedirects || event.url || '/');
      }
    });
  }

  private isNonDashboardRoute(url: string): boolean {
    const path = url.split(/[?#]/)[0] || '/';
    return path !== '/';
  }

  dismissStartupBanner(): void {
    const report = this.startupCapabilities();
    if (!report) {
      return;
    }

    const fingerprint = this.startupCapabilityReportFingerprint(report);
    this.dismissedStartupBannerFingerprint.set(fingerprint);
    this.writeDismissedStartupBannerFingerprint(fingerprint);
  }

  private startupCapabilityReportFingerprint(report: StartupCapabilityReport): string {
    const failingChecks = report.checks
      .filter((check) => check.status !== 'ready' && check.status !== 'disabled')
      .map((check) => ({
        critical: check.critical,
        id: check.id,
        status: check.status,
        summary: check.summary,
      }))
      .sort((a, b) =>
        a.id.localeCompare(b.id)
        || a.status.localeCompare(b.status)
        || a.summary.localeCompare(b.summary)
        || Number(a.critical) - Number(b.critical)
      );

    return JSON.stringify({
      status: report.status,
      checks: failingChecks,
    });
  }

  private readDismissedStartupBannerFingerprint(): string | null {
    if (typeof window === 'undefined') {
      return null;
    }

    try {
      return window.localStorage.getItem(STARTUP_BANNER_DISMISSAL_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  private writeDismissedStartupBannerFingerprint(fingerprint: string): void {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(STARTUP_BANNER_DISMISSAL_STORAGE_KEY, fingerprint);
    } catch {
      // Dismissal still works for the current renderer session.
    }
  }

  private clearDismissedStartupBannerFingerprint(): void {
    this.dismissedStartupBannerFingerprint.set(null);
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.removeItem(STARTUP_BANNER_DISMISSAL_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the in-memory signal is already reset.
    }
  }
}

// Re-export for consumers that import these types from app.component
export type { BenchmarkPresetName, WorkspaceBenchmarkHarness };
