import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import type { ContextProviderMeasurement, ProviderMeasuredContext } from '../../../../shared/types/provider-measured-context.types';
import { ContextAdviceListComponent } from './context-advice-list.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

@Component({ selector: 'app-context-measured-view', standalone: true,
  imports: [ContextAdviceListComponent, DecimalPipe, AioTooltipDirective], changeDetection: ChangeDetectionStrategy.OnPush,
  template: `@if (asleep() && !result()) { <p>Harness can ask Claude while the session is running. It is asleep now.</p> }
  @if (result(); as reply) {
    @if (reply.status === 'measured') {
      <p class="measured-label" tabindex="0" appTooltip="Claude counted the tokens in its current conversation.">Measured by Claude · {{ reply.measured.totalTokens | number }} of {{ reply.measured.maxTokens | number }} tokens</p>
      <dl>@for (category of reply.measured.categories; track $index) { <dt>{{ category.name }}{{ category.isDeferred ? ' (deferred)' : '' }}</dt><dd>{{ category.tokens | number }}</dd> }</dl>
      @for (file of reply.measured.memoryFiles; track $index) { <p>{{ file.name }} · {{ file.tokens | number }} tokens</p> }
      @for (server of reply.measured.connectorTools; track server.server) { <p>{{ server.server }} · {{ server.loadedTokens | number }} loaded · {{ server.deferredTokens | number }} deferred tokens</p> }
      @for (tool of reply.measured.topTools; track $index) { <p>{{ tool.name }} results · {{ tool.tokens | number }} tokens</p> }
    } @else if (reply.status === 'not-running') { <p>Harness can ask Claude while the session is running. It is asleep now.</p> }
    @else if (reply.status !== 'not-supported') { <p>Claude’s figures are unavailable. Showing estimates.</p> }
    <app-context-advice-list [advice]="reply.advice" [canCompact]="canMeasure()" (compact)="compact()" />
  }
  @if (canMeasure()) { <button type="button" [disabled]="loading()" (click)="measure()" appTooltip="Ask the running agent to count its current context. This may use a small amount of plan usage.">{{ loading() ? 'Measuring…' : 'Ask for context figures' }}</button> }
  @if (error()) { <p role="status">{{ error() }}</p> }`,
  styles: [`dl { display:grid; grid-template-columns:1fr auto; gap:4px 12px; } dd { margin:0; } .measured-label { font-weight:600; }`],
})
export class ContextMeasuredViewComponent implements OnInit {
  readonly instanceId = input.required<string>();
  readonly measured = output<ProviderMeasuredContext | null>();
  readonly result = signal<ContextProviderMeasurement | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  private readonly ipc = inject(ElectronIpcService);
  private readonly instances = inject(InstanceStore);
  readonly canMeasure = computed(() => ['idle', 'ready', 'waiting_for_input'].includes(this.instances.getInstance(this.instanceId())?.status ?? ''));
  readonly asleep = computed(() => ['hibernated', 'hibernating'].includes(this.instances.getInstance(this.instanceId())?.status ?? ''));
  ngOnInit(): void { if (this.canMeasure()) void this.measure(); }
  async measure(): Promise<void> {
    if (!this.canMeasure() || this.loading()) return;
    const api = this.ipc.getApi();
    if (!api?.contextProviderMeasure) return;
    this.loading.set(true);
    try {
      const response = await api.contextProviderMeasure({ instanceId: this.instanceId() });
      if (response.success && response.data) {
        const result = response.data as ContextProviderMeasurement;
        this.result.set(result); this.measured.emit(result.status === 'measured' ? result.measured : null);
      }
    } catch { this.error.set('Context figures are unavailable. Showing estimates.'); }
    finally { this.loading.set(false); }
  }
  async compact(): Promise<void> {
    if (!this.canMeasure()) return;
    try { await this.instances.compactInstance(this.instanceId()); this.result.set(null); this.measured.emit(null); await this.measure(); }
    catch { this.error.set('Could not compact this conversation.'); }
  }
}
