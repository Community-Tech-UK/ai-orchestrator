/** Validate explicit OpenCode workspace context without changing path spelling or security grants. */
export function normalizeOpenCodeAdditionalDirectories(value: unknown, provider?: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || Array.from(value).some(directory =>
    typeof directory !== 'string' || directory.length === 0 || directory.length > 4096
    || /[*?\0]/.test(directory)
    || !(directory.startsWith('/') || /^[a-z]:[\\/]/i.test(directory) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(directory)))) {
    throw new Error('Additional directories must be at most 64 absolute paths without wildcards.');
  }
  if (value.length > 0 && provider !== 'opencode') {
    throw new Error('Additional directories require the OpenCode provider.');
  }
  return [...value] as string[];
}
