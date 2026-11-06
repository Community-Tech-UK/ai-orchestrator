import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { localAiTargetFailureReason } from './local-ai-failure-copy';

type ChipTone = 'checking' | 'degraded' | 'unavailable' | 'paused';

interface ChipView {
  tone: ChipTone;
  text: string;
  tooltip: string;
}

const OPEN_HINT = 'Open Local models.';
const BUDGET_TOOLTIP = 'Helper models: daily limit reached. Paid fallbacks resume tomorrow.';

const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** Each chip needs its own id for the description its button points at. */
let nextDescriptionId = 0;

/**
 * Title-bar chip for the local models. Healthy means hidden: it appears only
 * when something needs a look (paused, not working, being checked, the helper
 * models' daily limit reached, or the status itself could not be read), and says
 * so in plain words. With nothing set up, or everything working, it renders
 * nothing and takes no room.
 *
 * The button's name is its visible text. The longer sentence (which helper
 * type is paused and why) is also kept as a hidden description tied to the
 * button, so a screen reader gets it without hovering for the tooltip.
 */
@Component({
  selector: 'app-local-ai-status-chip',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as chip) {
      <button
        type="button"
        class="local-ai-status-chip"
        data-testid="local-ai-status-chip"
        [attr.data-state]="chip.tone"
        [attr.aria-describedby]="descriptionId"
        [appTooltip]="chip.tooltip"
        (click)="openLocalModels()"
      >
        <span class="status-mark" aria-hidden="true"></span>
        <span>{{ chip.text }}</span>
      </button>
      <span class="sr-only" [id]="descriptionId" data-testid="local-ai-status-chip-description">{{ chip.tooltip }}</span>
    }
  `,
  styles: [`
    :host {
      display: inline-flex;
    }

    /* Nothing to show: leave no empty flex item behind, or the title bar's gap
       would still reserve room for it. */
    :host:empty {
      display: none;
    }

    .local-ai-status-chip {
      -webkit-app-region: no-drag;
      display: inline-flex;
      align-items: center;
      gap: 0.38rem;
      height: 24px;
      padding: 0 0.55rem;
      border: 1px solid var(--pill-neutral-border);
      border-radius: var(--radius-full);
      background: var(--pill-neutral-bg);
      color: var(--pill-neutral-fg);
      cursor: pointer;
      font: inherit;
      font-size: var(--text-xs);
      font-weight: 650;
      white-space: nowrap;
    }

    .status-mark {
      width: 6px;
      height: 6px;
      border-radius: var(--radius-full);
      background: currentColor;
    }

    .local-ai-status-chip[data-state='checking'] {
      border-color: var(--pill-info-border);
      background: var(--pill-info-bg);
      color: var(--pill-info-fg);
    }

    .local-ai-status-chip[data-state='degraded'] {
      border-color: var(--pill-warn-border);
      background: var(--pill-warn-bg);
      color: var(--pill-warn-fg);
    }

    .local-ai-status-chip[data-state='unavailable'] {
      border-color: var(--pill-error-border);
      background: var(--pill-error-bg);
      color: var(--pill-error-fg);
    }

    .local-ai-status-chip:hover {
      background: var(--glass-strong);
    }

    .local-ai-status-chip:focus-visible {
      outline: 2px solid var(--primary-color);
      outline-offset: 2px;
    }
  `],
})
export class LocalAiStatusChipComponent {
  protected readonly store = inject(LocalAiGuardStore);
  private readonly router = inject(Router);
  protected readonly descriptionId = `local-ai-status-chip-description-${nextDescriptionId++}`;

  protected readonly view = computed<ChipView | null>(() => {
    // Until the first read finishes there is nothing to say yet.
    if (!this.store.isInitialized()) return null;

    // The read finished but produced no snapshot: say we could not check, never
    // "unavailable" (that would claim the models are down when we do not know).
    // The reason is fixed text on purpose: nothing the store holds is printed.
    if (!this.store.hasAuthoritativeSnapshot()) {
      return {
        tone: 'unavailable',
        text: "Local models: couldn't check",
        tooltip: `Couldn't check your local models. Harness couldn't read their status. ${OPEN_HINT}`,
      };
    }

    // The helper models' daily limit is said beside whatever else is true, so it is never lost behind another state.
    const budget = this.store.helperBudget() !== undefined;
    const state = this.stateView();
    if (!state) {
      return budget
        ? { tone: 'degraded', text: 'Local helpers: daily limit reached', tooltip: `${BUDGET_TOOLTIP} ${OPEN_HINT}` }
        : null;
    }
    return {
      tone: state.tone,
      text: budget ? `${state.text} · daily limit reached` : state.text,
      tooltip: `${state.detail} ${budget ? `${BUDGET_TOOLTIP} ` : ''}${OPEN_HINT}`,
    };
  });

  /** What the models themselves say, or null when they are fine or not set up. */
  private readonly stateView = computed<{ tone: ChipTone; text: string; detail: string } | null>(() => {
    const pauses = this.store.helperPauses();
    if (pauses.length > 0) {
      const until = this.formatClock(Math.min(...pauses.map((pause) => pause.pausedUntil)));
      const details = pauses.map((pause) => `${pause.slot}: ${pause.reason}`).join('; ');
      return {
        tone: 'degraded',
        text: `Local helpers paused until ${until}`,
        detail: `Local helpers paused until ${until}. ${details}.`,
      };
    }

    // When every unwell target fails for the same reason, say it, so "not reachable" is not read as a connection fault.
    const reason = this.failureReason();
    switch (this.store.aggregate().state) {
      case 'checking':
        return { tone: 'checking', text: 'Local models: checking…', detail: 'Harness is checking your local models.' };
      case 'degraded':
        return reason
          ? { tone: 'degraded', text: `Local models: ${lowerFirst(reason)}`, detail: `Some of your local models aren't working well. ${reason}.` }
          : { tone: 'degraded', text: 'Local models: not working well', detail: "Some of your local models aren't working well." };
      case 'unavailable':
        return reason
          ? { tone: 'unavailable', text: `Local models: ${lowerFirst(reason)}`, detail: `Some of your local models are unavailable. ${reason}.` }
          : { tone: 'unavailable', text: 'Local models: not reachable', detail: "Harness can't reach some of your local models." };
      case 'paused':
        return { tone: 'paused', text: 'Local models: paused', detail: "Your local models are paused, so Harness isn't using them." };
      default:
        // Healthy, or nothing set up: healthy means hidden.
        return null;
    }
  });

  /** The one reason every unwell target shares, if there is one. */
  private readonly failureReason = computed(() => {
    const state = this.store.aggregate().state;
    if (state !== 'unavailable' && state !== 'degraded') return undefined;
    const reasons = new Set(this.store.targets()
      .filter(target => target.state === state
        && target.lifecycle !== 'retired' && target.lifecycle !== 'unmanaged')
      .map(localAiTargetFailureReason)
      .filter(reason => reason !== undefined));
    return reasons.size === 1 ? [...reasons][0] : undefined;
  });

  private formatClock(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  protected openLocalModels(): void {
    void this.router.navigateByUrl('/local-ai');
  }
}
