import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, Input, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Automation } from '../../../../shared/types/automation.types';
import type {
  WebhookAutomationSuggestion,
  WebhookDeliveryRecord,
  WebhookRouteConfig,
  WebhookServerStatus,
} from '../../../../shared/types/webhook.types';
import { AutomationIpcService } from '../../core/services/ipc/automation-ipc.service';

interface WebhookRouteForm {
  path: string;
  secret: string;
  automationId: string;
  eventTypes: string;
  allowUnsignedDev: boolean;
  maxBodyBytes: number;
}

@Component({
  selector: 'app-automation-webhooks-panel',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './automation-webhooks-panel.component.html',
  styleUrl: './automation-webhooks-panel.component.css',
})
export class AutomationWebhooksPanelComponent {
  @Input() automations: Automation[] = [];

  private readonly ipc = inject(AutomationIpcService);

  readonly status = signal<WebhookServerStatus | null>(null);
  readonly routes = signal<WebhookRouteConfig[]>([]);
  readonly deliveries = signal<WebhookDeliveryRecord[]>([]);
  readonly suggestions = signal<WebhookAutomationSuggestion[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = signal<WebhookRouteForm>({
    path: '/hooks/',
    secret: '',
    automationId: '',
    eventTypes: '',
    allowUnsignedDev: false,
    maxBodyBytes: 262_144,
  });

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [status, routes, deliveries, suggestions] = await Promise.all([
        this.ipc.webhookStatus(),
        this.ipc.webhookListRoutes(),
        this.ipc.webhookListDeliveries({ limit: 25 }),
        this.ipc.webhookListSuggestions({ limit: 5 }),
      ]);

      const errors: string[] = [];
      if (status.success) {
        this.status.set(status.data ?? null);
      } else {
        errors.push(status.error?.message ?? 'Failed to load webhook status');
      }
      if (routes.success) {
        this.routes.set(routes.data ?? []);
      } else {
        errors.push(routes.error?.message ?? 'Failed to load webhook routes');
      }
      if (deliveries.success) {
        this.deliveries.set(deliveries.data ?? []);
      } else {
        errors.push(deliveries.error?.message ?? 'Failed to load webhook deliveries');
      }
      if (suggestions.success) {
        this.suggestions.set(suggestions.data ?? []);
      } else {
        errors.push(suggestions.error?.message ?? 'Failed to load webhook suggestions');
      }
      this.error.set(errors[0] ?? null);
    } finally {
      this.loading.set(false);
    }
  }

  patchForm(patch: Partial<WebhookRouteForm>): void {
    this.form.update((current) => ({ ...current, ...patch }));
  }

  canCreate(): boolean {
    const form = this.form();
    return Boolean(form.path.trim() && form.secret.trim().length >= 16 && !this.saving());
  }

  async createRoute(): Promise<void> {
    if (!this.canCreate()) {
      return;
    }

    const form = this.form();
    this.saving.set(true);
    this.error.set(null);
    try {
      const response = await this.ipc.webhookCreateRoute({
        path: form.path.trim(),
        secret: form.secret,
        enabled: true,
        allowUnsignedDev: form.allowUnsignedDev,
        maxBodyBytes: form.maxBodyBytes,
        allowedAutomationIds: form.automationId ? [form.automationId] : [],
        allowedEvents: this.splitCsv(form.eventTypes),
      });
      if (!response.success) {
        this.error.set(response.error?.message ?? 'Failed to create webhook route');
        return;
      }
      this.form.update((current) => ({
        ...current,
        path: '/hooks/',
        secret: '',
        eventTypes: '',
      }));
      await this.refresh();
    } finally {
      this.saving.set(false);
    }
  }

  serverLabel(): string {
    const status = this.status();
    if (!status?.running) {
      return 'Stopped';
    }
    return status.port ? `127.0.0.1:${status.port}` : 'Listening';
  }

  routeEndpoint(route: WebhookRouteConfig): string {
    const port = this.status()?.port;
    return port ? `http://127.0.0.1:${port}${route.path}` : route.path;
  }

  automationLabel(id: string): string {
    return this.automations.find((automation) => automation.id === id)?.name ?? id;
  }

  routeAutomations(route: WebhookRouteConfig): string {
    if (route.allowedAutomationIds.length === 0) {
      return 'No automations linked';
    }
    return route.allowedAutomationIds.map((id) => this.automationLabel(id)).join(', ');
  }

  routeEvents(route: WebhookRouteConfig): string {
    return route.allowedEvents.length > 0 ? route.allowedEvents.join(', ') : 'All events';
  }

  deliveryRoute(delivery: WebhookDeliveryRecord): string {
    return this.routes().find((route) => route.id === delivery.routeId)?.path ?? delivery.routeId;
  }

  shortHash(hash: string): string {
    return hash.length > 18 ? `${hash.slice(0, 10)}...${hash.slice(-6)}` : hash;
  }

  formatTime(timestamp: number | undefined): string {
    return timestamp ? new Date(timestamp).toLocaleString() : 'None';
  }

  deliveryClass(delivery: WebhookDeliveryRecord): string {
    return `delivery delivery--${delivery.status}`;
  }

  suggestionConfidence(suggestion: WebhookAutomationSuggestion): string {
    return `${Math.round(suggestion.confidence * 100)}%`;
  }

  private splitCsv(value: string): string[] {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}
