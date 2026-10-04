import type { LocalAiTargetConfig } from '../../shared/types/local-ai-guard.types';

const DEFAULT_PORTS: Record<LocalAiTargetConfig['provider'], string> = {
  ollama: '11434',
  'openai-compatible': '1234',
};

/**
 * Human label for a new Local AI target, e.g. `windows-pc · LM Studio`.
 *
 * The old default (`<node uuid>: worker:<node uuid>:ollama:127.0.0.1:11434`) gave an operator
 * no way to tell targets apart. A worker's OpenAI-compatible endpoint is always its LM Studio
 * server (the worker only probes LM Studio on that provider). The host is appended only for a
 * non-default port, where two targets of one provider could otherwise share a label.
 */
export function friendlyLocalAiTargetLabel(
  config: Pick<LocalAiTargetConfig, 'location' | 'provider' | 'baseUrl'>,
  workerName?: string,
): string {
  const where = config.location.type === 'worker'
    ? workerName?.trim() || config.location.nodeId
    : 'This computer';
  const what = config.provider === 'ollama'
    ? 'Ollama'
    : config.location.type === 'worker' ? 'LM Studio' : 'OpenAI-compatible';
  const host = nonDefaultHost(config.baseUrl, DEFAULT_PORTS[config.provider]);
  return `${where} · ${what}${host ? ` (${host})` : ''}`.slice(0, 256);
}

function nonDefaultHost(baseUrl: string, defaultPort: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    return url.port && url.port !== defaultPort ? url.host : undefined;
  } catch {
    return undefined;
  }
}
