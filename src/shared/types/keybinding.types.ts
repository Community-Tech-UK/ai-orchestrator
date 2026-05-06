/**
 * Keybinding Types - Configurable keyboard shortcuts
 */

/**
 * Modifier keys
 */
export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'meta' | 'cmd';

/**
 * A key combination (e.g., "ctrl+shift+p")
 */
export interface KeyCombo {
  key: string;  // The actual key (e.g., 'p', 'Enter', 'Escape')
  modifiers: KeyModifier[];
}

/**
 * A keybinding that can be a single key combo or a sequence (leader key pattern)
 */
export interface KeyBinding {
  id: string;
  name: string;
  description: string;
  // Either a single combo or a sequence for leader key pattern
  keys: KeyCombo | KeyCombo[];
  // The action to perform (command ID or action type)
  action: string;
  // Optional context when the binding is active
  context?: KeybindingContext;
  // Additional eligibility checks evaluated against the current UI state
  when?: KeybindingWhen[];
  // Whether this binding can be customized
  customizable?: boolean;
  // Category for grouping in UI
  category?: string;
}

/**
 * Context in which a keybinding is active
 */
export type KeybindingContext =
  | 'global'           // Always active
  | 'input'            // When input field is focused
  | 'output'           // When output area is focused
  | 'instance-list'    // When instance list is focused
  | 'command-palette'; // When command palette is open

/**
 * Keybinding action types
 */
export type KeybindingAction =
  // Navigation
  | 'focus-input'
  | 'focus-output'
  | 'focus-instance-list'
  // Instance management
  | 'new-instance'
  | 'close-instance'
  | 'next-instance'
  | 'prev-instance'
  | 'restart-instance'
  // UI
  | 'toggle-command-palette'
  | 'toggle-sidebar'
  | 'toggle-history'
  | 'toggle-settings'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  // Session
  | 'send-message'
  | 'cancel-operation'
  | 'clear-input'
  | 'copy-last-response'
  // Agent
  | 'toggle-agent'
  | 'select-agent-build'
  | 'select-agent-plan'
  // Wave 2 — navigation, pickers, and recall
  | 'select-orchestrator'
  | 'select-visible-instance-1'
  | 'select-visible-instance-2'
  | 'select-visible-instance-3'
  | 'select-visible-instance-4'
  | 'select-visible-instance-5'
  | 'select-visible-instance-6'
  | 'select-visible-instance-7'
  | 'select-visible-instance-8'
  | 'select-visible-instance-9'
  | 'open-session-picker'
  | 'resume.openPicker'
  | 'open-model-picker'
  | 'open-prompt-history-search'
  | 'recall-prompt-prev'
  | 'recall-prompt-next'
  // Custom command
  | `command:${string}`;

export type KeybindingWhen =
  | 'instance-selected'
  | 'multiple-instances'
  | 'instance-running'
  | 'command-palette-open'
  | 'history-open'
  | 'sidebar-visible';

export interface KeybindingEligibilityState {
  instanceSelected: boolean;
  multipleInstances: boolean;
  instanceRunning: boolean;
  commandPaletteOpen: boolean;
  historyOpen: boolean;
  sidebarVisible: boolean;
}

export const DEFAULT_KEYBINDING_ELIGIBILITY_STATE: KeybindingEligibilityState = {
  instanceSelected: false,
  multipleInstances: false,
  instanceRunning: false,
  commandPaletteOpen: false,
  historyOpen: false,
  sidebarVisible: true,
};

const SELECT_VISIBLE_INSTANCE_BINDINGS: KeyBinding[] = Array.from({ length: 9 }, (_, index) => {
  const slot = index + 1;
  const action = `select-visible-instance-${slot}`;
  const ordinal = slot === 1 ? '1st' : slot === 2 ? '2nd' : slot === 3 ? '3rd' : `${slot}th`;

  return {
    id: action,
    name: `Select Visible Instance ${slot}`,
    description: `Switch focus to the ${ordinal} visible instance in the project rail`,
    keys: { key: String(slot), modifiers: ['meta'] },
    action,
    context: 'global',
    when: ['multiple-instances'],
    category: 'Navigation',
    customizable: true,
  };
});

/**
 * Default keybindings
 */
