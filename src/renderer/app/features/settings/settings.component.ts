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
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { CliHealthSettingsTabComponent } from './cli-health-settings-tab.component';
import { ProviderQuotaSettingsTabComponent } from './provider-quota-settings-tab.component';
import { NetworkSettingsTabComponent } from './network-settings-tab.component';
import { DoctorSettingsTabComponent } from './doctor-settings-tab.component';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { McpPageComponent } from '../mcp/mcp-page.component';
import { HooksPageComponent } from '../hooks/hooks-page.component';
import { WorktreePageComponent } from '../worktree/worktree-page.component';
import { SnapshotPageComponent } from '../snapshots/snapshot-page.component';
import { ArchivePageComponent } from '../archive/archive-page.component';
import { RemoteConfigPageComponent } from '../remote-config/remote-config-page.component';
import { ModelsPageComponent } from '../models/models-page.component';
import { SettingsNavIconComponent } from './ui/settings-nav-icon.component';
import { InlineHelpComponent, type InlineHelpVariant } from './ui/inline-help.component';

type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'connections'
  | 'network'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard'
  | 'remote-nodes'
  | 'doctor'
  | 'cli-health'
  | 'provider-quota'
  | 'rtk-savings'
  | 'models'
  | 'mcp'
  | 'hooks'
  | 'worktrees'
  | 'snapshots'
  | 'archive'
  | 'remote-config';

/** Tabs whose content is an embedded full-width feature page (no 760px cap). */
const WIDE_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'models',
  'mcp',
  'hooks',
  'worktrees',
  'snapshots',
  'archive',
  'remote-config',
  'doctor',
]);

/** localStorage key used to remember the last-opened settings section. */
const LAST_TAB_KEY = 'aiorch.settings.lastTab';

/** localStorage key used to remember the help pane collapsed state (item 13). */
const HELP_COLLAPSED_KEY = 'aiorch.settings.helpCollapsed';

/** Tone for a live nav badge. */
type NavBadgeStatus = 'ok' | 'warn' | 'error' | 'info';

/** A live, computed health badge shown next to a nav item (item 12). */
interface NavBadge {
  text: string;
  status: NavBadgeStatus;
}

/** A live status line shown in the contextual help pane (item 13). */
interface HelpStatus {
  variant: InlineHelpVariant;
  text: string;
}

interface SettingsNavItem {
  id: SettingsTab;
  label: string;
  /** One-line description shown in the section header. */
  summary: string;
  group?: string;
  recommended?: boolean;
  /** Extra search terms beyond the label/summary. */
  keywords?: string;
}

/**
 * Settings sections, ordered for the nav. Ungrouped items are everyday
 * preferences (shown first); grouped items separate agent configuration,
 * workspace tooling, network/remote, and advanced diagnostics so the long
 * tab list is no longer a flat wall of equivalent entries (item 17).
 */
