import { ElementRef } from '@angular/core';
import { Overlay, OverlayPositionBuilder, type ConnectedPosition, type OverlayRef } from '@angular/cdk/overlay';
export type TooltipPosition = 'above' | 'below' | 'before' | 'after';
const POSITIONS: Readonly<Record<'above' | 'below' | 'before' | 'after', ConnectedPosition[]>> = {
  above: [
    { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
    { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 },
  ],
  below: [
    { originX: 'center', originY: 'bottom', overlayX: 'center', overlayY: 'top', offsetY: 8 },
    { originX: 'center', originY: 'top', overlayX: 'center', overlayY: 'bottom', offsetY: -8 },
  ],
  before: [
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
  ],
  after: [
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
    { originX: 'start', originY: 'center', overlayX: 'end', overlayY: 'center', offsetX: -8 },
  ],
};


/** One overlay configuration for explicit and bridged tooltips. */
export function createTooltipOverlay(overlay: Overlay, positionBuilder: OverlayPositionBuilder,
  origin: HTMLElement | ElementRef<HTMLElement>, position: TooltipPosition,
  scrolling: 'close' | 'manual' = 'close'): OverlayRef {
  return overlay.create({
    positionStrategy: positionBuilder.flexibleConnectedTo(origin).withPositions(POSITIONS[position]).withPush(true),
    scrollStrategy: scrolling === 'manual' ? overlay.scrollStrategies.noop() : overlay.scrollStrategies.close(),
    hasBackdrop: false,
    panelClass: 'aio-tooltip-panel', disposeOnNavigation: true,
  });
}
