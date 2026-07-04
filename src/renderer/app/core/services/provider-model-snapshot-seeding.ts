import {
  MAX_MODEL_ID_LENGTH,
  mergeKnownModelCatalogSnapshot,
} from '../../../../shared/types/provider.types';

export function seedProviderModelIntoKnownCatalog(
  provider: string | null | undefined,
  model: string | null | undefined,
): void {
  if (!provider || provider === 'auto') {
    return;
  }

  const id = model?.trim();
  if (!id || id.length > MAX_MODEL_ID_LENGTH) {
    return;
  }

  mergeKnownModelCatalogSnapshot([{ provider, id }]);
}
