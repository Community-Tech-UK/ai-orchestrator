/**
 * Dashboard Component - Main application layout
 */

import { Component, inject, OnInit, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InstanceStore } from '../../core/state/instance.store';
import { CliStore } from '../../core/state/cli.store';
import { SettingsStore } from '../../core/state/settings.store';
import { InstanceListComponent } from '../instance-list/instance-list.component';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { CliErrorComponent } from '../cli-error/cli-error.component';
import { SettingsComponent } from '../settings/settings.component';
import { HistorySidebarComponent } from '../history/history-sidebar.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [DecimalPipe, InstanceListComponent, InstanceDetailComponent, CliErrorComponent, SettingsComponent, HistorySidebarComponent],
  template: `
    @if (cliStore.loading()) {
      <div class="loading-container">
        <div class="loading-spinner"></div>
        <p>Detecting available AI CLIs...</p>
      </div>
    } @else if (cliStore.noClisError()) {
      <app-cli-error [error]="cliStore.noClisError()!" (retry)="onRetryCliDetection()" />
    } @else {
    <div class="dashboard">
      <!-- Sidebar with instance list -->
      <aside class="sidebar">
        <div class="sidebar-header">
          <div class="header-row">
            <h1 class="app-title">Claude Orchestrator</h1>
            <div class="header-actions">
              <button class="btn-header-icon" (click)="showHistory.set(true)" title="History">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
              </button>
              <button class="btn-header-icon" (click)="showSettings.set(true)" title="Settings">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
              </button>
            </div>
          </div>
          <button class="btn-create" (click)="createInstance()">
            <span class="btn-icon">+</span>
            New Instance
          </button>
        </div>

        <app-instance-list />

        <div class="sidebar-footer">
          <div class="stats">
            <span class="stat">
              {{ store.instanceCount() }} instances
            </span>
            @if (store.totalContextUsage().total > 0) {
              <span class="stat">
                {{ (store.totalContextUsage().percentage | number:'1.0-0') }}% context
              </span>
            }
          </div>
          @if (store.instanceCount() > 0) {
            <button
              class="btn-close-all"
              (click)="closeAllInstances()"
              title="Close all instances"
            >
              Close All
            </button>
          }
        </div>
      </aside>

      <!-- Main content area -->
      <main class="main-content">
        <app-instance-detail />
      </main>
    </div>

    <!-- Settings Modal -->
    @if (showSettings()) {
      <app-settings (close)="showSettings.set(false)" />
    }

    <!-- History Sidebar -->
    @if (showHistory()) {
      <app-history-sidebar (close)="showHistory.set(false)" />
    }
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      width: 100%;
    }

    .loading-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: var(--spacing-md);
      color: var(--text-secondary);
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border-color);
      border-top-color: var(--primary-color);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .dashboard {
      display: flex;
      min-height: 100%;
      height: calc(100vh - 52px); /* Account for macOS title bar */
      width: 100%;
      background: var(--bg-primary);
    }

    .sidebar {
      width: 320px;
      min-width: 280px;
      max-width: 400px;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: var(--bg-secondary);
      border-right: 1px solid var(--border-color);
    }

    .sidebar-header {
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--spacing-md);
    }

    .app-title {
      font-size: 16px;
      font-weight: 600;
      margin: 0;
      color: var(--text-primary);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
    }

    .btn-header-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      background: transparent;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
      -webkit-app-region: no-drag;

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    }

    .btn-create {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--primary-color);
      color: white;
      border-radius: var(--radius-md);
      font-weight: 500;
      transition: background var(--transition-fast);
      -webkit-app-region: no-drag; /* Ensure button is clickable in drag zone */

      &:hover {
        background: var(--primary-hover);
      }
    }

    .btn-icon {
      font-size: 18px;
      line-height: 1;
    }

    .sidebar-footer {
      padding: var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .stats {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .btn-close-all {
      width: 100%;
      padding: var(--spacing-xs) var(--spacing-sm);
      background: transparent;
      border: 1px solid var(--error-color);
      color: var(--error-color);
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--error-color);
        color: white;
      }
    }

    .main-content {
      flex: 1;
      min-width: 0;
      height: 100%;
      display: flex;
      background: var(--bg-primary);
    }
  `],
})
export class DashboardComponent implements OnInit {
  store = inject(InstanceStore);
  cliStore = inject(CliStore);
  settingsStore = inject(SettingsStore);

  showSettings = signal(false);
  showHistory = signal(false);

  ngOnInit(): void {
    // Initialize settings first, then CLI detection
    this.settingsStore.initialize().then(() => {
      this.cliStore.initialize();
    });
  }

  createInstance(): void {
    const settings = this.settingsStore.settings();
    this.store.createInstance({
      displayName: `Instance ${Date.now()}`,
      workingDirectory: settings.defaultWorkingDirectory || undefined,
      yoloMode: settings.defaultYoloMode,
    });
  }

  closeAllInstances(): void {
    this.store.terminateAllInstances();
  }

  onRetryCliDetection(): void {
    this.cliStore.refresh();
  }
}
