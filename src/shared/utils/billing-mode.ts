export type BillingMode = 'plan' | 'credits' | 'api' | 'local' | 'unknown';
interface BillingSnapshot { plan?: string; windows: readonly { limit: number; unit: string; overage?: boolean }[] }
export function resolveBillingMode(provider: string, snapshot?: BillingSnapshot | null, account?: { planLabel?: string } | null): BillingMode {
  if (provider === 'copilot') return 'credits';
  if (['ollama', 'lmstudio', 'local'].includes(provider)) return 'local';
  if (snapshot?.plan?.toLowerCase() === 'api') return 'api';
  if (account?.planLabel || (snapshot?.plan && snapshot.plan !== 'unknown')
    || snapshot?.windows.some(w => w.limit > 0 && w.overage !== true && (w.unit !== 'usd' || w.overage === false))) return 'plan';
  return 'unknown';
}
