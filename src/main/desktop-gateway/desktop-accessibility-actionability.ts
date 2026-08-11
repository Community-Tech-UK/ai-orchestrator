import type {
  DesktopAccessibilityNode,
  DesktopAppDescriptor,
  DesktopRegion,
} from '../../shared/types/desktop-gateway.types';
import { desktopWindowIdsMatch } from './desktop-window-identity';

export function annotateInputEligibility(
  nodes: DesktopAccessibilityNode[],
  windowBounds: DesktopRegion,
): DesktopAccessibilityNode[] {
  return nodes.map((node) => annotateNode(node, windowBounds));
}

export function findApprovedWindowBounds(
  app: DesktopAppDescriptor,
  windowId: string | undefined,
): DesktopRegion | undefined {
  if (!windowId) {
    return undefined;
  }
  return app.windows?.find((window) =>
    desktopWindowIdsMatch(window.windowId, windowId))?.bounds;
}

function annotateNode(
  node: DesktopAccessibilityNode,
  windowBounds: DesktopRegion,
): DesktopAccessibilityNode {
  return {
    ...node,
    ...(node.bounds ? { inputEligible: centreIsInside(node.bounds, windowBounds) } : {}),
    ...(node.children
      ? { children: node.children.map((child) => annotateNode(child, windowBounds)) }
      : {}),
  };
}

function centreIsInside(bounds: DesktopRegion, windowBounds: DesktopRegion): boolean {
  const centreX = bounds.x + bounds.width / 2;
  const centreY = bounds.y + bounds.height / 2;
  return centreX >= windowBounds.x
    && centreX <= windowBounds.x + windowBounds.width
    && centreY >= windowBounds.y
    && centreY <= windowBounds.y + windowBounds.height;
}
