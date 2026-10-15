import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { KeepAwakeState } from '@contracts/schemas/observability';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';

const REASON_LABELS = {
  loop: 'loop running',
  'plan-queue': 'plan queue running',
  automation: 'automation running',
  session: 'session working',
  always: 'always on',
} satisfies Record<NonNullable<KeepAwakeState['reason']>, string>;

@Component({
  selector: 'app-keep-awake-chip',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state()?.active) {
      <button type="button" class="keep-awake-chip" [appTooltip]="tooltip" (click)="openSettings()">
        {{ label() }}
      </button>
    }
  `,
  styles: [`
    :host { display: inline-flex; }
    .keep-awake-chip {
      -webkit-app-region: no-drag;
      height: 24px;
      padding: 0 0.55rem;
      border: 1px solid var(--pill-info-border);
      border-radius: var(--radius-full);
      background: var(--pill-info-bg);
      color: var(--pill-info-fg);
      font: inherit;
      font-size: var(--text-xs);
      white-space: nowrap;
      cursor: pointer;
    }
    .keep-awake-chip:hover { background: var(--glass-strong); }
    .keep-awake-chip:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
  `],
})
export class KeepAwakeChipComponent implements OnInit {
  private readonly ipc = inject(AppIpcService);
  private readonly base = inject(ElectronIpcService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly state = signal<KeepAwakeState | null>(null);
  protected readonly tooltip = this.base.platform === 'darwin' ? copyFor('keepAwakeChip')
    : copyFor('keepAwakeChip').replaceAll('your Mac', 'your computer').replaceAll('the Mac', 'the computer');
  protected readonly label = computed(() => {
    const reason = this.state()?.reason;
    return `${this.base.platform === 'darwin' ? 'Mac' : 'Computer'} awake: ${reason ? REASON_LABELS[reason] : ''}`;
  });

  ngOnInit(): void {
    let receivedPush = false;
    const unsubscribe = this.ipc.onKeepAwakeState(state => {
      receivedPush = true;
      if (!this.destroyRef.destroyed) this.state.set(state);
    });
    this.destroyRef.onDestroy(unsubscribe);
    void this.ipc.getKeepAwakeState().then(state => {
      if (!receivedPush && !this.destroyRef.destroyed) this.state.set(state);
    }).catch(() => { /* Missing state leaves the chip hidden. */ });
  }

  protected openSettings(): void {
    void this.router.navigate(['/settings'], { queryParams: { tab: 'general' } });
  }
}
