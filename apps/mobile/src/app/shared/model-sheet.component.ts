import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MobileModelDto } from '../core/models';
import { MobileIconComponent } from './mobile-icon.component';
import { MobileSheetComponent } from './mobile-sheet.component';

interface ModelGroup {
  family: string;
  models: MobileModelDto[];
}

@Component({
  standalone: true,
  selector: 'app-model-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileIconComponent, MobileSheetComponent],
  template: `
    <app-mobile-sheet label="Model picker" (dismiss)="dismiss.emit()">
      <header class="model-heading">
        <div>
          <span class="model-eyebrow">{{ provider() || 'Session' }}</span>
          <h2>Choose model</h2>
          @if (error()) {
            <p class="model-error" role="alert">{{ error() }}</p>
          }
        </div>
        <button class="model-close" type="button" (click)="dismiss.emit()" aria-label="Close model picker">
          <app-mobile-icon name="close" />
        </button>
      </header>

      @if (includeDefault()) {
        <button class="model-row" type="button" [class.model-row--selected]="selected() === undefined" (click)="choose.emit(undefined)">
          <span>
            <strong>Default</strong>
            <small>Use the provider's default model</small>
          </span>
          @if (selected() === undefined) { <app-mobile-icon name="check" /> }
        </button>
      }

      @if (loading()) {
        <p class="model-state">Loading models…</p>
      } @else {
        @if (pinned().length > 0) {
          <span class="model-section">Latest</span>
          @for (model of pinned(); track model.id) {
            <button class="model-row" type="button" [class.model-row--selected]="selected() === model.id" (click)="choose.emit(model.id)">
              <span><strong>{{ model.name }}</strong><small>{{ model.id }}</small></span>
              @if (selected() === model.id) { <app-mobile-icon name="check" /> }
            </button>
          }
        }

        @if (otherGroups().length > 0) {
          <button
            class="model-fold"
            type="button"
            (click)="otherOpen.set(!otherOpen())"
            [attr.aria-expanded]="otherOpen()"
          >
            <span>Other versions</span>
            <app-mobile-icon [class.model-fold__icon--open]="otherOpen()" name="chevron-down" />
          </button>
          @if (otherOpen()) {
            @for (group of otherGroups(); track group.family) {
              <span class="model-section model-section--family">{{ group.family }}</span>
              @for (model of group.models; track model.id) {
                <button class="model-row" type="button" [class.model-row--selected]="selected() === model.id" (click)="choose.emit(model.id)">
                  <span><strong>{{ model.name }}</strong><small>{{ model.id }}</small></span>
                  @if (selected() === model.id) { <app-mobile-icon name="check" /> }
                </button>
              }
            }
          }
        }
      }
    </app-mobile-sheet>
  `,
  styles: [
    `
      :host { position: fixed; inset: 0; z-index: var(--z-modal); }
      .model-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); }
      .model-heading h2 { margin: var(--space-1) 0 0; font-size: var(--font-size-xl); text-transform: none; }
      .model-eyebrow, .model-section { color: var(--text-secondary); font-size: var(--font-size-xs); font-weight: 650; letter-spacing: 0.05em; text-transform: uppercase; }
      .model-close { display: grid; width: var(--control-size); height: var(--control-size); flex: none; place-items: center; border: 0; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--text-secondary); font-size: 1.15rem; }
      .model-error { margin: var(--space-2) 0 0; color: var(--accent-error); font-size: var(--font-size-sm); }
      .model-section { display: block; margin: var(--space-5) var(--space-3) var(--space-2); }
      .model-section--family { margin-top: var(--space-4); text-transform: none; }
      .model-row { display: grid; width: 100%; min-height: 58px; grid-template-columns: minmax(0, 1fr) 24px; align-items: center; gap: var(--space-3); border: 1px solid transparent; border-radius: var(--radius-md); background: transparent; color: var(--text); padding: var(--space-2) var(--space-3); text-align: left; }
      .model-row:active { background: rgba(255, 255, 255, 0.055); }
      .model-row--selected { background: rgba(255, 255, 255, 0.04); border-color: var(--separator); }
      .model-row > span { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
      .model-row strong { overflow: hidden; font-size: 0.95rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .model-row small { overflow: hidden; color: var(--text-secondary); font-size: var(--font-size-sm); text-overflow: ellipsis; white-space: nowrap; }
      .model-row > app-mobile-icon { justify-self: end; color: var(--text); font-size: 1.1rem; }
      .model-fold { display: flex; width: 100%; min-height: var(--control-size); align-items: center; justify-content: space-between; border: 0; border-radius: var(--radius-md); background: transparent; color: var(--text); padding: 0 var(--space-3); font-size: 0.95rem; }
      .model-fold app-mobile-icon { color: var(--text-secondary); transition: transform var(--motion-press) ease-out; }
      .model-fold__icon--open { transform: rotate(180deg); }
      .model-state { color: var(--text-secondary); padding: var(--space-8) 0; text-align: center; }
    `,
  ],
})
export class ModelSheetComponent {
  readonly provider = input('');
  readonly models = input<MobileModelDto[]>([]);
  readonly selected = input<string | undefined>(undefined);
  readonly includeDefault = input(true);
  readonly loading = input(false);
  readonly error = input<string | null>(null);

  readonly choose = output<string | undefined>();
  readonly dismiss = output<void>();

  protected readonly otherOpen = signal(false);
  private readonly visibleModels = computed(() =>
    this.includeDefault() ? this.models().filter((model) => model.id !== 'auto') : this.models(),
  );
  protected readonly pinned = computed(() => this.visibleModels().filter((model) => model.pinned));
  protected readonly otherGroups = computed<ModelGroup[]>(() => {
    const groups = new Map<string, MobileModelDto[]>();
    for (const model of this.visibleModels()) {
      if (model.pinned) continue;
      const family = model.family || 'Models';
      groups.set(family, [...(groups.get(family) ?? []), model]);
    }
    return [...groups.entries()].map(([family, models]) => ({ family, models }));
  });
}
