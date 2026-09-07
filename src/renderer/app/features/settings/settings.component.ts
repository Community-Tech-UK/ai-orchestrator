/**
 * Settings Component - Full-page settings workspace.
 *
 * A left nav rail (icons, grouping, live search), a sticky section header, a
 * scrollable content pane, and a collapsible contextual help/preview pane on
 * the right. The active section is deep-linkable via the URL fragment, still
 * reads legacy `tab` query params, and is remembered between visits via
 * localStorage. Nav badges and the help pane both surface real, live
 * subsystem health — see copilot_todo.md items 1, 12, 13 and 15.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { SettingsStore } from '../../core/state/settings.store';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { isRemoteNodeOnline } from '../../core/state/remote-node-connectivity';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';
import { GeneralSettingsTabComponent } from './general-settings-tab.component';
import { OrchestrationSettingsTabComponent } from './orchestration-settings-tab.component';
import { MemorySettingsTabComponent } from './memory-settings-tab.component';
import { DisplaySettingsTabComponent } from './display-settings-tab.component';
import { AdvancedSettingsTabComponent } from './advanced-settings-tab.component';
import { KeyboardSettingsTabComponent } from './keyboard-settings-tab.component';
import { PermissionsSettingsTabComponent } from './permissions-settings-tab.component';
import { EcosystemSettingsTabComponent } from './ecosystem-settings-tab.component';
import { ReviewSettingsTabComponent } from './review-settings-tab.component';
import { ConnectionsSettingsTabComponent } from './connections-settings-tab.component';
import { CopilotAccountsTabComponent } from './copilot-accounts-tab.component';
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { MobileSettingsTabComponent } from './mobile-settings-tab.component';
import { CliHealthSettingsTabComponent } from './cli-health-settings-tab.component';
import { ProviderQuotaSettingsTabComponent } from './provider-quota-settings-tab.component';
import { ComputerUseSettingsTabComponent } from './computer-use-settings-tab.component';
import { NetworkSettingsTabComponent } from './network-settings-tab.component';
import { DoctorSettingsTabComponent } from './doctor-settings-tab.component';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { AuxiliaryModelsSettingsTabComponent } from './auxiliary-models-settings-tab.component';
import { VoiceSettingsTabComponent } from './voice-settings-tab.component';
import { McpPageComponent } from '../mcp/mcp-page.component';
import { HooksPageComponent } from '../hooks/hooks-page.component';
import { WorktreePageComponent } from '../worktree/worktree-page.component';
import { SnapshotPageComponent } from '../snapshots/snapshot-page.component';
import { ArchivePageComponent } from '../archive/archive-page.component';
import { RemoteConfigPageComponent } from '../remote-config/remote-config-page.component';
import { ModelsPageComponent } from '../models/models-page.component';
import { SettingsNavIconComponent } from './ui/settings-nav-icon.component';
import { HelpPaneComponent } from '../../shared/help/help-pane.component';
import type { HelpEntry, HelpLiveStatus } from '../../shared/help/help-content.types';
import { SETTINGS_TAB_HELP } from './help/settings-help';
import { bestSettingMatch } from '../../../../shared/types/settings-search-catalog';
import { SettingsHealthNoticesComponent } from './settings-health-notices.component';

/** UX4.2 — how long the landing pulse marker stays on the row. */
const SEARCH_LANDING_MS = 1800;
const SEARCH_LANDING_CLASS = 'settings-search-landing';
/**
 * Frames to keep looking for the row. Six is enough for a tab swap plus a
 * couple of advanced disclosures; more would keep fighting for the viewport
 * long after it is clear the row is not coming.
 */
