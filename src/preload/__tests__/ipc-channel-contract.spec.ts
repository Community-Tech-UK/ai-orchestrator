/**
 * IPC Channel Contract Test
 *
 * Ensures the preload IPC_CHANNELS block (generated from shared types)
 * stays in exact sync with the shared definition. This is a safety net
 * on top of the build-time verify script.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

const SHARED_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');

/**
 * Extract channel name→value pairs from a TypeScript file containing IPC_CHANNELS.
 * Uses the same regex approach as the verify script for consistency.
 */
function extractChannels(filePath: string): Map<string, string> {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const channels = new Map<string, string>();

  const channelPattern = /^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/;
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
  const sharedChannels = extractChannels(SHARED_PATH);
  const preloadChannels = extractChannels(PRELOAD_PATH);

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
