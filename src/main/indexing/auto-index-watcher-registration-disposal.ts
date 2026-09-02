import type { AutoIndexWatcherRegistration } from './codebase-indexing-auto.types';

export function disposeAutoIndexWatcherRegistrations(
  registrations: Map<number, Set<AutoIndexWatcherRegistration>>,
  inFlight: Set<AutoIndexWatcherRegistration>,
  onError: (error: unknown) => void,
  targetGeneration?: number,
): void {
  for (const [generation, generationRegistrations] of registrations) {
    if (targetGeneration !== undefined && generation !== targetGeneration) continue;
    for (const registration of generationRegistrations) {
      if (inFlight.has(registration)) continue;
      inFlight.add(registration);
      void registration.dispose().then(
        () => {
          inFlight.delete(registration);
          generationRegistrations.delete(registration);
          if (
            generationRegistrations.size === 0
            && registrations.get(generation) === generationRegistrations
          ) {
            registrations.delete(generation);
          }
        },
        (error: unknown) => {
          inFlight.delete(registration);
          onError(error);
        },
      );
    }
  }
}
