/**
 * Frozen Phase 0 incident manifest loader/expander.
 *
 * Deliberately dependency-light (only `node:fs`/`node:path`) so it can be
 * imported by context-evidence-baseline.spec.ts, which globally mocks
 * `fs/promises` for its own OutputPersistenceManager assertions — pulling in
 * the heavier evidence-runtime harness there would fight that mock. Reused by
 * both context-evidence-baseline.spec.ts and incident-replay-harness.ts so
 * the manifest shape and expansion algorithm exist in exactly one place.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IncidentManifestGroup {
  category: string;
  toolName: string;
  callCount: number;
  externalizableCount: number;
  resultCharacters: number;
  fillCharacter: string;
}

export interface IncidentManifest {
  schemaVersion: 1;
  incident: {
    initialInputTokens: number;
    modelRequests: number;
    currentOccupancyTokens: number;
    contextWindowTokens: number;
    cumulativeProcessingTokens: number;
  };
  controlledUngovernedBaseline: {
    cumulativeInputTokens: number;
    cachedInputTokens: number;
    cacheAssumption: string;
  };
  generator: {
    algorithm: 'quotient-remainder-ascii';
    groups: IncidentManifestGroup[];
  };
}

export interface ExpandedIncidentCall {
  index: number;
  category: string;
  toolName: string;
  externalizable: boolean;
  result: string;
}

const MANIFEST_PATH = 'src/main/context-evidence/__fixtures__/codex-44-call-incident.manifest.json';

/** Loads the frozen Phase 0 manifest (raw text + parsed) from the repo root. */
export function readIncidentManifest(): { raw: string; manifest: IncidentManifest } {
  const raw = readFileSync(resolve(process.cwd(), MANIFEST_PATH), 'utf8');
  return { raw, manifest: JSON.parse(raw) as IncidentManifest };
}

/** Deterministically expands the compact manifest groups into 44 individual calls. */
export function expandIncidentManifest(manifest: IncidentManifest): ExpandedIncidentCall[] {
  let cursor = 0;
  return manifest.generator.groups.flatMap((group) => {
    const baseCharacters = Math.floor(group.resultCharacters / group.callCount);
    const remainder = group.resultCharacters % group.callCount;
    return Array.from({ length: group.callCount }, (_, indexInGroup) => ({
      index: cursor++,
      category: group.category,
      toolName: group.toolName,
      externalizable: indexInGroup < group.externalizableCount,
      result: group.fillCharacter.repeat(baseCharacters + (indexInGroup < remainder ? 1 : 0)),
    }));
  });
}
