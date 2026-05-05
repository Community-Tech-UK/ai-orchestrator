import { ChangeDetectionStrategy, Component, HostListener, inject, output } from '@angular/core';
import { ModelPickerController } from './model-picker.controller';

@Component({
  selector: 'app-model-picker-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="model-picker-backdrop">
      <button
        type="button"
        class="model-picker-scrim"
        aria-label="Close model picker"
        (click)="closeRequested.emit()"
      ></button>
      <section class="model-picker-panel">
        <header class="model-picker-header">
          <div>
            <h2>Model picker</h2>
            <p>{{ controller.selectedProviderOption().label }}</p>
          </div>
          <button type="button" class="icon-btn" aria-label="Close model picker" (click)="closeRequested.emit()">x</button>
        </header>

        <div class="search-row">
          <input
            type="search"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search model versions..."
            [value]="controller.query()"
            (input)="controller.setQuery(inputValue($event))"
          />
        </div>

        <div class="model-picker-body">
          <nav class="provider-rail" aria-label="Providers">
            @for (provider of controller.providerOptions(); track provider.id) {
              <button
                type="button"
                class="provider-option"
                [class.selected]="provider.id === controller.selectedProviderId()"
                [class.disabled]="!provider.available"
                [disabled]="!provider.available"
                [title]="provider.disabledReason || provider.label"
                (click)="controller.selectProvider(provider.id)"
              >
                <span class="provider-dot" [style.background]="provider.color"></span>
                <span>{{ provider.label }}</span>
              </button>
            }
          </nav>

          <main class="selection-panel">
            <section class="model-section">
              <div class="section-heading">
                <span>Model version</span>
                @if (controller.selectedModel(); as model) {
                  <span class="current-id">{{ model.id }}</span>
                }
              </div>

              <div class="model-list">
                @for (model of controller.selectedProviderModels(); track model.id) {
                  <button
                    type="button"
                    class="model-row"
                    [class.selected]="model.id === controller.selectedModelId()"
                    (click)="controller.selectModel(model.id)"
                  >
                    <span class="model-main">
                      <span class="model-name">{{ model.name }}</span>
                      <span class="model-id">{{ model.id }}</span>
                    </span>
                    <span class="tier-pill" [class]="'tier-' + model.tier">{{ model.tier }}</span>
                  </button>
                } @empty {
                  <div class="empty-state">No model versions match the search.</div>
                }
              </div>
            </section>

            @if (controller.reasoningOptions().length > 0) {
              <section class="thinking-section">
                <div class="section-heading">
                  <span>Thinking</span>
                  <span class="current-id">{{ controller.selectedReasoningId() }}</span>
                </div>
                <div class="thinking-grid">
                  @for (option of controller.reasoningOptions(); track option.id) {
                    <button
                      type="button"
                      class="thinking-option"
                      [class.selected]="option.id === controller.selectedReasoningId()"
                      (click)="controller.selectReasoningEffort(option.id)"
                    >
                      <span>{{ option.label }}</span>
                      <small>{{ option.description }}</small>
                    </button>
                  }
                </div>
              </section>
            }
          </main>
        </div>

        @if (controller.applyDisabledReason(); as reason) {
          <div class="disabled-reason">{{ reason }}</div>
        }

        <footer class="model-picker-footer">
          <button type="button" class="secondary-btn" (click)="closeRequested.emit()">Cancel</button>
          <button
            type="button"
            class="primary-btn"
            [disabled]="!!controller.applyDisabledReason() || !controller.hasSelectionChanged() || controller.applying()"
            (click)="applySelection()"
          >
            {{ controller.applying() ? 'Applying...' : 'Apply' }}
          </button>
        </footer>
      </section>
    </div>
  `,
  styles: [`
    .model-picker-backdrop {
      position: fixed;
      inset: 0;
      z-index: var(--z-modal, 1000);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    .model-picker-scrim {
      position: absolute;
      inset: 0;
      border: 0;
      padding: 0;
      background: rgba(0, 0, 0, 0.56);
      backdrop-filter: blur(10px);
      cursor: default;
    }

    .model-picker-panel {
      position: relative;
      z-index: 1;
      width: min(860px, calc(100vw - 32px));
      max-height: min(760px, calc(100vh - 32px));
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--bg-secondary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: var(--shadow-lg, 0 24px 80px rgba(0, 0, 0, 0.4));
    }

    .model-picker-header,
    .model-picker-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-color);
    }

    .model-picker-footer {
      border-top: 1px solid var(--border-color);
      border-bottom: 0;
      justify-content: flex-end;
    }

    h2 {
      margin: 0;
      font-size: 15px;
      line-height: 1.2;
    }

    p {
      margin: 3px 0 0;
      color: var(--text-muted);
      font-size: 12px;
    }

    .icon-btn,
    .secondary-btn,
    .primary-btn {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
      font-size: 12px;
    }

    .icon-btn {
      width: 28px;
      height: 28px;
    }

    .secondary-btn,
    .primary-btn {
      padding: 7px 12px;
    }

    .primary-btn {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
      font-weight: 600;
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .search-row {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-color);
    }

    input {
      width: 100%;
      height: 36px;
      box-sizing: border-box;
      padding: 0 11px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
    }

    input:focus {
      border-color: var(--primary-color);
    }

    .model-picker-body {
      display: grid;
      grid-template-columns: 190px minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }

    .provider-rail {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px;
      border-right: 1px solid var(--border-color);
      background: var(--bg-primary);
    }

    .provider-option {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 9px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      text-align: left;
      font-size: 12px;
    }

    .provider-option.selected {
      background: var(--bg-hover);
      border-color: var(--border-color);
      color: var(--text-primary);
    }

    .provider-option.disabled {
      opacity: 0.42;
    }

    .provider-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      flex: 0 0 auto;
    }

    .selection-panel {
      min-height: 0;
      overflow-y: auto;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .current-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--font-family-mono, monospace);
      font-weight: 500;
      text-transform: none;
      letter-spacing: 0;
    }

    .model-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .model-row,
    .thinking-option {
      border: 1px solid var(--border-color);
      border-radius: 6px;
      background: var(--bg-primary);
      color: var(--text-primary);
      cursor: pointer;
      transition: border-color var(--transition-fast), background var(--transition-fast);
    }

    .model-row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 54px;
      padding: 9px 10px;
      text-align: left;
    }

    .model-row:hover,
    .thinking-option:hover {
      background: var(--bg-tertiary);
      border-color: var(--border-light);
    }

    .model-row.selected,
    .thinking-option.selected {
      border-color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 12%, var(--bg-primary));
    }

    .model-main {
      min-width: 0;
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 3px;
    }

    .model-name {
      font-size: 13px;
      font-weight: 600;
    }

    .model-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-muted);
      font-family: var(--font-family-mono, monospace);
      font-size: 11px;
    }

    .tier-pill {
      padding: 3px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: #fff;
    }

    .tier-powerful { background: #d97706; }
    .tier-balanced { background: #2563eb; }
    .tier-fast { background: #059669; }

    .thinking-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(118px, 1fr));
      gap: 8px;
    }

    .thinking-option {
      min-height: 58px;
      padding: 8px;
      text-align: left;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .thinking-option span {
      font-size: 12px;
      font-weight: 700;
    }

    .thinking-option small {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.25;
    }

    .disabled-reason,
    .empty-state {
      color: var(--text-muted);
      font-size: 12px;
    }

    .disabled-reason {
      padding: 0 16px 12px;
    }

    .empty-state {
      padding: 16px;
      border: 1px dashed var(--border-color);
      border-radius: 6px;
      text-align: center;
    }

    @media (max-width: 720px) {
      .model-picker-backdrop {
        align-items: stretch;
        padding: 10px;
      }

      .model-picker-panel {
        width: 100%;
        max-height: none;
      }

      .model-picker-body {
        grid-template-columns: 1fr;
      }

      .provider-rail {
        flex-direction: row;
        overflow-x: auto;
        border-right: 0;
        border-bottom: 1px solid var(--border-color);
      }

      .provider-option {
        width: auto;
        white-space: nowrap;
      }
    }
  `],
})
export class ModelPickerHostComponent {
  protected readonly controller = inject(ModelPickerController);
  closeRequested = output<void>();

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeRequested.emit();
  }

  inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  async applySelection(): Promise<void> {
    const handled = await this.controller.applySelection();
    if (handled) {
      this.closeRequested.emit();
    }
  }
}
