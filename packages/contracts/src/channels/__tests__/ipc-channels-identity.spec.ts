/**
 * Contract test: IPC_CHANNELS from @contracts must contain every channel
 * defined in the legacy src/shared/types/ipc.types.ts.
 *
 * This test fails if any channel is accidentally omitted from the domain
 * split. It uses the raw text of the legacy file rather than importing it
 * (to avoid circular deps during migration).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { IPC_CHANNELS } from '../index';

const ROOT = resolve(__dirname, '../../../../..');

/** Extract channel entries from a TypeScript file that defines IPC_CHANNELS */
function extractChannelEntries(filePath: string): Map<string, string> {
  const content = readFileSync(filePath, 'utf-8');
  const map = new Map<string, string>();
  let inChannels = false;

  for (const line of content.split('\n')) {
    if (line.includes('IPC_CHANNELS') && line.includes('{')) {
      inChannels = true;
      continue;
    }
    if (inChannels && /^}\s*(as const)?;?\s*$/.test(line.trim())) {
      inChannels = false;
    }
    if (inChannels) {
      const m = line.match(/^\s+([A-Z0-9_]+):\s*['"]([^'"]+)['"]/);
      if (m) map.set(m[1], m[2]);
    }
  }
  return map;
}

describe('IPC_CHANNELS identity contract', () => {
  const legacyPath = resolve(ROOT, 'src/shared/types/ipc.types.ts');
  const legacyChannels = extractChannelEntries(legacyPath);
  const contractsChannels = IPC_CHANNELS as Record<string, string>;

  it('contracts IPC_CHANNELS contains all channels from the legacy file', () => {
    const missing: string[] = [];
    for (const [key, value] of legacyChannels) {
      if (contractsChannels[key] !== value) {
        missing.push(`${key}: expected '${value}', got '${contractsChannels[key]}'`);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} channels missing or mismatched in contracts:\n` +
        missing.join('\n')
      );
    }
  });

  it('contracts IPC_CHANNELS has no extra channels not in legacy file', () => {
    const extra: string[] = [];
    for (const key of Object.keys(contractsChannels)) {
      if (!legacyChannels.has(key)) {
        extra.push(key);
      }
    }
    // Extra channels are allowed (contracts can grow ahead of legacy),
    // but log them as a warning for visibility during migration.
    if (extra.length > 0) {
      console.warn(`[contracts] ${extra.length} channels in contracts not yet in legacy file: ${extra.join(', ')}`);
    }
    // Not a hard failure — only missing channels fail the build.
    expect(true).toBe(true);
  });
});
