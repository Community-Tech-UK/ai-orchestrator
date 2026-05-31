/**
 * Magic Prompt Service
 *
 * Runs a registered magic prompt as a single-turn, schema-validated request
 * against a fast CLI provider, reusing the existing one-shot adapter path
 * (createAdapter + sendMessage) — the same mechanism `auto-title-service` uses,
 * so no separate API key or interactive instance is required.
 *
 * The provider/adapter plumbing is injected so the parsing + validation logic
 * can be unit-tested without spawning a real CLI.
 */

import { resolveCliType, type CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';
import { isCliAvailable, type CliType } from '../cli/cli-detection';
import { isProviderNotice } from '../cli/provider-notice';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { extractJson } from '../orchestration/cross-model-review-service.helpers';
import {
  getMagicPrompt,
  listMagicPrompts,
  type MagicPromptInput,
  type MagicPromptSummary,
} from './magic-prompt-registry';

const logger = getLogger('MagicPrompt');

/** Timeout for a one-shot magic prompt (ms). Diffs/recaps run longer than titles. */
const MAGIC_PROMPT_TIMEOUT = 30_000;

/** Provider preference (fastest first) when no explicit provider is requested. */
const FAST_PROVIDER_PREFERENCE = ['claude', 'gemini', 'copilot', 'codex'] as const;

export interface MagicPromptRunInput extends MagicPromptInput {
  id: string;
  provider?: string;
  workingDirectory?: string;
}

export interface MagicPromptSuccess<T = unknown> {
  ok: true;
  id: string;
  provider: string;
  model?: string;
  data: T;
  raw: string;
}

export interface MagicPromptFailure {
  ok: false;
  id: string;
  error: string;
  raw?: string;
}

export type MagicPromptRunResult<T = unknown> = MagicPromptSuccess<T> | MagicPromptFailure;

/** Injection seam — defaults wire to the real provider runtime. */
export interface MagicPromptServiceDeps {
  resolveProvider(preferred?: string): Promise<CliType | null>;
  createAdapter(cliType: CliType, options: UnifiedSpawnOptions): CliAdapter;
}

type SendMessageAdapter = CliAdapter & {
  sendMessage: (message: CliMessage) => Promise<CliResponse>;
};

function hasSendMessage(adapter: CliAdapter): adapter is SendMessageAdapter {
  return typeof (adapter as { sendMessage?: unknown }).sendMessage === 'function';
}

async function defaultResolveProvider(preferred?: string): Promise<CliType | null> {
  // Honor an explicit preference first.
  if (preferred) {
    try {
      const info = await isCliAvailable(preferred as CliType);
      if (info.installed) return await resolveCliType(preferred as CliType);
    } catch {
      // fall through to preference order
    }
  }
  for (const candidate of FAST_PROVIDER_PREFERENCE) {
    try {
      const info = await isCliAvailable(candidate);
      if (info.installed) return await resolveCliType(candidate);
    } catch {
      // skip unavailable providers
    }
  }
  return null;
}

const DEFAULT_DEPS: MagicPromptServiceDeps = {
  resolveProvider: defaultResolveProvider,
  createAdapter: (cliType, options) =>
    getProviderRuntimeService().createAdapter({ cliType, options }),
};

export class MagicPromptService {
  private readonly deps: MagicPromptServiceDeps;

  constructor(deps: Partial<MagicPromptServiceDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  list(): MagicPromptSummary[] {
    return listMagicPrompts();
  }

  async run<T = unknown>(input: MagicPromptRunInput): Promise<MagicPromptRunResult<T>> {
    const def = getMagicPrompt(input.id);
    if (!def) {
      return { ok: false, id: input.id, error: `Unknown magic prompt: ${input.id}` };
    }

    const text = (input.text ?? '').trim();
    if (!text) {
      return { ok: false, id: def.id, error: 'No input text was provided' };
    }

    const cliType = await this.deps.resolveProvider(input.provider);
    if (!cliType) {
      return { ok: false, id: def.id, error: 'No CLI provider is available to run this command' };
    }

    const model = resolveModelForTier('fast', cliType);
    const adapter = this.deps.createAdapter(cliType, {
      workingDirectory: input.workingDirectory ?? process.cwd(),
      model,
      systemPrompt: def.systemPrompt,
      yoloMode: false,
      timeout: MAGIC_PROMPT_TIMEOUT,
    });

    if (!hasSendMessage(adapter)) {
      return { ok: false, id: def.id, error: `Provider ${cliType} does not support one-shot prompts` };
    }

    const prompt =
      `${def.buildPrompt({ text, context: input.context })}` +
      `\n\nRespond with ONLY a JSON object matching exactly this shape:\n${def.schemaHint}`;

    let response: CliResponse;
    try {
      response = await adapter.sendMessage({ role: 'user', content: prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Magic prompt one-shot failed', { id: def.id, provider: cliType, error: message });
      return { ok: false, id: def.id, error: `Provider request failed: ${message}` };
    }

    const raw = (response.content ?? '').trim();
    if (raw.length === 0) {
      return { ok: false, id: def.id, error: 'Provider returned an empty response' };
    }

    // A throttled/errored one-shot can return a status notice as content.
    if (isProviderNotice(raw)) {
      logger.warn('Magic prompt got a provider status/limit notice', { id: def.id, provider: cliType });
      return {
        ok: false,
        id: def.id,
        error: 'Provider returned a status/limit notice instead of a result',
        raw,
      };
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      return { ok: false, id: def.id, error: 'Could not parse a JSON object from the response', raw };
    }

    const validated = def.schema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return {
        ok: false,
        id: def.id,
        error: `Response did not match the expected schema (${issues})`,
        raw,
      };
    }

    return {
      ok: true,
      id: def.id,
      provider: cliType,
      model,
      data: validated.data as T,
      raw,
    };
  }
}

let instance: MagicPromptService | null = null;

export function getMagicPromptService(): MagicPromptService {
  instance ??= new MagicPromptService();
  return instance;
}

export function _resetMagicPromptServiceForTesting(): void {
  instance = null;
}
