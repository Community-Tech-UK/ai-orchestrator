/**
 * @ai-orchestrator/sdk
 *
 * Public SDK for external tools, plugins, and providers.
 *
 * Internal app code should import explicit subpaths (`@sdk/provider-adapter`,
 * `@sdk/plugins`, etc.) so tree-shaking and runtime alias checks stay precise.
 */

export * from './tools';
export * from './plugins';
export * from './providers';
export * from './provider-adapter';
export * from './provider-adapter-registry';
