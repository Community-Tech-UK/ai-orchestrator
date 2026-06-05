/**
 * A2 / Phase 3-B — ModelsDevService offline snapshot seeding.
 *
 * The build-time snapshot (`models-dev-snapshot.generated.ts`, produced by
 * `npm run sync:model-catalog`) is seeded into the pricing overlay + the
 * service's entry/context-window caches at startup so cost accounting and the
 * unified catalog are correct offline, before the first live fetch.
 *
 * Asserts against the snapshot's OWN values (not hardcoded prices) so the tests
 * stay correct each time the snapshot is regenerated from models.dev.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ModelsDevService } from './models-dev-service';
import { MODELS_DEV_SNAPSHOT } from './models-dev-snapshot.generated';
import {
  clearModelRateOverlay,
  getModelRate,
  hasOverlayRate,
  modelRateOverlaySize,
} from '../../shared/data/model-pricing';

const SNAPSHOT_IDS = Object.keys(MODELS_DEV_SNAPSHOT);
const SAMPLE_ID = SNAPSHOT_IDS[0]!;

describe('ModelsDevService.loadOfflineSnapshot', () => {
  afterEach(() => {
    clearModelRateOverlay();
  });

  it('the committed snapshot is non-empty (regenerate via npm run sync:model-catalog)', () => {
    expect(SNAPSHOT_IDS.length).toBeGreaterThan(0);
  });

  it('seeds the pricing overlay with the snapshot rates', () => {
    const service = new ModelsDevService();
    service.loadOfflineSnapshot();

    const expected = MODELS_DEV_SNAPSHOT[SAMPLE_ID]!;
    expect(hasOverlayRate(SAMPLE_ID)).toBe(true);
    expect(getModelRate(SAMPLE_ID)).toEqual({ input: expected.input, output: expected.output });
    expect(modelRateOverlaySize()).toBe(SNAPSHOT_IDS.length);
  });

  it('seeds entries and context windows for the unified catalog', () => {
    const service = new ModelsDevService();
    service.loadOfflineSnapshot();

    expect(service.listEntries()).toHaveLength(SNAPSHOT_IDS.length);

    // Find a snapshot model that publishes a context window and confirm it seeds.
    const withCtx = SNAPSHOT_IDS.find((id) => MODELS_DEV_SNAPSHOT[id]!.contextWindow !== undefined);
    if (withCtx) {
      expect(service.getContextWindow(withCtx)).toBe(MODELS_DEV_SNAPSHOT[withCtx]!.contextWindow);
    }
  });

  it('is idempotent — a second call does not re-seed', () => {
    const service = new ModelsDevService();
    service.loadOfflineSnapshot();
    const sizeAfterFirst = modelRateOverlaySize();
    service.loadOfflineSnapshot();
    expect(modelRateOverlaySize()).toBe(sizeAfterFirst);
  });

  it('does NOT clobber live data already fetched (lastFetchedAt > 0)', () => {
    const service = new ModelsDevService();
    // Simulate a prior successful live refresh.
    (service as unknown as { lastFetchedAt: number }).lastFetchedAt = 1;
    service.loadOfflineSnapshot();
    // The guard short-circuits before seeding, so the overlay stays empty.
    expect(modelRateOverlaySize()).toBe(0);
    expect(service.listEntries()).toHaveLength(0);
  });
});
