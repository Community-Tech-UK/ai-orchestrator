export type BrowserRendererState = 'healthy' | 'wedged' | 'unknown';

export interface BrowserTargetLiveness {
  renderer: BrowserRendererState;
  clockText?: string;
  clockAgeSeconds?: number;
  suggestedAction?: 'browser.reload';
}

export interface BrowserTargetLivenessInput {
  text?: string;
  now?: Date;
  managedRendererWedged?: boolean;
}

const JAGGAER_CLOCK_PATTERN = /(?:^|[^0-9])((\d{2}):(\d{2}) Greenwich Mean Time(?:(?: DST)(?![A-Za-z])|(?! DST)))(?![A-Za-z])/;
export const BROWSER_CLOCK_STALE_THRESHOLD_SECONDS = 180;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Classify one browser target from only explicit liveness evidence. The page
 * clock matcher is deliberately narrow: generic dates/times are content, not
 * proof that a renderer is advancing.
 */
export function classifyBrowserTargetLiveness(
  input: BrowserTargetLivenessInput,
): BrowserTargetLiveness {
  const match = JAGGAER_CLOCK_PATTERN.exec(input.text ?? '');
  const clockText = match?.[1];
  const parsedHour = match ? Number.parseInt(match[2], 10) : -1;
  const parsedMinute = match ? Number.parseInt(match[3], 10) : -1;
  const validClock = Boolean(
    clockText && parsedHour >= 0 && parsedHour <= 23 && parsedMinute >= 0 && parsedMinute <= 59,
  );

  if (!validClock) {
    return input.managedRendererWedged
      ? { renderer: 'wedged', suggestedAction: 'browser.reload' }
      : { renderer: 'unknown' };
  }

  const now = input.now ?? new Date();
  const dstOffsetSeconds = clockText!.endsWith(' DST') ? 60 * 60 : 0;
  const displayedSeconds = (parsedHour * 60 + parsedMinute) * 60;
  const currentSeconds = (
    (now.getUTCHours() * 60 + now.getUTCMinutes()) * 60
    + now.getUTCSeconds()
    + dstOffsetSeconds
  ) % SECONDS_PER_DAY;
  const directDistance = Math.abs(currentSeconds - displayedSeconds);
  const clockAgeSeconds = Math.min(directDistance, SECONDS_PER_DAY - directDistance);
  const wedged = input.managedRendererWedged
    || clockAgeSeconds > BROWSER_CLOCK_STALE_THRESHOLD_SECONDS;

  return {
    renderer: wedged ? 'wedged' : 'healthy',
    clockText,
    clockAgeSeconds,
    ...(wedged ? { suggestedAction: 'browser.reload' as const } : {}),
  };
}

export function aggregateBrowserRendererState(
  targets: readonly Pick<BrowserTargetLiveness, 'renderer'>[],
): BrowserRendererState {
  if (targets.some((target) => target.renderer === 'wedged')) {
    return 'wedged';
  }
  if (targets.some((target) => target.renderer === 'healthy')) {
    return 'healthy';
  }
  return 'unknown';
}

export function withBrowserSnapshotLiveness<T extends { text: string }>(
  result: BrowserGatewayResult<T | null>,
  managedRendererWedged: boolean,
): BrowserGatewayResult<(T & BrowserTargetLiveness) | null> {
  if (!result.data) {
    return result as BrowserGatewayResult<(T & BrowserTargetLiveness) | null>;
  }
  const liveness = classifyBrowserTargetLiveness({
    text: result.data.text,
    managedRendererWedged,
  });
  return { ...result, data: { ...result.data, ...liveness } };
}
import type { BrowserGatewayResult } from '@contracts/types/browser';
