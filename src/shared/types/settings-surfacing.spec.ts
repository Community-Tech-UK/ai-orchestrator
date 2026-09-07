/**
 * S2.1 — the surfacing registry is only worth having if it stays true and stays
 * exhaustive. The `satisfies` clause gives exhaustiveness at compile time; these
 * tests guard the parts a type cannot check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

import { SETTING_SURFACING, internalSettingKeys, type SettingSurfacing } from './settings-surfacing';
import { SETTINGS_METADATA } from './settings.types';

/** Every renderer source file, specs excluded. */
function rendererSources(): string[] {
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory()
      ? walk(join(d, e.name))
      : (/\.(ts|html)$/.test(e.name) && !e.name.includes('.spec.') ? [join(d, e.name)] : [])));
  return walk(join(__dirname, '..', '..', 'renderer'));
}

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

  /**
   * A `bespoke` key is owned by a dedicated tab. That is either a metadata entry
   * marked `hidden`, or a hand-coded picker with no metadata at all. What it must
   * NOT be is metadata that still shows in generic category listings, which would
   * mean it renders twice.
   */
  it('no `bespoke` key still appears in generic category listings', () => {
    const broken = entries
      .filter(([, v]) => v === 'bespoke')
      .filter(([key]) => {
        const meta = metaByKey.get(key);
        return meta !== undefined && meta.hidden !== true;
      })
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

  /**
   * Does an `internal` key actually have a UI?
   *
   * Two generations of this check were wrong, both in the same way — too narrow
   * to see how the code is really written:
   *
   *  1. The first only cross-checked `SETTINGS_METADATA`, so a hand-coded picker
   *     that never enters that array was invisible. It missed five keys.
   *  2. The second scanned for `store.get(` / `settings()` / `update({` — and
   *     assumed every tab injects the store as `store`. Tabs actually use
   *     `store`, `settingsStore` AND `settings`, so every write through the
   *     other two aliases was silently missed. It missed thirteen more.
   *
   * So this no longer tries to recognise the ACCESS pattern at all. If a
   * settings component mentions the key as a string literal, that key has a UI
   * — whatever the receiver happens to be called. Broader, and it cannot be
   * defeated by renaming a variable.
   *
   * The deliberate cost: a key merely DISPLAYED read-only would also be flagged,
   * and calling that `bespoke` would overstate it. Accepted, because the failure
   * modes are not symmetric — a wrongly-`internal` key is a control the operator
   * cannot find, while a wrongly-`bespoke` one is a control that turns out to be
   * read-only. All 34 keys this caught were checked by hand and every one has a
   * real write; the eight that looked read-only route through a generic handler
   * (`onBooleanSettingChange(key, …)` → `persistSetting`), which is exactly the
   * indirection a narrower pattern-matching test would miss again.
   */
  it('no `internal` key is mentioned by any settings component', () => {
    const sources = rendererSources()
      .filter((f) => f.includes(`${sep}features${sep}settings${sep}`))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    const leaked = entries
      .filter(([, v]) => v === 'internal')
      .filter(([key]) => sources.includes(`'${key}'`) || sources.includes(`"${key}"`))
      .map(([key]) => key);

    expect(leaked).toEqual([]);
  });

  /**
   * The check above scopes itself to the settings folder, and **that boundary is
   * wrong** — a third generation of the same mistake. Two keys got past it:
   *
   *  - `allowPrCreation` is edited by a checkbox on the source-control panel,
   *    which is not a settings tab at all and never will be scanned by a test
   *    that only reads `features/settings/`.
   *  - `keybindingCustomizations` is edited by the Keyboard tab's "Import
   *    shortcuts" control, which lives INSIDE the settings folder but writes
   *    through `KeybindingService`, so the key name appears only in
   *    `core/services/`.
   *
   * So the real question is not "which folder mentions this key" but "does
   * anything in the renderer WRITE it". A key nothing writes is internal; a key
   * something writes is a control someone can reach, wherever that control lives
   * and however many layers of service sit in between.
   *
   * The exceptions below are the honest remainder: state the app records as a
   * side effect of being used, rather than configuration anyone sets. Each needs
   * a reason, and adding one is a visible decision in a diff — which is the only
   * defence against this test being quietly widened until it passes again.
   */
  const WRITTEN_BUT_INTERNAL: ReadonlyArray<{ key: string; why: string }> = [
    { key: 'defaultFastModeByProvider', why: 'remembers the per-provider fast-mode toggle; not a control' },
    { key: 'modelUsageByKey', why: 'usage counters written automatically to rank the picker' },
    { key: 'modelPickerFavorites', why: 'starred models — a list built by using the picker' },
    { key: 'dismissedHints', why: 'records which hints were dismissed; the hint is the UI, not this' },
  ];

  it('no `internal` key is written from anywhere in the renderer', () => {
    const written = entries
      .filter(([, v]) => v === 'internal')
      .map(([key]) => key)
      .filter((key) => {
        const write = new RegExp(
          String.raw`(?:\.set|setSetting|persistSetting)\(\s*['"]${key}['"]`
          + String.raw`|update\(\s*\{[^}]{0,400}?\b${key}\s*:`,
          's',
        );
        return rendererSources().some((f) => write.test(readFileSync(f, 'utf8')));
      })
      .filter((key) => !WRITTEN_BUT_INTERNAL.some((e) => e.key === key));

    expect(written).toEqual([]);
  });

  it('the written-but-internal exceptions are all still internal and still written', () => {
    const stale = WRITTEN_BUT_INTERNAL
      .filter((e) => (SETTING_SURFACING as Record<string, SettingSurfacing>)[e.key] !== 'internal')
      .map((e) => e.key);
    expect(stale).toEqual([]);
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
