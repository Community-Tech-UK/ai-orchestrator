import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import type { CatalogSource } from '../../../../shared/types/unified-model-catalog.types';
import type { PickerProvider } from './compact-model-picker.types';
import { UnifiedCatalogStore } from './unified-catalog.store';

const SOURCE_LABELS: Record<CatalogSource, string> = {
  'cli-discovered': 'the provider',
  'models-dev': 'models.dev',
  'user-custom': 'your custom model',
  'catalog-override': 'your catalogue override',
  'local-model': 'your local model',
  static: 'the built-in catalogue',
};

/** Read-only detail for a model row; selection and availability stay on the row. */
@Component({
  selector: 'app-model-hover-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="model-hover-card">
      <strong>{{ model().name }}</strong>
      <code>{{ model().id }}</code>
      <span>{{ providerLabel() }} · {{ tierLabel() }}</span>
      @if (model().family; as family) { <span>Family: {{ family }}</span> }
      <span>{{ contextLabel() }}</span>
      @if (loadedContext(); as context) { <span>Loaded context: {{ context }} tokens</span> }
      <span>{{ price().text }}</span>
      @if (price().note; as note) { <span>{{ note }}</span> }
    </div>
  `,
  styles: [`
    .model-hover-card { display: grid; gap: 4px; }
    code { font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
  `],
})
export class ModelHoverCardComponent {
  readonly model = input.required<ModelDisplayInfo>();
  readonly provider = input.required<PickerProvider>();
  readonly providerLabel = input.required<string>();
  private readonly catalog = inject(UnifiedCatalogStore);
  private readonly entry = computed(() => this.catalog.models().find(entry =>
    entry.provider === this.provider() && entry.id === this.model().id,
  ));

  protected readonly tierLabel = computed(() => ({
    fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful',
  })[this.model().tier]);

  protected readonly contextLabel = computed(() => {
    const context = this.entry()?.contextWindow ?? this.model().localModel?.advertisedContextLength;
    return context === undefined ? 'Context size unknown' : `Context: ${context.toLocaleString('en-US')} tokens`;
  });

  protected readonly loadedContext = computed(() => {
    const local = this.model().localModel;
    return local?.loaded && local.loadedContextLength !== undefined
      ? local.loadedContextLength.toLocaleString('en-US') : null;
  });

  protected readonly price = computed(() => {
    const provider = this.provider();
    if (provider === 'copilot' || provider === 'cursor') return { text: 'Billed through your plan', note: null };
    if (provider === 'local-model') return { text: 'Runs on your computers', note: null };
    const entry = this.entry();
    if (!entry?.pricing) return { text: 'Price unknown', note: null };
    const { inputPerMillion, outputPerMillion } = entry.pricing;
    const source = entry.pricingSource ? SOURCE_LABELS[entry.pricingSource] : null;
    return {
      text: `API list price: $${inputPerMillion} in / $${outputPerMillion} out per 1M tokens`,
      note: `${source ? `List price from ${source}.` : 'Price source not recorded.'} Your plan may be billed differently.`,
    };
  });
}
