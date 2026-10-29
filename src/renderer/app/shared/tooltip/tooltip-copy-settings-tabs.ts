import type { TooltipCopyEntry } from './tooltip-copy';

export const SETTINGS_TABS_COPY = {
  "settingsHints.slotTier": { label: "Tier", meaning: "Which tier model this slot uses by default (quick = small/fast, quality = larger). Set the two tier models in Models." },
  "settingsHints.slotOverride": { label: "Model override", meaning: "Override the tier model for this slot with a specific model. Auto = use the slot's tier model (or first available if no tier model is set)." },
  "settingsHints.frontierFallback": { label: "Frontier fallback", meaning: "When on, this slot may escalate to the main frontier model if no auxiliary model produces output. Turn off to cap this slot at your configured auxiliary endpoints — if none is available it uses a deterministic local summary. Note: this only blocks the frontier model; content is still sent to whatever auxiliary endpoints you configure, which may be cloud." },
  "settingsHints.inactiveSlot": { label: "Not yet active", meaning: "No feature consumes this slot yet — the Test button still works, but nothing in normal operation routes through it." },
  "settingsHints.protectedAccount": { label: "Protected account", meaning: "A failed match here blocks Copilot rather than falling back" },
  "settingsHints.pinTrust": { label: "Approve", meaning: "Pin this file at its current content hash; it re-flags if it changes again" },
  "settingsHints.resetConnection": { label: "Reset connection", meaning: "Close this computer's live connection without revoking it. It reconnects by itself." },
} as const satisfies Record<string, TooltipCopyEntry>;
