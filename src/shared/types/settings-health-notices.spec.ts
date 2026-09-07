/**
 * S3.4 — each notice is a claim about the shipped settings, so these check the
 * claims against `DEFAULT_SETTINGS` rather than against hand-built fixtures
 * alone. A notice that misfires on a fresh install is noise, and a notice that
 * stays silent when the combination is genuinely broken is worse than absent.
 */
import { describe, expect, it } from 'vitest';

import {
  SETTINGS_HEALTH_NOTICES,
  activeHealthNotices,
  allActiveHealthNotices,
} from './settings-health-notices';
import { DEFAULT_SETTINGS } from './settings-defaults';

const defaults = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...(DEFAULT_SETTINGS as unknown as Record<string, unknown>),
  ...over,
});

function ids(settings: Record<string, unknown>): string[] {
  return allActiveHealthNotices(settings).map((n) => n.id);
}

describe('the registry itself', () => {
  it('has unique ids', () => {
    const seen = new Set(SETTINGS_HEALTH_NOTICES.map((n) => n.id));
    expect(seen.size).toBe(SETTINGS_HEALTH_NOTICES.length);
  });

  it('gives every notice a tab, so nothing lands in a global dump', () => {
    expect(SETTINGS_HEALTH_NOTICES.filter((n) => !n.tab)).toEqual([]);
  });

  it('produces a non-empty message for every notice on default settings', () => {
    for (const notice of SETTINGS_HEALTH_NOTICES) {
      expect(notice.message(defaults()).length).toBeGreaterThan(20);
    }
  });
});

describe('quiet hours configured while disabled', () => {
  const id = 'quiet-hours-configured-while-disabled';

  it('stays silent on an untouched install', () => {
    expect(ids(defaults())).not.toContain(id);
  });

  it('fires when a window was edited but the feature is off', () => {
    expect(ids(defaults({ notificationQuietHoursStartHour: 23 }))).toContain(id);
  });

  it('stays silent when quiet hours are actually on', () => {
    expect(ids(defaults({ notificationQuietHoursStartHour: 23, notificationQuietHoursEnabled: true })))
      .not.toContain(id);
  });

  it('states the window it found, so the message is checkable', () => {
    const notice = SETTINGS_HEALTH_NOTICES.find((n) => n.id === id)!;
    expect(notice.message(defaults({ notificationQuietHoursStartHour: 23 })))
      .toContain('23:00');
  });
});

describe('local cross-model review with no selector', () => {
  const id = 'cross-model-review-local-no-selector';

  /**
   * This one DOES fire on a fresh install, deliberately. Both halves are
   * shipped defaults, and the result is a control that reads as on and does
   * nothing — which is true and worth saying.
   */
  it('fires on default settings, because the default really is inert', () => {
    expect(ids(defaults())).toContain(id);
  });

  it('goes quiet once a model is selected', () => {
    expect(ids(defaults({ crossModelReviewLocalSelectorId: 'some-model' }))).not.toContain(id);
  });

  it('goes quiet when local review is turned off', () => {
    expect(ids(defaults({ crossModelReviewLocalEnabled: false }))).not.toContain(id);
  });

  it('treats a whitespace-only selector as no selector', () => {
    expect(ids(defaults({ crossModelReviewLocalSelectorId: '   ' }))).toContain(id);
  });
});

describe('remote nodes bound wide open without TLS', () => {
  const id = 'remote-nodes-no-tls-open-bind';

  it('stays silent while the feature is off, even though the values match', () => {
    // The shipped defaults are exactly host 0.0.0.0 + TLS off. Firing here would
    // warn every installation about a server nobody started.
    expect(ids(defaults())).not.toContain(id);
  });

  it('fires once the server is enabled with those values', () => {
    expect(ids(defaults({ remoteNodesEnabled: true }))).toContain(id);
  });

  it('goes quiet when TLS is required', () => {
    expect(ids(defaults({ remoteNodesEnabled: true, remoteNodesRequireTls: true })))
      .not.toContain(id);
  });

  it('goes quiet when bound to loopback', () => {
    expect(ids(defaults({ remoteNodesEnabled: true, remoteNodesServerHost: '127.0.0.1' })))
      .not.toContain(id);
  });
});

describe('local-first routing with nothing local', () => {
  const id = 'auxiliary-local-first-no-endpoints';

  it('stays silent while localhost Ollama is on, which is itself a local endpoint', () => {
    expect(ids(defaults())).not.toContain(id);
  });

  it('fires when local-first has no endpoint and no Ollama', () => {
    expect(ids(defaults({ auxiliaryLlmUseLocalhostOllama: false }))).toContain(id);
  });

  it('goes quiet once an endpoint is configured', () => {
    expect(ids(defaults({
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmEndpointsJson: '[{"url":"http://localhost:1234"}]',
    }))).not.toContain(id);
  });

  it('treats malformed endpoint JSON as nothing configured', () => {
    expect(ids(defaults({
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmEndpointsJson: '{not json',
    }))).toContain(id);
  });

  it('goes quiet when routing is not local-first', () => {
    expect(ids(defaults({
      auxiliaryLlmUseLocalhostOllama: false,
      auxiliaryLlmRoutingMode: 'cloud-only',
    }))).not.toContain(id);
  });
});

describe('T3 — Loop Mode has its own threshold', () => {
  const id = 'loop-uses-its-own-context-threshold';

  it('is always active, because it is a fact rather than a misconfiguration', () => {
    expect(ids(defaults())).toContain(id);
  });

  it('quotes the threshold actually configured here, so the contrast is concrete', () => {
    const notice = SETTINGS_HEALTH_NOTICES.find((n) => n.id === id)!;
    expect(notice.message(defaults({ contextWarningThreshold: 65 }))).toContain('65%');
    expect(notice.message(defaults())).toContain('85%');
  });
});

describe('activeHealthNotices', () => {
  it('returns only the notices for the requested tab', () => {
    const review = activeHealthNotices(defaults(), 'review');
    expect(review.map((n) => n.id)).toEqual(['cross-model-review-local-no-selector']);
  });

  it('returns nothing for a tab with no notices', () => {
    expect(activeHealthNotices(defaults(), 'keyboard')).toEqual([]);
  });

  it('does not leak the always-on loop notice onto unrelated tabs', () => {
    expect(activeHealthNotices(defaults(), 'keyboard').map((n) => n.id))
      .not.toContain('loop-uses-its-own-context-threshold');
    expect(activeHealthNotices(defaults(), 'memory').map((n) => n.id))
      .toContain('loop-uses-its-own-context-threshold');
  });

  it('tolerates a settings object missing every key', () => {
    expect(() => allActiveHealthNotices({})).not.toThrow();
  });
});
