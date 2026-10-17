import type { CliAdapter } from '../cli/adapters/adapter-factory';

/** Clone through the live source adapter only when its current runtime supports it. */
export async function forkNativeAdapterSession(adapter: CliAdapter | undefined): Promise<string | undefined> {
  if (adapter?.getRuntimeCapabilities?.().supportsForkSession !== true
    || !('forkNativeSession' in adapter)
    || typeof adapter.forkNativeSession !== 'function') return undefined;
  return adapter.forkNativeSession();
}
