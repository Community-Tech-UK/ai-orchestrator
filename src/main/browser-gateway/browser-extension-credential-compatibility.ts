import { compareSemverVersions, parseSemver } from '../cli/semver';
import {
  type BrowserExtensionContactState,
  type BrowserExtensionContactStateReader,
  type BrowserExtensionRuntimeRecord,
} from './browser-extension-contact-state';

/** First extension bundle whose credential writes are origin-bound and taint-safe. */
export const BROWSER_EXTENSION_SECURE_CREDENTIAL_FILL_MIN_VERSION = '0.2.18';

/** Parse bounded runtime evidence from an authenticated extension RPC. */
export function browserExtensionRuntimeFromPayload(
  payload: Record<string, unknown>,
): BrowserExtensionRuntimeRecord {
  const extensionVersion = payload['extensionVersion'];
  const extensionStartedAt = payload['extensionStartedAt'];
  return {
    ...(typeof extensionVersion === 'string' && extensionVersion ? { extensionVersion } : {}),
    ...(typeof extensionStartedAt === 'number'
      && Number.isInteger(extensionStartedAt)
      && extensionStartedAt >= 0
      ? { extensionStartedAt }
      : {}),
  };
}

export function recordCompatibleBrowserExtensionRuntime(
  contactState: BrowserExtensionContactState,
  channelId: string,
  payload: Record<string, unknown>,
  onContact: (runtime: BrowserExtensionRuntimeRecord) => void,
): boolean {
  const runtime = browserExtensionRuntimeFromPayload(payload);
  contactState.markExtensionContact(channelId);
  contactState.markExtensionRuntime(channelId, runtime);
  onContact(runtime);
  return isSecureBrowserExtensionRuntimeEvidence(runtime)
    && supportsSecureBrowserExtensionCredentialFill(contactState, channelId);
}

export function browserExtensionCommandId(payload: Record<string, unknown>): string {
  const commandId = payload['commandId'];
  if (typeof commandId !== 'string' || !commandId) {
    throw new Error('Invalid browser gateway RPC payload');
  }
  return commandId;
}

export function withoutBrowserExtensionRuntimeEvidence(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const {
    extensionVersion: _extensionVersion,
    extensionStartedAt: _extensionStartedAt,
    ...content
  } = payload;
  return content;
}

/**
 * Fail-closed compatibility check for a specific local/remote extension
 * channel. A stale, missing, malformed, prerelease, or older runtime cannot be
 * trusted with a vault value. The check is repeated immediately before every
 * sensitive extension write; the earlier operation-level check prevents even
 * vault resolution when the loaded extension is already known to be unsafe.
 */
export function supportsSecureBrowserExtensionCredentialFill(
  contactState: BrowserExtensionContactStateReader,
  channelId: string,
): boolean {
  if (!contactState.isExtensionContactFresh(channelId)) {
    return false;
  }
  return isSecureBrowserExtensionRuntimeEvidence(
    contactState.getExtensionRuntime?.(channelId),
  );
}

/** Validate build evidence carried by one exact authenticated native poll. */
export function isSecureBrowserExtensionRuntimeEvidence(
  runtime: { extensionVersion?: string; extensionStartedAt?: number } | undefined,
): boolean {
  const extensionVersion = runtime?.extensionVersion;
  if (
    !extensionVersion
    || runtime.extensionStartedAt === undefined
    || !Number.isInteger(runtime.extensionStartedAt)
    || runtime.extensionStartedAt < 0
    || !parseSemver(extensionVersion)
  ) {
    return false;
  }
  return compareSemverVersions(
    extensionVersion,
    BROWSER_EXTENSION_SECURE_CREDENTIAL_FILL_MIN_VERSION,
  ) >= 0;
}

/**
 * The only accepted native response after a password/secret write. Exact-key
 * matching prevents a legacy page-derived response from being treated as a
 * trusted acknowledgement merely because it contains one familiar field.
 */
export function isExactSecureCredentialWriteCompletion(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2
    && Object.hasOwn(record, 'completed')
    && Object.hasOwn(record, 'observationBlocked')
    && record['completed'] === true
    && record['observationBlocked'] === 'browser_secret_observation_blocked_for_tainted_origin';
}

/** Convert a native write acknowledgement into the one trusted boolean shape. */
export function confirmBrowserExtensionCredentialWrite(
  value: unknown,
  protection: 'public' | 'password' | 'secret',
): true {
  if (protection === 'public') {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const keys = Object.keys(record);
    const exactPublicCompletion = keys.length === 1
      && Object.hasOwn(record, 'valueApplied')
      && record['valueApplied'] === true;
    // Once any sensitive value has tainted the origin, the extension replaces
    // every later response — including a public username write — with the same
    // fixed non-observing sentinel. Accept that exact shape without accepting
    // any page-derived fields or weakening sensitive-write confirmation.
    if (!exactPublicCompletion && !isExactSecureCredentialWriteCompletion(value)) {
      throw new Error('shared_tab_public_credential_write_not_confirmed');
    }
    return true;
  }
  if (!isExactSecureCredentialWriteCompletion(value)) {
    throw new Error('shared_tab_secure_credential_write_not_confirmed');
  }
  return true;
}