const SEARCH_SCROLL_MAX_FRAMES = 6;
import {
  HELP_COLLAPSED_KEY,
  LAST_TAB_KEY,
  NAV_COLLAPSED_KEY,
  NAV_ITEMS,
  WIDE_TABS,
  isSettingsTab,
  type HelpStatus,
  type NavBadge,
  type SettingsNavItem,
  type SettingsTab,
} from './settings-navigation';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    SettingsHealthNoticesComponent,
    GeneralSettingsTabComponent,
    OrchestrationSettingsTabComponent,
    MemorySettingsTabComponent,
    DisplaySettingsTabComponent,
    EcosystemSettingsTabComponent,
    ReviewSettingsTabComponent,
    AdvancedSettingsTabComponent,
    KeyboardSettingsTabComponent,
    PermissionsSettingsTabComponent,
    ComputerUseSettingsTabComponent,
    ConnectionsSettingsTabComponent,
    CopilotAccountsTabComponent,
    NetworkSettingsTabComponent,
    DoctorSettingsTabComponent,
    RemoteNodesSettingsTabComponent,
    MobileSettingsTabComponent,
    CliHealthSettingsTabComponent,
    ProviderQuotaSettingsTabComponent,
    RtkSavingsTabComponent,
    AuxiliaryModelsSettingsTabComponent,
    VoiceSettingsTabComponent,
    McpPageComponent,
    HooksPageComponent,
    WorktreePageComponent,
    SnapshotPageComponent,
    ArchivePageComponent,
    RemoteConfigPageComponent,
    ModelsPageComponent,
    SettingsNavIconComponent,
    HelpPaneComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  protected readonly store = inject(SettingsStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private appIpc = inject(AppIpcService);
  private cliUpdates = inject(CliUpdatePillStore);
  private remoteNodes = inject(RemoteNodeStore);
  private providerQuota = inject(ProviderQuotaStore);
  private destroyRef = inject(DestroyRef);
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private activeFragmentTab: SettingsTab | null = null;

  /** Still emitted when opened as a modal (legacy callers). */
  closeDialog = output<void>();

  readonly activeTab = signal<SettingsTab>('general');
  readonly searchQuery = signal('');
  /** Whether the settings section tree is collapsed to an icon rail. */
  readonly navCollapsed = signal(this.readNavCollapsed());
  /** Whether the contextual help/preview pane is collapsed (item 13). */
  readonly helpCollapsed = signal(this.readHelpCollapsed());

  /** Latest startup-capability report — backs the Doctor + Models surfaces. */
  private readonly startupReport = signal<StartupCapabilityReport | null>(null);

  readonly isWideTab = computed(() => WIDE_TABS.has(this.activeTab()));
  readonly activeItem = computed(() => NAV_ITEMS.find((item) => item.id === this.activeTab()));
  /** True while the settings store is loading from disk on first open. */
  readonly isLoading = computed(() => this.store.loading());

  // ─── Live nav badges (item 12) ─────────────────────────────────────────────
  // Each badge is derived from a real subsystem signal — never a static label.

  /** Doctor: count of degraded/unavailable startup-capability checks. */
  private readonly doctorBadge = computed<NavBadge | null>(() => {
    const report = this.startupReport();
    if (!report) {
      return null;
    }
    const problems = report.checks.filter(
      (check) => check.status === 'degraded' || check.status === 'unavailable',
    ).length;
    if (problems === 0) {
      return null;
    }
    return {
      text: `${problems} ${problems === 1 ? 'issue' : 'issues'}`,
      status: report.status === 'failed' ? 'error' : 'warn',
    };
  });

  /** Models: provider CLIs that are not ready to serve models. */
  private readonly modelsBadge = computed<NavBadge | null>(() => {
    const report = this.startupReport();
    if (!report) {
      return null;
    }
    const providerChecks = report.checks.filter((check) => check.category === 'provider');
    const anyAvailable = providerChecks.find((check) => check.id === 'provider.any');
    if (anyAvailable?.status === 'unavailable') {
      return { text: 'No CLIs', status: 'error' };
    }
    const degraded = providerChecks.filter(
      (check) => check.id !== 'provider.any' && check.status === 'degraded',
    ).length;
    if (degraded === 0) {
      return null;
    }
    return {
      text: `${degraded} ${degraded === 1 ? 'provider' : 'providers'}`,
      status: 'warn',
    };
  });

  /** CLI Health: CLIs with a confirmed update available (same source as the title-bar pill). */
  private readonly cliHealthBadge = computed<NavBadge | null>(() => {
    const count = this.cliUpdates.state().count;
    if (count <= 0) {
      return null;
    }
    return {
      text: `${count} ${count === 1 ? 'update' : 'updates'}`,
      status: 'warn',
    };
  });

  /** Remote Nodes: connection health of enrolled worker nodes. */
  private readonly remoteNodesBadge = computed<NavBadge | null>(() => {
    const nodes = this.remoteNodes.nodes();
    if (nodes.length === 0) {
      return { text: 'Setup', status: 'info' };
    }
    const degraded = nodes.filter((node) => node.status === 'degraded').length;
    if (degraded > 0) {
      return { text: `${degraded} degraded`, status: 'warn' };
    }
    const connected = nodes.filter(isRemoteNodeOnline).length;
    if (connected > 0) {
      return { text: `${connected} online`, status: 'ok' };
    }
    return { text: 'Offline', status: 'warn' };
  });

  /** Provider Quota: usage of the most-constrained window across providers. */
  private readonly providerQuotaBadge = computed<NavBadge | null>(() => {
    const constrained = this.providerQuota.mostConstrainedWindow();
    if (!constrained || constrained.window.limit <= 0) {
      return null;
    }
    const percent = Math.round((constrained.window.used / constrained.window.limit) * 100);
    if (percent >= 100) {
      return { text: 'Exhausted', status: 'error' };
    }
    if (percent >= 90) {
      return { text: `${percent}%`, status: 'warn' };
    }
    return null;
  });

  /** Live badge per nav section, keyed by tab id. Absent entry = no badge. */
  readonly navBadges = computed<Partial<Record<SettingsTab, NavBadge>>>(() => {
    const badges: Partial<Record<SettingsTab, NavBadge>> = {};
    const doctor = this.doctorBadge();
    if (doctor) {
      badges.doctor = doctor;
    }
    const models = this.modelsBadge();
    if (models) {
      badges.models = models;
    }
    const cliHealth = this.cliHealthBadge();
    if (cliHealth) {
      badges['cli-health'] = cliHealth;
    }
    const remoteNodes = this.remoteNodesBadge();
    if (remoteNodes) {
      badges['remote-nodes'] = remoteNodes;
    }
    const providerQuota = this.providerQuotaBadge();
    if (providerQuota) {
      badges['provider-quota'] = providerQuota;
    }
    return badges;
  });

  // ─── Contextual help pane live status (item 13) ────────────────────────────

  /** Doctor help pane: live summary of the startup-capability report. */
  readonly doctorHelpStatus = computed<HelpStatus>(() => {
    const report = this.startupReport();
    if (!report) {
      return { variant: 'info', text: 'No startup report yet — open Doctor and run a refresh.' };
    }
    if (report.status === 'failed') {
      return { variant: 'warning', text: 'A critical startup check failed. Review the sections below.' };
    }
    if (report.status === 'degraded') {
      const problems = report.checks.filter(
        (check) => check.status === 'degraded' || check.status === 'unavailable',
      ).length;
      return {
        variant: 'warning',
        text: `${problems} startup ${problems === 1 ? 'check needs' : 'checks need'} attention.`,
      };
    }
    return { variant: 'info', text: 'All startup checks passed.' };
  });

  /** Models help pane: live provider-CLI readiness summary. */
  readonly modelsHelpStatus = computed<HelpStatus>(() => {
    const report = this.startupReport();
    if (!report) {
      return { variant: 'info', text: 'Provider readiness has not been probed yet.' };
    }
    const providerChecks = report.checks.filter(
      (check) => check.category === 'provider' && check.id !== 'provider.any',
    );
    const ready = providerChecks.filter((check) => check.status === 'ready').length;
    const total = providerChecks.length;
    return {
      variant: ready === total ? 'info' : 'warning',
      text: `${ready} of ${total} provider ${total === 1 ? 'CLI is' : 'CLIs are'} ready to serve models.`,
    };
  });

  /** Remote Nodes help pane: live enrolled-node connection summary. */
  readonly remoteNodesHelpStatus = computed<HelpStatus>(() => {
    const nodes = this.remoteNodes.nodes();
    if (nodes.length === 0) {
      return { variant: 'info', text: 'No remote nodes are enrolled yet.' };
    }
    const connected = nodes.filter(isRemoteNodeOnline).length;
    return {
      variant: connected === nodes.length ? 'info' : 'warning',
      text: `${connected} of ${nodes.length} enrolled ${nodes.length === 1 ? 'node is' : 'nodes are'} connected.`,
    };
  });

  /** Registry help content for the active tab. */
  readonly activeHelp = computed<HelpEntry>(() => SETTINGS_TAB_HELP[this.activeTab()]);

  /** Live subsystem status injected into the help pane for health-backed tabs. */
  readonly activeHelpStatus = computed<HelpLiveStatus | null>(() => {
    switch (this.activeTab()) {
      case 'models':
        return this.modelsHelpStatus();
      case 'remote-nodes':
        return this.remoteNodesHelpStatus();
      case 'doctor':
        return this.doctorHelpStatus();
      default:
        return null;
    }
  });

  /** NAV_ITEMS filtered by the current search query. */
  private readonly filteredItems = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) {
      return NAV_ITEMS;
    }
    return NAV_ITEMS.filter((item) => {
      const haystack = `${item.id} ${item.label} ${item.summary} ${item.group ?? ''} ${
        item.keywords ?? ''
      }`.toLowerCase();
      return haystack.includes(query);
    });
  });

  readonly ungroupedItems = computed(() => this.filteredItems().filter((item) => !item.group));
  readonly groups = computed(() => [
    ...new Set(
      this.filteredItems()
        .filter((item) => item.group)
        .map((item) => item.group as string),
    ),
  ]);
  readonly hasResults = computed(() => this.filteredItems().length > 0);

  constructor() {
    // Keep the live health stores warm so nav badges and the help pane reflect
    // real subsystem state even when Settings is the first surface opened.
    // Each of these is idempotent — safe to call again.
    this.cliUpdates.init();
    void this.remoteNodes.initialize();
    void this.providerQuota.initialize();

    // Startup-capability report → Doctor + Models badges and help status.
    void this.appIpc.getStartupCapabilities().then((report) => {
      if (report) {
        this.startupReport.set(report);
      }
    });
    const stopStartupCapabilities = this.appIpc.onStartupCapabilities((report) => {
      this.startupReport.set(report);
    });
    this.destroyRef.onDestroy(stopStartupCapabilities);

    this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => {
      this.activeFragmentTab = isSettingsTab(fragment) ? fragment : null;
      if (isSettingsTab(fragment)) {
        this.activeTab.set(fragment);
      }
    });

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      if (this.activeFragmentTab) {
        return;
      }
      const tab = params.get('tab');
      if (isSettingsTab(tab)) {
        this.activeTab.set(tab);
      }
    });

    // When the URL does not pin a section, restore the last-opened one.
    const snapshot = this.route.snapshot;
    const urlTab = snapshot.fragment ?? snapshot.queryParamMap.get('tab');
    if (!isSettingsTab(urlTab)) {
      const stored = this.readStoredTab();
      if (stored) {
        this.activeTab.set(stored);
      }
    }
  }

  getGroupItems(group: string): SettingsNavItem[] {
    return this.filteredItems().filter((item) => item.group === group);
  }

  onSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  /**
   * UX4.2 — the single best settings row for the current query, or null.
   *
   * Exposed rather than the whole ranked list: the affordance is "jump to the
   * obvious one", and offering a ranked menu inside a nav rail that is already
   * filtering itself would be two competing result lists in one panel.
   */
  readonly searchRowMatch = computed(() => bestSettingMatch(this.searchQuery()));

  /** Switch to the matched row's tab and scroll it into view. */
  jumpToSearchMatch(): void {
    const match = this.searchRowMatch();
    if (!match) return;
    if (isSettingsTab(match.tab)) this.selectTab(match.tab);
    this.scrollToSettingRow(match.key);
  }

  /**
   * Find the row and bring it into view, retrying across a few frames.
   *
   * The retry exists because the tab has only just been swapped in — the row
   * does not exist in the DOM on the frame the click happens. It also opens a
   * collapsed advanced disclosure (S3.2) one per frame, since a row hidden
   * behind one would otherwise be scrolled to and never seen.
   *
   * A real scroll gesture cancels the loop. Fighting a user who has started
   * scrolling is worse than failing to land: they have taken over, and yanking
   * the viewport back is the kind of thing that makes a page feel broken.
   */
  private scrollToSettingRow(key: string): void {
    const host = this.hostRef.nativeElement;
    const selector = `[data-setting-key="${key}"]`;
    let frames = 0;
    let cancelled = false;

    const cancel = (): void => { cancelled = true; };
    window.addEventListener('wheel', cancel, { passive: true });
    window.addEventListener('touchmove', cancel, { passive: true });
    const cleanup = (): void => {
      window.removeEventListener('wheel', cancel);
      window.removeEventListener('touchmove', cancel);
    };

    const step = (): void => {
      if (cancelled) { cleanup(); return; }

      const row = host.querySelector(selector);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        row.classList.add(SEARCH_LANDING_CLASS);
        // Remove the marker so a second jump to the same row pulses again.
        window.setTimeout(() => row.classList.remove(SEARCH_LANDING_CLASS), SEARCH_LANDING_MS);
        cleanup();
        return;
      }

      // One disclosure per frame: opening them all at once would expand every
      // advanced section on the tab to reveal a row in one of them.
      host.querySelector<HTMLButtonElement>(
        '.settings-tiered-row-list__advanced-toggle[aria-expanded="false"]',
      )?.click();

      if (++frames >= SEARCH_SCROLL_MAX_FRAMES) { cleanup(); return; }
      requestAnimationFrame(step);
    };

    requestAnimationFrame(step);
  }

  onSearchEscape(event: Event): void {
    // Escape clears the search first; only close the page once it is empty.
    if (this.searchQuery()) {
      this.searchQuery.set('');
      event.stopPropagation();
    }
  }

  selectTab(tab: SettingsTab): void {
    this.activeTab.set(tab);
    this.persistTab(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      fragment: tab,
      queryParams: {
        tab: null,
        section: tab === 'doctor' ? this.route.snapshot.queryParamMap.get('section') : null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  goBack(): void {
    // If opened as modal, emit close; otherwise navigate home.
    this.closeDialog.emit();
    void this.router.navigate(['/']);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.goBack();
    }
  }

  /** Toggle the contextual help/preview pane and remember the choice (item 13). */
  toggleHelp(): void {
    const collapsed = !this.helpCollapsed();
    this.helpCollapsed.set(collapsed);
    this.persistHelpCollapsed(collapsed);
  }

  toggleNav(): void {
    const collapsed = !this.navCollapsed();
    if (collapsed) {
      this.searchQuery.set('');
    }
    this.navCollapsed.set(collapsed);
    this.persistNavCollapsed(collapsed);
  }

  private readStoredTab(): SettingsTab | null {
    try {
      const stored = localStorage.getItem(LAST_TAB_KEY);
      return isSettingsTab(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  private persistTab(tab: SettingsTab): void {
    try {
      localStorage.setItem(LAST_TAB_KEY, tab);
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }

  private readHelpCollapsed(): boolean {
    try {
      return localStorage.getItem(HELP_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private readNavCollapsed(): boolean {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private persistHelpCollapsed(collapsed: boolean): void {
    try {
      localStorage.setItem(HELP_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }

  private persistNavCollapsed(collapsed: boolean): void {
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }
}
