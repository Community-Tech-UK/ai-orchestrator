/** Preserve both texts verbatim; queue restoration prepends, findings-table replies append. */
export function mergeComposerRestoreText(incoming: string, existing: string, placement: 'prepend' | 'append' = 'prepend'): string {
  if (!incoming) return existing;
  if (!existing) return incoming;
  return placement === 'prepend' ? `${incoming}\n\n${existing}` : `${existing}\n\n${incoming}`;
}
