export function readIpcAuthToken(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  const token = (data as { ipcAuthToken?: unknown }).ipcAuthToken;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}
