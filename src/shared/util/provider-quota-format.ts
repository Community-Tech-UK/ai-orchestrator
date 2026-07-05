const QUOTA_DECIMAL_PLACES = 3;
const QUOTA_AMOUNT_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: QUOTA_DECIMAL_PLACES,
  useGrouping: false,
});

export function normalizeQuotaAmount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** QUOTA_DECIMAL_PLACES;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function clampQuotaPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return normalizeQuotaAmount(Math.max(0, Math.min(100, value)));
}

export function quotaRemaining(limit: number, used: number): number {
  return normalizeQuotaAmount(limit - used);
}

export function formatQuotaAmount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return QUOTA_AMOUNT_FORMATTER.format(normalizeQuotaAmount(value));
}

export function formatQuotaWindowValue(used: number, limit: number, unit: string): string {
  return `${formatQuotaAmount(used)}/${formatQuotaAmount(limit)} ${unit}`;
}
