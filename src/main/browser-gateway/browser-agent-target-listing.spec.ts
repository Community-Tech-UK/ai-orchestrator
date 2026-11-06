import { describe, expect, it } from 'vitest';
import { BrowserTargetRegistry } from './browser-target-registry';
import { BrowserExtensionTabStore } from './browser-extension-tab-store';
import {
  compactAgentTargetListing,
  type CompactAgentTarget,
} from './browser-agent-target-listing';

function fullTarget(): Record<string, unknown> {
  return {
    id: 'target-1',
    targetId: 'target-1',
    profileId: 'profile-1',
    title: 'A tab',
    url: 'https://example.com/page',
    origin: 'https://example.com',
    mode: 'managed',
    status: 'attached',
    inspectionState: 'available',
    active: true,
    stale: false,
    nodeName: 'chrome',
    textUnavailableReason: undefined,
    reboundFromTargetId: 'target-0',
    // Dropped fields (bookkeeping agents never need):
    pageId: 'page-1',
    driver: 'puppeteer',
    windowId: 'win-1',
    tabIndex: 3,
    pinned: true,
    lastSeenAt: 1_700_000_000_000,
    lastConfirmedAt: 1_700_000_000_001,
  };
}

describe('compactAgentTargetListing (A19, Step 9c)', () => {
  it('drops the bookkeeping fields and keeps profileId and targetId', () => {
    const result = compactAgentTargetListing({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'a1',
      data: [fullTarget()],
    });
    const target = result.data![0] as CompactAgentTarget & Record<string, unknown>;

    expect(target.targetId).toBe('target-1');
    expect(target.profileId).toBe('profile-1');
    for (const dropped of ['id', 'pageId', 'driver', 'windowId', 'tabIndex', 'pinned', 'lastSeenAt', 'lastConfirmedAt']) {
      expect(dropped in target).toBe(false);
    }
    // The context fields stay.
    expect(target.title).toBe('A tab');
    expect(target.url).toBe('https://example.com/page');
    expect(target.inspectionState).toBe('available');
    expect(target.reboundFromTargetId).toBe('target-0');
    // The array shape is unchanged: one input target, one output target.
    expect(result.data).toHaveLength(1);
  });

  it('cuts long titles and URLs with a marker', () => {
    const result = compactAgentTargetListing({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'a2',
      data: [{
        ...fullTarget(),
        title: 't'.repeat(200),
        url: `https://example.com/${'u'.repeat(400)}`,
      }],
    });
    const target = result.data![0] as CompactAgentTarget;
    expect(target.title).toHaveLength(120);
    expect(target.title!.endsWith('…')).toBe(true);
    expect(target.url).toHaveLength(300);
    expect(target.url!.endsWith('…')).toBe(true);
  });

  it('leaves a denied (empty) listing alone', () => {
    const denied = { decision: 'denied', outcome: 'not_run', reason: 'no grant', auditId: 'a3' } as const;
    expect(compactAgentTargetListing(denied)).toEqual(denied);

    const empty = {
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'a4',
      data: [] as object[],
    } as const;
    expect(compactAgentTargetListing(empty)).toEqual(empty);
  });

  // W13 (round 5, suffix R5M7): the agent guidance tells the model to look for
  // `httpAuthChallenge` on a tab and answer it with browser.fill_http_auth, so the
  // compact listing must carry the field. Targets here come from the real tab store
  // and registry, not a hand-built object, so the shape is the one list_targets returns.
  describe('httpAuthChallenge', () => {
    const challenge = { origin: 'https://intranet.example.com', scheme: 'Basic', realm: 'staff', at: 1_700_000_000_000 };

    function realListing(withChallenge: boolean): { data: object[] } {
      const targetRegistry = new BrowserTargetRegistry();
      const store = new BrowserExtensionTabStore({ targetRegistry, now: () => 1234 });
      store.attachTab({
        tabId: 11,
        windowId: 2,
        url: 'https://intranet.example.com/dashboard',
        title: 'Intranet',
        ...(withChallenge ? { httpAuthChallenge: challenge } : {}),
      });
      return { data: targetRegistry.listTargets() };
    }

    it('keeps the challenge a real shared tab reports', () => {
      const listing = realListing(true);
      // Guard the fixture: the real target carries the field before compacting.
      expect((listing.data[0] as Record<string, unknown>)['httpAuthChallenge']).toEqual(challenge);

      const result = compactAgentTargetListing({ decision: 'allowed', outcome: 'succeeded', auditId: 'a5', ...listing });
      const target = result.data![0] as CompactAgentTarget;

      expect(target.httpAuthChallenge).toEqual(challenge);
      expect(target.targetId).toBe('existing-tab:2:11:target');
    });

    it('leaves the key out when no prompt is waiting', () => {
      const listing = realListing(false);
      expect('httpAuthChallenge' in (listing.data[0] as Record<string, unknown>)).toBe(false);

      const result = compactAgentTargetListing({ decision: 'allowed', outcome: 'succeeded', auditId: 'a6', ...listing });

      expect('httpAuthChallenge' in result.data![0]!).toBe(false);
    });

    it('ignores a non-object challenge value', () => {
      const result = compactAgentTargetListing({
        decision: 'allowed',
        outcome: 'succeeded',
        auditId: 'a7',
        data: [{ ...fullTarget(), httpAuthChallenge: 'yes' }],
      });
      expect('httpAuthChallenge' in result.data![0]!).toBe(false);
    });
  });
});
