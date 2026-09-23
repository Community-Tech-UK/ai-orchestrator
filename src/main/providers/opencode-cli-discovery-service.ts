/**
 * OpenCode CLI model discovery.
 *
 * Runs `opencode models --verbose`, which prints each model the user can use
 * (backends with a stored credential or env var, plus the free Zen models) as a
 * `provider/model` line followed by a JSON block. The ids feed the unified
 * catalog verbatim, since OpenCode only accepts `provider/model` ids. Models
 * that cannot drive a coding session (TTS, voice cloning, embeddings) are
 * dropped using the verbose metadata: a chat model has `toolcall` and text
 * output. When a block has no capability metadata, a name filter decides.
 *
 * Fail-soft like `GrokCliDiscoveryService`: a missing CLI or unparseable
 * output keeps whatever the catalog had, and the picker falls back to
 * "OpenCode default".
 */

import { spawn, type ChildProcess } from 'child_process';
import { getLogger } from '../logging/logger';
import { buildCliSpawnOptions } from '../cli/cli-environment';
import { PosixSpawnCommandResolver } from '../cli/adapters/posix-spawn-command-resolver';
import { killProcessGroup } from '../cli/adapters/base-cli-process-utils';
import { withOpenCodeProcessGate } from '../cli/adapters/opencode-process-gate';
import { MAX_MODEL_ID_LENGTH, type ModelDisplayInfo } from '../../shared/types/provider.types';
import { getUnifiedModelCatalog } from './unified-model-catalog-service';

const logger = getLogger('OpenCodeCliDiscovery');

const OPENCODE_PROVIDER = 'opencode';

/** Same cadence as Grok discovery. */
export const OPENCODE_MODEL_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 20_000;

const MODEL_HEADER = /^([a-z0-9][\w.-]*)\/(\S+)\s*$/i;
const NON_CHAT_NAME = /tts|voiceclone|voicedesign|embedding/i;

/** Friendly group labels for backends James uses; others show their raw id. */
const BACKEND_LABELS: Record<string, string> = {
  'opencode': 'OpenCode Zen',
  'xiaomi-token-plan-ams': 'Xiaomi Token Plan (Europe)',
  'xiaomi-token-plan-sgp': 'Xiaomi Token Plan (Singapore)',
  'xiaomi-token-plan-cn': 'Xiaomi Token Plan (China)',
  'xiaomi': 'Xiaomi MiMo',
  'openrouter': 'OpenRouter',
};

export function openCodeBackendLabel(providerId: string): string {
  return BACKEND_LABELS[providerId] ?? providerId;
}

export interface OpenCodeModelListEntry {
  id: string;
  providerId: string;
  name?: string;
  /** False when metadata shows the model cannot run a tool-using chat turn. */
  isChatModel: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifyChatModel(id: string, metadata: unknown): boolean {
  const capabilities = isRecord(metadata) ? metadata['capabilities'] : undefined;
  if (!isRecord(capabilities)) {
    return !NON_CHAT_NAME.test(id);
  }
  const output = capabilities['output'];
  const textOutput = isRecord(output) ? output['text'] === true : true;
  return capabilities['toolcall'] === true && textOutput;
}

/** Parse `opencode models [--verbose]` output. Plain output (no JSON) is accepted too. */
export function parseOpenCodeModelList(output: string): OpenCodeModelListEntry[] {
  const lines = output.split(/\r?\n/);
  const entries = new Map<string, OpenCodeModelListEntry>();
  for (let index = 0; index < lines.length; index += 1) {
    const header = MODEL_HEADER.exec(lines[index]?.trim() ?? '');
    if (!header) continue;
    const id = `${header[1]}/${header[2]}`;
    if (id.length > MAX_MODEL_ID_LENGTH) continue;
    const jsonLines: string[] = [];
    while (index + 1 < lines.length && !MODEL_HEADER.test(lines[index + 1]?.trim() ?? '')) {
      index += 1;
      jsonLines.push(lines[index] ?? '');
    }
    let metadata: unknown;
    const json = jsonLines.join('\n').trim();
    if (json.startsWith('{')) {
      try {
        metadata = JSON.parse(json);
      } catch {
        metadata = undefined;
      }
    }
    const name = isRecord(metadata) && typeof metadata['name'] === 'string' ? metadata['name'] : undefined;
    entries.set(id, {
      id,
      providerId: header[1] ?? '',
      ...(name ? { name } : {}),
      isChatModel: classifyChatModel(id, metadata),
    });
  }
  return [...entries.values()];
}

function classifyTier(id: string): ModelDisplayInfo['tier'] {
  const lower = id.toLowerCase();
  if (/flash|mini|lite|fast/.test(lower)) return 'fast';
  if (/-pro\b|ultra|opus/.test(lower)) return 'powerful';
  return 'balanced';
}

export function toOpenCodeModelDisplayInfos(entries: OpenCodeModelListEntry[]): ModelDisplayInfo[] {
  return entries
    .filter((entry) => entry.isChatModel)
    .map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id.slice(entry.providerId.length + 1),
      tier: classifyTier(entry.id),
      family: openCodeBackendLabel(entry.providerId),
    }));
}