export const DEFAULT_KEYBINDINGS: KeyBinding[] = [
  // Navigation
  {
    id: 'focus-input',
    name: 'Focus Input',
    description: 'Focus the message input field',
    keys: { key: 'i', modifiers: [] },
    action: 'focus-input',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },
  {
    id: 'focus-output',
    name: 'Focus Output',
    description: 'Focus the output area',
    keys: { key: 'o', modifiers: [] },
    action: 'focus-output',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },
  ...SELECT_VISIBLE_INSTANCE_BINDINGS,
  {
    id: 'select-orchestrator',
    name: 'Select Orchestrator',
    description: 'Switch focus to the global Orchestrator control plane',
    keys: { key: 'o', modifiers: ['meta', 'shift'] },
    action: 'select-orchestrator',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },

  // Instance management
  {
    id: 'new-instance',
    name: 'New Instance',
    description: 'Create a new Claude instance',
    keys: { key: 'n', modifiers: ['meta'] },
    action: 'new-instance',
    context: 'global',
    category: 'Instance',
    customizable: true,
  },
  {
    id: 'close-instance',
    name: 'Close Instance',
    description: 'Close the current instance',
    keys: { key: 'w', modifiers: ['meta'] },
    action: 'close-instance',
    context: 'global',
    when: ['instance-selected'],
    category: 'Instance',
    customizable: true,
  },
  {
    id: 'next-instance',
    name: 'Next Instance',
    description: 'Switch to the next instance',
    keys: { key: 'Tab', modifiers: ['ctrl'] },
    action: 'next-instance',
    context: 'global',
    when: ['multiple-instances'],
    category: 'Instance',
    customizable: true,
  },
  {
    id: 'prev-instance',
    name: 'Previous Instance',
    description: 'Switch to the previous instance',
    keys: { key: 'Tab', modifiers: ['ctrl', 'shift'] },
    action: 'prev-instance',
    context: 'global',
    when: ['multiple-instances'],
    category: 'Instance',
    customizable: true,
  },
  {
    id: 'restart-instance',
    name: 'Restart Instance',
    description: 'Restart the current instance',
    keys: { key: 'r', modifiers: ['meta', 'shift'] },
    action: 'restart-instance',
    context: 'global',
    when: ['instance-selected'],
    category: 'Instance',
    customizable: true,
  },

  // UI
  {
    id: 'toggle-command-palette',
    name: 'Command Palette',
    description: 'Open the command palette',
    keys: { key: 'p', modifiers: ['meta', 'shift'] },
    action: 'toggle-command-palette',
    context: 'global',
    when: ['instance-selected'],
    category: 'UI',
    customizable: true,
  },
  {
    id: 'toggle-command-palette-alt',
    name: 'Command Palette (Alternate)',
    description: 'Open the command palette (Cmd+K)',
    keys: { key: 'k', modifiers: ['meta'] },
    action: 'toggle-command-palette',
    context: 'global',
    when: ['instance-selected'],
    category: 'UI',
    customizable: true,
  },
  {
    id: 'toggle-sidebar',
    name: 'Toggle Sidebar',
    description: 'Toggle the sidebar visibility',
    keys: { key: 'b', modifiers: ['meta'] },
    action: 'toggle-sidebar',
    context: 'global',
    category: 'UI',
    customizable: true,
  },
  {
    id: 'toggle-history',
    name: 'Toggle History',
    description: 'Toggle the history sidebar',
    keys: { key: 'h', modifiers: ['meta'] },
    action: 'toggle-history',
    context: 'global',
    category: 'UI',
    customizable: true,
  },
  {
    id: 'toggle-settings',
    name: 'Open Settings',
    description: 'Open the settings panel',
    keys: { key: ',', modifiers: ['meta'] },
    action: 'toggle-settings',
    context: 'global',
    category: 'UI',
    customizable: true,
  },
  {
    id: 'zoom-in',
    name: 'Zoom In',
    description: 'Increase font size',
    keys: { key: '=', modifiers: ['meta'] },
    action: 'zoom-in',
    context: 'global',
    category: 'UI',
    customizable: true,
  },
  {
    id: 'zoom-out',
    name: 'Zoom Out',
    description: 'Decrease font size',
    keys: { key: '-', modifiers: ['meta'] },
    action: 'zoom-out',
    context: 'global',
    category: 'UI',
    customizable: true,
  },
  {
    id: 'zoom-reset',
    name: 'Reset Zoom',
    description: 'Reset font size to default',
    keys: { key: '0', modifiers: ['meta'] },
    action: 'zoom-reset',
    context: 'global',
    category: 'UI',
    customizable: true,
  },

  // Session
  {
    id: 'send-message',
    name: 'Send Message',
    description: 'Send the current message',
    keys: { key: 'Enter', modifiers: [] },
    action: 'send-message',
    context: 'input',
    category: 'Session',
    customizable: false,
  },
  {
    id: 'send-message-meta',
    name: 'Send Message (Meta)',
    description: 'Send the current message',
    keys: { key: 'Enter', modifiers: ['meta'] },
    action: 'send-message',
    context: 'input',
    category: 'Session',
    customizable: true,
  },
  {
    id: 'cancel-operation',
    name: 'Cancel Operation',
    description: 'Cancel the current operation',
    keys: { key: 'Escape', modifiers: [] },
    action: 'cancel-operation',
    context: 'global',
    when: ['command-palette-open', 'history-open', 'instance-running'],
    category: 'Session',
    customizable: false,
  },
  {
    id: 'clear-input',
    name: 'Clear Input',
    description: 'Clear the input field',
    keys: { key: 'u', modifiers: ['meta'] },
    action: 'clear-input',
    context: 'input',
    category: 'Session',
    customizable: true,
  },
  {
    id: 'copy-last-response',
    name: 'Copy Last Response',
    description: 'Copy the last Claude response to clipboard',
    keys: { key: 'c', modifiers: ['meta', 'shift'] },
    action: 'copy-last-response',
    context: 'global',
    category: 'Session',
    customizable: true,
  },
  {
    id: 'open-session-picker',
    name: 'Open Session Picker',
    description: 'Open the session picker',
    keys: { key: 'o', modifiers: ['meta'] },
    action: 'open-session-picker',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },
  {
    id: 'open-resume-picker',
    name: 'Open Resume Picker',
    description: 'Open resume actions for live and historical sessions',
    keys: { key: 'r', modifiers: ['meta'] },
    action: 'resume.openPicker',
    context: 'global',
    category: 'Navigation',
    customizable: true,
  },
  {
    id: 'open-model-picker',
    name: 'Open Model Picker',
    description: 'Open the active provider model picker',
    keys: { key: 'm', modifiers: ['meta', 'shift'] },
    action: 'open-model-picker',
    context: 'global',
    when: ['instance-selected'],
    category: 'Session',
    customizable: true,
  },
  {
    id: 'open-prompt-history-search',
    name: 'Prompt History Search',
    description: 'Open reverse-search overlay for past prompts',
    keys: { key: 'r', modifiers: ['ctrl'] },
    action: 'open-prompt-history-search',
    context: 'input',
    when: ['instance-selected'],
    category: 'Session',
    customizable: true,
  },

  // Agent
  {
    id: 'toggle-agent',
    name: 'Toggle Agent',
    description: 'Switch between agent modes',
    keys: { key: 'Tab', modifiers: [] },
    action: 'toggle-agent',
    context: 'input',
    category: 'Agent',
    customizable: true,
  },
];

