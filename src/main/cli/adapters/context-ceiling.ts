/** Provider-window ceiling policy. Zero leaves the provider default unchanged. */
function readSetting(key: string): unknown {
 try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSettingsManager } = require('../../core/config/settings-manager') as { getSettingsManager: () => { get: (key: string) => unknown } };
  return getSettingsManager().get(key);
 } catch { return undefined; }
}
export function resolveContextCeilingTokens(machineSession: boolean, read: (key: string) => unknown = readSetting): number | undefined {
 const value = read(machineSession ? 'machineContextCeilingTokens' : 'ownChatContextCeilingTokens');
 if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
 return Math.min(1_000_000, Math.max(100_000, Math.floor(value)));
}
export function selfCompactThreshold(modelWindow: number, ceiling?: number): number {
 return Math.max(0, Math.min(modelWindow, ceiling ?? modelWindow) - 33_000);
}
