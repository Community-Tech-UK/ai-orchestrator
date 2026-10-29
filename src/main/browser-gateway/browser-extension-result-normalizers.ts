import type { BrowserDownloadFileResult } from '@contracts/types/browser';
import {
  BrowserDialogTypeSchema,
  type BrowserFocusInfo,
  type BrowserHandleDialogResult,
  type BrowserPressKeyResult,
  type BrowserSetViewportResult,
  type BrowserSetZoomResult,
} from '@contracts/schemas/browser';
import { redactBrowserText, redactBrowserUrl } from './browser-redaction';

export function extractScreenshotBase64(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  const value = (result as Record<string, unknown>)['screenshotBase64'];
  if (typeof value !== 'string' || !value) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  // CDP returns raw base64; tolerate older extension data URLs as well.
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').slice(0, 2_000_000);
}

export function normalizeDownloadFileResult(result: unknown): BrowserDownloadFileResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_download_result_invalid');
  }
  const value = result as Record<string, unknown>;
  const download: BrowserDownloadFileResult = {};
  if (typeof value['id'] === 'number' || typeof value['id'] === 'string') {
    download.id = value['id'];
  }
  if (typeof value['url'] === 'string') {
    download.url = value['url'];
  }
  if (typeof value['finalUrl'] === 'string') {
    download.finalUrl = value['finalUrl'];
  }
  if (typeof value['filename'] === 'string') {
    download.filename = value['filename'];
  }
  if (typeof value['mime'] === 'string') {
    download.mime = value['mime'];
  }
  if (typeof value['bytesReceived'] === 'number') {
    download.bytesReceived = value['bytesReceived'];
  }
  if (typeof value['totalBytes'] === 'number') {
    download.totalBytes = value['totalBytes'];
  }
  if (typeof value['state'] === 'string') {
    download.state = value['state'];
  }
  if (typeof value['startedAt'] === 'string') {
    download.startedAt = value['startedAt'];
  }
  if (typeof value['endedAt'] === 'string') {
    download.endedAt = value['endedAt'];
  }
  if (!download.filename && !download.url) {
    throw new Error('browser_download_result_invalid');
  }
  return download;
}