/**
 * User keybinding customization
 */
export interface KeybindingCustomization {
  id: string;
  keys: KeyCombo | KeyCombo[];
}

/**
 * Parse a key string like "ctrl+shift+p" into KeyCombo
 */
export function parseKeyCombo(keyString: string): KeyCombo {
  const parts = keyString.toLowerCase().split('+');
  const modifiers: KeyModifier[] = [];
  let key = '';

  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') {
      modifiers.push('ctrl');
    } else if (part === 'alt' || part === 'option') {
      modifiers.push('alt');
    } else if (part === 'shift') {
      modifiers.push('shift');
    } else if (part === 'meta' || part === 'cmd' || part === 'command' || part === 'win') {
      modifiers.push('meta');
    } else {
      // This is the actual key
      key = part;
    }
  }

  return { key, modifiers };
}

/**
 * Format a KeyCombo as a display string
 */
export function formatKeyCombo(combo: KeyCombo, isMac = true): string {
  const modifierSymbols: Record<KeyModifier, string> = isMac
    ? { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘', cmd: '⌘' }
    : { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win', cmd: 'Win' };

  const parts = combo.modifiers.map((m) => modifierSymbols[m]);
  parts.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);

  return isMac ? parts.join('') : parts.join('+');
}

/**
 * Format a KeyBinding for display
 */
export function formatKeyBinding(binding: KeyBinding, isMac = true): string {
  if (Array.isArray(binding.keys)) {
    return binding.keys.map((k) => formatKeyCombo(k, isMac)).join(' ');
  }
  return formatKeyCombo(binding.keys, isMac);
}

/**
 * Minimal keyboard event interface for cross-platform compatibility
 */
export interface KeyboardEventLike {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Check if a keyboard event matches a key combo
 */
export function matchesKeyCombo(event: KeyboardEventLike, combo: KeyCombo): boolean {
  const eventModifiers = {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    cmd: event.metaKey,
  };

  // Check all required modifiers are pressed
  for (const mod of combo.modifiers) {
    if (!eventModifiers[mod]) {
      return false;
    }
  }

  // Check no extra modifiers are pressed
  const requiredModCount = combo.modifiers.length;
  const pressedModCount = [
    event.ctrlKey,
    event.altKey,
    event.shiftKey,
    event.metaKey,
  ].filter(Boolean).length;

  if (pressedModCount !== requiredModCount) {
    return false;
  }

  // Check the key
  return event.key.toLowerCase() === combo.key.toLowerCase();
}

export function matchesKeybindingWhen(
  when: KeybindingWhen[] | undefined,
  state: KeybindingEligibilityState,
): boolean {
  if (!when || when.length === 0) {
    return true;
  }

  return when.some((clause) => {
    switch (clause) {
      case 'instance-selected':
        return state.instanceSelected;
      case 'multiple-instances':
        return state.multipleInstances;
      case 'instance-running':
        return state.instanceRunning;
      case 'command-palette-open':
        return state.commandPaletteOpen;
      case 'history-open':
        return state.historyOpen;
      case 'sidebar-visible':
        return state.sidebarVisible;
      default:
        return false;
    }
  });
}
