export interface McpBridgeCommand {
  command: string;
  args: string[];
}

export function toWindowsSafeBridge(command: string, args: string[]): McpBridgeCommand {
  if (process.platform === 'win32' && needsCmdWrapper(command)) {
    return { command: 'cmd', args: ['/c', command, ...args] };
  }
  return { command, args };
}

export function needsCmdWrapper(command: string): boolean {
  const lower = command.toLowerCase();
  return lower !== 'cmd' && lower !== 'cmd.exe' && !lower.endsWith('.exe');
}

export function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function tomlArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(', ')}]`;
}

export function tomlBareKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : tomlString(value);
}

/** Dotted table key segment; always quoted to avoid ambiguity around hyphens. */
export function tomlTableKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? `"${value}"` : tomlString(value);
}
