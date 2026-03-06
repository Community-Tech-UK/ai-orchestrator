/**
 * MCP Page
 * MCP Server Management — list servers, manage connections, browse tools,
 * resources, and prompts, and add new servers.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { BrowserAutomationIpcService } from '../../core/services/ipc/browser-automation-ipc.service';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface McpServer {
  id: string;
  name: string;
  description?: string;
  transport: string;
  status: string;
  error?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect?: boolean;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId: string;
}

interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
  serverId: string;
}

interface BrowserAutomationHealthSource {
  path: string;
  detected: boolean;
  serverNames: string[];
}

interface BrowserAutomationHealthReport {
  status: 'ready' | 'partial' | 'missing';
  checkedAt: number;
  lastSuccessfulCheckAt?: number;
  runtimeAvailable: boolean;
  runtimeCommand?: string;
  nodeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  inAppToolCount: number;
  configDetected: boolean;
  configSources: BrowserAutomationHealthSource[];
  browserToolNames: string[];
  warnings: string[];
  suggestions: string[];
}

type DetailTab = 'tools' | 'resources' | 'prompts' | 'config';

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-mcp-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">

      <!-- Page header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">MCP Servers</span>
          <span class="subtitle">Model Context Protocol server management</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">
            {{ loading() ? 'Refreshing…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- Error / info banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }
      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- Metric cards -->
      <div class="metrics-row">
        <div class="metric-card">
          <span class="metric-value">{{ servers().length }}</span>
          <span class="metric-label">Total Servers</span>
        </div>
        <div class="metric-card">
          <span class="metric-value connected">{{ connectedCount() }}</span>
          <span class="metric-label">Connected</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ tools().length }}</span>
          <span class="metric-label">Tools Available</span>
        </div>
        <div class="metric-card">
          <span class="metric-value">{{ resources().length }}</span>
          <span class="metric-label">Resources Available</span>
        </div>
      </div>

      <div class="browser-health-panel">
        <div class="panel-toolbar">
          <div>
            <span class="panel-heading">Browser Automation</span>
            <div class="panel-subtitle">Health check for Chrome DevTools and browser MCP readiness.</div>
          </div>
          <div class="server-actions">
            <button class="btn small" type="button" [disabled]="working()" (click)="runBrowserHealthCheck()">
              Test Browser Tooling
            </button>
            <button class="btn small primary" type="button" [disabled]="working()" (click)="installBrowserPreset()">
              Add Chrome DevTools Preset
            </button>
          </div>
        </div>

        @if (browserHealth(); as health) {
          <div class="health-summary">
            <span class="status-badge" [class]="'status-' + mapHealthStatus(health.status)">
              {{ health.status }}
            </span>
            <span>Runtime: {{ health.runtimeAvailable ? (health.runtimeCommand || 'detected') : 'missing' }}</span>
            <span>Node: {{ health.nodeAvailable ? 'ready' : 'missing' }}</span>
            <span>In-app MCP: {{ health.inAppConfigured ? (health.inAppConnected ? 'connected' : 'configured') : 'not configured' }}</span>
            <span>Browser tools: {{ health.inAppToolCount }}</span>
          </div>

          @if (health.browserToolNames.length > 0) {
            <div class="health-tools">
              @for (toolName of health.browserToolNames; track toolName) {
                <span class="tool-pill">{{ toolName }}</span>
              }
            </div>
          }

          @if (health.warnings.length > 0) {
            <div class="health-list">
              <span class="field-label">Warnings</span>
              <ul>
                @for (warning of health.warnings; track warning) {
                  <li>{{ warning }}</li>
                }
              </ul>
            </div>
          }

          @if (health.suggestions.length > 0) {
            <div class="health-list">
              <span class="field-label">Suggested Fixes</span>
              <ul>
                @for (suggestion of health.suggestions; track suggestion) {
                  <li>{{ suggestion }}</li>
                }
              </ul>
            </div>
          }

          @if (health.configSources.length > 0) {
            <div class="health-list">
              <span class="field-label">Claude Config Files</span>
              <ul>
                @for (source of health.configSources; track source.path) {
                  <li>
                    {{ source.path }}:
                    {{ source.detected ? ('browser MCP entries: ' + source.serverNames.join(', ')) : 'no browser MCP entry detected' }}
                  </li>
                }
              </ul>
            </div>
          }
        }
      </div>

      <!-- 2-column layout -->
      <div class="body-grid">

        <!-- Left: server list -->
        <div class="server-list-panel">
          <div class="panel-toolbar">
            <span class="panel-heading">Servers</span>
            <button class="btn primary small" type="button" (click)="openAddDialog()">+ Add</button>
          </div>

          @if (servers().length === 0 && !loading()) {
            <div class="empty-hint">No servers configured.</div>
          }

          <div class="server-list">
            @for (srv of servers(); track srv.id) {
              <div
                class="server-card"
                [class.selected]="selectedServerId() === srv.id"
                (click)="selectServer(srv.id)"
                role="button"
                tabindex="0"
                (keydown.enter)="selectServer(srv.id)"
              >
                <div class="server-card-top">
                  <span class="server-name">{{ srv.name }}</span>
                  <span class="status-badge" [class]="'status-' + srv.status">{{ srv.status }}</span>
                </div>
                <div class="server-meta">{{ srv.transport }}</div>
                @if (srv.error) {
                  <div class="server-error">{{ srv.error }}</div>
                }
                <div class="server-actions">
                  @if (srv.status !== 'connected') {
                    <button class="btn small" type="button" [disabled]="working()" (click)="connectServer($event, srv.id)">
                      Connect
                    </button>
                  }
                  @if (srv.status === 'connected') {
                    <button class="btn small" type="button" [disabled]="working()" (click)="disconnectServer($event, srv.id)">
                      Disconnect
                    </button>
                    <button class="btn small" type="button" [disabled]="working()" (click)="restartServer($event, srv.id)">
                      Restart
                    </button>
                  }
                  <button class="btn small danger" type="button" [disabled]="working()" (click)="removeServer($event, srv.id)">
                    Remove
                  </button>
                </div>
              </div>
            }
          </div>
        </div>

        <!-- Right: detail panel -->
        <div class="detail-panel">
          @if (!selectedServerId()) {
            <div class="detail-empty">Select a server to view details.</div>
          } @else {

            <!-- Tab bar -->
            <div class="tab-bar">
              @for (tab of tabs; track tab.id) {
                <button
                  class="tab-btn"
                  [class.active]="activeTab() === tab.id"
                  type="button"
                  (click)="setTab(tab.id)"
                >
                  {{ tab.label }}
                  <span class="tab-count">{{ tabCount(tab.id) }}</span>
                </button>
              }
            </div>

            <!-- Tools tab -->
            @if (activeTab() === 'tools') {
              <div class="tab-content">
                @if (selectedTools().length === 0) {
                  <div class="empty-hint">No tools from this server.</div>
                }
                @for (tool of selectedTools(); track tool.name) {
                  <div class="item-card">
                    <div class="item-header">
                      <span class="item-name">{{ tool.name }}</span>
                      <button
                        class="btn small"
                        type="button"
                        (click)="openToolCall(tool)"
                      >Call Tool</button>
                    </div>
                    @if (tool.description) {
                      <div class="item-desc">{{ tool.description }}</div>
                    }

                    <!-- Inline call form -->
                    @if (toolCallTarget()?.name === tool.name) {
                      <div class="inline-form">
                        <label class="field">
                          <span class="field-label">Arguments (JSON)</span>
                          <textarea
                            class="textarea"
                            [value]="toolCallArgsJson()"
                            placeholder="{}"
                            (input)="onToolArgsInput($event)"
                          ></textarea>
                        </label>
                        <div class="form-actions">
                          <button class="btn small primary" type="button" [disabled]="working()" (click)="executeTool()">
                            Execute
                          </button>
                          <button class="btn small" type="button" (click)="closeToolCall()">Cancel</button>
                        </div>
                        @if (toolCallResult()) {
                          <pre class="result-pre">{{ toolCallResult() }}</pre>
                        }
                      </div>
                    }
                  </div>
                }
              </div>
            }

            <!-- Resources tab -->
            @if (activeTab() === 'resources') {
              <div class="tab-content">
                @if (selectedResources().length === 0) {
                  <div class="empty-hint">No resources from this server.</div>
                }
                @for (res of selectedResources(); track res.uri) {
                  <div class="item-card">
                    <div class="item-header">
                      <span class="item-name">{{ res.name ?? res.uri }}</span>
                      <button
                        class="btn small"
                        type="button"
                        [disabled]="working()"
                        (click)="readResource(res)"
                      >Read</button>
                    </div>
                    <div class="item-uri">{{ res.uri }}</div>
                    @if (res.description) {
                      <div class="item-desc">{{ res.description }}</div>
                    }
                    @if (resourceReadTarget() === res.uri && resourceReadResult()) {
                      <pre class="result-pre">{{ resourceReadResult() }}</pre>
                    }
                  </div>
                }
              </div>
            }

            <!-- Prompts tab -->
            @if (activeTab() === 'prompts') {
              <div class="tab-content">
                @if (selectedPrompts().length === 0) {
                  <div class="empty-hint">No prompts from this server.</div>
                }
                @for (prompt of selectedPrompts(); track prompt.name) {
                  <div class="item-card">
                    <div class="item-header">
                      <span class="item-name">{{ prompt.name }}</span>
                      <button
                        class="btn small"
                        type="button"
                        [disabled]="working()"
                        (click)="getPrompt(prompt)"
                      >Get Prompt</button>
                    </div>
                    @if (prompt.description) {
                      <div class="item-desc">{{ prompt.description }}</div>
                    }
                    @if (promptTarget() === prompt.name && promptResult()) {
                      <pre class="result-pre">{{ promptResult() }}</pre>
                    }
                  </div>
                }
              </div>
            }

            <!-- Config tab -->
            @if (activeTab() === 'config') {
              <div class="tab-content">
                @if (selectedServer()) {
                  <pre class="result-pre config-pre">{{ selectedServerJson() }}</pre>
                }
              </div>
            }
          }
        </div>
      </div>
    </div>

    <!-- Add Server dialog overlay -->
    @if (showAddDialog()) {
      <div
        class="overlay"
        role="presentation"
        (click)="closeAddDialog()"
        (keydown.escape)="closeAddDialog()"
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-label="Add MCP Server"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
        >
          <div class="dialog-header">
            <span class="dialog-title">Add MCP Server</span>
            <button class="close-btn" type="button" (click)="closeAddDialog()">✕</button>
          </div>

          <div class="dialog-body">
            <label class="field">
              <span class="field-label">ID <span class="required">*</span></span>
              <input class="input" type="text" [value]="addForm.id()" (input)="onAddField('id', $event)" placeholder="my-server" />
            </label>

            <label class="field">
              <span class="field-label">Name <span class="required">*</span></span>
              <input class="input" type="text" [value]="addForm.name()" (input)="onAddField('name', $event)" placeholder="My Server" />
            </label>

            <label class="field">
              <span class="field-label">Transport <span class="required">*</span></span>
              <select class="select" [value]="addForm.transport()" (change)="onTransportChange($event)">
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse</option>
              </select>
            </label>

            @if (addForm.transport() === 'stdio') {
              <label class="field">
                <span class="field-label">Command</span>
                <input class="input" type="text" [value]="addForm.command()" (input)="onAddField('command', $event)" placeholder="node server.js" />
              </label>
            }

            @if (addForm.transport() === 'http' || addForm.transport() === 'sse') {
              <label class="field">
                <span class="field-label">URL</span>
                <input class="input" type="text" [value]="addForm.url()" (input)="onAddField('url', $event)" placeholder="http://localhost:3000" />
              </label>
            }

            <label class="checkbox-row">
              <input type="checkbox" [checked]="addForm.autoConnect()" (change)="onAutoConnectChange($event)" />
              Auto-connect on startup
            </label>

            @if (addDialogError()) {
              <div class="error-banner">{{ addDialogError() }}</div>
            }
          </div>

          <div class="dialog-footer">
            <button class="btn" type="button" (click)="closeAddDialog()">Cancel</button>
            <button class="btn primary" type="button" [disabled]="working()" (click)="submitAddServer()">
              {{ working() ? 'Adding…' : 'Add Server' }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
        position: relative;
      }

      /* ── Page shell ───────────────────────────── */

      .page {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
        overflow: auto;
      }

      /* ── Header ───────────────────────────────── */

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .header-title {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      /* ── Buttons ──────────────────────────────── */

      .header-btn,
      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }

      .btn.small {
        padding: 2px 8px;
        font-size: 11px;
      }

      .btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn.danger {
        background: color-mix(in srgb, var(--error-color) 20%, transparent);
        border-color: color-mix(in srgb, var(--error-color) 60%, transparent);
        color: var(--error-color);
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* ── Banners ──────────────────────────────── */

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
        flex-shrink: 0;
      }

      .error-banner {
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .info-banner {
        border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        color: var(--text-primary);
      }

      /* ── Metrics row ──────────────────────────── */

      .metrics-row {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .metric-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-sm) var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .metric-value {
        font-size: 22px;
        font-weight: 700;
        line-height: 1;
      }

      .metric-value.connected {
        color: var(--success-color);
      }

      .metric-label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      /* ── 2-column body ────────────────────────── */

      .body-grid {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 280px 1fr;
        gap: var(--spacing-md);
      }

      /* ── Server list panel ────────────────────── */

      .server-list-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        min-height: 0;
      }

      .panel-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }

      .panel-heading {
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .panel-subtitle {
        font-size: 12px;
        color: var(--text-muted);
        margin-top: 4px;
      }

      .browser-health-panel {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .health-summary,
      .health-tools {
        display: flex;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        align-items: center;
      }

      .tool-pill {
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-secondary);
      }

      .health-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .health-list ul {
        margin: 0;
        padding-left: 18px;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .server-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        overflow-y: auto;
        flex: 1;
        min-height: 0;
      }

      .server-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-sm);
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 4px;
        transition: border-color 0.1s;
      }

      .server-card:hover {
        border-color: color-mix(in srgb, var(--primary-color) 50%, var(--border-color));
      }

      .server-card.selected {
        border-color: var(--primary-color);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary-color) 30%, transparent);
      }

      .server-card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-xs);
      }

      .server-name {
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .server-meta {
        font-size: 11px;
        color: var(--text-muted);
      }

      .server-error {
        font-size: 11px;
        color: var(--error-color);
        overflow-wrap: anywhere;
      }

      .server-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
        margin-top: 2px;
      }

      /* ── Status badge ─────────────────────────── */

      .status-badge {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: 999px;
        flex-shrink: 0;
        border: 1px solid currentColor;
      }

      .status-connected {
        color: var(--success-color);
        background: color-mix(in srgb, var(--success-color) 14%, transparent);
      }

      .status-disconnected,
      .status-idle {
        color: var(--text-muted);
        background: transparent;
      }

      .status-connecting {
        color: var(--warning-color);
        background: color-mix(in srgb, var(--warning-color) 14%, transparent);
      }

      .status-error {
        color: var(--error-color);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
      }

      /* ── Detail panel ─────────────────────────── */

      .detail-panel {
        display: flex;
        flex-direction: column;
        min-height: 0;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        overflow: hidden;
      }

      .detail-empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        color: var(--text-muted);
      }

      /* ── Tabs ─────────────────────────────────── */

      .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
        background: var(--bg-tertiary);
      }

      .tab-btn {
        padding: var(--spacing-xs) var(--spacing-md);
        font-size: 12px;
        border: none;
        border-bottom: 2px solid transparent;
        background: transparent;
        color: var(--text-secondary);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 6px;
        transition: color 0.1s, border-color 0.1s;
      }

      .tab-btn.active {
        color: var(--text-primary);
        border-bottom-color: var(--primary-color);
      }

      .tab-count {
        font-size: 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        border-radius: 999px;
        padding: 0 5px;
        min-width: 18px;
        text-align: center;
        color: var(--text-muted);
      }

      .tab-content {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      /* ── Item cards (tools / resources / prompts) */

      .item-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        padding: var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .item-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-sm);
      }

      .item-name {
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-desc {
        font-size: 12px;
        color: var(--text-muted);
      }

      .item-uri {
        font-size: 11px;
        color: var(--text-muted);
        font-family: var(--font-family-mono);
        overflow-wrap: anywhere;
      }

      /* ── Inline tool-call form ────────────────── */

      .inline-form {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        margin-top: var(--spacing-xs);
        padding-top: var(--spacing-xs);
        border-top: 1px solid var(--border-color);
      }

      .form-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .field-label {
        font-size: 11px;
        color: var(--text-muted);
      }

      .required {
        color: var(--error-color);
      }

      .input,
      .select,
      .textarea {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .textarea {
        min-height: 80px;
        resize: vertical;
        font-family: var(--font-family-mono);
      }

      .result-pre {
        margin: 0;
        padding: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        font-size: 11px;
        font-family: var(--font-family-mono);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 240px;
        overflow-y: auto;
        color: var(--text-secondary);
      }

      .config-pre {
        max-height: unset;
      }

      /* ── Empty hint ───────────────────────────── */

      .empty-hint {
        font-size: 12px;
        color: var(--text-muted);
        padding: var(--spacing-xs) 0;
      }

      /* ── Add-server overlay / dialog ─────────── */

      .overlay {
        position: fixed;
        inset: 0;
        background: color-mix(in srgb, #000 55%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .dialog {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        width: 400px;
        max-width: calc(100vw - 32px);
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
        box-shadow: 0 16px 48px color-mix(in srgb, #000 40%, transparent);
      }

      .dialog-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      .dialog-title {
        font-size: 14px;
        font-weight: 700;
      }

      .close-btn {
        border: none;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 14px;
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .close-btn:hover {
        color: var(--text-primary);
        background: var(--bg-primary);
      }

      .dialog-body {
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 12px;
        color: var(--text-secondary);
        cursor: pointer;
      }

      .dialog-footer {
        display: flex;
        justify-content: flex-end;
        gap: var(--spacing-sm);
        padding: var(--spacing-md);
        border-top: 1px solid var(--border-color);
        background: var(--bg-tertiary);
      }

      /* ── Responsive ───────────────────────────── */

      @media (max-width: 900px) {
        .body-grid {
          grid-template-columns: 1fr;
        }
        .metrics-row {
          grid-template-columns: repeat(2, 1fr);
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly mcpIpc = inject(McpIpcService);
  private readonly browserAutomationIpc = inject(BrowserAutomationIpcService);

  // ── Data signals ──────────────────────────────────────────────────────────

  readonly servers = signal<McpServer[]>([]);
  readonly tools = signal<McpTool[]>([]);
  readonly resources = signal<McpResource[]>([]);
  readonly prompts = signal<McpPrompt[]>([]);
  readonly browserHealth = signal<BrowserAutomationHealthReport | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────

  readonly selectedServerId = signal<string | null>(null);
  readonly activeTab = signal<DetailTab>('tools');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  // Tool call state
  readonly toolCallTarget = signal<McpTool | null>(null);
  readonly toolCallArgsJson = signal('{}');
  readonly toolCallResult = signal<string | null>(null);

  // Resource read state
  readonly resourceReadTarget = signal<string | null>(null);
  readonly resourceReadResult = signal<string | null>(null);

  // Prompt state
  readonly promptTarget = signal<string | null>(null);
  readonly promptResult = signal<string | null>(null);

  // Add-server dialog state
  readonly showAddDialog = signal(false);
  readonly addDialogError = signal<string | null>(null);
  readonly addForm = {
    id: signal(''),
    name: signal(''),
    transport: signal<'stdio' | 'http' | 'sse'>('stdio'),
    command: signal(''),
    url: signal(''),
    autoConnect: signal(false),
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  readonly connectedCount = computed(
    () => this.servers().filter((s) => s.status === 'connected').length
  );

  readonly selectedServer = computed(
    () => this.servers().find((s) => s.id === this.selectedServerId()) ?? null
  );

  readonly selectedTools = computed(
    () => this.tools().filter((t) => t.serverId === this.selectedServerId())
  );

  readonly selectedResources = computed(
    () => this.resources().filter((r) => r.serverId === this.selectedServerId())
  );

  readonly selectedPrompts = computed(
    () => this.prompts().filter((p) => p.serverId === this.selectedServerId())
  );

  readonly selectedServerJson = computed(() => {
    const srv = this.selectedServer();
    if (!srv) return '';
    const { id, name, description, transport, command, args, env, url, autoConnect } = srv;
    return JSON.stringify({ id, name, description, transport, command, args, env, url, autoConnect }, null, 2);
  });

  // ── Tab definitions ───────────────────────────────────────────────────────

  readonly tabs: { id: DetailTab; label: string }[] = [
    { id: 'tools', label: 'Tools' },
    { id: 'resources', label: 'Resources' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'config', label: 'Config' },
  ];

  tabCount(tab: DetailTab): number {
    switch (tab) {
      case 'tools': return this.selectedTools().length;
      case 'resources': return this.selectedResources().length;
      case 'prompts': return this.selectedPrompts().length;
      default: return 0;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private unsubStateChanged: (() => void) | null = null;
  private unsubStatusChanged: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.loadAll();
    this.subscribeToEvents();
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.unsubStateChanged?.();
    this.unsubStatusChanged?.();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      await this.loadAll();
    } finally {
      this.loading.set(false);
    }
  }

  async runBrowserHealthCheck(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      const response = await this.browserAutomationIpc.getHealth();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to run browser automation health check.');
        return;
      }
      this.browserHealth.set((response.data as BrowserAutomationHealthReport) ?? null);
      this.infoMessage.set('Browser automation health check updated.');
    } finally {
      this.working.set(false);
    }
  }

  async installBrowserPreset(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const existing = this.servers().find((server) => server.id === 'chrome-devtools');
      if (!existing) {
        const response = await this.mcpIpc.mcpAddServer({
          id: 'chrome-devtools',
          name: 'Chrome DevTools',
          description: 'Browser automation through Chrome DevTools MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@latest'],
          autoConnect: false,
        });

        if (!response.success) {
          this.errorMessage.set(response.error?.message ?? 'Failed to add Chrome DevTools preset.');
          return;
        }
      }

      this.infoMessage.set('Chrome DevTools preset is available in the server list.');
      await this.loadServers();
      this.selectedServerId.set('chrome-devtools');
      await this.runBrowserHealthCheck();
    } finally {
      this.working.set(false);
    }
  }

  // ── Server selection ──────────────────────────────────────────────────────

  selectServer(id: string): void {
    this.selectedServerId.set(id);
    // Reset sub-panel state when switching servers
    this.toolCallTarget.set(null);
    this.toolCallResult.set(null);
    this.resourceReadTarget.set(null);
    this.resourceReadResult.set(null);
    this.promptTarget.set(null);
    this.promptResult.set(null);
  }

  setTab(tab: DetailTab): void {
    this.activeTab.set(tab);
  }

  // ── Server operations ─────────────────────────────────────────────────────

  async connectServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpConnect(serverId),
      `Connected to server ${serverId}.`,
      'Failed to connect.'
    );
  }

  async disconnectServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpDisconnect(serverId),
      `Disconnected from server ${serverId}.`,
      'Failed to disconnect.'
    );
  }

  async restartServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpRestart(serverId),
      `Server ${serverId} restarted.`,
      'Failed to restart.'
    );
  }

  async removeServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpRemoveServer(serverId),
      `Server ${serverId} removed.`,
      'Failed to remove server.'
    );
    if (this.selectedServerId() === serverId) {
      this.selectedServerId.set(null);
    }
  }

  // ── Tool call ─────────────────────────────────────────────────────────────

  openToolCall(tool: McpTool): void {
    this.toolCallTarget.set(tool);
    this.toolCallArgsJson.set('{}');
    this.toolCallResult.set(null);
  }

  closeToolCall(): void {
    this.toolCallTarget.set(null);
    this.toolCallResult.set(null);
  }

  onToolArgsInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.toolCallArgsJson.set(target.value);
  }

  async executeTool(): Promise<void> {
    const tool = this.toolCallTarget();
    if (!tool) return;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(this.toolCallArgsJson()) as Record<string, unknown>;
    } catch {
      this.errorMessage.set('Tool arguments must be valid JSON.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpCallTool({
        serverId: tool.serverId,
        toolName: tool.name,
        arguments: args,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Tool call failed.');
        return;
      }
      this.toolCallResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Resource read ─────────────────────────────────────────────────────────

  async readResource(resource: McpResource): Promise<void> {
    this.resourceReadTarget.set(resource.uri);
    this.resourceReadResult.set(null);
    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpReadResource({
        serverId: resource.serverId,
        uri: resource.uri,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to read resource.');
        return;
      }
      this.resourceReadResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Prompt get ────────────────────────────────────────────────────────────

  async getPrompt(prompt: McpPrompt): Promise<void> {
    this.promptTarget.set(prompt.name);
    this.promptResult.set(null);
    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpGetPrompt({
        serverId: prompt.serverId,
        promptName: prompt.name,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to get prompt.');
        return;
      }
      this.promptResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Add server dialog ─────────────────────────────────────────────────────

  openAddDialog(): void {
    this.addForm.id.set('');
    this.addForm.name.set('');
    this.addForm.transport.set('stdio');
    this.addForm.command.set('');
    this.addForm.url.set('');
    this.addForm.autoConnect.set(false);
    this.addDialogError.set(null);
    this.showAddDialog.set(true);
  }

  closeAddDialog(): void {
    this.showAddDialog.set(false);
    this.addDialogError.set(null);
  }

  onAddField(field: 'id' | 'name' | 'command' | 'url', event: Event): void {
    const target = event.target as HTMLInputElement;
    this.addForm[field].set(target.value);
  }

  onTransportChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.addForm.transport.set(target.value as 'stdio' | 'http' | 'sse');
  }

  onAutoConnectChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.addForm.autoConnect.set(target.checked);
  }

  async submitAddServer(): Promise<void> {
    const id = this.addForm.id().trim();
    const name = this.addForm.name().trim();
    const transport = this.addForm.transport();

    if (!id) {
      this.addDialogError.set('ID is required.');
      return;
    }
    if (!name) {
      this.addDialogError.set('Name is required.');
      return;
    }

    this.working.set(true);
    this.addDialogError.set(null);
    try {
      const payload = {
        id,
        name,
        transport,
        command: transport === 'stdio' ? this.addForm.command().trim() || undefined : undefined,
        url: transport !== 'stdio' ? this.addForm.url().trim() || undefined : undefined,
        autoConnect: this.addForm.autoConnect(),
      };

      const response = await this.mcpIpc.mcpAddServer(payload);
      if (!response.success) {
        this.addDialogError.set(response.error?.message ?? 'Failed to add server.');
        return;
      }

      this.closeAddDialog();
      this.infoMessage.set(`Server "${name}" added.`);
      await this.loadServers();
    } finally {
      this.working.set(false);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async loadAll(): Promise<void> {
    await Promise.all([
      this.loadServers(),
      this.loadTools(),
      this.loadResources(),
      this.loadPrompts(),
      this.loadBrowserHealth(),
    ]);
  }

  private async loadServers(): Promise<void> {
    const response = await this.mcpIpc.mcpGetServers();
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to load servers.');
      return;
    }
    this.servers.set(this.extractArray<McpServer>(response));
  }

  private async loadTools(): Promise<void> {
    const response = await this.mcpIpc.mcpGetTools();
    if (!response.success) return;
    this.tools.set(this.extractArray<McpTool>(response));
  }

  private async loadResources(): Promise<void> {
    const response = await this.mcpIpc.mcpGetResources();
    if (!response.success) return;
    this.resources.set(this.extractArray<McpResource>(response));
  }

  private async loadPrompts(): Promise<void> {
    const response = await this.mcpIpc.mcpGetPrompts();
    if (!response.success) return;
    this.prompts.set(this.extractArray<McpPrompt>(response));
  }

  private subscribeToEvents(): void {
    this.unsubStateChanged = this.mcpIpc.onMcpStateChanged(() => {
      void this.loadAll();
    });

    this.unsubStatusChanged = this.mcpIpc.onMcpServerStatusChanged((data) => {
      this.servers.update((current) =>
        current.map((srv) =>
          srv.id === data.serverId
            ? { ...srv, status: data.status, error: data.error }
            : srv
        )
      );
    });
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.loadAll();
    }, 10_000);
  }

  mapHealthStatus(status: BrowserAutomationHealthReport['status']): string {
    switch (status) {
      case 'ready':
        return 'connected';
      case 'partial':
        return 'connecting';
      default:
        return 'error';
    }
  }

  private async runServerOp(
    op: () => Promise<IpcResponse>,
    successMessage: string,
    fallbackError: string
  ): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      const response = await op();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? fallbackError);
        return;
      }
      this.infoMessage.set(successMessage);
      await this.loadServers();
    } finally {
      this.working.set(false);
    }
  }

  private extractArray<T>(response: IpcResponse): T[] {
    if (!response.success) return [];
    if (Array.isArray(response.data)) return response.data as T[];
    return [];
  }

  private async loadBrowserHealth(): Promise<void> {
    const response = await this.browserAutomationIpc.getHealth();
    if (!response.success) {
      return;
    }
    this.browserHealth.set((response.data as BrowserAutomationHealthReport) ?? null);
  }
}
