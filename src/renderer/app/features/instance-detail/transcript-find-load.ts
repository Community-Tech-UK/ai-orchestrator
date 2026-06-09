export interface LoadOlderUntilFindMatchOptions {
  hasMatches: () => boolean;
  hasOlderMessages: () => boolean;
  loadOlderMessages: () => Promise<void>;
  afterLoad?: () => void | Promise<void>;
  maxLoads?: number;
}

export async function loadOlderUntilFindMatch(
  options: LoadOlderUntilFindMatchOptions,
): Promise<number> {
  const maxLoads = options.maxLoads ?? 50;
  let loads = 0;

  while (!options.hasMatches() && options.hasOlderMessages() && loads < maxLoads) {
    await options.loadOlderMessages();
    loads += 1;
    await options.afterLoad?.();
  }

  return loads;
}
