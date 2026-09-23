/**
 * The operator's `browserSecretObservationProtectionEnabled` value as stamped
 * onto extension command payloads. Kept free of other gateway imports so the
 * extension command store can stamp EVERY command it queues without an import
 * cycle through browser-secret-observation-protection.ts.
 *
 * The extension applies the stamped value before it runs any command, and a
 * `false` clears its stored taints. A command sent without the stamp leaves the
 * extension on whatever it last stored, which is how a switched-off setting
 * could still leave an origin unreadable.
 */

export const SECRET_OBSERVATION_PROTECTION_PAYLOAD_KEY = 'secretObservationProtectionEnabled';

/**
 * Default ON once a reader is bound. Unbound (unit tests that never start the
 * gateway) leaves payloads untouched so existing command assertions stay exact.
 */
let readEnabled: () => boolean = () => true;
let readerBound = false;

export function isSecretObservationProtectionEnabled(): boolean {
  try {
    return readEnabled() !== false;
  } catch {
    return true;
  }
}

export function stampSecretObservationProtection(
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!readerBound) {
    return payload;
  }
  return {
    ...(payload ?? {}),
    [SECRET_OBSERVATION_PROTECTION_PAYLOAD_KEY]: isSecretObservationProtectionEnabled(),
  };
}

export function bindSecretObservationProtectionReader(reader: () => boolean): void {
  readEnabled = reader;
  readerBound = true;
}

export function resetSecretObservationStampForTesting(): void {
  readEnabled = () => true;
  readerBound = false;
}
