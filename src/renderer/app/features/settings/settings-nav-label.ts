/** The badge and recommendation follow the same precedence as the visible menu. */
export function navItemLabel(label: string, badgeText: string | null, recommended: boolean): string {
  const status = badgeText || (recommended ? 'Recommended' : null);
  return status ? `${label}, ${status}` : label;
}
