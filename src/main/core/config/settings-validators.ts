import safeRegex from 'safe-regex2';
import { isIP } from 'net';
import type { AppSettings } from '../../../shared/types/settings.types';

export type ValidationResult<V> =
  | { ok: true; value: V }
  | { ok: false; error: string };

export type Validator<K extends keyof AppSettings> = (
  value: unknown
) => ValidationResult<AppSettings[K]>;

function asBoolean<K extends keyof AppSettings>(): Validator<K> {
  return (value) =>
    typeof value === 'boolean'
      ? { ok: true, value: value as AppSettings[K] }
      : { ok: false, error: `Expected boolean, got ${typeof value}` };
}

const validateRegexString: Validator<'pauseVpnInterfacePattern'> = (value) => {
  if (typeof value !== 'string') return { ok: false, error: 'Expected string' };
  if (value.length === 0 || value.length > 200) {
    return { ok: false, error: 'Length must be 1-200' };
  }

  try {
    new RegExp(value);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid regex: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!safeRegex(value)) {
    return { ok: false, error: 'Regex appears unsafe (catastrophic backtracking)' };
  }

  return { ok: true, value };
};

function isValidDnsHost(host: string): boolean {
  if (host.length < 1 || host.length > 253) return false;
  return host
    .split('.')
    .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}

function parseHostPort(value: string): { host: string; port: number } | null {
  if (value.startsWith('[')) {
    const closing = value.indexOf(']');
    if (closing <= 1 || value[closing + 1] !== ':') return null;
    const host = value.slice(1, closing);
    const port = Number(value.slice(closing + 2));
    return { host, port };
  }

  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) return null;
  if (value.slice(0, separator).includes(':')) return null;
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  return { host, port };
}

const validateHostPort: Validator<'pauseReachabilityProbeHost'> = (value) => {
  if (typeof value !== 'string') return { ok: false, error: 'Expected string' };
  if (value === '') return { ok: true, value: '' };

  const parsed = parseHostPort(value);
  if (!parsed) {
    return { ok: false, error: 'Expected host:port or [ipv6]:port' };
  }

  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    return { ok: false, error: `Port out of range: ${parsed.port}` };
  }

  if (!isValidDnsHost(parsed.host) && isIP(parsed.host) === 0) {
    return { ok: false, error: 'Invalid host' };
  }

  return { ok: true, value };
};

const validateProbeMode: Validator<'pauseReachabilityProbeMode'> = (value) => {
  if (
    value === 'disabled' ||
    value === 'reachable-means-vpn' ||
    value === 'unreachable-means-vpn'
  ) {
    return { ok: true, value };
  }
  return { ok: false, error: `Invalid mode: ${String(value)}` };
};

function validateIntInRange(
  min: number,
  max: number
): Validator<'pauseReachabilityProbeIntervalSec'> {
  return (value) => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return { ok: false, error: 'Expected integer' };
    }
    if (value < min || value > max) return { ok: false, error: `Out of range ${min}-${max}` };
    return { ok: true, value };
  };
}

export const PAUSE_SETTING_VALIDATORS: Partial<{
  [K in keyof AppSettings]: Validator<K>;
}> = {
  pauseFeatureEnabled: asBoolean<'pauseFeatureEnabled'>(),
  pauseOnVpnEnabled: asBoolean<'pauseOnVpnEnabled'>(),
  pauseTreatExistingVpnAsActive: asBoolean<'pauseTreatExistingVpnAsActive'>(),
  pauseDetectorDiagnostics: asBoolean<'pauseDetectorDiagnostics'>(),
  pauseAllowPrivateRanges: asBoolean<'pauseAllowPrivateRanges'>(),
  pauseVpnInterfacePattern: validateRegexString,
  pauseReachabilityProbeHost: validateHostPort,
  pauseReachabilityProbeMode: validateProbeMode,
  pauseReachabilityProbeIntervalSec: validateIntInRange(10, 600),
};
