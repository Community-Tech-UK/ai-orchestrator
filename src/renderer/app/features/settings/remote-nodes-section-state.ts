/**
 * Pure state helpers for the Remote Nodes settings tab's task-based section
 * navigation (Task 3) and Computers list/detail selection (Task 4). Extracted
 * from the component so both are independently testable and to keep the
 * component under the repo's LOC ratchet.
 */
import type { SettingsSectionTab } from './settings-navigation';

/** Task-based sections for the Remote Nodes settings tab. */
export type RemoteNodesSection = 'overview' | 'pairing' | 'computers' | 'advanced';

const REMOTE_NODES_SECTIONS: readonly RemoteNodesSection[] = [
  'overview',
  'pairing',
  'computers',
  'advanced',
];

export function isRemoteNodesSection(id: string): id is RemoteNodesSection {
  return (REMOTE_NODES_SECTIONS as readonly string[]).includes(id);
}

/** Tabs for the shared section switcher; badges reflect live counts. */
export function buildRemoteNodesSectionTabs(
  pendingPairingCount: number,
  connectedNodeCount: number,
): SettingsSectionTab[] {
  return [
    { id: 'overview', label: 'Overview', panelId: 'remote-nodes-panel-overview' },
    {
      id: 'pairing',
      label: 'Pairing',
      panelId: 'remote-nodes-panel-pairing',
      ...(pendingPairingCount > 0 ? { badge: String(pendingPairingCount) } : {}),
    },
    {
      id: 'computers',
      label: 'Computers',
      panelId: 'remote-nodes-panel-computers',
      ...(connectedNodeCount > 0 ? { badge: String(connectedNodeCount) } : {}),
    },
    { id: 'advanced', label: 'Advanced', panelId: 'remote-nodes-panel-advanced' },
  ];
}

export interface NodeSelectionState {
  readonly selectedNodeId: string | null;
  readonly initialSelectionDone: boolean;
}

/**
 * Keep the Computers selection stable across live roster refreshes: preserve
 * a still-present selection, fall back to the list (null) if the selected
 * node disappears, and auto-select the first node only the first time the
 * roster is populated (never re-steal a deliberate "Back to computers").
 */
export function syncSelectedNodeAfterRosterChange(
  current: NodeSelectionState,
  nodes: readonly { id: string }[],
): NodeSelectionState {
  if (current.selectedNodeId !== null) {
    if (!nodes.some((node) => node.id === current.selectedNodeId)) {
      return { selectedNodeId: null, initialSelectionDone: current.initialSelectionDone };
    }
    return current;
  }
  if (!current.initialSelectionDone && nodes.length > 0) {
    return { selectedNodeId: nodes[0].id, initialSelectionDone: true };
  }
  return current;
}
