/**
 * Electron desktopCapturer ids use `window:<CGWindowID>:<displayIndex>`, while
 * the macOS helper uses the decimal CGWindowID. Treat only those proven forms
 * as equivalent; arbitrary platform ids still require literal equality.
 */
export function desktopWindowIdsMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftCgWindowId = cgWindowId(left);
  const rightCgWindowId = cgWindowId(right);
  return leftCgWindowId !== null
    && rightCgWindowId !== null
    && leftCgWindowId === rightCgWindowId;
}

export function normalizeDesktopWindowId(
  actualWindowId: string | undefined,
  expectedWindowId: string | undefined,
): string | undefined {
  return actualWindowId
    && expectedWindowId
    && desktopWindowIdsMatch(actualWindowId, expectedWindowId)
    ? expectedWindowId
    : actualWindowId;
}

function cgWindowId(windowId: string): string | null {
  if (/^\d+$/u.test(windowId)) {
    return windowId;
  }
  return /^window:(\d+):\d+$/u.exec(windowId)?.[1] ?? null;
}
