/**
 * Pure shaping of ACP `available_commands_update` and `plan` session updates.
 * Extracted from acp-cli-adapter.ts to keep that file under its size ceiling;
 * behaviour is unchanged.
 */

import { getLogger } from '../../logging/logger';
import type { AcpAvailableCommandsUpdate, AcpPlanUpdate } from '../../../shared/types/cli.types';

const logger = getLogger('AcpCliAdapter');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function normalizeAcpAvailableCommands(
  update: Record<string, unknown>,
): NonNullable<AcpAvailableCommandsUpdate['availableCommands']> {
  // ACP spec field name is `availableCommands` (camelCase). Older drafts
  // used the bare `commands` key — accept both so we work against
  // cursor-agent (canonical), copilot, and any older agents in the wild.
  const candidate = update['availableCommands'] ?? update['commands'];
  if (!Array.isArray(candidate)) {
    // The slash-command catalog is informational and optional. A missing
    // or non-array payload is not a real protocol violation — older code
    // surfaced a red "Malformed ACP available commands update" bubble in
    // the chat, which scared users off perfectly working sessions
    // (cursor's payload uses `availableCommands` so the lookup against
    // `commands` always missed). Log for diagnostics and move on.
    logger.debug('ACP available_commands_update missing commands array', {
      keys: Object.keys(update),
    });
    return [];
  }

  return candidate.flatMap((command) => {
    if (typeof command === 'string' && command.trim()) {
      return [{ name: command.trim() }];
    }

    if (!isRecord(command)) {
      return [];
    }

    const name = optionalString(command['name']);
    if (!name) {
      return [];
    }

    return [{
      name,
      description: optionalString(command['description']),
    }];
  });
}

export function renderAcpPlan(entries: AcpPlanUpdate['entries']): string {
  if (entries.length === 0) {
    return 'Plan: no entries advertised.';
  }

  const lines = entries.map((entry) => {
    const parts = [entry.status, entry.priority].filter(Boolean).join(' / ');
    return parts ? `- ${entry.content} (${parts})` : `- ${entry.content}`;
  });
  return ['Plan:', ...lines].join('\n');
}