const NAV_ITEMS: SettingsNavItem[] = [
  {
    id: 'general',
    label: 'General',
    summary: 'Default CLI, working directory, and core application behavior.',
    keywords: 'yolo cli directory startup notifications model',
  },
  {
    id: 'display',
    label: 'Display',
    summary: 'Theme, font size, and how agent output is rendered.',
    recommended: true,
    keywords: 'theme dark light appearance font thinking tool messages',
  },
  {
    id: 'keyboard',
    label: 'Keyboard',
    summary: 'Review and customize keyboard shortcuts.',
    keywords: 'shortcuts keybindings hotkeys',
  },
  {
    id: 'orchestration',
    label: 'Orchestration',
    summary: 'Limits and policy for spawning and running agents.',
    group: 'Agents',
    keywords: 'children instances nesting limits idle',
  },
  {
    id: 'review',
    label: 'Cross-Model Review',
    summary: 'Automatic verification of agent output by secondary models.',
    group: 'Agents',
    keywords: 'verification verify reviewers gemini codex',
  },
  {
    id: 'memory',
    label: 'Memory',
    summary: 'Session persistence and in-memory output buffers.',
    group: 'Agents',
    keywords: 'buffer disk storage persistence heap',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    summary: 'Control what agents may do without asking first.',
    group: 'Agents',
    keywords: 'allow deny security tools approval rules',
  },
  {
    id: 'connections',
    label: 'Connections',
    summary: 'Manage links to AI providers and external services.',
    group: 'Workspace',
    keywords: 'providers accounts auth login',
  },
  {
    id: 'models',
    label: 'Models',
    summary: 'Choose and configure the model used for each provider.',
    group: 'Workspace',
    recommended: true,
    keywords: 'model opus sonnet gpt gemini haiku',
  },
  {
    id: 'mcp',
    label: 'MCP Servers',
    summary: 'Manage Model Context Protocol servers across providers.',
    group: 'Workspace',
    keywords: 'mcp servers tools context protocol',
  },
  {
    id: 'hooks',
    label: 'Hooks',
    summary: 'Run custom commands on agent lifecycle events.',
    group: 'Workspace',
    keywords: 'hooks events automation scripts triggers',
  },
  {
    id: 'worktrees',
    label: 'Worktrees',
    summary: 'Manage git worktrees used for parallel agent work.',
    group: 'Workspace',
    keywords: 'git worktree branch parallel',
  },
  {
    id: 'snapshots',
    label: 'Snapshots',
    summary: 'Capture and restore project state checkpoints.',
    group: 'Workspace',
    keywords: 'checkpoint restore backup',
  },
  {
    id: 'archive',
    label: 'Archive',
    summary: 'Browse and restore archived sessions.',
    group: 'Workspace',
    keywords: 'archived sessions history old',
  },
  {
    id: 'network',
    label: 'Network',
    summary: 'VPN-aware pausing and connection safety controls.',
    group: 'Network & Remote',
    keywords: 'vpn pause proxy offline reachability probe',
  },
  {
    id: 'remote-nodes',
    label: 'Remote Nodes',
    summary: 'Offload work to enrolled remote machines.',
    group: 'Network & Remote',
    keywords: 'remote nodes offload distributed gpu browser',
  },
  {
    id: 'remote-config',
    label: 'Remote Config',
    summary: 'Synchronize configuration from a remote source.',
    group: 'Network & Remote',
    keywords: 'sync cloud remote shared',
  },
  {
    id: 'cli-health',
    label: 'CLI Health',
    summary: 'Check installed AI CLIs and keep them up to date.',
    group: 'Diagnostics',
    keywords: 'cli health version update install diagnose',
  },
  {
    id: 'doctor',
    label: 'Doctor',
    summary: 'Diagnose environment and configuration issues.',
    group: 'Diagnostics',
    keywords: 'diagnostics troubleshoot environment health checks',
  },
  {
    id: 'provider-quota',
    label: 'Provider Quota',
    summary: 'Track provider rate limits and usage quotas.',
    group: 'Diagnostics',
    keywords: 'quota rate limit usage cost',
  },
  {
    id: 'rtk-savings',
    label: 'RTK Savings',
    summary: 'Token-saving output compression stats and controls.',
    group: 'Diagnostics',
    keywords: 'rtk token cost savings compression',
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    summary: 'Integrations with the wider tool ecosystem.',
    group: 'Diagnostics',
    keywords: 'integrations extensions plugins',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    summary: 'Low-level tuning and diagnostic options.',
    group: 'Diagnostics',
    keywords: 'parser codemem buffer experimental',
  },
];

const SETTINGS_TAB_IDS = new Set<SettingsTab>(NAV_ITEMS.map((item) => item.id));

