/**
 * Checks on migration numbering. A version that has run on a real database is never renumbered, so
 * a clash has to be caught before it ships rather than repaired after (the 031 livetest-port
 * incident). Pure and database-free so a test can feed it deliberately broken lists.
 */

export interface NumberedMigration {
  version: number;
  name: string;
}

export interface ReservedMigration extends NumberedMigration {
  purpose: string;
}

/** Plain-English descriptions of every numbering problem; empty when the list is sound. */
export function findMigrationNumberProblems(
  migrations: readonly NumberedMigration[],
  reserved: readonly ReservedMigration[] = [],
): string[] {
  const problems: string[] = [];
  const versions = new Map<number, string>();
  const names = new Map<string, number>();
  let previous = 0;

  for (const { version, name } of migrations) {
    if (!Number.isInteger(version) || version < 1) problems.push(`${name}: version ${version} is not a positive whole number`);
    const sameVersion = versions.get(version);
    if (sameVersion !== undefined) problems.push(`version ${version} is used by both ${sameVersion} and ${name}`);
    versions.set(version, name);
    const sameName = names.get(name);
    if (sameName !== undefined) problems.push(`name ${name} is used by versions ${sameName} and ${version}`);
    names.set(name, version);
    if (version <= previous && sameVersion === undefined) problems.push(`${name}: version ${version} does not come after ${previous}`);
    previous = Math.max(previous, version);
    const prefix = /^(\d+)_/.exec(name);
    if (!prefix || Number(prefix[1]) !== version) problems.push(`${name}: the name does not start with its version ${version}`);
  }

  const reservedVersions = new Set<number>();
  for (const entry of reserved) {
    if (reservedVersions.has(entry.version)) problems.push(`reserved version ${entry.version} is listed twice`);
    reservedVersions.add(entry.version);
    const existing = versions.get(entry.version);
    // A reserved number may be unused so far, but once used it must be by the migration it was held for.
    if (existing !== undefined && existing !== entry.name) {
      problems.push(`reserved version ${entry.version} (${entry.name}) is used by ${existing}`);
    }
    const takenName = names.get(entry.name);
    if (takenName !== undefined && takenName !== entry.version) {
      problems.push(`reserved name ${entry.name} is used by version ${takenName}, not ${entry.version}`);
    }
  }
  return problems;
}
