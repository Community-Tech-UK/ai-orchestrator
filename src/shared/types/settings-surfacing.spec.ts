/**
 * S2.1 — the surfacing registry is only worth having if it stays true and stays
 * exhaustive. The `satisfies` clause gives exhaustiveness at compile time; these
 * tests guard the parts a type cannot check.
 */
import { describe, expect, it } from 'vitest';

import { SETTING_SURFACING, internalSettingKeys, type SettingSurfacing } from './settings-surfacing';
import { SETTINGS_METADATA } from './settings.types';

describe('SETTING_SURFACING', () => {
  const metaByKey = new Map<string, (typeof SETTINGS_METADATA)[number]>(
    SETTINGS_METADATA.map((m) => [m.key as string, m]),
  );
  const entries = Object.entries(SETTING_SURFACING) as [string, SettingSurfacing][];

  it('classifies every key with one of the four values', () => {
    const allowed = new Set(['tab', 'bespoke', 'hidden', 'internal']);
    const bad = entries.filter(([, v]) => !allowed.has(v));
    expect(bad).toEqual([]);
  });

  /**
   * A `tab` key claims it renders in a category-driven tab. That is only true
   * if it has metadata and is not hidden from generic listings.
   */
  it('every `tab` key has visible metadata backing the claim', () => {
    const broken = entries
      .filter(([, v]) => v === 'tab')
      .filter(([key]) => {
        const meta = metaByKey.get(key);
        return !meta || meta.hidden === true;
      })
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  /** A `bespoke` key is owned by a dedicated tab, so it must be hidden from generic ones. */
  it('every `bespoke` key has metadata marked hidden', () => {
    const broken = entries
      .filter(([, v]) => v === 'bespoke')
      .filter(([key]) => metaByKey.get(key)?.hidden !== true)
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  /** An `internal` key claims no settings-UI presence; metadata would contradict that. */
  it('no `internal` key secretly has settings metadata', () => {
    const contradictory = entries
      .filter(([, v]) => v === 'internal')
      .filter(([key]) => metaByKey.has(key))
      .map(([key]) => key);
    expect(contradictory).toEqual([]);
  });

  it('every metadata key is classified', () => {
    const unclassified = SETTINGS_METADATA
      .map((m) => m.key as string)
      .filter((key) => !(key in SETTING_SURFACING));
    expect(unclassified).toEqual([]);
  });

  /**
   * Not an aspiration — a measurement, pinned so the number moving is visible in
   * a diff. 64 keys had no declaration of any kind before this registry existed.
   */
  it('reports the internal set rather than hiding it', () => {
    const internal = internalSettingKeys();
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.length).toBeLessThan(Object.keys(SETTING_SURFACING).length);
  });
});
