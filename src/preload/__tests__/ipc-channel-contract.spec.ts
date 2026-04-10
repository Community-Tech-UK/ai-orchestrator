/**
 * IPC Channel Contract Test
 *
 * Ensures the preload IPC_CHANNELS block (generated from the contracts package)
 * stays in exact sync with the contract definitions. The legacy shim is covered
 * separately by the contracts identity test.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

const CONTRACTS_INDEX_PATH = path.join(ROOT, 'packages/contracts/src/channels/index.ts');
const GENERATED_PRELOAD_CHANNELS_PATH = path.join(
  ROOT,
  'src/preload/generated/channels.ts',
);

function getContractsChannelFiles(indexPath: string): string[] {
  const content = fs.readFileSync(indexPath, 'utf-8');
  const files: string[] = [];
  const importPattern = /^import\s+\{\s*[A-Z0-9_]+\s*\}\s+from\s+['"](\.\/[^'"]+\.channels)['"];?$/;

  for (const line of content.split('\n')) {
    const match = line.match(importPattern);
    if (match) {
      files.push(path.resolve(path.dirname(indexPath), `${match[1]}.ts`));
    }
  }

  return files;
}

function extractContractsChannels(indexPath: string): Map<string, string> {
  const channels = new Map<string, string>();
  const channelPattern = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;

  for (const filePath of getContractsChannelFiles(indexPath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let capturing = false;
    let braceDepth = 0;

    for (const line of lines) {
      if (!capturing && line.includes('export const') && line.includes('= {')) {
        capturing = true;
        braceDepth = 1;
        continue;
      }

      if (!capturing) {
        continue;
      }

      for (const ch of line) {
        if (ch === '{') braceDepth += 1;
        if (ch === '}') braceDepth -= 1;
      }

      if (braceDepth <= 0) {
        break;
      }

      const match = line.match(channelPattern);
      if (match) {
        channels.set(match[1], match[2]);
      }
    }
  }

  return channels;
}

/**
 * Extract channel name→value pairs from a generated TypeScript file containing
 * the preload IPC_CHANNELS object. Uses the same IPC object parsing approach as
 * the verify script.
 */
function extractChannels(filePath: string): Map<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const channels = new Map<string, string>();

  const channelPattern = /^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/;
  let inIpcChannels = false;

  for (const line of lines) {
    if (line.includes('IPC_CHANNELS') && line.includes('{')) {
      inIpcChannels = true;
      continue;
    }

    if (inIpcChannels && /^}\s*(as const)?;?\s*$/.test(line.trim())) {
      inIpcChannels = false;
      continue;
    }

    if (inIpcChannels) {
      const match = line.match(channelPattern);
      if (match) {
        channels.set(match[1], match[2]);
      }
    }
  }

  return channels;
}

describe('IPC Channel Contract', () => {
  const sharedChannels = extractContractsChannels(CONTRACTS_INDEX_PATH);
  const preloadChannels = extractChannels(GENERATED_PRELOAD_CHANNELS_PATH);

  it('should have channels defined in both files', () => {
    expect(sharedChannels.size).toBeGreaterThan(0);
    expect(preloadChannels.size).toBeGreaterThan(0);
  });

  it('should have the same number of channels in shared and preload', () => {
    expect(preloadChannels.size).toBe(sharedChannels.size);
  });

  it('should have every shared channel present in preload', () => {
    const missingInPreload: string[] = [];
    for (const [name] of sharedChannels) {
      if (!preloadChannels.has(name)) {
        missingInPreload.push(name);
      }
    }
    expect(missingInPreload).toEqual([]);
  });

  it('should have every preload channel present in shared', () => {
    const missingInShared: string[] = [];
    for (const [name] of preloadChannels) {
      if (!sharedChannels.has(name)) {
        missingInShared.push(name);
      }
    }
    expect(missingInShared).toEqual([]);
  });

  it('should have matching values for all channels', () => {
    const mismatches: string[] = [];
    for (const [name, sharedValue] of sharedChannels) {
      const preloadValue = preloadChannels.get(name);
      if (preloadValue !== undefined && preloadValue !== sharedValue) {
        mismatches.push(
          `${name}: shared='${sharedValue}' vs preload='${preloadValue}'`
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('should have no duplicate channel values', () => {
    const valueToNames = new Map<string, string[]>();
    for (const [name, value] of sharedChannels) {
      const existing = valueToNames.get(value) || [];
      existing.push(name);
      valueToNames.set(value, existing);
    }

    const duplicates: string[] = [];
    for (const [value, names] of valueToNames) {
      if (names.length > 1) {
        duplicates.push(`'${value}' used by: ${names.join(', ')}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
