import { describe, expect, it } from 'vitest';
import { DesktopObservationStore } from './desktop-observation-store';
import type { DesktopAccessibilityNode } from '../../shared/types/desktop-gateway.types';

function makeStore(nowRef: { value: number }): DesktopObservationStore {
  let seq = 0;
  return new DesktopObservationStore(
    () => nowRef.value,
    () => `id${(seq += 1)}`,
  );
}

const SNAPSHOT: DesktopAccessibilityNode[] = [
  {
    uid: 'ax_1',
    role: 'AXWindow',
    label: 'Preview',
    bounds: { x: 0, y: 0, width: 400, height: 300 },
    children: [
      {
        uid: 'ax_2',
        role: 'AXButton',
        label: 'Save',
        value: '',
        bounds: { x: 10, y: 20, width: 100, height: 40 },
      },
      { uid: 'ax_3', role: 'AXTextField', label: 'Filename', value: 'draft.pdf' },
    ],
  },
];

describe('DesktopObservationStore', () => {
  it('mints an obs-prefixed token that validates for the same app', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('darwin-app:com.apple.Preview');
    expect(token.startsWith('obs_')).toBe(true);
    expect(store.validate(token, 'darwin-app:com.apple.Preview')).toBeNull();
  });

  it('rejects a token for a different app', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('darwin-app:com.apple.Preview');
    expect(store.validate(token, 'darwin-app:com.apple.Safari')).toBe(
      'computer_use_stale_observation',
    );
  });

  it('rejects a token after the active window changes within the same app', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('darwin-app:com.example.Editor', { windowId: 'window-1' });

    expect(store.validate(token, 'darwin-app:com.example.Editor', 'window-2')).toBe(
      'computer_use_target_changed',
    );
  });

  it('expires a token after the TTL elapses', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app');
    now.value += 15_001;
    expect(store.validate(token, 'app')).toBe('computer_use_stale_observation');
  });

  it('reports no snapshot when the token carried none', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { contentHash: 'abc' });
    const result = store.query({ appId: 'app', observationToken: token });
    expect(result).toEqual({ ok: false, reason: 'computer_use_no_snapshot' });
  });

  it('returns every node when the query has no filter', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { snapshot: SNAPSHOT });
    const result = store.query({ appId: 'app', observationToken: token });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidates.map((c) => c.uid)).toEqual(['ax_1', 'ax_2', 'ax_3']);
    }
  });

  it('filters by role and text', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { snapshot: SNAPSHOT });
    const byRole = store.query({ appId: 'app', observationToken: token, role: 'AXButton' });
    expect(byRole.ok && byRole.candidates.map((c) => c.uid)).toEqual(['ax_2']);

    const token2 = store.create('app', { snapshot: SNAPSHOT });
    const byText = store.query({ appId: 'app', observationToken: token2, text: 'draft' });
    expect(byText.ok && byText.candidates.map((c) => c.uid)).toEqual(['ax_3']);
  });

  it('resolves an observed element by uid for a bounded input action', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { snapshot: SNAPSHOT });

    expect(store.findElement(token, 'app', 'ax_2')).toEqual({
      ok: true,
      appId: 'app',
      candidate: {
        uid: 'ax_2',
        role: 'AXButton',
        label: 'Save',
        value: '',
        bounds: { x: 10, y: 20, width: 100, height: 40 },
      },
    });
  });

  it('resolves the deepest observed element containing a coordinate', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { snapshot: SNAPSHOT });

    expect(store.findElementAtPoint(token, 'app', { x: 20, y: 30 })).toMatchObject({
      ok: true,
      candidate: { uid: 'ax_2', label: 'Save' },
    });
    expect(store.findElementAtPoint(token, 'app', { x: 500, y: 500 })).toEqual({
      ok: false,
      reason: 'computer_use_target_outside_approved_window',
    });
  });

  it('rejects a query against a stale token', () => {
    const now = { value: 1_000 };
    const store = makeStore(now);
    const token = store.create('app', { snapshot: SNAPSHOT });
    now.value += 15_001;
    const result = store.query({ appId: 'app', observationToken: token });
    expect(result).toEqual({ ok: false, reason: 'computer_use_stale_observation' });
  });

  it('hashes content deterministically to a bounded hex string', () => {
    const hash = DesktopObservationStore.hashContent('hello');
    expect(hash).toHaveLength(16);
    expect(hash).toBe(DesktopObservationStore.hashContent('hello'));
    expect(hash).not.toBe(DesktopObservationStore.hashContent('world'));
  });
});