/** Runs the lister process and parses its output. Rejects on timeout, spawn error or empty output. */
export function discoverOpenCodeModels(spawnLister: () => ChildProcess): Promise<ModelDisplayInfo[]> {
  return new Promise<ModelDisplayInfo[]>((resolve, reject) => {
    const proc = spawnLister();
    let output = '';
    proc.stdout?.on('data', (data) => {
      output += (data as Buffer).toString();
    });
    const timer = setTimeout(() => {
      if (!killProcessGroup(proc.pid, 'SIGTERM')) {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignored */
        }
      }
      reject(new Error('Timeout fetching OpenCode model list'));
    }, OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS);
    proc.on('close', (code) => {
      clearTimeout(timer);
      const models = toOpenCodeModelDisplayInfos(parseOpenCodeModelList(output));
      if (models.length > 0) {
        resolve(models);
        return;
      }
      reject(new Error(`OpenCode model list was empty or unparseable (exit ${code})`));
    });
    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export interface OpenCodeCatalogSink {
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void;
}

export interface OpenCodeCliDiscoveryServiceOptions {
  catalog?: OpenCodeCatalogSink;
  intervalMs?: number;
  lister?: () => Promise<ModelDisplayInfo[]>;
}

/** Packaged apps start with a stripped PATH; resolve `opencode` against the CLI PATH first. */
const commandResolver = new PosixSpawnCommandResolver();

function defaultLister(): Promise<ModelDisplayInfo[]> {
  // `opencode models` opens OpenCode's database too, so it takes the same gate
  // as session startups (see opencode-process-gate.ts).
  return withOpenCodeProcessGate(() => discoverOpenCodeModels(() =>
    spawn(commandResolver.resolve('opencode'), ['models', '--verbose'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...buildCliSpawnOptions(),
    }),
  ));
}

export class OpenCodeCliDiscoveryService {
  private readonly catalog: OpenCodeCatalogSink;
  private readonly intervalMs: number;
  private readonly lister: () => Promise<ModelDisplayInfo[]>;
  private refreshInFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: OpenCodeCliDiscoveryServiceOptions = {}) {
    this.catalog = options.catalog ?? getUnifiedModelCatalog();
    this.intervalMs = options.intervalMs ?? OPENCODE_MODEL_DISCOVERY_INTERVAL_MS;
    this.lister = options.lister ?? defaultLister;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.refreshOnce();
    this.timer = setInterval(() => {
      void this.refreshOnce();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refreshOnce(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<void> {
    try {
      const models = await this.lister();
      this.catalog.onCliDiscoveryRefreshed(OPENCODE_PROVIDER, models);
      logger.info('OpenCode CLI models refreshed into unified catalog', { count: models.length });
    } catch (error) {
      logger.debug('OpenCode CLI model discovery failed; keeping existing catalog', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let openCodeCliDiscoveryService: OpenCodeCliDiscoveryService | null = null;

export function getOpenCodeCliDiscoveryService(): OpenCodeCliDiscoveryService {
  openCodeCliDiscoveryService ??= new OpenCodeCliDiscoveryService();
  return openCodeCliDiscoveryService;
}

export function _resetOpenCodeCliDiscoveryServiceForTesting(): void {
  openCodeCliDiscoveryService?.stop();
  openCodeCliDiscoveryService = null;
}
