export const RECONNECT_CONFIG = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  stableConnectionResetMs: 60_000,
};

export function nextReconnectDelayMs(attempt: number): number {
  const exp = Math.min(
    RECONNECT_CONFIG.maxMs,
    RECONNECT_CONFIG.initialMs * RECONNECT_CONFIG.factor ** Math.min(attempt, 30),
  );
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}
