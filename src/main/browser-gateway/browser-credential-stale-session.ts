import type { BwCommandResult } from './browser-credential-vault';

/**
 * Does this failure look like the session we hold is no longer valid?
 *
 * Deliberately narrow. Retrying every failure would double the work on a genuine
 * error (a missing item, a malformed edit) and could repeat a mutation. These
 * are the messages the Bitwarden CLI emits when the session key it was handed is
 * rejected, matched case-insensitively.
 *
 * Command output is inspected but never logged or returned: a failed command
 * can echo an encoded item body containing a password. Stdout is scanned only
 * when it is not valid JSON so ordinary item bodies cannot trigger recovery.
 */
export function isStaleSessionFailure(result: BwCommandResult): boolean {
  if (containsStaleSessionSignal(result.stderr)) {
    return true;
  }
  const stdout = result.stdout.trim();
  return stdout !== '' && !isJsonText(stdout) && containsStaleSessionSignal(stdout);
}

function containsStaleSessionSignal(value: string): boolean {
  const text = value.toLowerCase();
  return (
    text.includes('not logged in')
    || text.includes('vault is locked')
    || text.includes('session key is invalid')
    || text.includes('invalid session')
    || text.includes('mac failed')
    || text.includes('master password: [input is hidden]')
    || text.includes('err_use_after_close')
  );
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
