import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { getStaticContextWindow } from '../../../../shared/data/static-context-window';

export interface ModelRowFacts {
  tierLabel: string;
  contextLabel: string | null;
  price: { text: string; note: string };
}

const TIERS: Record<ModelDisplayInfo['tier'], string> = {
  fast: 'Fast', balanced: 'Balanced', powerful: 'Powerful',
};

function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

// Cents from a dollar up; three significant figures below it, so $0.075 and $0.0375 stay exact.
function dollars(value: number): string {
  return Number(value >= 1 ? value.toFixed(2) : value.toPrecision(3)).toString();
}

export function buildModelRowFacts(model: ModelDisplayInfo, provider: string): ModelRowFacts {
  const normalized = provider.trim().toLowerCase();
  // The catalogue's window (models.dev, CLI, override) wins; the static table only
  // covers rows that arrive without a usable one, such as the pre-load fallback list.
  const isUsable = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const size = isUsable(model.contextWindow) ? model.contextWindow : getStaticContextWindow(normalized, model.id);
  const contextLabel = isUsable(size) ? `${compactTokens(size)} context` : null;
  let price: ModelRowFacts['price'];
  if (normalized === 'copilot' || normalized === 'cursor') {
    price = { text: 'Billed through your plan', note: '' };
  } else if (normalized === 'local-model') {
    price = { text: 'Runs on your machine', note: '' };
  } else if (model.pricing && Number.isFinite(model.pricing.inputPerMillion)
    && Number.isFinite(model.pricing.outputPerMillion)) {
    price = {
      text: `$${dollars(model.pricing.inputPerMillion)} in / $${dollars(model.pricing.outputPerMillion)} out per 1M tokens`,
      note: `API list price from ${model.pricingSource ?? 'the catalog'}. Your plan may be billed differently.`,
    };
  } else {
    price = { text: 'Price unknown', note: '' };
  }
  return { tierLabel: TIERS[model.tier], contextLabel, price };
}
