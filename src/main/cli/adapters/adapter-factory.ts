/**
 * CLI Adapter Factory - Creates appropriate CLI adapters based on provider type
 *
 * Centralizes adapter instantiation to support multiple CLI providers:
 * - Claude Code CLI
 * - OpenAI Codex CLI
 * - Google Gemini CLI
 * - Ollama (future)
 */

import { ClaudeCliAdapter, ClaudeCliSpawnOptions } from './claude-cli-adapter';
import { CodexCliAdapter, CodexCliConfig } from './codex-cli-adapter';
import { GeminiCliAdapter, GeminiCliConfig } from './gemini-cli-adapter';
import { CopilotSdkAdapter, CopilotSdkConfig } from './copilot-sdk-adapter';
import { CliDetectionService, CliType } from '../cli-detection';
import type { CliType as SettingsCliType } from '../../../shared/types/settings.types';

/**
 * Unified spawn options that work across all adapters
 */
export interface UnifiedSpawnOptions {
  sessionId?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  timeout?: number;
  disallowedTools?: string[];
}

/**
 * Adapter type union - the concrete adapter types
 */
export type CliAdapter = ClaudeCliAdapter | CodexCliAdapter | GeminiCliAdapter | CopilotSdkAdapter;

/**
 * Maps settings CliType to detection CliType
 */
function mapSettingsToDetectionType(settingsType: SettingsCliType): CliType | 'auto' {
  switch (settingsType) {
    case 'claude':
      return 'claude';
    case 'openai':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'copilot':
      return 'copilot';
    case 'auto':
      return 'auto';
    default:
      return 'auto';
  }
}

/**
 * Resolves the CLI type to use based on settings and availability
 */
export async function resolveCliType(
  requestedType?: SettingsCliType | CliType,
  defaultType: SettingsCliType = 'auto'
): Promise<CliType> {
  const detection = CliDetectionService.getInstance();
  console.log(`[AdapterFactory] resolveCliType called with requested=${requestedType}, default=${defaultType}`);

  // If explicitly requested (not 'auto'), try to use it
  if (requestedType && requestedType !== 'auto') {
    const cliType = mapSettingsToDetectionType(requestedType as SettingsCliType);
    console.log(`[AdapterFactory] Mapped ${requestedType} -> ${cliType}`);
    if (cliType !== 'auto') {
      // Verify it's available
      const result = await detection.detectAll();
      console.log(`[AdapterFactory] Available CLIs: ${result.available.map(c => c.name).join(', ')}`);
      const isAvailable = result.available.some((cli) => cli.name === cliType);
      console.log(`[AdapterFactory] Is ${cliType} available? ${isAvailable}`);
      if (isAvailable) {
        return cliType;
      }
      console.warn(`[AdapterFactory] Requested CLI '${requestedType}' (mapped to '${cliType}') not available, falling back to auto`);
    }
  }

  // Auto-detect: use default setting or find first available
  if (defaultType !== 'auto') {
    const cliType = mapSettingsToDetectionType(defaultType);
    if (cliType !== 'auto') {
      const result = await detection.detectAll();
      const isAvailable = result.available.some((cli) => cli.name === cliType);
      if (isAvailable) {
        return cliType;
      }
    }
  }

  // Fall back to first available CLI (priority: claude > codex > gemini > ollama)
  const result = await detection.detectAll();
  const priority: CliType[] = ['claude', 'codex', 'gemini', 'copilot', 'ollama'];
  console.log(`[AdapterFactory] Falling back to auto-detect from: ${priority.join(', ')}`);

  for (const cli of priority) {
    if (result.available.some((c) => c.name === cli)) {
      console.log(`[AdapterFactory] Auto-selected: ${cli}`);
      return cli;
    }
  }

  // Default to Claude if nothing is detected (will fail gracefully later)
  console.warn('[AdapterFactory] No CLI detected, defaulting to claude');
  return 'claude';
}

/**
 * Creates a Claude CLI adapter
 */
export function createClaudeAdapter(options: UnifiedSpawnOptions): ClaudeCliAdapter {
  const claudeOptions: ClaudeCliSpawnOptions = {
    sessionId: options.sessionId,
    workingDirectory: options.workingDirectory,
    systemPrompt: options.systemPrompt,
    model: options.model,
    yoloMode: options.yoloMode,
    disallowedTools: options.disallowedTools,
  };
  return new ClaudeCliAdapter(claudeOptions);
}

/**
 * Creates a Codex CLI adapter
 */
export function createCodexAdapter(options: UnifiedSpawnOptions): CodexCliAdapter {
  const codexConfig: CodexCliConfig = {
    workingDir: options.workingDirectory,
    model: options.model,
    approvalMode: options.yoloMode ? 'full-auto' : 'suggest',
    timeout: options.timeout,
  };
  return new CodexCliAdapter(codexConfig);
}

/**
 * Creates a Gemini CLI adapter
 */
export function createGeminiAdapter(options: UnifiedSpawnOptions): GeminiCliAdapter {
  const geminiConfig: GeminiCliConfig = {
    workingDir: options.workingDirectory,
    model: options.model,
    yoloMode: options.yoloMode,
    timeout: options.timeout,
  };
  return new GeminiCliAdapter(geminiConfig);
}

/**
 * Creates a Copilot SDK adapter
 */
export function createCopilotAdapter(options: UnifiedSpawnOptions): CopilotSdkAdapter {
  const copilotConfig: CopilotSdkConfig = {
    workingDir: options.workingDirectory,
    model: options.model,
    systemPrompt: options.systemPrompt,
    yoloMode: options.yoloMode,
    timeout: options.timeout,
  };
  return new CopilotSdkAdapter(copilotConfig);
}

/**
 * Creates a CLI adapter for the specified type
 * Returns a ClaudeCliAdapter for Claude, or the appropriate adapter for other types
 */
export function createCliAdapter(
  cliType: CliType,
  options: UnifiedSpawnOptions
): CliAdapter {
  switch (cliType) {
    case 'claude':
      return createClaudeAdapter(options);

    case 'codex':
      return createCodexAdapter(options);

    case 'gemini':
      return createGeminiAdapter(options);

    case 'copilot':
      return createCopilotAdapter(options);

    case 'ollama':
      // Ollama doesn't have a full CLI adapter yet, fall back to Claude
      console.warn('[AdapterFactory] Ollama adapter not implemented, falling back to Claude');
      return createClaudeAdapter(options);

    default:
      throw new Error(`Unknown CLI type: ${cliType}`);
  }
}

/**
 * Creates a CLI adapter with automatic type resolution
 */
export async function createCliAdapterAuto(
  options: UnifiedSpawnOptions,
  requestedType?: SettingsCliType | CliType,
  defaultType: SettingsCliType = 'auto'
): Promise<{ adapter: CliAdapter; cliType: CliType }> {
  const cliType = await resolveCliType(requestedType, defaultType);
  const adapter = createCliAdapter(cliType, options);
  return { adapter, cliType };
}

/**
 * Get display name for a CLI type
 */
export function getCliDisplayName(cliType: CliType): string {
  switch (cliType) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'OpenAI Codex';
    case 'gemini':
      return 'Google Gemini';
    case 'copilot':
      return 'GitHub Copilot';
    case 'ollama':
      return 'Ollama';
    default:
      return cliType;
  }
}
