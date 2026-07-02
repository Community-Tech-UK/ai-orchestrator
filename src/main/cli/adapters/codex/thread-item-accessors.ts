/**
 * Pure accessors for Codex app-server ThreadItem payloads.
 *
 * The app-server wire format has drifted between snake_case and camelCase
 * across Codex releases, so every field read tolerates both spellings.
 * Extracted from CodexCliAdapter (no state involved) to keep the adapter lean.
 */

import type { ThreadItem } from './app-server-types';

export function isCommandExecutionItem(item: ThreadItem): boolean {
  return item.type === 'command_execution' || item.type === 'commandExecution';
}

export function getCommandAggregatedOutput(item: ThreadItem): string | undefined {
  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }
  if (typeof item.aggregatedOutput === 'string') {
    return item.aggregatedOutput;
  }
  return undefined;
}

export function getCommandExitCode(item: ThreadItem): number | undefined {
  if (typeof item.exit_code === 'number') {
    return item.exit_code;
  }
  if (typeof item.exitCode === 'number') {
    return item.exitCode;
  }
  return undefined;
}

export function getFileChangePath(item: ThreadItem): string {
  if (typeof item.path === 'string' && item.path.trim()) {
    return item.path;
  }
  if (Array.isArray(item.changes)) {
    const firstPath = item.changes
      .map((change) => change?.path)
      .find((path): path is string => typeof path === 'string' && path.trim().length > 0);
    if (firstPath) {
      return firstPath;
    }
  }
  return 'unknown';
}

export function getToolCallName(item: ThreadItem): string {
  for (const value of [item.tool, item.toolName, item['name']]) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return 'unknown';
}

export function getToolCallInput(item: ThreadItem): Record<string, unknown> {
  for (const value of [item.input, item['arguments'], item['args']]) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}
