#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { indexMaximum, reservationAuthority, reserveIdentifier } from './lib/lt-id-reservation.mjs';

try {
  const args = process.argv.slice(2);
  const reserve = args[0] === '--reserve';
  if (reserve) args.shift();
  if (args.length > 1 || args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: next-lt-id.mjs [--reserve] [register-path]');
  }
  if (reserve) {
    const authority = reservationAuthority(process.cwd());
    if (args[0] && realpathSync(resolve(args[0])) !== authority.register) {
      throw new Error(`Reservations must use the authoritative root register: ${authority.register}`);
    }
    console.log(reserveIdentifier(authority));
  } else {
    // Retained read-only interface for diagnostics and callers inspecting a supplied register.
    const register = args[0] ?? fileURLToPath(new URL('../docs/plans/livetest-remediation-register.md', import.meta.url));
    console.log(`LT-${String(indexMaximum(readFileSync(register, 'utf8')) + 1n).padStart(3, '0')}`);
  }
} catch (error) {
  console.error(`next-lt-id: ${error.message}`);
  process.exitCode = 1;
}
