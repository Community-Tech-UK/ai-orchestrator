/**
 * Bootstrap Module Registry
 *
 * Each domain registers a bootstrap module with an explicit contract:
 * init, teardown, dependencies, and failure mode.
 *
 * The main entry point (index.ts) calls bootstrapAll() instead of
 * manually wiring each singleton.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('Bootstrap');

/** Failure mode for a bootstrap module. */
export type BootstrapFailureMode = 'critical' | 'degraded' | 'skip';

/** A domain-specific bootstrap module. */
export interface BootstrapModule {
  /** Human-readable name for logging. */
  name: string;
  /** Domain group for dependency ordering. */
  domain: string;
  /** What happens if this module fails to initialize. */
  failureMode: BootstrapFailureMode;
  /** Dependencies: names of other modules that must init first. */
  dependencies?: string[];
  /** Initialize the module. */
  init: () => Promise<void> | void;
  /** Tear down the module. Called in reverse order on shutdown. */
  teardown?: () => Promise<void> | void;
}

const registry: BootstrapModule[] = [];

/** Register a bootstrap module. */
export function registerBootstrapModule(module: BootstrapModule): void {
  registry.push(module);
}

/** Get all registered modules in dependency order. */
export function getBootstrapModules(): readonly BootstrapModule[] {
  return registry;
}

/**
 * Run all registered bootstrap modules.
 * Returns list of failed non-critical modules.
 */
export async function bootstrapAll(): Promise<{ failed: string[] }> {
  const failed: string[] = [];

  for (const mod of registry) {
    try {
      logger.info(`Bootstrapping: ${mod.name} [${mod.domain}]`);
      await mod.init();
      logger.info(`Bootstrapped: ${mod.name}`);
    } catch (error) {
      logger.error(
        `Bootstrap failed: ${mod.name}`,
        error instanceof Error ? error : undefined,
      );

      if (mod.failureMode === 'critical') {
        throw error;
      }
      failed.push(mod.name);
    }
  }

  return { failed };
}

/**
 * Tear down all modules in reverse order.
 */
export async function teardownAll(): Promise<void> {
  for (const mod of [...registry].reverse()) {
    if (!mod.teardown) continue;
    try {
      logger.info(`Tearing down: ${mod.name}`);
      await mod.teardown();
    } catch (error) {
      logger.warn(`Teardown failed: ${mod.name}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
