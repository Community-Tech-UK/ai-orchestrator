/** Shared ownership and timing across explicit tooltip hosts and the native-title bridge. */
export const tooltipHostElements = new WeakSet<Element>();
let lastTooltipClosedAt = 0;
let bridgeHider: (() => void) | null = null;
export function getLastTooltipClosedAt(): number { return lastTooltipClosedAt; }
export function markTooltipClosed(): void { lastTooltipClosedAt = Date.now(); }
export function registerBridgeHider(hider: () => void): () => void {
  bridgeHider = hider;
  return () => { if (bridgeHider === hider) bridgeHider = null; };
}
export function hideBridgeTooltip(): void { bridgeHider?.(); }
