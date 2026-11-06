import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { ColdCacheResumeService, formatIdleDuration, formatTokenEstimate } from './cold-cache-resume.service';

@Component({
  selector: 'app-cold-cache-chip', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AioTooltipDirective],
  template: `
    @if (phase() === 'compacting') {
      <div class="cold-cache-chip" role="status">Compacting this conversation first. Your message will send when it finishes.
        <button type="button" (click)="cancel()">Cancel</button></div>
    } @else if (phase() === 'failed') {
      <div class="cold-cache-chip failed" role="alert">Harness could not compact this conversation, so nothing was sent. Your message is back in the box. Choose Send with full history to send it as it is.
        <button type="button" [attr.aria-pressed]="preferCompact()" [appTooltip]="copyFor('coldCache.compactFirst')" (click)="toggle()">
          {{ preferCompact() ? 'Compact first' : 'Send with full history' }}</button></div>
    } @else if (offer(); as o) {
      <div class="cold-cache-chip">Claude's saved copy of this conversation has expired (away {{ formatIdle(o.idleMinutes) }}). Your next message would re-read {{ formatTokens(o.tokens) }} at full price.
        <button type="button" [attr.aria-pressed]="preferCompact()" [appTooltip]="copyFor('coldCache.compactFirst')" (click)="toggle()">
          {{ preferCompact() ? 'Compact first (' + formatTokens(o.tokens) + ')' : 'Send with full history' }}</button></div>
    }
  `,
  styles: [`
    .cold-cache-chip { display: flex; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,.14); border-radius: 10px; background: rgba(255,255,255,.04); font: 11px var(--font-mono); }
    .failed { border-color: rgba(255,120,120,.35); }
    button { margin-left: auto; flex: none; border: 1px solid rgba(255,255,255,.18); border-radius: 8px; background: transparent; color: inherit; padding: 5px 10px; cursor: pointer; }
  `],
})
export class ColdCacheChipComponent {
  readonly instanceId = input.required<string>();
  private readonly coldCache = inject(ColdCacheResumeService);
  readonly copyFor = copyFor;
  readonly formatIdle = formatIdleDuration;
  readonly formatTokens = formatTokenEstimate;
  readonly phase = computed(() => this.coldCache.phaseFor(this.instanceId()));
  readonly offer = computed(() => {
    const value = this.coldCache.offerFor(this.instanceId());
    return value.offer ? value : null;
  });
  readonly preferCompact = computed(() => this.coldCache.preferCompact(this.instanceId()));
  toggle(): void { this.coldCache.setPreferCompact(this.instanceId(), !this.preferCompact()); }
  cancel(): void { this.coldCache.cancelPendingSend(this.instanceId()); }
}
