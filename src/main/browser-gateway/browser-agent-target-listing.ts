/**
 * Compact tab listing for agents (A19, Step 9c / backlog 19.3).
 *
 * `browser.list_targets` results carry every registry field (ids, driver and
 * window bookkeeping, timestamps) — about 40% more text than an agent needs
 * to act on a tab. Close tools only need `profileId` and `targetId`; the
 * fields an agent reads for context (title, url, origin, state) stay, cut to
 * readable lengths. The array shape is unchanged. Harness's own screen uses
 * the full listing and is unaffected — this projection runs only on the
 * agent RPC path.
 */

import type { BrowserGatewayResult, BrowserHttpAuthChallenge } from '@contracts/types/browser';

const TITLE_MAX_CHARS = 120;
const URL_MAX_CHARS = 300;

/** The fields an agent gets per tab; everything else is dropped. */
export interface CompactAgentTarget {
  targetId: string;
  profileId?: string;
  title?: string;
  url?: string;
  origin?: string;
  mode?: string;
  status?: string;
  inspectionState?: string;
  active?: boolean;
  stale?: boolean;
  nodeName?: string;
  textUnavailableReason?: string;
  /** Chrome's own sign-in prompt waiting on this tab; agent guidance names it. */
  httpAuthChallenge?: BrowserHttpAuthChallenge;
  reboundFromTargetId?: string;
}

type ListingResult = BrowserGatewayResult<object[]>;

function cut(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function pickField(source: Record<string, unknown>, key: string): unknown {
  return source[key];
}

function compactTarget(target: object): CompactAgentTarget {
  const source = target as Record<string, unknown>;
  const title = cut(pickField(source, 'title'), TITLE_MAX_CHARS);
  const url = cut(pickField(source, 'url'), URL_MAX_CHARS);
  const httpAuthChallenge = pickField(source, 'httpAuthChallenge');
  return {
    targetId: String(pickField(source, 'targetId') ?? pickField(source, 'id') ?? ''),
    ...(pickField(source, 'profileId') !== undefined ? { profileId: String(pickField(source, 'profileId')) } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(pickField(source, 'origin') !== undefined ? { origin: String(pickField(source, 'origin')) } : {}),
    ...(pickField(source, 'mode') !== undefined ? { mode: String(pickField(source, 'mode')) } : {}),
    ...(pickField(source, 'status') !== undefined ? { status: String(pickField(source, 'status')) } : {}),
    ...(pickField(source, 'inspectionState') !== undefined ? { inspectionState: String(pickField(source, 'inspectionState')) } : {}),
    ...(pickField(source, 'active') !== undefined ? { active: Boolean(pickField(source, 'active')) } : {}),
    ...(pickField(source, 'stale') !== undefined ? { stale: Boolean(pickField(source, 'stale')) } : {}),
    ...(pickField(source, 'nodeName') !== undefined ? { nodeName: String(pickField(source, 'nodeName')) } : {}),
    ...(pickField(source, 'textUnavailableReason') !== undefined ? { textUnavailableReason: String(pickField(source, 'textUnavailableReason')) } : {}),
    ...(typeof httpAuthChallenge === 'object' && httpAuthChallenge !== null
      ? { httpAuthChallenge: httpAuthChallenge as BrowserHttpAuthChallenge }
      : {}),
    ...(pickField(source, 'reboundFromTargetId') !== undefined ? { reboundFromTargetId: String(pickField(source, 'reboundFromTargetId')) } : {}),
  };
}

/**
 * Project an agent-facing `browser.list_targets` result onto the compact
 * listing. A denied/empty listing (no `data`) is returned unchanged.
 */
export function compactAgentTargetListing(
  result: unknown,
): BrowserGatewayResult<CompactAgentTarget[]> {
  const listing = result as ListingResult;
  if (!Array.isArray(listing.data)) return listing as BrowserGatewayResult<CompactAgentTarget[]>;
  return { ...listing, data: listing.data.map(compactTarget) };
}
