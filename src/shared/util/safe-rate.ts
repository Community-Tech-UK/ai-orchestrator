export interface SafeRate { value: number | null; numerator: number; denominator: number }
export function rate(numerator: number, denominator: number): SafeRate {
  return { numerator, denominator, value: Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 && numerator >= 0 && numerator <= denominator ? numerator / denominator : null };
}
export function formatRate(r: SafeRate): string {
  return r.value === null ? '-' : `${Math.round(r.value * 100)}% (${r.numerator} of ${r.denominator})`;
}
export function formatMoneyRate(numeratorCents: number, denominatorCents: number): string {
  const r = rate(numeratorCents, denominatorCents);
  return r.value === null ? '-' : `${Math.round(r.value * 100)}% ($${(numeratorCents / 100).toFixed(2)} of $${(denominatorCents / 100).toFixed(2)})`;
}
export function formatMean(total: number, count: number, noun: string): string {
  return Number.isFinite(total) && Number.isFinite(count) && total >= 0 && count > 0
    ? `${Math.round(total / count).toLocaleString('en-US')} ${noun} (${count} ${noun.includes('task') ? 'tasks' : 'items'})` : '-';
}
