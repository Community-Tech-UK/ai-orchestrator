const PLAIN_USD = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Everyday costs use cents without rounding a tiny nonzero cost to zero. */
export function formatMoneyPlain(usd: number): string {
  if (!Number.isFinite(usd)) return 'Cost unknown';
  if (usd !== 0 && Math.abs(usd) < 0.005) return 'under 1 cent';
  return PLAIN_USD.format(usd);
}

/** Preserve the supplied number, including sub-cent precision, for Details. */
export function formatMoneyExact(usd: number): string {
  return Number.isFinite(usd) ? `$${usd}` : 'Cost unknown';
}
