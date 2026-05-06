import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  ProviderQuotaDiagnostics,
  ProviderPromptWeightBreakdown,
  ProviderRateLimitDiagnostics,
  ProviderRuntimeEvent,
} from '@contracts/types/provider-runtime-events';
import type { ContextUsage } from '../../core/state/instance.store';
import { InstanceEventsService } from '../../core/services/instance-events.service';

interface ProviderDiagnosticsSnapshot {
  requestId?: string;
  stopReason?: string;
  rateLimit?: ProviderRateLimitDiagnostics;
  quota?: ProviderQuotaDiagnostics;
  context?: {
    percentage: number;
    used: number;
    total: number;
    inputTokens?: number;
    outputTokens?: number;
    source?: string;
    promptWeight?: number;
    promptWeightBreakdown?: ProviderPromptWeightBreakdown;
  };
}

interface ProviderDiagnosticItem {
  id: string;
  label: string;
  value: string;
  tone?: 'warning' | 'danger';
}

@Component({
  selector: 'app-provider-diagnostics-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (items().length > 0) {
      <section class="provider-diagnostics" aria-label="Provider diagnostics">
        @for (item of items(); track item.id) {
          <span
            class="diagnostic-pill"
            [class.warning]="item.tone === 'warning'"
            [class.danger]="item.tone === 'danger'"
            [title]="item.value"
          >
            <span class="diagnostic-label">{{ item.label }}</span>
            <span class="diagnostic-value">{{ item.value }}</span>
          </span>
        }
      </section>
    }
  `,
  styles: [`
    .provider-diagnostics {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 6px 14px 0;
      color: var(--text-secondary);
    }

    .diagnostic-pill {
      min-height: 24px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 3px 8px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.045);
      font: 11px var(--font-mono);
    }

    .diagnostic-pill.warning {
      border-color: rgba(255, 183, 77, 0.34);
      color: var(--warning-color, #ffb74d);
    }

    .diagnostic-pill.danger {
      border-color: rgba(255, 107, 107, 0.36);
      color: var(--error-color, #ff6b6b);
    }

    .diagnostic-label {
      color: var(--text-muted);
      text-transform: uppercase;
    }

    .diagnostic-value {
      color: inherit;
      max-width: min(42vw, 340px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `],
})
export class ProviderDiagnosticsPanelComponent {
  private readonly instanceEvents = inject(InstanceEventsService);
  private readonly snapshot = signal<ProviderDiagnosticsSnapshot>({});
  private readonly instanceIdValue = signal('');
  private readonly contextUsageValue = signal<ContextUsage | null>(null);

  @Input()
  set instanceId(value: string) {
    const next = value ?? '';
    if (next !== this.instanceIdValue()) {
      this.snapshot.set({});
    }
    this.instanceIdValue.set(next);
  }

  @Input()
  set contextUsage(value: ContextUsage | null) {
    this.contextUsageValue.set(value ?? null);
  }

  readonly items = computed<ProviderDiagnosticItem[]>(() => {
    const snapshot = this.withInputContext(this.snapshot());
    const items: ProviderDiagnosticItem[] = [];

    if (snapshot.requestId) {
      items.push({ id: 'request', label: 'Request', value: snapshot.requestId });
    }
    if (snapshot.stopReason) {
      items.push({ id: 'stop', label: 'Stop', value: snapshot.stopReason });
    }
    if (snapshot.rateLimit) {
      items.push({
        id: 'rate-limit',
        label: 'Rate',
        value: this.formatRateLimit(snapshot.rateLimit),
        tone: snapshot.rateLimit.remaining === 0 ? 'warning' : undefined,
      });
    }
    if (snapshot.quota) {
      items.push({
        id: 'quota',
        label: 'Quota',
        value: this.formatQuota(snapshot.quota),
        tone: snapshot.quota.exhausted ? 'danger' : undefined,
      });
    }
    if (snapshot.context) {
      items.push({
        id: 'context',
        label: 'Context',
        value: this.formatContext(snapshot.context),
        tone: snapshot.context.percentage >= 90 ? 'warning' : undefined,
      });
    }

    return items;
  });

  constructor() {
    this.instanceEvents.events$
      .pipe(takeUntilDestroyed())
      .subscribe((envelope) => {
        if (envelope.instanceId !== this.instanceIdValue()) {
          return;
        }
        this.applyEvent(envelope.event);
      });
  }

  private applyEvent(event: ProviderRuntimeEvent): void {
    if (event.kind === 'context') {
      this.snapshot.update((current) => ({
        ...current,
        context: {
          percentage: event.percentage ?? (event.total > 0 ? (event.used / event.total) * 100 : 0),
          used: event.used,
          total: event.total,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          source: event.source,
          promptWeight: event.promptWeight,
          promptWeightBreakdown: event.promptWeightBreakdown,
        },
      }));
      return;
    }

    if (event.kind !== 'error' && event.kind !== 'complete') {
      return;
    }

    this.snapshot.update((current) => ({
      ...current,
      requestId: event.requestId ?? current.requestId,
      stopReason: event.stopReason ?? current.stopReason,
      rateLimit: event.rateLimit ?? current.rateLimit,
      quota: event.quota ?? current.quota,
    }));
  }

  private withInputContext(snapshot: ProviderDiagnosticsSnapshot): ProviderDiagnosticsSnapshot {
    const usage = this.contextUsageValue();
    if (!usage) {
      return snapshot;
    }

    return {
      ...snapshot,
      context: snapshot.context ?? {
        percentage: usage.percentage,
        used: usage.used,
        total: usage.total,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        source: usage.source,
        promptWeight: usage.promptWeight,
        promptWeightBreakdown: usage.promptWeightBreakdown,
      },
    };
  }

  private formatRateLimit(rateLimit: ProviderRateLimitDiagnostics): string {
    if (rateLimit.remaining !== undefined) {
      return `${rateLimit.remaining} remaining`;
    }
    if (rateLimit.limit !== undefined) {
      return `${rateLimit.limit} limit`;
    }
    if (rateLimit.resetAt !== undefined) {
      return `resets ${this.formatTime(rateLimit.resetAt)}`;
    }
    return 'reported';
  }

  private formatQuota(quota: ProviderQuotaDiagnostics): string {
    const status = quota.exhausted ? 'Exhausted' : 'Available';
    return quota.message ? `${status}: ${quota.message}` : status;
  }

  private formatContext(context: NonNullable<ProviderDiagnosticsSnapshot['context']>): string {
    const parts = [`${Math.round(context.percentage)}%`];
    if (context.inputTokens !== undefined || context.outputTokens !== undefined) {
      parts.push(`${context.inputTokens ?? 0} in / ${context.outputTokens ?? 0} out`);
    }
    if (context.promptWeight !== undefined) {
      parts.push(`${Math.round(context.promptWeight * 100)}% prompt`);
    }
    if (context.promptWeightBreakdown !== undefined) {
      parts.push(this.formatPromptWeightBreakdown(context.promptWeightBreakdown));
    }
    return parts.join(' - ');
  }

  private formatPromptWeightBreakdown(breakdown: ProviderPromptWeightBreakdown): string {
    const parts: string[] = [];
    if (breakdown.systemPrompt !== undefined) parts.push(`system ${Math.round(breakdown.systemPrompt)}`);
    if (breakdown.mcpToolDescriptions !== undefined) parts.push(`MCP tools ${Math.round(breakdown.mcpToolDescriptions)}`);
    if (breakdown.skills !== undefined) parts.push(`skills ${Math.round(breakdown.skills)}`);
    if (breakdown.plugins !== undefined) parts.push(`plugins ${Math.round(breakdown.plugins)}`);
    if (breakdown.userPrompt !== undefined) parts.push(`user ${Math.round(breakdown.userPrompt)}`);
    if (breakdown.other !== undefined) parts.push(`other ${Math.round(breakdown.other)}`);
    return parts.join(', ');
  }

  private formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}
