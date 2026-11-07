import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { buildComposerQuotaNotice, type ComposerQuotaNotice } from './composer-quota-notice';
import { sessionQuotaSnapshot } from './session-quota-snapshot';

@Component({ selector: 'app-composer-quota-notice', standalone: true, imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.empty]': 'parked() || !notice()' },
  template: `@if (!parked() && notice(); as line) {
    <span class="hint hint-quota" [class.strong]="line.strong" tabindex="0"
      [appTooltip]="tooltip">
      <span class="wide">{{ line.text }}</span><span class="narrow">{{ line.short }}</span>
    </span>
  }`,
  styles: [`.hint-quota { color: var(--text-secondary); font-size: 11px; display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .strong { font-weight: 600; }
    .narrow { display:none; } :host { container-type:inline-size; display:block; flex:1 1 220px; min-width:0; }
    :host(.empty) { display:none; }
    @container (max-width: 350px) { .wide { display:none; } .narrow { display:inline; } }`],
})
export class ComposerQuotaNoticeComponent {
  readonly tooltip = copyFor('composer.quota');
  readonly instanceId = input.required<string>();
  private readonly instances = inject(InstanceStore);
  private readonly quota = inject(ProviderQuotaStore);
  readonly notice = signal<ComposerQuotaNotice | null>(null);
  readonly parked = computed(() => this.instances.getInstance(this.instanceId())?.waitReason?.kind === 'quota-park');
  constructor() {
    let identity = '';
    effect(() => {
      const instance = this.instances.getInstance(this.instanceId());
      if (!instance) { this.notice.set(null); return; }
      const key = `${instance.id}:${instance.provider}:${instance.accountProfileId ?? instance.copilotAccountProfileId ?? 'legacy'}:${instance.currentModel}`;
      if (key !== identity) { identity = key; this.notice.set(null); }
      this.notice.update(previous => buildComposerQuotaNotice({
        snapshot: sessionQuotaSnapshot(instance, this.quota.snapshots(), this.quota.accountSnapshots()),
        sessionModel: instance.currentModel, now: Date.now(), previous }));
    });
  }
}
