import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MobileModelDto } from '../core/models';

interface ModelGroup {
  family: string;
  models: MobileModelDto[];
}

@Component({
  standalone: true,
  selector: 'app-model-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="scrim" type="button" (click)="dismiss.emit()" aria-label="Close model picker"></button>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="Model picker">
      <header class="head">
        <div>
          <h3>{{ provider() }} model</h3>
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
        </div>
        <button class="icon" type="button" (click)="dismiss.emit()" aria-label="Close">&times;</button>
      </header>

      @if (includeDefault()) {
        <button class="row" type="button" [class.sel]="selected() === undefined" (click)="choose.emit(undefined)">
          <span>
            <strong>Default (auto)</strong>
            <small>No override</small>
          </span>
          @if (selected() === undefined) {
            <span class="check">&#10003;</span>
          }
        </button>
      }

      @if (loading()) {
        <p class="muted">Loading models...</p>
      } @else {
        @if (pinned().length > 0) {
          <span class="section">Latest</span>
          @for (model of pinned(); track model.id) {
            <button class="row" type="button" [class.sel]="selected() === model.id" (click)="choose.emit(model.id)">
              <span>
                <strong>{{ model.name }}</strong>
                <small>{{ model.id }}</small>
              </span>
              @if (selected() === model.id) {
                <span class="check">&#10003;</span>
              }
            </button>
          }
        }

        @if (otherGroups().length > 0) {
          <button class="fold" type="button" (click)="otherOpen.set(!otherOpen())">
            <span>Other versions</span>
            <span>{{ otherOpen() ? '-' : '+' }}</span>
          </button>
          @if (otherOpen()) {
            @for (group of otherGroups(); track group.family) {
              <span class="section sub">{{ group.family }}</span>
              @for (model of group.models; track model.id) {
                <button class="row" type="button" [class.sel]="selected() === model.id" (click)="choose.emit(model.id)">
                  <span>
                    <strong>{{ model.name }}</strong>
                    <small>{{ model.id }}</small>
                  </span>
                  @if (selected() === model.id) {
                    <span class="check">&#10003;</span>
                  }
                </button>
              }
            }
          }
        }
      }
    </section>
  `,
  styles: [
    `
      :host { position: fixed; inset: 0; z-index: 20; }
      .scrim { position: absolute; inset: 0; border: none; background: rgba(0,0,0,0.45); }
      .sheet {
        position: absolute; left: 0; right: 0; bottom: 0; max-height: 78vh;
        overflow-y: auto; background: var(--surface-2); color: var(--text);
        border-radius: 16px 16px 0 0; padding: 12px 14px calc(14px + env(safe-area-inset-bottom));
        box-shadow: 0 -12px 30px rgba(0,0,0,0.45);
      }
      .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      h3 { margin: 0; font-size: 17px; text-transform: capitalize; }
      .icon { background: none; border: none; color: var(--text-secondary); font-size: 28px; line-height: 1; }
      .section { display: block; color: var(--text-secondary); font-size: 12px; margin: 14px 4px 6px; text-transform: uppercase; }
      .section.sub { text-transform: none; font-size: 13px; }
      .row {
        width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px;
        background: var(--surface); border: 1px solid transparent; color: var(--text);
        border-radius: 10px; padding: 10px 12px; text-align: left; margin-bottom: 6px;
      }
      .row.sel { border-color: var(--accent-action); }
      .row span:first-child { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      strong { font-size: 15px; font-weight: 600; }
      small { color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .check { color: var(--accent-action); font-size: 18px; flex: none; }
      .fold {
        width: 100%; display: flex; justify-content: space-between; align-items: center;
        background: none; border: none; color: var(--text); padding: 10px 4px; font-size: 15px;
      }
      .muted { color: var(--text-secondary); text-align: center; padding: 18px 0; }
      .error { color: var(--accent-error); font-size: 13px; margin: 4px 0 0; }
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
    this.includeDefault()
      ? this.models().filter((model) => model.id !== 'auto')
      : this.models(),
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
