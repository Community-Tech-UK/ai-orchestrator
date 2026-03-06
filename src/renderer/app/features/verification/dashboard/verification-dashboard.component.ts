/**
 * Verification Dashboard Component
 *
 * Main entry point for multi-agent verification:
 * - Available agents overview with status
 * - Quick start verification form
 * - Recent verification sessions
 * - Navigation to monitor and results views
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnDestroy,
  ElementRef,
  viewChild,
  AfterViewInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { VerificationStore } from '../../../core/state/verification.store';
import { CliStore } from '../../../core/state/cli.store';
import { ElectronIpcService } from '../../../core/services/ipc';
import { TaskIpcService } from '../../../core/services/ipc/task-ipc.service';
import { DraftService, VERIFICATION_DRAFT_KEY } from '../../../core/services/draft.service';
import { AgentCardComponent } from '../shared/components/agent-card.component';
import { AgentConfigPanelComponent } from '../config/agent-config-panel.component';
import { VerificationMonitorComponent } from '../execution/verification-monitor.component';
import { VerificationResultsComponent } from '../results/verification-results.component';
import { DropZoneComponent } from '../../file-drop/drop-zone.component';
import type { CliType } from '../../../../../shared/types/unified-cli-response';
import type { SynthesisStrategy } from '../../../../../shared/types/verification.types';
import type { TaskPreflightReport } from '../../../../../shared/types/task-preflight.types';
import { TaskPreflightCardComponent } from '../../../shared/components/task-preflight-card.component';

@Component({
  selector: 'app-verification-dashboard',
  standalone: true,
  imports: [
    FormsModule,
    AgentCardComponent,
    AgentConfigPanelComponent,
    VerificationMonitorComponent,
    VerificationResultsComponent,
    DropZoneComponent,
    TaskPreflightCardComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="verification-container">
      <!-- Header -->
      <div class="verification-header">
        <div class="header-left">
          <button class="back-btn" type="button" (click)="navigateBack()" aria-label="Back to Dashboard">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M19 12H5"></path>
              <polyline points="12 19 5 12 12 5"></polyline>
            </svg>
          </button>
          <span class="verification-icon">🔍</span>
          <h1 class="verification-title">Multi-Agent Verification</h1>
        </div>
        <div class="header-actions">
          <button class="action-btn secondary" type="button" (click)="openSettings()">
            Settings
          </button>
          <button class="action-btn secondary" type="button" (click)="showHelp()" aria-label="Help">
            ?
          </button>
        </div>
      </div>

      <!-- Tab Navigation -->
      <div class="tab-navigation">
        <button
          class="tab-btn"
          type="button"
          [class.active]="store.selectedTab() === 'dashboard'"
          (click)="store.setSelectedTab('dashboard')"
        >
          Dashboard
        </button>
        <button
          class="tab-btn"
          type="button"
          [class.active]="store.selectedTab() === 'monitor'"
          [disabled]="!store.isRunning()"
          (click)="store.setSelectedTab('monitor')"
        >
          Monitor
          @if (store.isRunning()) {
            <span class="running-indicator"></span>
          }
        </button>
        <button
          class="tab-btn"
          type="button"
          [class.active]="store.selectedTab() === 'results'"
          [disabled]="!store.result()"
          (click)="store.setSelectedTab('results')"
        >
          Results
        </button>
      </div>

      <!-- Tab Content -->
      <app-drop-zone
        class="tab-content-drop-zone"
        (filesDropped)="onFilesDropped($event)"
        (imagesPasted)="onImagesPasted($event)"
      >
      <div class="tab-content">
        @switch (store.selectedTab()) {
          @case ('dashboard') {
            <!-- Quick Start Section -->
            <section class="section">
              <div class="section-header">
                <h2 class="section-title">Quick Start</h2>
              </div>

              <div class="quick-start-form">
                <!-- Pending files preview -->
                @if (pendingFilePreviews().length > 0) {
                  <div class="pending-files">
                    @for (preview of pendingFilePreviews(); track preview.file.name) {
                      @if (preview.isImage) {
                        <div class="file-preview-card">
                          <div class="preview-thumbnail" [style.background-image]="'url(' + preview.previewUrl + ')'">
                          </div>
                          <div class="preview-info">
                            <span class="file-name">{{ preview.file.name }}</span>
                            <span class="file-size">{{ preview.size }}</span>
                          </div>
                          <button class="file-remove" type="button" (click)="removeFile(preview.file)" [attr.aria-label]="'Remove ' + preview.file.name">×</button>
                        </div>
                      } @else {
                        <div class="file-chip">
                          <span class="file-icon">{{ preview.icon }}</span>
                          <span class="file-name">{{ preview.file.name }}</span>
                          <button class="file-remove" type="button" (click)="removeFile(preview.file)" [attr.aria-label]="'Remove ' + preview.file.name">×</button>
                        </div>
                      }
                    }
                  </div>
                }

                <!-- Working Directory Selector -->
                <div class="form-group">
                  <span class="form-label">Working Directory</span>
                  <div class="directory-selector">
                    <button
                      class="directory-btn"
                      type="button"
                      (click)="selectWorkingDirectory()"
                      [title]="workingDirectory() || 'Select a folder for agents to scan'"
                    >
                      <span class="directory-icon">📁</span>
                      <span class="directory-path">
                        {{ workingDirectory() || 'Select folder to scan...' }}
                      </span>
                    </button>
                    @if (workingDirectory()) {
                      <button
                        class="directory-clear"
                        type="button"
                        (click)="clearWorkingDirectory()"
                        aria-label="Clear working directory"
                      >
                        ×
                      </button>
                    }
                  </div>
                  <span class="form-hint">Agents will analyze code in this directory</span>
                  <div class="preflight-wrapper">
                    <app-task-preflight-card
                      [report]="preflight()"
                      [loading]="preflightLoading()"
                      title="Verification Preflight"
                      subtitle="Checks the selected workspace for instruction, permission, and network readiness."
                      emptyMessage="Pick a working directory to inspect verification readiness."
                    />
                  </div>
                </div>

                <div class="form-group">
                  <label class="form-label" for="prompt-input">Prompt</label>
                  <textarea
                    #promptTextarea
                    id="prompt-input"
                    class="form-textarea auto-expand"
                    [ngModel]="promptInput"
                    (ngModelChange)="onPromptChange($event)"
                    (input)="autoExpandTextarea()"
                    (keydown.enter)="onEnterKey($event)"
                    placeholder="Enter your verification prompt... (paste images or drop files here)

You can write detailed, multi-line prompts here. The textarea will expand as needed."
                    rows="4"
                  ></textarea>
                  <div class="prompt-actions">
                    <span class="char-count">{{ promptInput.length }} characters</span>
                    <button
                      class="expand-btn"
                      type="button"
                      (click)="toggleExpandedPrompt()"
                      [title]="isPromptExpanded() ? 'Collapse prompt area' : 'Expand prompt area'"
                    >
                      {{ isPromptExpanded() ? '↑ Collapse' : '↓ Expand' }}
                    </button>
                  </div>
                </div>

                <div class="form-row">
                  <div class="form-group">
                    <span class="form-label">Selected Agents</span>
                    <div class="agent-chips">
                      @for (agent of validSelectedAgents(); track agent) {
                        <span class="agent-chip">
                          {{ getAgentDisplayName(agent) }}
                          <button
                            class="chip-remove"
                            type="button"
                            (click)="store.removeSelectedAgent(agent)"
                            [attr.aria-label]="'Remove ' + getAgentDisplayName(agent)"
                          >
                            ×
                          </button>
                        </span>
                      }
                      @if (canAddMoreAgents()) {
                        <button class="add-agent-btn" type="button" (click)="showAgentPicker()">
                          + Add Agent
                        </button>
                      }
                    </div>
                  </div>

                  <div class="form-group">
                    <span class="form-label">Strategy</span>
                    <div class="strategy-cards">
                      @for (strategy of strategies; track strategy.value) {
                        <label
                          class="strategy-card"
                          [class.selected]="selectedStrategy === strategy.value"
                        >
                          <input
                            type="radio"
                            name="strategy"
                            [value]="strategy.value"
                            [(ngModel)]="selectedStrategy"
                            (ngModelChange)="onStrategyChange($event)"
                            class="visually-hidden"
                          />
                          <span class="strategy-name">{{ strategy.label }}</span>
                          <span class="strategy-desc">{{ strategy.description }}</span>
                        </label>
                      }
                    </div>
                  </div>
                </div>

                <div class="form-actions">
                  <button
                    class="action-btn text"
                    type="button"
                    (click)="store.toggleConfigPanel()"
                  >
                    Advanced Options
                  </button>
                  <button
                    class="action-btn primary"
                    type="button"
                    [disabled]="!canStartVerification()"
                    (click)="startVerification()"
                  >
                    Start Verification
                  </button>
                </div>
              </div>
            </section>

            <!-- Available Agents Section -->
            <section class="section" [class.collapsed]="agentsCollapsed()">
              <div class="section-header clickable" (click)="toggleAgentsCollapsed()" (keydown.enter)="toggleAgentsCollapsed()" (keydown.space)="toggleAgentsCollapsed()" tabindex="0" role="button" [attr.aria-expanded]="!agentsCollapsed()">
                <div class="section-header-left">
                  <button class="collapse-btn" [class.collapsed]="agentsCollapsed()" type="button" [attr.aria-label]="agentsCollapsed() ? 'Expand available agents' : 'Collapse available agents'">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </button>
                  <h2 class="section-title">Available Agents</h2>
                  <span class="agents-count-badge">{{ availableClis().length }}/{{ totalClis() }}</span>
                </div>
                <button
                  class="action-btn text"
                  type="button"
                  [disabled]="isScanning()"
                  (click)="rescanClis(); $event.stopPropagation()"
                >
                  @if (isScanning()) {
                    Scanning...
                  } @else {
                    Rescan CLIs
                  }
                </button>
              </div>

              <div class="collapsible-content" [class.collapsed]="agentsCollapsed()">
                <div class="agents-grid">
                  @for (cli of availableClis(); track cli.name) {
                    <app-agent-card
                      [cli]="cli"
                      [selected]="isAgentSelected(cli.name)"
                      (agentSelect)="toggleAgentSelection(cli.name)"
                      (configure)="openAgentConfig(cli.name)"
                    />
                  }
                  @for (cli of unavailableClis(); track cli.name) {
                    <app-agent-card
                      [cli]="cli"
                      [selected]="false"
                      [unavailable]="true"
                      (install)="openInstallGuide(cli.name)"
                    />
                  }
                </div>

                <div class="agents-summary">
                  <span class="summary-text">
                    {{ availableClis().length }} of {{ totalClis() }} agents available
                  </span>
                </div>
              </div>
            </section>

            <!-- Recent Sessions Section -->
            <section class="section">
              <div class="section-header">
                <h2 class="section-title">Recent Sessions</h2>
              </div>

              @if (store.recentSessions().length > 0) {
                <div class="sessions-list">
                  @for (session of store.recentSessions(); track session.id) {
                    <div
                      class="session-item"
                      (click)="viewSession(session.id)"
                      (keydown.enter)="viewSession(session.id)"
                      (keydown.space)="viewSession(session.id)"
                      tabindex="0"
                      role="button"
                    >
                      <div class="session-info">
                        <span class="session-icon">📋</span>
                        <span class="session-prompt">{{ truncatePrompt(session.prompt) }}</span>
                      </div>
                      <div class="session-meta">
                        <span class="session-agents">{{ session.config.agentCount }} agents</span>
                        <span class="session-strategy">{{ session.config.synthesisStrategy }}</span>
                        <span class="session-time">{{ formatTimeAgo(session.startedAt) }}</span>
                        <span
                          class="session-status"
                          [class]="'status-' + session.status"
                        >
                          {{ session.status }}
                        </span>
                      </div>
                      <button
                        class="session-delete"
                        type="button"
                        aria-label="Delete session"
                        (click)="deleteSession(session.id, $event)"
                      >
                        ×
                      </button>
                      <button class="session-arrow" type="button" aria-hidden="true" tabindex="-1">→</button>
                    </div>
                  }
                </div>
              } @else {
                <div class="empty-state">
                  <p>No verification sessions yet. Start your first verification above!</p>
                </div>
              }
            </section>
          }

          @case ('monitor') {
            <app-verification-monitor />
          }

          @case ('results') {
            <app-verification-results />
          }
        }
      </div>
      </app-drop-zone>

      <!-- Config Panel Overlay -->
      @if (store.configPanelOpen()) {
        <app-agent-config-panel (closePanel)="store.closeConfigPanel()" />
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .verification-container {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: hidden;
    }

    .verification-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 32px;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .back-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      background: transparent;
      border: 1px solid var(--border-color);
      border-radius: 8px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.2s;
    }

    .back-btn:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
      border-color: var(--text-secondary);
    }

    .verification-icon {
      font-size: 24px;
    }

    .verification-title {
      font-size: 20px;
      font-weight: 600;
      margin: 0;
    }

    .header-actions {
      display: flex;
      gap: 8px;
    }

    .action-btn {
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      border: none;
    }

    .action-btn.primary {
      background: var(--accent-color, #3b82f6);
      color: white;
    }

    .action-btn.primary:hover:not(:disabled) {
      background: var(--accent-hover, #2563eb);
    }

    .action-btn.primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .action-btn.secondary {
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .action-btn.secondary:hover {
      background: var(--bg-hover);
    }

    .action-btn.text {
      background: transparent;
      color: var(--accent-color, #3b82f6);
    }

    .action-btn.text:hover {
      background: var(--bg-hover);
    }

    .tab-navigation {
      display: flex;
      gap: 8px;
      padding: 12px 32px;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .tab-btn {
      padding: 8px 16px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .tab-btn:hover:not(:disabled) {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .tab-btn.active {
      background: var(--accent-color, #3b82f6);
      color: white;
    }

    .tab-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .running-indicator {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .tab-content {
      flex: 1;
      overflow-y: auto;
      padding: 32px;
    }

    .tab-content > section {
      max-width: 1200px;
      margin-left: auto;
      margin-right: auto;
    }

    .section {
      background: var(--bg-secondary);
      border-radius: 12px;
      border: 1px solid var(--border-color);
      padding: 24px;
      margin-bottom: 24px;
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border-color);
    }

    .section-header.clickable {
      cursor: pointer;
      user-select: none;
    }

    .section-header.clickable:hover {
      background: var(--bg-hover);
      margin: -12px -12px 20px -12px;
      padding: 12px 12px 12px 12px;
      border-radius: 8px 8px 0 0;
    }

    .section.collapsed .section-header {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }

    .section.collapsed .section-header.clickable:hover {
      margin: -12px;
      padding: 12px;
      border-radius: 8px;
    }

    .section-header-left {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .collapse-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: transparent;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      transition: transform 0.2s ease;
      padding: 0;
    }

    .collapse-btn.collapsed {
      transform: rotate(-90deg);
    }

    .agents-count-badge {
      font-size: 12px;
      font-weight: 500;
      padding: 2px 8px;
      background: var(--bg-tertiary);
      border-radius: 12px;
      color: var(--text-secondary);
    }

    .collapsible-content {
      overflow: hidden;
      max-height: 1000px;
      opacity: 1;
      transition: max-height 0.3s ease, opacity 0.2s ease;
    }

    .collapsible-content.collapsed {
      max-height: 0;
      opacity: 0;
    }

    .section-title {
      font-size: 15px;
      font-weight: 600;
      margin: 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
    }

    .agents-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 20px;
      margin-bottom: 16px;
    }

    .agents-grid:empty::after {
      content: 'No CLI agents detected. Click "Rescan CLIs" to search.';
      grid-column: 1 / -1;
      text-align: center;
      padding: 40px 20px;
      color: var(--text-secondary);
      font-size: 14px;
    }

    .agents-summary {
      text-align: right;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .quick-start-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .tab-content-drop-zone {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .pending-files {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px;
      background: var(--bg-secondary);
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    .file-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      font-size: 12px;
    }

    .file-icon {
      font-size: 14px;
    }

    .file-name {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-remove {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0 2px;
      font-size: 14px;
      line-height: 1;
    }

    .file-remove:hover {
      color: var(--error-color, #ef4444);
    }

    .file-preview-card {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--bg-tertiary, var(--bg-secondary));
      border-radius: 6px;
      border: 1px solid var(--border-color);
    }

    .preview-thumbnail {
      width: 48px;
      height: 48px;
      border-radius: 4px;
      overflow: hidden;
      flex-shrink: 0;
      background-color: var(--bg-secondary);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
    }

    .preview-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .preview-info .file-name {
      max-width: 200px;
    }

    .file-size {
      font-size: 11px;
      color: var(--text-secondary);
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .form-row {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 32px;
      align-items: start;
    }

    .form-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
    }

    .form-textarea {
      padding: 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 14px;
      resize: vertical;
      font-family: inherit;
      min-height: 100px;
      max-height: 500px;
      transition: min-height 0.2s ease;
    }

    .form-textarea.auto-expand {
      overflow-y: hidden;
      resize: none;
    }

    .form-textarea.auto-expand.expanded {
      min-height: 300px;
    }

    .form-textarea:focus {
      outline: none;
      border-color: var(--accent-color, #3b82f6);
    }

    .form-hint {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .preflight-wrapper {
      margin-top: 12px;
    }

    .prompt-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 4px;
    }

    .char-count {
      font-size: 12px;
      color: var(--text-muted);
    }

    .expand-btn {
      background: transparent;
      border: none;
      color: var(--accent-color, #3b82f6);
      font-size: 12px;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
    }

    .expand-btn:hover {
      background: var(--bg-hover);
    }

    .directory-selector {
      display: flex;
      align-items: stretch;
      gap: 0;
    }

    .directory-btn {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 14px;
      cursor: pointer;
      text-align: left;
      transition: all 0.2s;
      min-height: 44px;
    }

    .directory-btn:hover {
      border-color: var(--accent-color, #3b82f6);
      background: var(--bg-hover);
    }

    .directory-icon {
      font-size: 18px;
      flex-shrink: 0;
    }

    .directory-path {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-secondary);
    }

    .directory-btn:has(+ .directory-clear) {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      border-right: none;
    }

    .directory-btn:has(+ .directory-clear) .directory-path {
      color: var(--text-primary);
    }

    .directory-clear {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 12px;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-left: none;
      border-radius: 0 6px 6px 0;
      color: var(--text-secondary);
      font-size: 18px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .directory-clear:hover {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .agent-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .agent-chip {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      background: var(--bg-tertiary);
      border-radius: 16px;
      font-size: 13px;
    }

    .chip-remove {
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0;
      font-size: 16px;
      line-height: 1;
    }

    .chip-remove:hover {
      color: var(--text-primary);
    }

    .add-agent-btn {
      padding: 6px 10px;
      background: transparent;
      border: 1px dashed var(--border-color);
      border-radius: 16px;
      font-size: 13px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .add-agent-btn:hover {
      border-color: var(--accent-color, #3b82f6);
      color: var(--accent-color, #3b82f6);
    }

    .strategy-cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .strategy-card {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 12px 16px;
      background: var(--bg-primary);
      border: 2px solid var(--border-color);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .strategy-card:hover {
      border-color: var(--text-secondary);
    }

    .strategy-card.selected {
      border-color: var(--accent-color, #3b82f6);
      background: rgba(59, 130, 246, 0.05);
    }

    .strategy-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .strategy-desc {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .strategy-card.selected .strategy-name {
      color: var(--accent-color, #3b82f6);
    }

    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      padding-top: 8px;
    }

    .sessions-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-primary);
      border-radius: 6px;
      cursor: pointer;
      transition: background 0.2s;
    }

    .session-item:hover {
      background: var(--bg-hover);
    }

    .session-info {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
    }

    .session-prompt {
      font-size: 14px;
      font-weight: 500;
    }

    .session-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .session-status {
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
    }

    .session-status.status-complete {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    .session-status.status-running {
      background: rgba(59, 130, 246, 0.1);
      color: #3b82f6;
    }

    .session-status.status-error {
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .session-delete {
      background: none;
      border: none;
      font-size: 18px;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }

    .session-delete:hover {
      color: #ef4444;
      background: rgba(239, 68, 68, 0.1);
    }

    .session-arrow {
      background: none;
      border: none;
      font-size: 18px;
      color: var(--text-secondary);
    }

    .empty-state {
      text-align: center;
      padding: 32px;
      color: var(--text-secondary);
    }
  `],
})
export class VerificationDashboardComponent implements OnDestroy, AfterViewInit {
  private router = inject(Router);
  private draftService = inject(DraftService);
  private ipc = inject(ElectronIpcService);
  private taskIpc = inject(TaskIpcService);
  store = inject(VerificationStore);
  cliStore = inject(CliStore);

  // ViewChild for auto-expanding textarea
  private promptTextarea = viewChild<ElementRef<HTMLTextAreaElement>>('promptTextarea');

  // Form state
  promptInput = '';
  selectedStrategy: SynthesisStrategy = 'debate';
  workingDirectory = signal<string | null>(null);
  preflight = signal<TaskPreflightReport | null>(null);
  preflightLoading = signal(false);
  pendingFiles = signal<File[]>([]);
  private filePreviewUrls = new Map<File, string>();

  // UI state
  agentsCollapsed = signal(true);
  isPromptExpanded = signal(false);

  // Computed preview data for pending files
  pendingFilePreviews = computed(() => {
    const files = this.pendingFiles();
    return files.map(file => ({
      file,
      isImage: file.type.startsWith('image/'),
      previewUrl: this.getOrCreatePreviewUrl(file),
      size: this.formatFileSize(file.size),
      icon: this.getFileIcon(file),
    }));
  });

  private getOrCreatePreviewUrl(file: File): string {
    if (!this.filePreviewUrls.has(file)) {
      const url = URL.createObjectURL(file);
      this.filePreviewUrls.set(file, url);
    }
    return this.filePreviewUrls.get(file)!;
  }

  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Strategy options with descriptions
  strategies: { value: SynthesisStrategy; label: string; description: string }[] = [
    { value: 'consensus', label: 'Consensus', description: 'Only returns points all agents agree on' },
    { value: 'debate', label: 'Debate', description: 'Agents critique each other over multiple rounds' },
    { value: 'best-of', label: 'Best-of', description: 'Picks the single best response from all agents' },
    { value: 'merge', label: 'Merge', description: 'Combines best parts from each agent response' },
  ];

  // Computed from CliStore
  availableClis = computed(() => this.cliStore.availableClis());

  unavailableClis = computed(() =>
    this.cliStore.clis().filter(cli => !cli.installed)
  );

  totalClis = computed(() => this.cliStore.clis().length);

  isScanning = computed(() => this.cliStore.loading());

  // Filter selected agents to only include available (installed) CLIs
  validSelectedAgents = computed(() => {
    const selected = this.store.selectedAgents();
    const availableNames = this.availableClis().map(cli => cli.name);
    return selected.filter(agent => availableNames.includes(agent));
  });

  constructor() {
    // Load draft on init
    this.promptInput = this.draftService.getDraft(VERIFICATION_DRAFT_KEY);

    // Initialize CLI detection if not already done
    if (!this.cliStore.initialized()) {
      this.cliStore.initialize();
    }

    // Load saved strategy from store config
    const config = this.store.defaultConfig();
    if (config.synthesisStrategy) {
      this.selectedStrategy = config.synthesisStrategy;
    }
  }

  ngAfterViewInit(): void {
    // Auto-expand textarea on initial load if there's content
    setTimeout(() => this.autoExpandTextarea(), 0);
  }

  ngOnDestroy(): void {
    // Save draft when leaving the view
    this.draftService.setDraft(VERIFICATION_DRAFT_KEY, this.promptInput);

    // Clean up all preview URLs
    for (const url of this.filePreviewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.filePreviewUrls.clear();
  }

  // ============================================
  // Agent Selection
  // ============================================

  isAgentSelected(name: string): boolean {
    return this.store.selectedAgents().includes(name as CliType);
  }

  toggleAgentSelection(name: string): void {
    const cliType = name as CliType;
    if (this.isAgentSelected(name)) {
      this.store.removeSelectedAgent(cliType);
    } else {
      this.store.addSelectedAgent(cliType);
    }
  }

  canAddMoreAgents(): boolean {
    return this.validSelectedAgents().length < this.availableClis().length;
  }

  showAgentPicker(): void {
    // Show a dropdown or modal to pick additional agents
    // For now, just toggle config panel
    this.store.toggleConfigPanel();
  }

  getAgentDisplayName(agent: string): string {
    const displayNames: Record<string, string> = {
      claude: 'Claude',
      codex: 'Codex',
      gemini: 'Gemini',
      ollama: 'Ollama',
      aider: 'Aider',
      continue: 'Continue',
      cursor: 'Cursor',
      copilot: 'Copilot',
    };
    return displayNames[agent] || agent;
  }

  // ============================================
  // CLI Management
  // ============================================

  rescanClis(): void {
    this.cliStore.refresh();
  }

  openAgentConfig(name: string): void {
    // Open config panel with specific agent selected
    // TODO: Use 'name' to pre-select specific agent in config panel
    void name;
    this.store.toggleConfigPanel();
  }

  openInstallGuide(name: string): void {
    // Open installation guide for the CLI
    console.log('Open install guide for:', name);
  }

  // ============================================
  // Working Directory
  // ============================================

  async selectWorkingDirectory(): Promise<void> {
    const folder = await this.ipc.selectFolder();
    if (folder) {
      this.workingDirectory.set(folder);
      await this.refreshPreflight();
    }
  }

  clearWorkingDirectory(): void {
    this.workingDirectory.set(null);
    this.preflight.set(null);
  }

  // ============================================
  // Prompt Textarea
  // ============================================

  autoExpandTextarea(): void {
    const textarea = this.promptTextarea()?.nativeElement;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';

    // Calculate new height (with min and max constraints handled by CSS)
    const newHeight = Math.min(Math.max(textarea.scrollHeight, 100), 500);
    textarea.style.height = `${newHeight}px`;
  }

  toggleExpandedPrompt(): void {
    this.isPromptExpanded.update(v => !v);
    const textarea = this.promptTextarea()?.nativeElement;
    if (textarea) {
      if (this.isPromptExpanded()) {
        textarea.classList.add('expanded');
        textarea.style.height = '300px';
      } else {
        textarea.classList.remove('expanded');
        this.autoExpandTextarea();
      }
    }
  }

  // ============================================
  // Verification
  // ============================================

  canStartVerification(): boolean {
    return (
      this.promptInput.trim().length > 0 &&
      this.validSelectedAgents().length >= 2 &&
      (!this.workingDirectory() || !this.preflightLoading()) &&
      (!this.workingDirectory() || (this.preflight()?.blockers.length || 0) === 0) &&
      !this.store.isRunning()
    );
  }

  onStrategyChange(strategy: SynthesisStrategy): void {
    // Persist to localStorage immediately when user changes strategy
    this.store.setDefaultConfig({ synthesisStrategy: strategy });
    void this.refreshPreflight();
  }

  async startVerification(): Promise<void> {
    if (!this.canStartVerification()) return;

    // Update config with selected strategy
    this.store.setDefaultConfig({
      synthesisStrategy: this.selectedStrategy,
    });

    // Get pending files and working directory before clearing
    const files = this.pendingFiles();
    const workingDir = this.workingDirectory();

    // Start verification with files and working directory
    await this.store.startVerification(
      this.promptInput.trim(),
      undefined,
      files.length > 0 ? files : undefined,
      workingDir || undefined
    );

    // Clear input and draft
    this.promptInput = '';
    this.draftService.clearDraft(VERIFICATION_DRAFT_KEY);
    this.pendingFiles.set([]);
    this.workingDirectory.set(null);
    this.isPromptExpanded.set(false);

    // Reset textarea height
    const textarea = this.promptTextarea()?.nativeElement;
    if (textarea) {
      textarea.classList.remove('expanded');
      textarea.style.height = 'auto';
    }
  }

  // ============================================
  // Session Management
  // ============================================

  viewSession(sessionId: string): void {
    this.store.viewSessionResults(sessionId);
  }

  deleteSession(sessionId: string, event: Event): void {
    event.stopPropagation(); // Don't trigger viewSession
    this.store.deleteSession(sessionId);
  }

  truncatePrompt(prompt: string): string {
    return prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
  }

  formatTimeAgo(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  // ============================================
  // Navigation
  // ============================================

  navigateBack(): void {
    this.router.navigate(['/']);
  }

  toggleAgentsCollapsed(): void {
    this.agentsCollapsed.update(v => !v);
  }

  // ============================================
  // Settings & Help
  // ============================================

  openSettings(): void {
    this.store.toggleConfigPanel();
  }

  showHelp(): void {
    // Show help modal or navigate to docs
    console.log('Show help');
  }

  // ============================================
  // Draft & File Handling
  // ============================================

  onPromptChange(value: string): void {
    this.promptInput = value;
    this.draftService.setDraft(VERIFICATION_DRAFT_KEY, value);
  }

  onEnterKey(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    // Enter without Shift sends, Shift+Enter adds newline
    if (!keyEvent.shiftKey && this.canStartVerification()) {
      event.preventDefault();
      this.startVerification();
    }
  }

  onFilesDropped(files: File[]): void {
    this.pendingFiles.update(current => [...current, ...files]);
  }

  onImagesPasted(images: File[]): void {
    this.pendingFiles.update(current => [...current, ...images]);
  }

  removeFile(file: File): void {
    // Revoke the preview URL
    const url = this.filePreviewUrls.get(file);
    if (url) {
      URL.revokeObjectURL(url);
      this.filePreviewUrls.delete(file);
    }
    this.pendingFiles.update(current => current.filter(f => f !== file));
  }

  getFileIcon(file: File): string {
    if (file.type.startsWith('image/')) return '🖼️';
    if (file.type.includes('pdf')) return '📄';
    if (file.type.includes('text')) return '📝';
    if (file.type.includes('json') || file.type.includes('javascript')) return '📋';
    return '📎';
  }

  private async refreshPreflight(): Promise<void> {
    const workingDirectory = this.workingDirectory()?.trim();
    if (!workingDirectory) {
      this.preflight.set(null);
      this.preflightLoading.set(false);
      return;
    }

    this.preflightLoading.set(true);
    try {
      const response = await this.taskIpc.taskGetPreflight({
        workingDirectory,
        surface: 'verification',
        taskType: `verification:${this.selectedStrategy}`,
        requiresNetwork: true,
      });

      if (response.success && response.data) {
        this.preflight.set(response.data);
        return;
      }

      this.preflight.set(null);
    } finally {
      this.preflightLoading.set(false);
    }
  }
}