function isSettingsTab(value: string | null | undefined): value is SettingsTab {
  return Boolean(value && SETTINGS_TAB_IDS.has(value as SettingsTab));
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    GeneralSettingsTabComponent,
    OrchestrationSettingsTabComponent,
    MemorySettingsTabComponent,
    DisplaySettingsTabComponent,
    EcosystemSettingsTabComponent,
    ReviewSettingsTabComponent,
    AdvancedSettingsTabComponent,
    KeyboardSettingsTabComponent,
    PermissionsSettingsTabComponent,
    ConnectionsSettingsTabComponent,
    NetworkSettingsTabComponent,
    DoctorSettingsTabComponent,
    RemoteNodesSettingsTabComponent,
    CliHealthSettingsTabComponent,
    ProviderQuotaSettingsTabComponent,
    RtkSavingsTabComponent,
    McpPageComponent,
    HooksPageComponent,
    WorktreePageComponent,
    SnapshotPageComponent,
    ArchivePageComponent,
    RemoteConfigPageComponent,
    ModelsPageComponent,
    SettingsNavIconComponent,
    InlineHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-page" (keydown)="onKeydown($event)" tabindex="0">
      <!-- Left nav rail -->
      <aside class="settings-sidebar">
        <div class="sidebar-header">
          <button class="back-btn" type="button" (click)="goBack()">
            <app-settings-nav-icon name="back" />
            <span>Settings</span>
          </button>
        </div>

        <div class="sidebar-search">
          <span class="search-icon"><app-settings-nav-icon name="search" /></span>
          <input
            type="search"
            class="search-input"
            placeholder="Search settings…"
            [value]="searchQuery()"
            (input)="onSearch($event)"
            (keydown.escape)="onSearchEscape($event)"
            aria-label="Search settings"
          />
          @if (searchQuery()) {
            <button
              class="search-clear"
              type="button"
              (click)="clearSearch()"
              aria-label="Clear search"
            >
              ×
            </button>
          }
        </div>

        <nav class="settings-nav">
          @for (item of ungroupedItems(); track item.id) {
            <button
              class="nav-item"
              type="button"
              [class.active]="activeTab() === item.id"
              (click)="selectTab(item.id)"
            >
              <span class="nav-item-icon"><app-settings-nav-icon [name]="item.id" /></span>
              <span class="nav-item-label">{{ item.label }}</span>
              @if (navBadges()[item.id]; as badge) {
                <span class="nav-badge" [attr.data-status]="badge.status">{{ badge.text }}</span>
              } @else if (item.recommended) {
                <span class="nav-recommended">Recommended</span>
              }
            </button>
          }

          @for (group of groups(); track group) {
            <span class="nav-group-label">{{ group }}</span>
            @for (item of getGroupItems(group); track item.id) {
              <button
                class="nav-item"
                type="button"
                [class.active]="activeTab() === item.id"
                (click)="selectTab(item.id)"
              >
                <span class="nav-item-icon"><app-settings-nav-icon [name]="item.id" /></span>
                <span class="nav-item-label">{{ item.label }}</span>
                @if (navBadges()[item.id]; as badge) {
                  <span class="nav-badge" [attr.data-status]="badge.status">{{ badge.text }}</span>
                } @else if (item.recommended) {
                  <span class="nav-recommended">Recommended</span>
                }
              </button>
            }
          }

          @if (!hasResults()) {
            <p class="nav-empty">No settings match “{{ searchQuery() }}”.</p>
          }
        </nav>
      </aside>

      <!-- Main content area -->
      <main class="settings-main">
        <div class="settings-main-primary">
          @if (!isWideTab() && activeItem(); as item) {
            <header class="section-topbar">
              <span class="section-icon">
                <app-settings-nav-icon [name]="item.id" />
              </span>
              <div class="section-heading">
                <h2>{{ item.label }}</h2>
                <p>{{ item.summary }}</p>
              </div>
            </header>
          }

          <div class="settings-content" [class.wide]="isWideTab()">
            @if (isLoading()) {
              <div class="settings-skeleton" aria-busy="true" aria-label="Loading settings…">
                <div class="skeleton-card">
                  <div class="skeleton-bar wide"></div>
                  <div class="skeleton-bar medium"></div>
                  <div class="skeleton-bar narrow"></div>
                </div>
                <div class="skeleton-card">
                  <div class="skeleton-bar medium"></div>
                  <div class="skeleton-bar narrow"></div>
                </div>
              </div>
            }
            <div class="settings-body" [class.wide]="isWideTab()" [class.hidden]="isLoading()">
              @switch (activeTab()) {
                @case ('general') {
                  <app-general-settings-tab />
                }
                @case ('connections') {
                  <app-connections-settings-tab />
                }
                @case ('network') {
                  <app-network-settings-tab />
                }
                @case ('orchestration') {
                  <app-orchestration-settings-tab />
                }
                @case ('memory') {
                  <app-memory-settings-tab />
                }
                @case ('display') {
                  <app-display-settings-tab />
                }
                @case ('ecosystem') {
                  <app-ecosystem-settings-tab />
                }
                @case ('permissions') {
                  <app-permissions-settings-tab />
                }
                @case ('review') {
                  <app-review-settings-tab />
                }
                @case ('advanced') {
                  <app-advanced-settings-tab />
                }
                @case ('keyboard') {
                  <app-keyboard-settings-tab />
                }
                @case ('remote-nodes') {
                  <app-remote-nodes-settings-tab />
                }
                @case ('cli-health') {
                  <app-cli-health-settings-tab />
                }
                @case ('doctor') {
                  <app-doctor-settings-tab />
                }
                @case ('provider-quota') {
                  <app-provider-quota-settings-tab />
                }
                @case ('rtk-savings') {
                  <app-rtk-savings-tab />
                }
                @case ('models') {
                  <app-models-page />
                }
                @case ('mcp') {
                  <app-mcp-page />
                }
                @case ('hooks') {
                  <app-hooks-page />
                }
                @case ('worktrees') {
                  <app-worktree-page />
                }
                @case ('snapshots') {
                  <app-snapshot-page />
                }
                @case ('archive') {
                  <app-archive-page />
                }
                @case ('remote-config') {
                  <app-remote-config-page />
                }
              }
            </div>
          </div>
        </div>

        <!-- Contextual help / preview pane (item 13) -->
        <aside
          class="settings-help-pane"
          [class.collapsed]="helpCollapsed()"
          aria-label="Contextual help and preview"
        >
          @if (helpCollapsed()) {
            <button
              class="help-pane-rail"
              type="button"
              (click)="toggleHelp()"
              aria-expanded="false"
              title="Show help &amp; tips"
            >
              <span class="help-pane-rail-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </span>
              <span class="help-pane-rail-text">Help</span>
            </button>
          } @else {
            <div class="help-pane-inner">
              <header class="help-pane-header">
                <h3 class="help-pane-title">Help &amp; tips</h3>
                <button
                  class="help-pane-collapse"
                  type="button"
                  (click)="toggleHelp()"
                  aria-expanded="true"
                  aria-label="Hide help panel"
                  title="Hide help panel"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </header>
              <div class="help-pane-body">
                @switch (activeTab()) {
                  @case ('display') {
                    <app-inline-help heading="What this does">
                      Controls the workspace theme, layout density, base font size, and
                      how much of each agent's reasoning and tool activity is shown
                      inline with messages.
                    </app-inline-help>
                    <app-inline-help variant="tip" heading="Saved as you go">
                      Theme, density, and font changes apply immediately and persist
                      across restarts — there is no separate save step.
                    </app-inline-help>
                    <app-inline-help variant="tip" heading="Quieter transcripts">
                      Hide thinking and tool messages to keep runs compact, then switch
                      them back on only while debugging.
                    </app-inline-help>
                  }
                  @case ('models') {
                    <app-inline-help heading="What this does">
                      Discovers the models each provider exposes, verifies they
                      respond, and lets you pin per-model overrides such as temperature.
                    </app-inline-help>
                    <app-inline-help [variant]="modelsHelpStatus().variant" heading="Live status">
                      {{ modelsHelpStatus().text }}
                    </app-inline-help>
                    <app-inline-help variant="tip" heading="Verify before relying">
                      “Verify” runs a real probe against the model. One still labelled
                      “available” has not been confirmed to work yet.
                    </app-inline-help>
                    <div class="help-block">
                      <p class="help-subhead">Override config example</p>
                      <pre class="help-code">{{ modelOverrideExample }}</pre>
                    </div>
                  }
                  @case ('remote-nodes') {
                    <app-inline-help heading="What this does">
                      Lets this machine hand agent work to other machines you have
                      paired as remote worker nodes.
                    </app-inline-help>
                    <app-inline-help [variant]="remoteNodesHelpStatus().variant" heading="Live status">
                      {{ remoteNodesHelpStatus().text }}
                    </app-inline-help>
                    <div class="help-block">
                      <p class="help-subhead">Pairing a node</p>
                      <ol class="help-steps">
                        <li>Enable Remote Nodes to start the pairing server.</li>
                        <li>Create a one-time pairing credential.</li>
                        <li>Scan the QR code or paste the link on the worker machine.</li>
                      </ol>
                    </div>
                    <app-inline-help variant="warning" heading="Credentials expire">
                      Pairing credentials are single-use and time-limited. Generate a
                      fresh one if a worker does not connect in time.
                    </app-inline-help>
                  }
                  @case ('doctor') {
                    <app-inline-help heading="What this does">
                      Aggregates startup, provider, CLI, browser-automation, and
                      command/skill/instruction diagnostics into one report.
                    </app-inline-help>
                    <app-inline-help [variant]="doctorHelpStatus().variant" heading="Live status">
                      {{ doctorHelpStatus().text }}
                    </app-inline-help>
                    <div class="help-block">
                      <p class="help-subhead">Runbooks</p>
                      <p class="help-text">
                        “Open Runbook” in each Doctor section opens the matching guide:
                      </p>
                      <ul class="help-links">
                        <li><code>runbooks/doctor-updates-and-artifacts.md</code></li>
                        <li><code>runbooks/command-help-and-palette.md</code></li>
                      </ul>
                    </div>
                    <app-inline-help variant="tip" heading="Sharing diagnostics">
                      Operator Artifacts exports a redacted bundle — paths are
                      home-relative and secrets are stripped — safe to attach to a
                      bug report.
                    </app-inline-help>
                  }
                  @case ('permissions') {
                    <app-inline-help heading="What this does">
                      Sets the default answer for filesystem and network actions an
                      agent takes that no rule or earlier decision already covers.
                    </app-inline-help>
                    <app-inline-help variant="warning" heading="“Allow” is broad">
                      The Allow preset lets agents act with no confirmation. “Ask” is
                      the safe default — switch to Allow only for trusted, sandboxed
                      workspaces.
                    </app-inline-help>
                    <div class="help-block">
                      <p class="help-subhead">Decision scopes</p>
                      <ul class="help-list">
                        <li><strong>This time only</strong> — applies to a single action.</li>
                        <li><strong>This session</strong> — until the app restarts.</li>
                        <li><strong>Always</strong> — saved as a persistent rule.</li>
                      </ul>
                    </div>
                    <app-inline-help variant="tip" heading="Learned patterns">
                      Approving a learned pattern turns a repeated decision into a
                      standing rule, cutting future prompts.
                    </app-inline-help>
                  }
                  @default {
                    <app-inline-help heading="Settings tips">
                      Use the search box to jump straight to any setting by name. Your
                      last section reopens automatically next time you visit Settings.
                    </app-inline-help>
                    <app-inline-help variant="tip" heading="Finding your way">
                      Sidebar sections are grouped by what they affect — agents,
                      workspace, network, and diagnostics. Press Esc to leave Settings.
                    </app-inline-help>
                  }
                }
              </div>
            </div>
          }
        </aside>
      </main>
    </div>
  `,
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  private store = inject(SettingsStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private appIpc = inject(AppIpcService);
  private cliUpdates = inject(CliUpdatePillStore);
  private remoteNodes = inject(RemoteNodeStore);
  private providerQuota = inject(ProviderQuotaStore);
  private destroyRef = inject(DestroyRef);
  private activeFragmentTab: SettingsTab | null = null;

  /** Still emitted when opened as a modal (legacy callers). */
  closeDialog = output<void>();

  readonly activeTab = signal<SettingsTab>('general');
  readonly searchQuery = signal('');
  /** Whether the contextual help/preview pane is collapsed (item 13). */
  readonly helpCollapsed = signal(this.readHelpCollapsed());

  /**
   * JSON example rendered in the Models help pane. Kept as a bound value so the
   * literal braces never reach the Angular template parser, which would treat a
   * bare `{` as the start of an ICU expansion and fail to compile the template.
   */
  readonly modelOverrideExample = '{ "temperature": 0.7, "topP": 0.9 }';

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
    const connected = nodes.filter((node) => node.status === 'connected').length;
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
    const connected = nodes.filter((node) => node.status === 'connected').length;
    return {
      variant: connected === nodes.length ? 'info' : 'warning',
      text: `${connected} of ${nodes.length} enrolled ${nodes.length === 1 ? 'node is' : 'nodes are'} connected.`,
    };
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

  /** Toggle the contextual help/preview pane and remember the choice (item 13). */
  toggleHelp(): void {
    const collapsed = !this.helpCollapsed();
    this.helpCollapsed.set(collapsed);
    this.persistHelpCollapsed(collapsed);
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

  resetAll(): void {
    if (confirm('Are you sure you want to reset all settings to their defaults?')) {
      void this.store.reset();
    }
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

  private persistHelpCollapsed(collapsed: boolean): void {
    try {
      localStorage.setItem(HELP_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }
}
