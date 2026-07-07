import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../../../../shared/types/automation.types';
import type {
  AutomationPreflightReport,
  AutomationPreflightRequest,
  AutomationTemplate,
} from '../../../../../shared/types/task-preflight.types';
import type {
  WebhookCreateRouteInput,
  WebhookAutomationSuggestion,
  WebhookDeliveryRecord,
  WebhookRouteConfig,
  WebhookServerStatus,
} from '../../../../../shared/types/webhook.types';

@Injectable({ providedIn: 'root' })
export class AutomationIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async list(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationList();
  }

  async get(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationGet({ id });
  }

  async create(payload: CreateAutomationInput): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationCreate(payload);
  }

  async update(id: string, updates: UpdateAutomationInput): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationUpdate({ id, updates });
  }

  async delete(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationDelete({ id });
  }

  async runNow(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationRunNow({ id });
  }

  async cancelPending(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationCancelPending({ id });
  }

  async listRuns(payload: { automationId?: string; limit?: number } = {}): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationListRuns(payload);
  }

  async markSeen(payload: { automationId?: string; runId?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationMarkSeen(payload);
  }

  async preflight(payload: AutomationPreflightRequest): Promise<IpcResponse<AutomationPreflightReport>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationPreflight(payload) as Promise<IpcResponse<AutomationPreflightReport>>;
  }

  async listTemplates(): Promise<IpcResponse<AutomationTemplate[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationTemplatesList() as Promise<IpcResponse<AutomationTemplate[]>>;
  }

  async webhookStatus(): Promise<IpcResponse<WebhookServerStatus>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.webhookStatus() as Promise<IpcResponse<WebhookServerStatus>>;
  }

  async webhookListRoutes(): Promise<IpcResponse<WebhookRouteConfig[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.webhookListRoutes() as Promise<IpcResponse<WebhookRouteConfig[]>>;
  }

  async webhookCreateRoute(payload: WebhookCreateRouteInput): Promise<IpcResponse<WebhookRouteConfig>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.webhookCreateRoute(payload) as Promise<IpcResponse<WebhookRouteConfig>>;
  }

  async webhookListDeliveries(payload: { limit?: number } = {}): Promise<IpcResponse<WebhookDeliveryRecord[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.webhookListDeliveries(payload) as Promise<IpcResponse<WebhookDeliveryRecord[]>>;
  }

  async webhookListSuggestions(payload: { limit?: number } = {}): Promise<IpcResponse<WebhookAutomationSuggestion[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.webhookListSuggestions(payload) as Promise<IpcResponse<WebhookAutomationSuggestion[]>>;
  }

  /**
   * Parse a natural-language description into an automation draft via the
   * schema-backed `automation-draft` magic prompt (one-shot, no interactive
   * instance). The inner result carries its own ok/error discriminator.
   */
  async draftFromText(payload: {
    text: string;
    context?: string;
    provider?: string;
    workingDirectory?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.magicPromptRun({ id: 'automation-draft', ...payload });
  }

  onChanged(callback: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onAutomationChanged((event) => {
      this.ngZone.run(() => callback(event));
    });
  }

  onRunChanged(callback: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onAutomationRunChanged((event) => {
      this.ngZone.run(() => callback(event));
    });
  }
}
