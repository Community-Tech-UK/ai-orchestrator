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