function stringField(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function numberField(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Validate the extension's press_key result. A result without `applied` or
 * `deduplicated` is a failure — a key press must never report success without
 * positive evidence from the executing side. Focus text/href and page url/
 * title are page-controlled strings: bounded and redacted here. Field VALUES
 * are never requested or carried.
 */
export function normalizePressKeyResult(result: unknown): BrowserPressKeyResult {
  const value = recordField(result);
  const applied = value?.['applied'] === true;
  const deduplicated = value?.['deduplicated'] === true;
  if (!applied && !deduplicated) {
    throw new Error('browser_extension_press_key_result_invalid');
  }
  const key = stringField(value?.['key'], 40);
  if (!key) {
    throw new Error('browser_extension_press_key_result_invalid');
  }
  const modifiers = Array.isArray(value?.['modifiers'])
    ? (value['modifiers'] as unknown[])
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 3)
    : [];
  const focusRaw = recordField(value?.['focus']);
  const focus: BrowserFocusInfo | undefined = focusRaw
    ? {
      ...(stringField(focusRaw['tagName'], 120) ? { tagName: stringField(focusRaw['tagName'], 120)! } : {}),
      ...(stringField(focusRaw['role'], 120) ? { role: stringField(focusRaw['role'], 120)! } : {}),
      ...(stringField(focusRaw['id'], 200) ? { id: stringField(focusRaw['id'], 200)! } : {}),
      ...(stringField(focusRaw['name'], 200) ? { name: stringField(focusRaw['name'], 200)! } : {}),
      ...(stringField(focusRaw['type'], 120) ? { type: stringField(focusRaw['type'], 120)! } : {}),
      ...(stringField(focusRaw['ariaLabel'], 500)
        ? { ariaLabel: redactBrowserText(stringField(focusRaw['ariaLabel'], 500)!) }
        : {}),
      ...(stringField(focusRaw['text'], 300)
        ? { text: redactBrowserText(stringField(focusRaw['text'], 300)!) }
        : {}),
      ...(stringField(focusRaw['href'], 2000)
        ? { href: redactBrowserUrl(stringField(focusRaw['href'], 2000)!) }
        : {}),
      ...(typeof focusRaw['editable'] === 'boolean' ? { editable: focusRaw['editable'] } : {}),
    }
    : undefined;
  return {
    applied,
    key: key as BrowserPressKeyResult['key'],
    modifiers: modifiers as BrowserPressKeyResult['modifiers'],
    ...(deduplicated ? { deduplicated: true } : {}),
    ...(focus ? { focus } : {}),
    ...(stringField(value?.['url'], 2000)
      ? { url: redactBrowserUrl(stringField(value['url'], 2000)!) }
      : {}),
    ...(stringField(value?.['title'], 500)
      ? { title: redactBrowserText(stringField(value['title'], 500)!) }
      : {}),
  };
}

export function normalizeSetViewportResult(result: unknown): BrowserSetViewportResult {
  const value = recordField(result);
  const mode = stringField(value?.['mode'], 30);
  if (
    !value
    || !mode
    || !['tab_emulation', 'window_resize', 'reset', 'read'].includes(mode)
  ) {
    throw new Error('browser_extension_set_viewport_result_invalid');
  }
  const actualRaw = recordField(value['actual']);
  const innerWidth = numberField(actualRaw?.['innerWidth'], 0, 20_000);
  const innerHeight = numberField(actualRaw?.['innerHeight'], 0, 20_000);
  if (innerWidth === undefined || innerHeight === undefined) {
    throw new Error('browser_extension_set_viewport_result_invalid');
  }
  const scope: BrowserSetViewportResult['scope'] = value['scope'] === 'window' ? 'window' : 'tab';
  const requestedRaw = recordField(value['requested']);
  const requestedWidth = numberField(requestedRaw?.['width'], 0, 20_000);
  const requestedHeight = numberField(requestedRaw?.['height'], 0, 20_000);
  const emulationRaw = recordField(value['emulation']);
  const windowRaw = recordField(value['window']);
  const previousRaw = recordField(value['previous']);
  const boundsRaw = recordField(windowRaw?.['bounds']);
  const prevBoundsRaw = recordField(previousRaw?.['windowBounds']);
  const normalizeBounds = (raw: Record<string, unknown> | undefined) => {
    const left = numberField(raw?.['left'], -20_000, 20_000);
    const top = numberField(raw?.['top'], -20_000, 20_000);
    const width = numberField(raw?.['width'], 0, 20_000);
    const height = numberField(raw?.['height'], 0, 20_000);
    return left === undefined || top === undefined || width === undefined || height === undefined
      ? undefined
      : { left, top, width, height };
  };
  const bounds = normalizeBounds(boundsRaw);
  const windowId = numberField(windowRaw?.['windowId'], 0, Number.MAX_SAFE_INTEGER);
  return {
    mode: mode as BrowserSetViewportResult['mode'],
    scope,
    ...(requestedWidth !== undefined && requestedHeight !== undefined
      ? { requested: { width: requestedWidth, height: requestedHeight } }
      : {}),
    actual: { innerWidth, innerHeight },
    ...(emulationRaw
      ? {
        emulation: {
          width: numberField(emulationRaw['width'], 0, 20_000) ?? 0,
          height: numberField(emulationRaw['height'], 0, 20_000) ?? 0,
          deviceScaleFactor: numberField(emulationRaw['deviceScaleFactor'], 0, 10) ?? 0,
        },
      }
      : {}),
    ...(windowRaw && windowId !== undefined && bounds
      ? {
        window: {
          windowId,
          otherTabIds: Array.isArray(windowRaw['otherTabIds'])
            ? (windowRaw['otherTabIds'] as unknown[])
              .filter((entry): entry is number => Number.isInteger(entry))
              .slice(0, 200)
            : [],
          bounds,
        },
      }
      : {}),
    ...(previousRaw
      ? {
        previous: {
          emulationActive: previousRaw['emulationActive'] === true,
          ...(numberField(previousRaw['emulationWidth'], 0, 20_000) !== undefined
            ? { emulationWidth: numberField(previousRaw['emulationWidth'], 0, 20_000)! }
            : {}),
          ...(numberField(previousRaw['emulationHeight'], 0, 20_000) !== undefined
            ? { emulationHeight: numberField(previousRaw['emulationHeight'], 0, 20_000)! }
            : {}),
          ...(normalizeBounds(prevBoundsRaw) ? { windowBounds: normalizeBounds(prevBoundsRaw)! } : {}),
        },
      }
      : {}),
    ...(stringField(value['restorationFailed'], 500)
      ? { restorationFailed: stringField(value['restorationFailed'], 500)! }
      : {}),
  };
}

export function normalizeSetZoomResult(result: unknown): BrowserSetZoomResult {
  const value = recordField(result);
  const mode = stringField(value?.['mode'], 30);
  const zoomFactor = numberField(value?.['zoomFactor'], 0, 10);
  if (!value || !mode || !['set', 'read', 'reset'].includes(mode) || zoomFactor === undefined) {
    throw new Error('browser_extension_set_zoom_result_invalid');
  }
  const viewportRaw = recordField(value['viewport']);
  const innerWidth = numberField(viewportRaw?.['innerWidth'], 0, 20_000);
  const innerHeight = numberField(viewportRaw?.['innerHeight'], 0, 20_000);
  if (innerWidth === undefined || innerHeight === undefined) {
    throw new Error('browser_extension_set_zoom_result_invalid');
  }
  return {
    mode: mode as BrowserSetZoomResult['mode'],
    zoomFactor,
    zoomPercent: numberField(value['zoomPercent'], 0, 1000) ?? Math.round(zoomFactor * 100),
    ...(numberField(value['previousZoomFactor'], 0, 10) !== undefined
      ? { previousZoomFactor: numberField(value['previousZoomFactor'], 0, 10)! }
      : {}),
    ...(stringField(value['zoomScope'], 60) ? { zoomScope: stringField(value['zoomScope'], 60)! } : {}),
    ...(stringField(value['previousZoomScope'], 60)
      ? { previousZoomScope: stringField(value['previousZoomScope'], 60)! }
      : {}),
    viewport: { innerWidth, innerHeight },
    ...(stringField(value['restorationFailed'], 500)
      ? { restorationFailed: stringField(value['restorationFailed'], 500)! }
      : {}),
  };
}

/**
 * Validate the extension's handle_dialog result against what was asked. On a
 * secret-filled tab the extension replaces every result with its fixed
 * `completed` marker: the answer went through and its details are withheld.
 */
export function normalizeHandleDialogResult(
  result: unknown,
  accept: boolean,
): BrowserHandleDialogResult {
  const value = recordField(result);
  if (value?.['completed'] === true) {
    return { handled: true, accepted: accept };
  }
  if (value?.['handled'] !== true || value['accepted'] !== accept) {
    throw new Error('browser_extension_handle_dialog_result_invalid');
  }
  const dialogType = BrowserDialogTypeSchema.safeParse(value['dialogType']);
  return {
    handled: true,
    accepted: accept,
    ...(dialogType.success ? { dialogType: dialogType.data } : {}),
  };
}
