export function matchesOverlayQuery(fields: (string | undefined)[], query: string): boolean {
  if (!query) return true;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = fields.filter(Boolean).map((f) => f!.toLowerCase()).join(' ');
  return terms.every((term) => haystack.includes(term));
}

export function scoreOverlayQuery(fields: (string | undefined)[], query: string): number {
  if (!query) return 0;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const primary = (fields[0] ?? '').toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (primary === term) score += 50;
    else if (primary.startsWith(term)) score += 30;
    else if (primary.includes(term)) score += 10;
    else score += 1;
  }
  return score;
}
