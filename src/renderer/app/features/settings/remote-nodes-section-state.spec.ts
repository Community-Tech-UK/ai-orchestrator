import { describe, expect, it } from 'vitest';
import {
  buildRemoteNodesSectionTabs,
  isRemoteNodesSection,
  syncSelectedNodeAfterRosterChange,
} from './remote-nodes-section-state';

describe('isRemoteNodesSection', () => {
  it('accepts only the four known section ids', () => {
    expect(isRemoteNodesSection('overview')).toBe(true);
    expect(isRemoteNodesSection('pairing')).toBe(true);
    expect(isRemoteNodesSection('computers')).toBe(true);
    expect(isRemoteNodesSection('advanced')).toBe(true);
    expect(isRemoteNodesSection('bogus')).toBe(false);
  });
});

describe('buildRemoteNodesSectionTabs', () => {
  it('renders four tabs with no badges when counts are zero', () => {
    const tabs = buildRemoteNodesSectionTabs(0, 0);
    expect(tabs.map((tab) => tab.id)).toEqual(['overview', 'pairing', 'computers', 'advanced']);
    expect(tabs.every((tab) => tab.badge === undefined)).toBe(true);
  });

  it('surfaces a pending-pairing badge on Pairing and a connected-count badge on Computers', () => {
    const tabs = buildRemoteNodesSectionTabs(2, 3);
    expect(tabs.find((tab) => tab.id === 'pairing')?.badge).toBe('2');
    expect(tabs.find((tab) => tab.id === 'computers')?.badge).toBe('3');
    expect(tabs.find((tab) => tab.id === 'overview')?.badge).toBeUndefined();
    expect(tabs.find((tab) => tab.id === 'advanced')?.badge).toBeUndefined();
  });
});

describe('syncSelectedNodeAfterRosterChange', () => {
  it('auto-selects the first node the first time the roster is populated', () => {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: null, initialSelectionDone: false },
      [{ id: 'a' }, { id: 'b' }],
    );
    expect(next).toEqual({ selectedNodeId: 'a', initialSelectionDone: true });
  });

  it('does not auto-select on an empty roster', () => {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: null, initialSelectionDone: false },
      [],
    );
    expect(next).toEqual({ selectedNodeId: null, initialSelectionDone: false });
  });

  it('preserves a still-present selection across a refresh', () => {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: 'b', initialSelectionDone: true },
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    );
    expect(next).toEqual({ selectedNodeId: 'b', initialSelectionDone: true });
  });

  it('falls back to the list (null) when the selected node disappears', () => {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: 'gone', initialSelectionDone: true },
      [{ id: 'a' }, { id: 'b' }],
    );
    expect(next).toEqual({ selectedNodeId: null, initialSelectionDone: true });
  });

  it('never re-steals a deliberate "Back to computers" (null) once initial selection has run', () => {
    const next = syncSelectedNodeAfterRosterChange(
      { selectedNodeId: null, initialSelectionDone: true },
      [{ id: 'a' }, { id: 'b' }],
    );
    expect(next).toEqual({ selectedNodeId: null, initialSelectionDone: true });
  });
});
