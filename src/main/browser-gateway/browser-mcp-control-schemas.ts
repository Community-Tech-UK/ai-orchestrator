/**
 * JSON-schema fragments for the input-control browser tools
 * (browser.press_key / browser.set_viewport / browser.set_zoom). Kept beside
 * the shared schema props so the declarative MCP tool catalog stays under its
 * size ceiling. Plain data only — this file is bundled into the aio-mcp SEA
 * forwarder, so it must stay free of Electron and main-process imports.
 */

import {
  booleanProp,
  objectSchema,
  profileIdProp,
  selectorProp,
  stringProp,
  targetIdProp,
} from './browser-mcp-schema-props';

const pressKeyKeyProp = {
  type: 'string',
  enum: [
    'Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Backspace', 'Delete',
  ],
  description:
    'Named key to press with the browser\'s REAL input mechanism (native '
    + 'keystrokes, not JavaScript dispatchEvent), so focus movement and default '
    + 'keyboard behaviour actually occur. No printable characters — type text '
    + 'with browser.type instead.',
};

const pressKeyModifiersProp = {
  type: 'array',
  items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] },
  description:
    'Modifier keys held while pressing the key (e.g. ["Shift"] for Shift+Tab). '
    + 'Sent as real modifier key-down/up events and always released, including '
    + 'when the press fails or is cancelled.',
};

const pressKeyHintProp = {
  ...stringProp,
  description:
    'What this key press is meant to do (e.g. "activate the Help link"). '
    + 'Shown to the approver and keyword-classified: Enter/Space with no '
    + 'informative hint require explicit user approval before they can activate '
    + 'anything.',
};

const expectUrlChangeProp = {
  ...booleanProp,
  description: 'Opt in to post-dispatch verification that the target URL changed.',
};

const expectChangeProp = objectSchema({
  selector: {
    ...selectorProp,
    description: 'Element whose visible text must change after the action.',
  },
  urlContains: {
    ...stringProp,
    description: 'URL substring that must become newly present after the action.',
  },
});

const idempotencyKeyProp = {
  ...stringProp,
  description:
    'Optional retry-dedupe token. Re-pressing with the same key within a short '
    + 'window returns the original result (deduplicated: true) instead of '
    + 'pressing again — use it so a retried Enter cannot double-activate.',
};

export const pressKeyToolSchema = objectSchema({
  profileId: profileIdProp,
  targetId: targetIdProp,
  key: pressKeyKeyProp,
  modifiers: pressKeyModifiersProp,
  actionHint: pressKeyHintProp,
  expectUrlChange: expectUrlChangeProp,
  expectChange: expectChangeProp,
  idempotencyKey: idempotencyKeyProp,
  requestId: {
    ...stringProp,
    description: 'Browser Gateway approval request id.',
  },
}, ['profileId', 'targetId', 'key']);

export const setViewportToolSchema = objectSchema({
  profileId: profileIdProp,
  targetId: targetIdProp,
  width: {
    type: 'number',
    description: 'Target content width in CSS pixels (e.g. 768 for tablet width).',
  },
  height: {
    type: 'number',
    description: 'Target content height in CSS pixels (e.g. 1024).',
  },
  scope: {
    type: 'string',
    enum: ['tab', 'window'],
    description:
      '"tab" (default) emulates the selected tab\'s viewport only (reported as '
      + 'mode "tab_emulation") and never touches other tabs or the OS window. '
      + '"window" resizes the real Chrome window (reported as "window_resize") — '
      + 'a window-wide, shared-tab-only operation that affects every tab in it; '
      + 'the result identifies the window and its other tabs and retains the '
      + 'original bounds for restore. Neither stands in for the other. Omitting '
      + 'width/height/reset reads the current dimensions (and window bounds for '
      + 'scope "window").',
  },
  reset: {
    ...booleanProp,
    description:
      'Clear tab emulation / restore the recorded original window bounds. '
      + 'Reports restorationFailed explicitly if the original state is gone.',
  },
  requestId: {
    ...stringProp,
    description: 'Browser Gateway approval request id.',
  },
}, ['profileId', 'targetId']);

export const setZoomToolSchema = objectSchema({
  profileId: profileIdProp,
  targetId: targetIdProp,
  zoomFactor: {
    type: 'number',
    description:
      'Real Chrome browser zoom factor: 1 = 100%, 2 = 200%. CSS zoom, transforms '
      + 'and device-scale emulation are NOT this and are not used. Tab-scoped '
      + '(per-tab zoom settings); the original zoom and settings are preserved '
      + 'and restorable.',
  },
  reset: {
    ...booleanProp,
    description:
      'Restore the zoom factor and zoom settings recorded before the first '
      + 'change on this tab. Reports restorationFailed explicitly if the '
      + 'baseline was lost.',
  },
  requestId: {
    ...stringProp,
    description: 'Browser Gateway approval request id.',
  },
}, ['profileId', 'targetId']);
