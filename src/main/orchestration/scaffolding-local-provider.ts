/**
 * Local-first scaffolding provider support (cost-routing Phase 3).
 *
 * Scaffolding gates (verify/review/non-synthesis debate) pass their full
 * context inline and require no tool use, so a strong local model behind the
 * text-only Ollama REST adapter can serve them at zero cloud cost.
 *
 * The only direct endpoint is localhost Ollama, gated on
 * `auxiliaryLlmUseLocalhostOllama`. Worker-local endpoints must stay behind the
 * authenticated worker RPC boundary; callers that need a worker auxiliary
 * model use `AuxiliaryLlmService` / `auxiliaryModel.generate` instead.
 *
 * Model selection: the first candidate endpoint that has the configured
 * `auxiliaryLlmQualityModel` wins; otherwise the endpoint holding the largest
 * installed model overall. No reachable endpoint with models → undefined, and
 * scaffolding falls through to the cloud CLI preference list.
 */

import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { resolveCliType } from '../cli/adapters/adapter-factory';
import type { CliType } from '../cli/cli-detection';
// Type-only import: erased at runtime, so no require cycle with default-invokers.
import type { RoutingIntent } from './default-invokers';

const logger = getLogger('ScaffoldingLocalProvider');

/**
 * Provider preference for scaffolding/workflow gates steered off Claude.
 * Ollama leads (zero cloud cost) but is only eligible for the 'scaffolding'
 * intent and only when a reachable server has an installed model; the cloud
 * CLIs take over otherwise. The Ollama adapter is REST-only, so no local
 * `ollama` binary is required — eligibility comes from the endpoint probe.
 */
const SCAFFOLDING_PROVIDER_PREFERENCE: readonly CliType[] = [
  'ollama',
  'gemini',
  'codex',
  'copilot',
  'cursor',
];

type DefaultCliSetting = NonNullable<Parameters<typeof resolveCliType>[1]>;

export interface ScaffoldingProviderChoice {
  provider: CliType;
  /** Concrete model to spawn with, for providers whose model cannot come from
   *  the tier map (ollama: whatever is actually installed locally). */
  model?: string;
  /** Direct server endpoint for REST-only providers (localhost only). */
  endpoint?: { host: string; port: number };
}

/**
 * Pick the provider (and, for ollama, the concrete model + endpoint) that a
 * scaffolding/workflow gate should spawn instead of Claude.
 */
export async function resolveScaffoldingProvider(
  defaultCli: DefaultCliSetting,
  routingIntent?: RoutingIntent,
): Promise<ScaffoldingProviderChoice | undefined> {
  for (const provider of SCAFFOLDING_PROVIDER_PREFERENCE) {
    if (provider === 'ollama') {
      // Text-only adapter: eligible for inline-context scaffolding gates only,
      // never for caller-authored workflow steps that may need tool use.
      if (routingIntent !== 'scaffolding') continue;
      const target = await resolveOllamaScaffoldingTarget();
      if (!target) continue;
      logger.info('Scaffolding routed to local Ollama', {
        model: target.model,
        origin: target.origin,
      });
      return {
        provider,
        model: target.model,
        endpoint: { host: target.host, port: target.port },
      };
    }
    const resolved = await resolveCliType(provider, defaultCli);
    if (resolved === provider) return { provider };
  }
  return undefined;
}

const LOCALHOST = '127.0.0.1';
const DEFAULT_OLLAMA_PORT = 11434;
const TAGS_TIMEOUT_MS = 2000;

export interface OllamaScaffoldingTarget {
  /** Concrete installed model id to spawn with. */
  model: string;
  /** Ollama server host to dial (localhost only). */
  host: string;
  port: number;
  /** Human-readable origin for logs ('this-device' or the node name). */
  origin: string;
}

interface OllamaTagsResponse {
  models?: ({ name?: unknown; size?: unknown } | null | undefined)[];
}

interface InstalledModel {
  name: string;
  size: number;
}

interface ProbedEndpoint {
  host: string;
  port: number;
  origin: string;
  models: InstalledModel[];
}

/**
 * Pick the local Ollama endpoint + model scaffolding should spawn with, or
 * undefined when nothing local is reachable (callers then fall through to the
 * cloud CLI preference list). Fail-soft: never throws.
 */
export async function resolveOllamaScaffoldingTarget(): Promise<OllamaScaffoldingTarget | undefined> {
  const candidates = collectCandidateEndpoints();
  if (candidates.length === 0) return undefined;

  const probed: ProbedEndpoint[] = [];
  for (const candidate of candidates) {
    const models = await listInstalledModels(candidate.host, candidate.port);
    if (models && models.length > 0) probed.push({ ...candidate, models });
  }
  if (probed.length === 0) return undefined;

  const preferred = readPreferredModel();
  if (preferred) {
    for (const endpoint of probed) {
      const match = endpoint.models.find(
        (model) => model.name === preferred || model.name.startsWith(`${preferred}:`),
      );
      if (match) {
        logger.info('Scaffolding local model: using configured aux quality model', {
          model: match.name,
          origin: endpoint.origin,
        });
        return { model: match.name, host: endpoint.host, port: endpoint.port, origin: endpoint.origin };
      }
    }
    logger.info('Configured aux quality model not installed on any reachable endpoint', {
      preferred,
    });
  }

  // Largest installed model across all reachable endpoints — scaffolding
  // gates want the strongest local model available.
  let best: { endpoint: ProbedEndpoint; model: InstalledModel } | undefined;
  for (const endpoint of probed) {
    for (const model of endpoint.models) {
      if (!best || model.size > best.model.size) best = { endpoint, model };
    }
  }
  if (!best) return undefined;
  logger.info('Scaffolding local model: using largest installed Ollama model', {
    model: best.model.name,
    origin: best.endpoint.origin,
  });
  return {
    model: best.model.name,
    host: best.endpoint.host,
    port: best.endpoint.port,
    origin: best.endpoint.origin,
  };
}

function collectCandidateEndpoints(): Omit<ProbedEndpoint, 'models'>[] {
  const candidates: Omit<ProbedEndpoint, 'models'>[] = [];
  if (readBooleanSetting('auxiliaryLlmUseLocalhostOllama')) {
    candidates.push({ host: LOCALHOST, port: DEFAULT_OLLAMA_PORT, origin: 'this-device' });
  }
  return candidates;
}

async function listInstalledModels(host: string, port: number): Promise<InstalledModel[] | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
    let payload: OllamaTagsResponse;
    try {
      const response = await fetch(`http://${host}:${port}/api/tags`, { signal: controller.signal });
      if (!response.ok) return undefined;
      payload = (await response.json()) as OllamaTagsResponse;
    } finally {
      clearTimeout(timer);
    }
    return (payload.models ?? [])
      .map((entry) => ({
        name: typeof entry?.name === 'string' ? entry.name : '',
        size: typeof entry?.size === 'number' ? entry.size : 0,
      }))
      .filter((entry) => entry.name.length > 0);
  } catch {
    // Server down/unreachable — candidate silently skipped.
    return undefined;
  }
}

function readBooleanSetting(
  key: 'auxiliaryLlmUseLocalhostOllama',
): boolean {
  try {
    // Default-open: only an explicit false disables the candidate class. Test
    // doubles may return partial settings objects, hence the loose check.
    const value: unknown = getSettingsManager().getAll()[key];
    return value !== false;
  } catch {
    return true;
  }
}

function readPreferredModel(): string | undefined {
  try {
    const value: unknown = getSettingsManager().getAll().auxiliaryLlmQualityModel;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}
