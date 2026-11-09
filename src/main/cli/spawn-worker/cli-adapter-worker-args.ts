import type { UnifiedSpawnOptions } from '../adapters/adapter-factory';
import type { CliMessage } from '../adapters/base-cli-adapter';
import { resolveClaudeDebugLogging } from '../adapters/claude-env-pack';
import { claudeOutputCapSettings, resolveClaudeBashOutputMaxChars } from '../adapters/claude-output-caps';
import { DEFAULT_DISALLOWED_TOOLS } from '../adapters/host-cli-tool-policy';
import { claudePermissionHooks, type ClaudePermissionHooks } from '../adapters/claude-permission-hooks';
import { resolveBashHookCommand } from '../hooks/hook-path-resolver';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import { wrapSystemInstructions } from '../adapters/system-instruction-wrapper';

export function buildWorkerArgs(
  cliType: 'claude' | 'gemini',
  options: UnifiedSpawnOptions,
  sessionId: string | null,
  message: CliMessage,
  state: { geminiAdvisoryDelivered?: boolean } = {},
): string[] {
  return cliType === 'claude'
    ? buildClaudeArgs(options, sessionId)
    : buildGeminiArgs(options, message, state.geminiAdvisoryDelivered === true);
}

function buildClaudeArgs(options: UnifiedSpawnOptions, sessionId: string | null): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose'];
  if (options.bare) args.push('--bare');
  if (options.name) args.push('--name', options.name);
  if (options.yoloMode) {
    args.push('--dangerously-skip-permissions');
  } else {
    args.push('--permission-mode', 'acceptEdits');
    if (options.allowedTools?.length) args.push('--allowedTools', options.allowedTools.join(','));
  }
  if (options.resume && sessionId) {
    args.push('--resume', sessionId);
    if (options.forkSession) args.push('--fork-session');
  } else if (sessionId) {
    args.push('--session-id', sessionId);
  }
  if (typeof options.maxTurns === 'number' && Number.isInteger(options.maxTurns) && options.maxTurns > 0) {
    args.push('--max-turns', String(options.maxTurns));
  }
  if (!args.includes('--resume') && typeof options.maxBudgetUsd === 'number'
    && Number.isFinite(options.maxBudgetUsd) && options.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(options.maxBudgetUsd));
  }
  if (options.model) args.push('--model', options.model);
  const effort = mapClaudeReasoningEffort(options.reasoningEffort);
  if (effort) args.push('--effort', effort);
  if (options.yoloMode && options.allowedTools?.length) {
    args.push('--allowedTools', options.allowedTools.join(','));
  }
  const disallowedTools = Array.from(new Set([...DEFAULT_DISALLOWED_TOOLS, ...(options.disallowedTools ?? [])]));
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));
  // Append by default — `--system-prompt` would REPLACE Claude Code's entire
  // default system prompt; our prompts are overlays (see claude-cli-adapter.ts).
  if (options.systemPrompt && !options.resume) {
    const flag = options.systemPromptMode === 'replace' ? '--system-prompt' : '--append-system-prompt';
    args.push(flag, options.systemPrompt);
  }
  const settingsOverlay = buildClaudeSettingsOverlay(options);
  if (settingsOverlay) args.push('--settings', settingsOverlay);
  if (options.mcpConfig?.length) args.push('--mcp-config', ...options.mcpConfig);
  if (options.chrome === true) args.push('--chrome');
  if (resolveClaudeDebugLogging()) args.push('--debug');
  return args;
}

function buildClaudeSettingsOverlay(options: UnifiedSpawnOptions): string | undefined {
  // This isolated spawn path has no detected CLI version, so the cap is omitted.
  const settings: {
    ultracode?: true;
    bashOutputMaxChars?: number;
    hooks?: ClaudePermissionHooks;
  } = {};
  if (options.reasoningEffort === 'workflow') {
    settings.ultracode = true;
  }
  Object.assign(settings, claudeOutputCapSettings(resolveClaudeBashOutputMaxChars(options.bashOutputMaxChars), null));
  const permissionHooks = claudePermissionHooks(resolveBashHookCommand({
    yoloMode: options.yoloMode,
    permissionHookPath: options.permissionHookPath,
    rtk: options.rtk,
  }), options);
  if (permissionHooks) settings.hooks = permissionHooks;
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : undefined;
}

function mapClaudeReasoningEffort(
  effort: UnifiedSpawnOptions['reasoningEffort'],
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  switch (effort) {
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined;
  }
}

function buildGeminiArgs(
  options: UnifiedSpawnOptions,
  message: CliMessage,
  advisoryDelivered: boolean,
): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  args.push('--output-format', 'stream-json');
  if (options.yoloMode ?? true) args.push('--yolo');
  if (message.content) {
    const promptParts: string[] = [];
    const systemPrompt = advisoryDelivered ? options.systemPromptAfterFirstTurn ?? options.systemPrompt : options.systemPrompt;
    if (systemPrompt) {
      promptParts.push(wrapSystemInstructions(systemPrompt));
    }
    if (options.rtk?.enabled && options.rtk.binaryPath) {
      promptParts.push(wrapRtkAwareness());
    }
    promptParts.push(message.content);
    // The explicit separator prevents a leading-dash prompt from being parsed
    // as another Gemini CLI option.
    args.push('--', promptParts.join('\n\n'));
  }
  return args;
}
