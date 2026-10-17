import type { CommandTemplate, ParsedCommand } from '../../shared/types/command.types';

interface NativeCommandSource { getAvailableCommands?: () => readonly { name: string; description?: string }[] }

/** Catalogs remain session-scoped, never persisted into the shared command registry. */
export function nativeOpenCodeCommands(provider: string | undefined, adapter: unknown): CommandTemplate[] {
  if (provider !== 'opencode') return [];
  const source = adapter as NativeCommandSource | undefined;
  return (source?.getAvailableCommands?.() ?? []).slice(0, 128).flatMap((command) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,100}$/.test(command.name)) return [];
    return [{ id: `acp:opencode:${command.name}`, name: command.name,
      description: command.description?.slice(0, 1000) ?? `OpenCode /${command.name}`,
      template: `/${command.name} $ARGUMENTS`, execution: { type: 'prompt' as const },
      builtIn: false, category: 'session' as const, applicability: { provider: 'opencode' as const },
      createdAt: 0, updatedAt: 0 }];
  });
}

export function resolveNativeOpenCodeCommand(provider: string | undefined, adapter: unknown,
  id: string, args: string[]): ParsedCommand | undefined {
  const command = nativeOpenCodeCommands(provider, adapter).find((entry) => entry.id === id);
  return command ? { command, args, resolvedPrompt: [`/${command.name}`, ...args].join(' '), execution: { type: 'prompt' } } : undefined;
}

export function resolveNativeOpenCodeCommandInput(provider: string | undefined, adapter: unknown,
  id: string, input: string): ParsedCommand | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
  return match && id === `acp:opencode:${match[1]}` ? resolveNativeOpenCodeCommand(provider, adapter, id, match[2] ? [match[2]] : []) : undefined;
}
