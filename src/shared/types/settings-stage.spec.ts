import { describe, expect, it } from 'vitest';

import {
  badgesFor,
  isOfferable,
  matchesSearch,
  needsStageCaveat,
  searchTermsFor,
  stageCaveat,
  stageOf,
} from './settings-stage';
import type { SettingMetadata } from './settings-metadata.types';

const base: SettingMetadata = {
  key: 'showThinking', label: 'Show thinking', description: 'Show model reasoning inline.',
  type: 'boolean', category: 'general',
};

describe('stageOf (S2.2)', () => {
  /** Requiring every setting to declare `stable` produces a field nobody reads. */
  it('treats an undeclared stage as stable', () => {
    expect(stageOf(base)).toBe('stable');
  });

  it('respects a declared stage', () => {
    expect(stageOf({ stage: 'experimental' })).toBe('experimental');
  });
});

describe('isOfferable', () => {
  it('offers everything except removed', () => {
    for (const stage of ['under-development', 'experimental', 'stable', 'deprecated'] as const) {
      expect(isOfferable({ stage }), stage).toBe(true);
    }
  });

  /** A control that can never do anything is a dead control; delete, don't explain. */
  it('does not offer a removed setting', () => {
    expect(isOfferable({ stage: 'removed' })).toBe(false);
  });
});

describe('stageCaveat', () => {
  it('says nothing for a stable setting', () => {
    expect(stageCaveat(base)).toBeNull();
    expect(needsStageCaveat(base)).toBe(false);
  });

  /** "Experimental" alone tells a user nothing about whether to touch it. */
  it('explains what the stage means for the user, not just its name', () => {
    expect(stageCaveat({ stage: 'experimental' })).toContain('behaviour may change');
    expect(stageCaveat({ stage: 'deprecated' })).toContain('going away');
    expect(stageCaveat({ stage: 'under-development' })).toContain('may not work yet');
  });

  it('flags exactly the stages that need a caveat', () => {
    expect(needsStageCaveat({ stage: 'experimental' })).toBe(true);
    expect(needsStageCaveat({ stage: 'deprecated' })).toBe(true);
    expect(needsStageCaveat({ stage: 'stable' })).toBe(false);
  });
});

describe('badgesFor', () => {
  it('gives a stable, dependency-free setting no badges', () => {
    expect(badgesFor(base)).toEqual([]);
  });

  it('warns that a change will not take effect until restart', () => {
    const [badge] = badgesFor({ requiresRestart: true });
    expect(badge!.text).toBe('restart required');
    expect(badge!.detail).toContain('restart the app');
  });

  it('names the setting a dependent control needs', () => {
    const [badge] = badgesFor({ dependsOn: 'computerUseEnabled' });
    expect(badge!.text).toContain('computerUseEnabled');
  });

  /** Order is need-based, not alphabetical: safety, then "why is nothing happening". */
  it('orders badges stage, restart, dependency', () => {
    const badges = badgesFor({
      stage: 'experimental', requiresRestart: true, dependsOn: 'computerUseEnabled',
    });
    expect(badges.map((b) => b.text)).toEqual([
      'experimental', 'restart required', 'requires computerUseEnabled',
    ]);
  });
});

describe('matchesSearch', () => {
  const withKeywords: SettingMetadata = { ...base, keywords: ['reasoning', 'chain of thought'] };

  it('matches everything on an empty query', () => {
    expect(matchesSearch(base, '   ')).toBe(true);
  });

  it('matches the label and the key', () => {
    expect(matchesSearch(base, 'thinking')).toBe(true);
    expect(matchesSearch(base, 'showThinking')).toBe(true);
  });

  it('matches a declared keyword the label does not contain', () => {
    expect(matchesSearch(withKeywords, 'reasoning')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(matchesSearch(base, 'SHOW THINKING')).toBe(true);
  });

  /** Every word must appear, or a search is noise rather than a filter. */
  it('requires all words, not any', () => {
    expect(matchesSearch(base, 'show thinking')).toBe(true);
    expect(matchesSearch(base, 'show nonsense')).toBe(false);
  });

  it('includes keywords in the search text', () => {
    expect(searchTermsFor(withKeywords)).toContain('chain of thought');
  });
});
