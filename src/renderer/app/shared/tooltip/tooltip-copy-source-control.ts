import type { TooltipCopyEntry } from './tooltip-copy';

/** Local source-control gestures; these are not rebindable registry actions. */
export const SOURCE_CONTROL_COPY = {
  'sourceControl.commitMac': { label: 'Commit', meaning: 'Commit staged changes (⌘+Enter)' },
  'sourceControl.commitOther': { label: 'Commit', meaning: 'Commit staged changes (Ctrl+Enter)' },
  'sourceControl.trackedMac': {
    label: 'Open diff',
    meaning: 'click to open diff · ⌘/⇧-click to multi-select · drag to attach',
  },
  'sourceControl.trackedOther': {
    label: 'Open diff',
    meaning: 'click to open diff · Ctrl/Shift-click to multi-select · drag to attach',
  },
  'sourceControl.untrackedMac': {
    label: 'Select file',
    meaning: '⌘/⇧-click to multi-select · drag to attach',
  },
  'sourceControl.untrackedOther': {
    label: 'Select file',
    meaning: 'Ctrl/Shift-click to multi-select · drag to attach',
  },
} as const satisfies Record<string, TooltipCopyEntry>;
