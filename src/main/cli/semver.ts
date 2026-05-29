/**
 * Dependency-free semver comparison, ported from t3code
 * (`packages/shared/src/semver.ts`). Used by the CLI update poller to decide
 * whether an installed CLI is behind the latest published version.
 *
 * Tolerant by design: handles a leading `v`, two-segment versions (`1.2` →
 * `1.2.0`), and prerelease ordering. When either side cannot be parsed as
 * semver it falls back to `localeCompare` so callers always get a total order.
 */

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly string[];
}

const SEMVER_NUMBER_SEGMENT = /^\d+$/;

export function normalizeSemverVersion(version: string): string {
  const [main, prerelease] = version.trim().split('-', 2);
  const segments = (main ?? '')
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 2) {
    segments.push('0');
  }

  return prerelease ? `${segments.join('.')}-${prerelease}` : segments.join('.');
}

export function parseSemver(value: string): ParsedSemver | null {
  const normalized = normalizeSemverVersion(value).replace(/^v/, '');
  const [main = '', prerelease] = normalized.split('-', 2);
  const segments = main.split('.');
  if (segments.length !== 3) {
    return null;
  }

  const [majorSegment, minorSegment, patchSegment] = segments;
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null;
  }
  if (
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null;
  }

  const major = Number.parseInt(majorSegment, 10);
  const minor = Number.parseInt(minorSegment, 10);
  const patch = Number.parseInt(patchSegment, 10);
  if (![major, minor, patch].every(Number.isInteger)) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease:
      prerelease
        ?.split('.')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0) ?? [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = SEMVER_NUMBER_SEGMENT.test(left);
  const rightNumeric = SEMVER_NUMBER_SEGMENT.test(right);

  if (leftNumeric && rightNumeric) {
    return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  }
  if (leftNumeric) {
    return -1;
  }
  if (rightNumeric) {
    return 1;
  }
  return left.localeCompare(right);
}

/**
 * Returns a negative number when `left` is an older version than `right`,
 * zero when they are equal, and a positive number when `left` is newer.
 */
export function compareSemverVersions(left: string, right: string): number {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);
  if (!parsedLeft || !parsedRight) {
    return left.localeCompare(right);
  }

  if (parsedLeft.major !== parsedRight.major) {
    return parsedLeft.major - parsedRight.major;
  }
  if (parsedLeft.minor !== parsedRight.minor) {
    return parsedLeft.minor - parsedRight.minor;
  }
  if (parsedLeft.patch !== parsedRight.patch) {
    return parsedLeft.patch - parsedRight.patch;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) {
    return 0;
  }
  // A version with no prerelease tag (1.0.0) is newer than one with a
  // prerelease tag (1.0.0-beta), per the semver spec.
  if (parsedLeft.prerelease.length === 0) {
    return 1;
  }
  if (parsedRight.prerelease.length === 0) {
    return -1;
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifier(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

/**
 * Whether `latestVersion` is strictly newer than `currentVersion`. Returns
 * false unless both versions are known — an unknown latest (registry
 * unreachable, or a provider with no registry source) must never be reported
 * as an available update. Shared by the update poller and the CLI Health
 * diagnosis so both decide "update available" identically.
 */
export function isUpdateAvailable(
  currentVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): boolean {
  return Boolean(
    currentVersion && latestVersion && compareSemverVersions(currentVersion, latestVersion) < 0,
  );
}
