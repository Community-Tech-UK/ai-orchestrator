import { Bonjour } from 'bonjour-service';
import type { SubsystemLogger } from '../logging/logger';

/**
 * A Bonjour publisher whose response failures are reported, not thrown.
 *
 * bonjour-service's default error callback rethrows. It fires when the
 * responder cannot send an answer to an mDNS query, so a host that refuses
 * multicast (macOS without Local Network permission returns EHOSTUNREACH)
 * turned every query on the network into an uncaught main-process exception,
 * while the advertisement had already been logged as published.
 *
 * The warning is logged once per publisher instance: the failure repeats for
 * every query, but it has one cause and one fix.
 */
export function createPublishingBonjour(
  logger: Pick<SubsystemLogger, 'warn'>,
  purpose: string,
): Bonjour {
  let reported = false;
  return new Bonjour({}, (err: unknown) => {
    if (reported) return;
    reported = true;
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    logger.warn(`mDNS answer could not be sent; other machines cannot discover the ${purpose}`, {
      error: err instanceof Error ? err.message : String(err),
      ...(code ? { code } : {}),
      ...(code === 'EHOSTUNREACH'
        ? {
            hint: 'On macOS this means the app has no Local Network permission. Allow Harness under '
              + 'System Settings → Privacy & Security → Local Network.',
          }
        : {}),
    });
  });
}
