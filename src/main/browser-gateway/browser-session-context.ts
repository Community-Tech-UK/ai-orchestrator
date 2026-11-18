import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

// User-data directories separate Harnesses on one computer; the hostname
// separates the same directory layout on two computers. Keep this stable over
// a Harness restart so a restored session can still use its Chrome tabs.
const ownerContext = new AsyncLocalStorage<string>();

export function withBrowserSession<T>(userDataPath: string, instanceId: string, work: () => T): T {
  const owner = createHash('sha256').update(hostname()).update('\0').update(resolve(userDataPath))
    .update('\0').update(instanceId).digest('hex');
  return ownerContext.run(owner, work);
}

export function currentBrowserSessionOwner(): string | undefined {
  return ownerContext.getStore();
}

let sessionUserDataPath: (() => string) | undefined;

/** Set once at startup to the same user-data path the RPC server stamps owners with. */
export function setBrowserSessionUserDataPathProvider(provider: (() => string) | undefined): void {
  sessionUserDataPath = provider;
}

/**
 * Run Harness-initiated work (not an RPC call) as one session's browser owner,
 * so the extension treats it as that session's own command on a tab the
 * session holds. Without a provider (unit tests) the work runs owner-less.
 */
export function withBrowserSessionOfInstance<T>(instanceId: string, work: () => T): T {
  return sessionUserDataPath ? withBrowserSession(sessionUserDataPath(), instanceId, work) : work();
}
