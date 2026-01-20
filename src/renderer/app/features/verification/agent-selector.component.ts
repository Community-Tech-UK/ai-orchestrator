/**
 * Agent Selector Component
 *
 * Multi-select dropdown for choosing CLI agents in verification sessions.
 * Different from the agents/ AgentSelectorComponent which handles agent profiles.
 *
 * Features:
 * - Multi-select dropdown for CLI agents
 * - Status indicators (available/unavailable/auth-required)
 * - Quick add/remove with max limit
 * - Integration with VerificationStore
 */

import {
  Component,
  input,
  output,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnInit,
  OnDestroy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CliDetectionService } from './services/cli-detection.service';
import { VerificationStore } from '../../core/state/verification.store';
import { CliStatusIndicatorComponent } from './cli-status-indicator.component';
import { AgentCapabilityBadgesComponent } from './agent-capability-badges.component';
import type { CliType } from '../../../../shared/types/unified-cli-response';
import type { CliStatus, CliStatusInfo } from '../../../../shared/types/verification-ui.types';

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  imports: [CommonModule, CliStatusIndicatorComponent, AgentCapabilityBadgesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="agent-selector" [class.disabled]="disabled()">
      <!-- Dropdown Trigger -->
      <button
        class="selector-trigger"
        [class.open]="isOpen()"
        [disabled]="disabled()"
        (click)="toggleDropdown()"
      >
        <div class="trigger-content">
          @if (selectedCount() === 0) {
            <span class="placeholder">Select agents...</span>
          } @else {
            <div class="selected-preview">
              @for (agent of selectedAgentsPreview(); track agent) {
                <span class="agent-chip">
                  <app-cli-status-indicator
                    [status]="getAgentStatus(agent)"
                    [showLabel]="false"
                    [compact]="true"
                  />
                  {{ getDisplayName(agent) }}
                </span>
              }
              @if (selectedCount() > maxPreview()) {
                <span class="more-badge">+{{ selectedCount() - maxPreview() }}</span>
              }
            </div>
          }
        </div>
        <div class="trigger-actions">
          <span class="count-badge" [class.at-limit]="isAtLimit()">
            {{ selectedCount() }}/{{ maxAgents() }}
          </span>
          <span class="chevron" [class.rotated]="isOpen()">▼</span>
        </div>
      </button>

      <!-- Dropdown Menu -->
      @if (isOpen()) {
        <div class="dropdown-menu" (click)="$event.stopPropagation()">
          <!-- Search/Filter -->
          <div class="dropdown-header">
            <input
              type="text"
              class="search-input"
              placeholder="Filter agents..."
              [value]="searchQuery()"
              (input)="onSearchInput($event)"
            />
            @if (selectedCount() > 0) {
              <button
                class="clear-btn"
                title="Clear all"
                (click)="clearSelection()"
              >
                Clear
              </button>
            }
          </div>

          <!-- Agent List -->
          <div class="agent-list">
            @for (cli of filteredClis(); track cli.type) {
              <div
                class="agent-item"
                [class.selected]="isSelected(cli.type)"
                [class.unavailable]="cli.status !== 'available'"
                [class.disabled]="!canSelect(cli)"
                (click)="toggleAgent(cli)"
              >
                <div class="agent-info">
                  <div class="agent-header">
                    <app-cli-status-indicator
                      [status]="cli.status"
                      [showLabel]="false"
                    />
                    <span class="agent-name">{{ getDisplayName(cli.type) }}</span>
                    @if (isSelected(cli.type)) {
                      <span class="selected-check">✓</span>
                    }
                  </div>

                  <div class="agent-meta">
                    @if (cli.version) {
                      <span class="version">v{{ cli.version }}</span>
                    }
                    @if (cli.status === 'auth-required') {
                      <span class="auth-warning">Auth required</span>
                    } @else if (cli.status === 'not-found') {
                      <span class="not-found">Not installed</span>
                    } @else if (cli.status === 'error') {
                      <span class="error-text">{{ cli.errorMessage || 'Error' }}</span>
                    }
                  </div>

                  @if (cli.capabilities && cli.capabilities.length > 0 && cli.status === 'available') {
                    <app-agent-capability-badges
                      [capabilities]="cli.capabilities"
                      [maxVisible]="3"
                      [compact]="true"
                    />
                  }
                </div>

                @if (cli.status !== 'available') {
                  <div class="agent-actions">
                    @if (cli.status === 'not-found') {
                      <button
                        class="action-link"
                        (click)="handleInstall(cli.type, $event)"
                      >
                        Install
                      </button>
                    } @else if (cli.status === 'auth-required') {
                      <button
                        class="action-link warning"
                        (click)="handleAuth(cli.type, $event)"
                      >
                        Authenticate
                      </button>
                    }
                  </div>
                }
              </div>
            } @empty {
              <div class="empty-state">
                @if (searchQuery()) {
                  <span>No agents match "{{ searchQuery() }}"</span>
                } @else {
                  <span>No agents available</span>
                  <button class="scan-btn" (click)="handleScan()">
                    Scan for CLIs
                  </button>
                }
              </div>
            }
          </div>

          <!-- Footer -->
          <div class="dropdown-footer">
            <div class="footer-stats">
              <span class="stat available">
                {{ availableCount() }} available
              </span>
              @if (authRequiredCount() > 0) {
                <span class="stat warning">
                  {{ authRequiredCount() }} need auth
                </span>
              }
            </div>
            @if (showScanButton()) {
              <button
                class="scan-link"
                [disabled]="cliService.isScanning()"
                (click)="handleScan()"
              >
                @if (cliService.isScanning()) {
                  <span class="spinner"></span>
                  Scanning...
                } @else {
                  🔍 Rescan
                }
              </button>
            }
          </div>
        </div>
      }

      <!-- Click-outside overlay -->
      @if (isOpen()) {
        <div class="backdrop" (click)="closeDropdown()"></div>
      }
    </div>
  `,
  styles: [`
    .agent-selector {
      position: relative;
      width: 100%;
    }

    .agent-selector.disabled {
      opacity: 0.6;
      pointer-events: none;
    }

    /* Trigger Button */
    .selector-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: 100%;
      min-height: 40px;
      padding: 8px 12px;
      background: var(--bg-tertiary, #262626);
      border: 1px solid var(--border-color, #374151);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .selector-trigger:hover:not(:disabled) {
      border-color: var(--border-hover, #9ca3af);
    }

    .selector-trigger.open {
      border-color: var(--accent-color, #3b82f6);
    }

    .selector-trigger:disabled {
      cursor: not-allowed;
    }

    .trigger-content {
      flex: 1;
      min-width: 0;
    }

    .placeholder {
      color: var(--text-muted, #6b7280);
      font-size: 13px;
    }

    .selected-preview {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .agent-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-primary);
    }

    .more-badge {
      padding: 2px 6px;
      background: var(--accent-color, #3b82f6);
      color: white;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
    }

    .trigger-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: 8px;
    }

    .count-badge {
      font-size: 11px;
      color: var(--text-secondary);
      padding: 2px 6px;
      background: var(--bg-secondary, #1a1a1a);
      border-radius: 4px;
    }

    .count-badge.at-limit {
      color: #f59e0b;
      background: rgba(245, 158, 11, 0.1);
    }

    .chevron {
      font-size: 10px;
      color: var(--text-muted, #6b7280);
      transition: transform 0.2s;
    }

    .chevron.rotated {
      transform: rotate(180deg);
    }

    /* Dropdown Menu */
    .dropdown-menu {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      z-index: 100;
      background: var(--bg-secondary, #1a1a1a);
      border: 1px solid var(--border-color, #374151);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      max-height: 400px;
      display: flex;
      flex-direction: column;
    }

    .dropdown-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border-color, #374151);
    }

    .search-input {
      flex: 1;
      padding: 6px 10px;
      background: var(--bg-tertiary, #262626);
      border: 1px solid var(--border-color, #374151);
      border-radius: 4px;
      font-size: 12px;
      color: var(--text-primary);
    }

    .search-input::placeholder {
      color: var(--text-muted, #6b7280);
    }

    .search-input:focus {
      outline: none;
      border-color: var(--accent-color, #3b82f6);
    }

    .clear-btn {
      padding: 4px 8px;
      background: none;
      border: none;
      font-size: 11px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .clear-btn:hover {
      color: var(--text-primary);
    }

    /* Agent List */
    .agent-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    .agent-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.15s;
    }

    .agent-item:hover:not(.disabled) {
      background: var(--bg-tertiary, #262626);
    }

    .agent-item.selected {
      background: rgba(59, 130, 246, 0.1);
    }

    .agent-item.unavailable {
      opacity: 0.7;
    }

    .agent-item.disabled {
      cursor: not-allowed;
      opacity: 0.5;
    }

    .agent-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;
      min-width: 0;
    }

    .agent-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .agent-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .selected-check {
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--accent-color, #3b82f6);
      color: white;
      border-radius: 50%;
      font-size: 10px;
      font-weight: bold;
      margin-left: auto;
    }

    .agent-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
    }

    .version {
      color: var(--text-muted, #6b7280);
    }

    .auth-warning {
      color: #f59e0b;
    }

    .not-found {
      color: #ef4444;
    }

    .error-text {
      color: #ef4444;
    }

    .agent-actions {
      display: flex;
      align-items: center;
      margin-left: 8px;
    }

    .action-link {
      background: none;
      border: none;
      padding: 4px 8px;
      font-size: 11px;
      color: var(--accent-color, #3b82f6);
      cursor: pointer;
    }

    .action-link:hover {
      text-decoration: underline;
    }

    .action-link.warning {
      color: #f59e0b;
    }

    /* Empty State */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 24px 16px;
      color: var(--text-muted, #6b7280);
      font-size: 13px;
    }

    .scan-btn {
      padding: 6px 12px;
      background: var(--accent-color, #3b82f6);
      border: none;
      border-radius: 4px;
      font-size: 12px;
      color: white;
      cursor: pointer;
    }

    .scan-btn:hover {
      background: #2563eb;
    }

    /* Footer */
    .dropdown-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-top: 1px solid var(--border-color, #374151);
      font-size: 11px;
    }

    .footer-stats {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .stat {
      color: var(--text-secondary);
    }

    .stat.available {
      color: #22c55e;
    }

    .stat.warning {
      color: #f59e0b;
    }

    .scan-link {
      display: flex;
      align-items: center;
      gap: 4px;
      background: none;
      border: none;
      padding: 0;
      font-size: 11px;
      color: var(--accent-color, #3b82f6);
      cursor: pointer;
    }

    .scan-link:hover:not(:disabled) {
      text-decoration: underline;
    }

    .scan-link:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .spinner {
      width: 10px;
      height: 10px;
      border: 2px solid rgba(59, 130, 246, 0.3);
      border-top-color: var(--accent-color, #3b82f6);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Backdrop */
    .backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
    }
  `],
})
export class AgentSelectorComponent implements OnInit, OnDestroy {
  readonly cliService = inject(CliDetectionService);
  private readonly store = inject(VerificationStore);

  // Inputs
  maxAgents = input<number>(4);
  maxPreview = input<number>(3);
  disabled = input<boolean>(false);
  showScanButton = input<boolean>(true);
  initialSelection = input<CliType[]>([]);

  // Outputs
  selectionChange = output<CliType[]>();
  agentInstall = output<CliType>();
  agentAuth = output<CliType>();

  // Local State
  isOpen = signal<boolean>(false);
  searchQuery = signal<string>('');

  // Computed - Selected Agents
  selectedAgents = computed(() => this.store.selectedAgents());
  selectedCount = computed(() => this.selectedAgents().length);
  isAtLimit = computed(() => this.selectedCount() >= this.maxAgents());

  selectedAgentsPreview = computed(() =>
    this.selectedAgents().slice(0, this.maxPreview())
  );

  // Computed - CLI Lists
  filteredClis = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const clis = this.cliService.cliList();

    if (!query) {
      // Sort: available first, then by name
      return [...clis].sort((a, b) => {
        if (a.status === 'available' && b.status !== 'available') return -1;
        if (a.status !== 'available' && b.status === 'available') return 1;
        return this.getDisplayName(a.type).localeCompare(this.getDisplayName(b.type));
      });
    }

    return clis.filter(cli => {
      const name = this.getDisplayName(cli.type).toLowerCase();
      const type = cli.type.toLowerCase();
      return name.includes(query) || type.includes(query);
    });
  });

  availableCount = computed(() =>
    this.cliService.availableClis().length
  );

  authRequiredCount = computed(() =>
    this.cliService.authRequiredClis().length
  );

  // ============================================
  // Lifecycle
  // ============================================

  ngOnInit(): void {
    // Initialize selection if provided
    const initial = this.initialSelection();
    if (initial.length > 0) {
      this.store.setSelectedAgents(initial);
    }

    // Scan for CLIs if not already done
    if (this.cliService.cliList().length === 0 ||
        this.cliService.cliList().every(cli => cli.status === 'not-found')) {
      this.cliService.scanAll();
    }
  }

  ngOnDestroy(): void {
    // Cleanup if needed
  }

  // ============================================
  // Public Methods
  // ============================================

  toggleDropdown(): void {
    if (this.disabled()) return;
    this.isOpen.update(v => !v);
    if (!this.isOpen()) {
      this.searchQuery.set('');
    }
  }

  closeDropdown(): void {
    this.isOpen.set(false);
    this.searchQuery.set('');
  }

  onSearchInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.searchQuery.set(input.value);
  }

  toggleAgent(cli: CliStatusInfo): void {
    if (!this.canSelect(cli)) return;

    if (this.isSelected(cli.type)) {
      this.store.removeSelectedAgent(cli.type);
    } else {
      this.store.addSelectedAgent(cli.type);
    }

    this.selectionChange.emit(this.selectedAgents());
  }

  clearSelection(): void {
    this.store.setSelectedAgents([]);
    this.selectionChange.emit([]);
  }

  isSelected(type: CliType): boolean {
    return this.selectedAgents().includes(type);
  }

  canSelect(cli: CliStatusInfo): boolean {
    // Can always deselect
    if (this.isSelected(cli.type)) return true;
    // Can't select if unavailable
    if (cli.status !== 'available') return false;
    // Can't select if at limit
    if (this.isAtLimit()) return false;
    return true;
  }

  getAgentStatus(type: CliType): CliStatus {
    return this.cliService.getCliStatus(type)?.status || 'not-found';
  }

  getDisplayName(type: CliType): string {
    const metadata = this.cliService.getCliMetadata(type);
    return metadata?.displayName || type;
  }

  handleScan(): void {
    this.cliService.scanAll(true);
  }

  handleInstall(type: CliType, event: Event): void {
    event.stopPropagation();
    const url = this.cliService.getInstallUrl(type);
    if (url) {
      window.open(url, '_blank');
    }
    this.agentInstall.emit(type);
  }

  handleAuth(type: CliType, event: Event): void {
    event.stopPropagation();
    this.agentAuth.emit(type);
  }
}
