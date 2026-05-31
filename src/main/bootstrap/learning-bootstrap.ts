/**
 * Learning & Self-Improvement Domain Bootstrap
 *
 * Historically this eagerly instantiated the learning stack at startup, which
 * synchronously hydrated several persistence-backed singletons on the main
 * thread. Keep the bootstrap registration so the domain remains visible in
 * startup diagnostics, but defer singleton construction until first use.
 */

import { registerBootstrapModule } from './index';

export function registerLearningBootstrap(): void {
  registerBootstrapModule({
    name: 'Learning singletons',
    domain: 'learning',
    failureMode: 'degraded',
    init: () => undefined,
  });
}
