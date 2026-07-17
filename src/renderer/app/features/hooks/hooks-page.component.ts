/**
 * Hooks Page
 * Container that wires hook management UI to backend hook IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  HookContext,
  HookResult,
  HookRule,
} from '../../../../shared/types/hook.types';
import { HookEventReferenceComponent } from './hook-event-reference.component';
import { HooksConfigComponent } from './hooks-config.component';
import { HooksIpcService } from '../../core/services/ipc/hooks-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface HookApprovalItem {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  approvalRequired: boolean;
  approved: boolean;
  handlerType: string;
  handlerSummary?: string;
}

type HookSourceFilter = 'all' | 'built-in' | 'project' | 'user';

const DEFAULT_EVAL_CONTEXT = JSON.stringify(
  {
    event: 'PreToolUse',
    sessionId: 'preview-session',
    instanceId: 'preview-instance',
    toolName: 'Bash',
    command: 'rm -rf /tmp/test',
    filePath: '/tmp/example.txt',
    newContent: 'example change',
    userPrompt: 'preview hook evaluation',
  },
  null,
  2
);

@Component({
  selector: 'app-hooks-page',
  standalone: true,
  imports: [CommonModule, HooksConfigComponent, HookEventReferenceComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Hooks</span>
          <span class="subtitle">Rule CRUD, approval flow, evaluation preview, and import/export</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">Refresh</button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-hooks-config
            [hooks]="hooks()"
            [builtInRules]="builtInRules()"
            (ruleCreated)="onRuleCreated($event)"
            (ruleUpdated)="onRuleUpdated($event)"
            (ruleDeleted)="onRuleDeleted($event)"
            (ruleToggled)="onRuleToggled($event)"
            (ruleTested)="onRuleTested($event)"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Approvals</div>
            <label class="checkbox-row">
              <input
                type="checkbox"
                [checked]="pendingOnlyApprovals()"
                (change)="onPendingOnlyChange($event)"
              />
              Pending only
            </label>

            @if (approvals().length > 0) {
              <div class="approval-list">
                @for (item of approvals(); track item.id) {
                  <div class="approval-item">
                    <div class="approval-header">
                      <span class="approval-name">{{ item.name }}</span>
                      <span class="approval-state" [class.approved]="item.approved">
                        {{ item.approved ? 'approved' : 'pending' }}
                      </span>
                    </div>
                    <div class="approval-meta">{{ item.event }} • {{ item.handlerType }}</div>
                    @if (item.handlerSummary) {
                      <div class="approval-summary">{{ item.handlerSummary }}</div>
                    }
                    <div class="row-actions">
                      <button class="btn tiny" type="button" [disabled]="working()" (click)="setApproval(item, true)">
                        Approve
                      </button>
                      <button class="btn tiny" type="button" [disabled]="working()" (click)="setApproval(item, false)">
                        Revoke
                      </button>
                    </div>
                  </div>
                }
              </div>
            } @else {
              <div class="hint">No approvals found.</div>
            }

            <div class="row-actions">
              <button class="btn" type="button" [disabled]="working()" (click)="clearApprovals()">
                Clear Approvals
              </button>
            </div>
          </div>

          <div class="panel-card">
            <div class="panel-title">Evaluation Preview</div>
            <textarea
              class="textarea"
              [value]="evaluationContextJson()"
              (input)="onEvaluationContextInput($event)"
            ></textarea>
            <div class="row-actions">
              <button class="btn" type="button" [disabled]="working()" (click)="evaluateFromContext()">
                Evaluate
              </button>
            </div>
            @if (evaluationResult()) {
              <pre class="preview">{{ evaluationResult() }}</pre>
            } @else {
              <div class="hint">Run evaluation to preview matching rules/actions.</div>
            }
          </div>

          <app-hook-event-reference />

          <div class="panel-card">
            <div class="panel-title">Import / Export</div>

            <label class="field">
              <span class="label">Export Source</span>
              <select class="select" [value]="exportSource()" (change)="onExportSourceChange($event)">
                <option value="all">all</option>
                <option value="built-in">built-in</option>
                <option value="project">project</option>
                <option value="user">user</option>
              </select>
            </label>

            <div class="row-actions">
              <button class="btn" type="button" [disabled]="working()" (click)="exportRules()">Export</button>
            </div>

            <textarea
              class="textarea"
              [value]="importExportJson()"
              (input)="onImportExportInput($event)"
              placeholder="Paste exported hook JSON here"
            ></textarea>

            <label class="checkbox-row">
              <input type="checkbox" [checked]="overwriteImport()" (change)="onOverwriteChange($event)" />
              Overwrite existing rules
            </label>

            <div class="row-actions">
              <button class="btn" type="button" [disabled]="working()" (click)="importRules()">Import</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
      }

      .page {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
      }

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
      }

      .header-title {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
      }

      .btn.tiny {
        padding: 2px 8px;
        font-size: 11px;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
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

      .content {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
        gap: var(--spacing-md);
      }

      .main-panel,
      .side-panel {
        min-height: 0;
      }

      .main-panel {
        overflow: auto;
      }

      .side-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        overflow: auto;
      }

      .panel-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .panel-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
      }

      .approval-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        max-height: 200px;
        overflow: auto;
      }

      .approval-item {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        padding: var(--spacing-xs) var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .approval-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .approval-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .approval-state {
        font-size: 10px;
        font-weight: 600;
        color: var(--warning-color);
      }

      .approval-state.approved {
        color: var(--success-color);
      }

      .approval-meta,
      .approval-summary {
        font-size: 11px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
      }

      .row-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      .textarea,
      .select {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .textarea {
        min-height: 96px;
        resize: vertical;
        font-family: var(--font-family-mono);
      }

      .preview {
        margin: 0;
        padding: var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        white-space: pre-wrap;
        max-height: 160px;
        overflow: auto;
        font-size: 11px;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .label {
        font-size: 11px;
        color: var(--text-muted);
      }

      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 1100px) {
        .content {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HooksPageComponent implements OnInit {
  private readonly hooksIpc = inject(HooksIpcService);

  readonly hooks = signal<HookRule[]>([]);
  readonly builtInRules = signal<HookRule[]>([]);
  readonly approvals = signal<HookApprovalItem[]>([]);

  readonly pendingOnlyApprovals = signal(true);
  readonly evaluationContextJson = signal(DEFAULT_EVAL_CONTEXT);
  readonly evaluationResult = signal<string>('');

  readonly importExportJson = signal('');
  readonly exportSource = signal<HookSourceFilter>('user');
  readonly overwriteImport = signal(false);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
  }

  async refreshAll(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      await Promise.all([this.loadHooks(), this.loadApprovals()]);
    } finally {
      this.working.set(false);
    }
  }

  async onRuleCreated(rule: HookRule): Promise<void> {
    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hooksCreate(this.toCreatePayload(rule));
      this.assertSuccess(response, 'Failed to create hook rule.');
      this.infoMessage.set('Hook created.');
    });
  }

  async onRuleUpdated(rule: HookRule): Promise<void> {
    const existing = this.hooks().find((candidate) => candidate.id === rule.id);

    await this.runAndRefresh(async () => {
      if (!existing) {
        const createResponse = await this.hooksIpc.hooksCreate(this.toCreatePayload(rule));
        this.assertSuccess(createResponse, 'Failed to recreate missing hook rule.');
        this.infoMessage.set('Rule was recreated because the original was missing.');
        return;
      }

      const eventChanged = existing.event !== rule.event;
      const matcherChanged = (existing.toolMatcher || '') !== (rule.toolMatcher || '');
      if (eventChanged || matcherChanged) {
        const removeResponse = await this.hooksIpc.hooksDelete(rule.id);
        this.assertSuccess(removeResponse, 'Failed to recreate hook after event/tool matcher change (delete step).');

        const createResponse = await this.hooksIpc.hooksCreate(this.toCreatePayload(rule));
        this.assertSuccess(createResponse, 'Failed to recreate hook after event/tool matcher change (create step).');
        this.infoMessage.set('Rule event/tool matcher changed, so it was recreated with a new ID.');
        return;
      }

      const updateResponse = await this.hooksIpc.hooksUpdate(rule.id, {
        name: rule.name,
        enabled: rule.enabled,
        conditions: rule.conditions,
        action: rule.action,
        message: rule.message,
      });
      this.assertSuccess(updateResponse, 'Failed to update hook rule.');
      this.infoMessage.set('Hook updated.');
    });
  }

  async onRuleDeleted(ruleId: string): Promise<void> {
    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hooksDelete(ruleId);
      this.assertSuccess(response, 'Failed to delete hook rule.');
      this.infoMessage.set('Hook deleted.');
    });
  }

  async onRuleToggled(payload: { id: string; enabled: boolean }): Promise<void> {
    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hooksUpdate(payload.id, { enabled: payload.enabled });
      this.assertSuccess(response, 'Failed to toggle hook rule.');
    }, false);
  }

  async onRuleTested(rule: HookRule): Promise<void> {
    const context = this.buildContextForRule(rule);
    await this.evaluateContext(context, `Preview evaluation for "${rule.name}" complete.`);
  }

  async setApproval(item: HookApprovalItem, approved: boolean): Promise<void> {
    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hookApprovalsUpdate(item.id, approved);
      this.assertSuccess(response, 'Failed to update approval state.');
      this.infoMessage.set(approved ? 'Hook approved.' : 'Hook approval revoked.');
    });
  }

  async clearApprovals(): Promise<void> {
    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hookApprovalsClear();
      this.assertSuccess(response, 'Failed to clear approvals.');
      this.infoMessage.set('Approvals cleared.');
    });
  }

  async evaluateFromContext(): Promise<void> {
    let parsed: HookContext;
    try {
      parsed = JSON.parse(this.evaluationContextJson()) as HookContext;
    } catch {
      this.errorMessage.set('Evaluation context must be valid JSON.');
      return;
    }

    await this.evaluateContext(parsed, 'Hook evaluation complete.');
  }

  async exportRules(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const source = this.exportSource();
      const response = await this.hooksIpc.hooksExport(source === 'all' ? undefined : source);
      this.assertSuccess(response, 'Failed to export hooks.');

      const rules = this.unwrapData<HookRule[]>(response, []);
      this.importExportJson.set(JSON.stringify(rules, null, 2));
      this.infoMessage.set(`Exported ${rules.length} rules.`);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  async importRules(): Promise<void> {
    const raw = this.importExportJson().trim();
    if (!raw) {
      this.errorMessage.set('Provide hook JSON to import.');
      return;
    }

    let parsed: HookRule[];
    try {
      parsed = JSON.parse(raw) as HookRule[];
      if (!Array.isArray(parsed)) {
        throw new Error('JSON must be an array of hook rules.');
      }
    } catch {
      this.errorMessage.set('Import JSON must be a valid array of hook rules.');
      return;
    }

    await this.runAndRefresh(async () => {
      const response = await this.hooksIpc.hooksImport(parsed, this.overwriteImport());
      this.assertSuccess(response, 'Failed to import hook rules.');
      const imported = this.unwrapData<HookRule[]>(response, []);
      this.infoMessage.set(`Imported ${imported.length} rules.`);
    });
  }

  onPendingOnlyChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.pendingOnlyApprovals.set(target.checked);
    void this.loadApprovals();
  }

  onEvaluationContextInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.evaluationContextJson.set(target.value);
  }

  onImportExportInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.importExportJson.set(target.value);
  }

  onExportSourceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.exportSource.set(target.value as HookSourceFilter);
  }

  onOverwriteChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.overwriteImport.set(target.checked);
  }

  private async evaluateContext(context: HookContext, successMessage: string): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response = await this.hooksIpc.hooksEvaluate(context);
      this.assertSuccess(response, 'Failed to evaluate hook context.');
      const result = this.unwrapData<HookResult>(response, { matched: false });
      this.evaluationResult.set(JSON.stringify(result, null, 2));
      this.infoMessage.set(successMessage);
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  private async loadHooks(): Promise<void> {
    const response = await this.hooksIpc.hooksList();
    this.assertSuccess(response, 'Failed to load hook rules.');

    const rules = this.unwrapData<HookRule[]>(response, []);
    this.hooks.set(rules);
    this.builtInRules.set(rules.filter((rule) => rule.source === 'built-in'));
  }

  private async loadApprovals(): Promise<void> {
    const response = await this.hooksIpc.hookApprovalsList(this.pendingOnlyApprovals());
    this.assertSuccess(response, 'Failed to load hook approvals.');

    const approvals = this.unwrapData<unknown[]>(response, [])
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: String(item['id']),
        name: String(item['name'] || item['id']),
        event: String(item['event'] || 'unknown'),
        enabled: Boolean(item['enabled']),
        approvalRequired: Boolean(item['approvalRequired']),
        approved: Boolean(item['approved']),
        handlerType: String(item['handlerType'] || 'unknown'),
        handlerSummary: typeof item['handlerSummary'] === 'string' ? item['handlerSummary'] : undefined,
      }));

    this.approvals.set(approvals);
  }

  private buildContextForRule(rule: HookRule): HookContext {
    const event = rule.event === 'all' ? 'PreToolUse' : rule.event;

    const context: HookContext = {
      event,
      sessionId: 'preview-session',
      instanceId: 'preview-instance',
      toolName: rule.toolMatcher?.split('|')[0] || 'Bash',
      command: 'echo "hook-preview"',
      filePath: '/tmp/hook-preview.txt',
      newContent: 'preview-content',
      userPrompt: 'run hook preview',
    };

    return context;
  }

  private toCreatePayload(rule: HookRule): {
    name: string;
    enabled: boolean;
    event: string;
    toolMatcher?: string;
    conditions: {
      field: string;
      operator:
        | 'regex_match'
        | 'contains'
        | 'not_contains'
        | 'equals'
        | 'starts_with'
        | 'ends_with';
      pattern: string;
    }[];
    action: 'warn' | 'block';
    message: string;
  } {
    return {
      name: rule.name,
      enabled: rule.enabled,
      event: rule.event,
      toolMatcher: rule.toolMatcher,
      conditions: rule.conditions,
      action: rule.action,
      message: rule.message,
    };
  }

  private async runAndRefresh(
    action: () => Promise<void>,
    refreshApprovals = true
  ): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      await action();
      await this.loadHooks();
      if (refreshApprovals) {
        await this.loadApprovals();
      }
    } catch (error) {
      this.errorMessage.set((error as Error).message);
    } finally {
      this.working.set(false);
    }
  }

  private assertSuccess(response: IpcResponse, fallback: string): void {
    if (!response.success) {
      throw new Error(response.error?.message || fallback);
    }
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    if (!response.success) {
      const message = response.error?.message || 'IPC request failed';
      this.errorMessage.set(message);
      return fallback;
    }
    return (response.data as T) ?? fallback;
  }
}
