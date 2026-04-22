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
let initializedModules: BootstrapModule[] = [];

/** Register a bootstrap module. */
export function registerBootstrapModule(module: BootstrapModule): void {
  if (registry.some((registered) => registered.name === module.name)) {
    throw new Error(`Bootstrap module "${module.name}" already registered`);
  }
  registry.push(module);
}

/** Clear the registry between tests. */
export function resetBootstrapRegistryForTesting(): void {
  registry.length = 0;
  initializedModules = [];
}

/** Get all registered modules in dependency order. */
export function getBootstrapModules(): readonly BootstrapModule[] {
  return registry;
}

function resolveBootstrapModules(): BootstrapModule[] {
  if (registry.length <= 1) {
    return [...registry];
  }

  const modulesByName = new Map(registry.map((module) => [module.name, module]));
  const dependents = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const module of registry) {
    dependents.set(module.name, []);
    inDegree.set(module.name, 0);
  }

  for (const module of registry) {
    for (const dependency of module.dependencies ?? []) {
      if (!modulesByName.has(dependency)) {
        throw new Error(
          `Bootstrap module "${module.name}" depends on unknown module "${dependency}"`,
        );
      }
      dependents.get(dependency)?.push(module.name);
      inDegree.set(module.name, (inDegree.get(module.name) ?? 0) + 1);
    }
  }

  const ready = registry
    .filter((module) => (inDegree.get(module.name) ?? 0) === 0)
    .map((module) => module.name);
  const orderedNames: string[] = [];

  while (ready.length > 0) {
    const nextName = ready.shift();
    if (!nextName) {
      break;
    }

    orderedNames.push(nextName);
    for (const dependent of dependents.get(nextName) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
      }
    }
  }

  if (orderedNames.length !== registry.length) {
    throw new Error('Bootstrap module dependency cycle detected');
  }

  return orderedNames
    .map((name) => modulesByName.get(name))
    .filter((module): module is BootstrapModule => !!module);
}

/**
 * Run all registered bootstrap modules.
 * Returns list of failed non-critical modules.
 */
export async function bootstrapAll(): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  const modules = resolveBootstrapModules();
  initializedModules = [];

  for (const mod of modules) {
    try {
      logger.info(`Bootstrapping: ${mod.name} [${mod.domain}]`);
      await mod.init();
      initializedModules.push(mod);
      logger.info(`Bootstrapped: ${mod.name}`);
    } catch (error) {
      logger.error(
        `Bootstrap failed: ${mod.name}`,
        error instanceof Error ? error : undefined,
      );

      if (mod.failureMode === 'critical') {
        await teardownInitializedModules();
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
  await teardownInitializedModules();
}

async function teardownInitializedModules(): Promise<void> {
  for (const mod of [...initializedModules].reverse()) {
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
  initializedModules = [];
}
