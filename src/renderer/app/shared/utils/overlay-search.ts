import { fuzzyRank } from './fuzzy';

export function matchesOverlayQuery(fields: (string | undefined)[], query: string): boolean {
  if (!query.trim()) return true;
  return fuzzyRank(query, [fieldsToSearchText(fields)], value => value).length > 0;
}

export function scoreOverlayQuery(fields: (string | undefined)[], query: string): number {
  if (!query.trim()) return 0;
  return fuzzyRank(query, [fieldsToSearchText(fields)], value => value)[0]?.score ?? 0;
}

function fieldsToSearchText(fields: (string | undefined)[]): string {
  return fields.filter(Boolean).join(' ');
}
