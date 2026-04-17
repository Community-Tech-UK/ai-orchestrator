/**
 * @ai-orchestrator/contracts — subpath-only module
 *
 * This file intentionally exports nothing. Consumers must import via
 * subpaths declared in package.json `exports`:
 *
 *   import { InstanceStatusSchema } from '@ai-orchestrator/contracts/schemas/instance';
 *   import { INSTANCE_CHANNELS }    from '@ai-orchestrator/contracts/channels/instance';
 *
 * The package-level barrel was removed in Wave 1 (2026-04-17) to
 * prevent circular deps, force tree-shaking, and keep imports grep-able.
 * See docs/superpowers/specs/2026-04-16-ai-orchestrator-cross-repo-improvements-design.md
 * Item 10 for rationale.
 */
export {};
