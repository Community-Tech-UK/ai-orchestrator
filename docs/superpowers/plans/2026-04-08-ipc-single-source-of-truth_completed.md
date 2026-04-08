# IPC Single-Source-of-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate IPC channel drift by generating preload's `IPC_CHANNELS` from the shared definition, hardening the verification script to be bidirectional, and adding contract tests.

**Architecture:** A build-time code generator reads `src/shared/types/ipc.types.ts` (the single source of truth), extracts all channel definitions, and writes them into `src/preload/preload.ts` between generation markers. The existing verify script is upgraded to enforce exact parity (not just subset). A vitest contract test provides a second safety net. All channels are generated into preload — unused constants are harmless since the `electronAPI` wrapper functions control what's actually exposed.

**Tech Stack:** Node.js (generator script), Vitest (contract tests), TypeScript, Electron preload

**Why preload can't just import from shared:** Electron's sandboxed preload (`sandbox: true`) gets a polyfilled `require` that only loads Electron built-in modules. Local file imports fail at runtime. The project compiles preload via `tsc -p tsconfig.electron.json` (CommonJS output), not a bundler. Hence: code generation.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `scripts/generate-preload-channels.js` | Reads shared IPC_CHANNELS, writes them into preload.ts between markers |
| Modify | `src/preload/preload.ts:12-706` | Replace hand-maintained IPC_CHANNELS with generation markers + generated block |
| Modify | `scripts/verify-ipc-channels.js` | Upgrade to bidirectional strict verification |
| Create | `src/preload/__tests__/ipc-channel-contract.spec.ts` | Vitest contract test asserting channel parity |
| Modify | `package.json` | Add `generate:ipc` script, wire into `prebuild` and `prestart` |

---

### Task 1: Add Generation Markers to preload.ts

**Files:**
- Modify: `src/preload/preload.ts:1-706`

This task replaces the hand-maintained `IPC_CHANNELS` block with generation markers. The block content stays identical for now — the generator (Task 2) will own it going forward.

- [ ] **Step 1: Read the current preload.ts to confirm the block boundaries**

Open `src/preload/preload.ts`. Confirm:
- Line 10-11: Comment about duplication
- Line 12: `const IPC_CHANNELS = {`
- Line 706: `} as const;`

- [ ] **Step 2: Replace the comment and opening with a generation marker**

Replace lines 10-12:

```typescript
// IPC Channel names - must match main process exactly
// (Duplicated here because preload can't import from shared)
const IPC_CHANNELS = {
```

With:

```typescript
// --- GENERATED: IPC_CHANNELS START (do not edit manually — run `npm run generate:ipc`) ---
const IPC_CHANNELS = {
```

- [ ] **Step 3: Replace the closing with an end marker**

Replace line 706:

```typescript
} as const;
```

With:

```typescript
} as const;
// --- GENERATED: IPC_CHANNELS END ---
```

- [ ] **Step 4: Verify TypeScript still compiles**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: No errors (markers are just comments, no functional change)

- [ ] **Step 5: Commit**

```bash
git add src/preload/preload.ts
git commit -m "chore: add generation markers to preload IPC_CHANNELS block"
```

---

### Task 2: Create the Channel Generator Script

**Files:**
- Create: `scripts/generate-preload-channels.js`
- Modify: `package.json` (add `generate:ipc` script)

This script reads `src/shared/types/ipc.types.ts`, extracts the entire IPC_CHANNELS object body (preserving comments and formatting), and writes it into `src/preload/preload.ts` between the generation markers.

- [ ] **Step 1: Create the generator script**

Create `scripts/generate-preload-channels.js`:

```javascript
#!/usr/bin/env node
/**
 * IPC Channel Generator
 *
 * Reads IPC_CHANNELS from src/shared/types/ipc.types.ts (the single source
 * of truth) and writes them into src/preload/preload.ts between generation
 * markers. This eliminates manual duplication and channel drift.
 *
 * Usage:
 *   node scripts/generate-preload-channels.js
 *   npm run generate:ipc
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SHARED_PATH = path.join(ROOT, 'src/shared/types/ipc.types.ts');
const PRELOAD_PATH = path.join(ROOT, 'src/preload/preload.ts');

const START_MARKER = '// --- GENERATED: IPC_CHANNELS START (do not edit manually — run `npm run generate:ipc`) ---';
const END_MARKER = '// --- GENERATED: IPC_CHANNELS END ---';

/**
 * Extract the IPC_CHANNELS object body (everything between { and } as const;)
 * from the shared types file, preserving comments and formatting.
 */
function extractChannelBlock(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  let capturing = false;
  let braceDepth = 0;
  const bodyLines = [];

  for (const line of lines) {
    // Detect: export const IPC_CHANNELS = {
    if (!capturing && line.includes('IPC_CHANNELS') && line.includes('{')) {
      capturing = true;
      braceDepth = 1;
      continue;
    }

    if (capturing) {
      // Count braces to handle nested objects (if any future use)
      for (const ch of line) {
        if (ch === '{') braceDepth++;
        if (ch === '}') braceDepth--;
      }

      // If brace depth hit 0, this is the closing line (} as const;)
      if (braceDepth <= 0) {
        break;
      }

      bodyLines.push(line);
    }
  }

  if (bodyLines.length === 0) {
    throw new Error(`Failed to extract IPC_CHANNELS body from ${filePath}`);
  }

  return bodyLines;
}

/**
 * Replace the block between generation markers in preload.ts
 * with the extracted channel definitions.
 */
function writeToPreload(channelBodyLines) {
  const content = fs.readFileSync(PRELOAD_PATH, 'utf-8');

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1) {
    throw new Error(
      `Start marker not found in ${PRELOAD_PATH}.\n` +
      `Expected: ${START_MARKER}\n` +
      `Run Task 1 first to add generation markers.`
    );
  }

  if (endIdx === -1) {
    throw new Error(
      `End marker not found in ${PRELOAD_PATH}.\n` +
      `Expected: ${END_MARKER}`
    );
  }

  // Build the replacement block
  const generatedBlock = [
    START_MARKER,
    'const IPC_CHANNELS = {',
    ...channelBodyLines,
    '} as const;',
    END_MARKER
  ].join('\n');

  // Replace everything from start marker to end marker (inclusive)
  const endOfEndMarker = endIdx + END_MARKER.length;
  const newContent = content.slice(0, startIdx) + generatedBlock + content.slice(endOfEndMarker);

  fs.writeFileSync(PRELOAD_PATH, newContent, 'utf-8');
}

function main() {
  console.log('⚙️  Generating preload IPC channels from shared types...\n');

  // Verify source file exists
  if (!fs.existsSync(SHARED_PATH)) {
    console.error(`❌ Shared types file not found: ${SHARED_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(PRELOAD_PATH)) {
    console.error(`❌ Preload file not found: ${PRELOAD_PATH}`);
    process.exit(1);
  }

  // Extract channels from shared types
  const channelBodyLines = extractChannelBlock(SHARED_PATH);

  // Count channels for reporting
  const channelPattern = /^\s+([A-Z_]+):\s*['"]([^'"]+)['"]/;
  const channelCount = channelBodyLines.filter(l => channelPattern.test(l)).length;
  console.log(`📁 Extracted ${channelCount} channels from shared types`);

  // Write to preload
  writeToPreload(channelBodyLines);

  console.log(`✅ Wrote ${channelCount} channels to preload.ts`);
  console.log('   (between GENERATED markers)\n');
}

main();
```

- [ ] **Step 2: Make the script executable**

Run: `chmod +x scripts/generate-preload-channels.js`

- [ ] **Step 3: Add the npm script to package.json**

In `package.json`, in the `"scripts"` section, add after the `"verify:ipc"` line:

```json
"generate:ipc": "node scripts/generate-preload-channels.js",
```

- [ ] **Step 4: Run the generator and verify it produces identical output**

Run: `npm run generate:ipc`
Expected output:
```
⚙️  Generating preload IPC channels from shared types...

📁 Extracted ~657 channels from shared types
✅ Wrote ~657 channels to preload.ts
   (between GENERATED markers)
```

Then verify no functional diff in the channel block:

Run: `git diff src/preload/preload.ts`

Expected: The diff should show:
1. The old duplication comment replaced by the start marker
2. **New channels added** (the ~195 channels that were in shared but missing from preload)
3. The end marker added after `} as const;`
4. No changes to the `electronAPI` object or any wrapper functions

- [ ] **Step 5: Verify TypeScript still compiles**

Run: `npx tsc --noEmit -p tsconfig.electron.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-preload-channels.js package.json src/preload/preload.ts
git commit -m "feat: add IPC channel generator — single source of truth from shared types"
```

---

### Task 3: Harden the Verification Script

**Files:**
- Modify: `scripts/verify-ipc-channels.js`

The current verify script only errors when preload has channels not in shared (preload ⊆ shared). With the generator, we now enforce **exact equality**: every shared channel must be in preload, and vice versa. Warnings become errors.

- [ ] **Step 1: Read the current verify script**

Open `scripts/verify-ipc-channels.js`. Confirm the structure matches what we expect (lines 1-167).

- [ ] **Step 2: Replace Check 2 (informational warnings) with strict errors**

Replace lines 106-119 (the "Check 2" block):

```javascript
  // Check 2: Warn about shared channels not in preload (informational)
  const missingInPreload = [];
  for (const sharedChannel of sharedChannels) {
    if (!preloadByName.has(sharedChannel.name)) {
      missingInPreload.push(sharedChannel);
    }
  }

  if (missingInPreload.length > 0) {
    warnings.push(
      `ℹ️  ${missingInPreload.length} channels in ipc.types.ts are not exposed in preload.ts ` +
      `(this may be intentional for main-process-only channels)`
    );
  }
```

With:

```javascript
  // Check 2: All shared channels must exist in preload (bidirectional sync)
  // Since channels are now generated, any mismatch means the generator wasn't run.
  const missingInPreload = [];
  for (const sharedChannel of sharedChannels) {
    if (!preloadByName.has(sharedChannel.name)) {
      missingInPreload.push(sharedChannel);
    }
  }

  if (missingInPreload.length > 0) {
    errors.push(
      `❌ ${missingInPreload.length} channel(s) in ipc.types.ts are missing from preload.ts.\n` +
      `   Run \`npm run generate:ipc\` to regenerate.\n` +
      `   Missing: ${missingInPreload.slice(0, 10).map(c => c.name).join(', ')}` +
      (missingInPreload.length > 10 ? ` ... and ${missingInPreload.length - 10} more` : '')
    );
  }
```

- [ ] **Step 3: Update the script header comment**

Replace lines 2-6:

```javascript
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies that IPC channels defined in preload.ts are a subset of those
 * defined in shared/types/ipc.types.ts. Run during build to catch drift.
 *
 * Usage:
 *   node scripts/verify-ipc-channels.js
 *   npm run verify:ipc
 */
```

With:

```javascript
/**
 * IPC Channel Sync Verification Script
 *
 * Verifies BIDIRECTIONAL sync: preload.ts and ipc.types.ts must have
 * identical IPC_CHANNELS. Since preload channels are now generated from
 * shared types, any mismatch means `npm run generate:ipc` wasn't run.
 *
 * Usage:
 *   node scripts/verify-ipc-channels.js
 *   npm run verify:ipc
 */
```

- [ ] **Step 4: Update the summary output to reflect bidirectional checking**

Replace lines 150-158 (the success summary):

```javascript
  if (errors.length === 0) {
    console.log('✅ IPC channels are synchronized!\n');

    // Print summary
    console.log('Summary:');
    console.log(`  - ${preloadChannels.length} channels exposed to renderer`);
    console.log(`  - ${sharedChannels.length} channels defined in types`);
    console.log(`  - ${missingInPreload.length} main-process-only channels`);

    process.exit(0);
```

With:

```javascript
  if (errors.length === 0) {
    console.log('✅ IPC channels are synchronized (bidirectional)!\n');

    // Print summary
    console.log('Summary:');
    console.log(`  - ${sharedChannels.length} channels in shared types`);
    console.log(`  - ${preloadChannels.length} channels in preload`);

    if (preloadChannels.length !== sharedChannels.length) {
      console.log(`  ⚠️  Count mismatch (${sharedChannels.length} vs ${preloadChannels.length}) — channel names match but counts differ`);
    }

    process.exit(0);
```

- [ ] **Step 5: Run the verify script to confirm it passes after generation**

Run: `npm run verify:ipc`
Expected:
```
🔍 Verifying IPC channel synchronization...

📁 Preload channels: ~657
📁 Shared type channels: ~657

✅ IPC channels are synchronized (bidirectional)!

Summary:
  - ~657 channels in shared types
  - ~657 channels in preload
```

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-ipc-channels.js
git commit -m "fix: make IPC verify script bidirectional — shared-only channels are now errors"
```

---

### Task 4: Add Contract Test

**Files:**
- Create: `src/preload/__tests__/ipc-channel-contract.spec.ts`

A vitest test that imports both channel definitions and asserts exact parity at the type/value level. This catches drift even if someone forgets to run the generator AND the build step.

- [ ] **Step 1: Create the test directory**

Run: `mkdir -p src/preload/__tests__`
(from the project root `/Users/suas/work/orchestrat0r/ai-orchestrator`)

- [ ] **Step 2: Write the contract test**

Create `src/preload/__tests__/ipc-channel-contract.spec.ts`:

```typescript
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
```

- [ ] **Step 3: Run the contract test**

Run: `npx vitest run src/preload/__tests__/ipc-channel-contract.spec.ts`
Expected: All 6 tests pass:
```
✓ IPC Channel Contract
  ✓ should have channels defined in both files
  ✓ should have the same number of channels in shared and preload
  ✓ should have every shared channel present in preload
  ✓ should have every preload channel present in shared
  ✓ should have matching values for all channels
  ✓ should have no duplicate channel values
```

- [ ] **Step 4: Verify spec tsconfig includes the new test**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors. The test file matches `src/**/*.spec.ts` in `tsconfig.spec.json`'s include patterns.

- [ ] **Step 5: Commit**

```bash
git add src/preload/__tests__/ipc-channel-contract.spec.ts
git commit -m "test: add IPC channel contract test — bidirectional parity assertion"
```

---

### Task 5: Wire Generator Into Build Pipeline

**Files:**
- Modify: `package.json:12` (the `prebuild` script)
- Modify: `package.json:11` (the `prestart` script)

The generator must run before the verify script, and both must run before build and dev start.

- [ ] **Step 1: Update `prebuild` to run generator before verify**

In `package.json`, replace line 12:

```json
"prebuild": "node scripts/check-node.js && npm run verify:ipc",
```

With:

```json
"prebuild": "node scripts/check-node.js && npm run generate:ipc && npm run verify:ipc",
```

- [ ] **Step 2: Update `prestart` to also generate and verify**

In `package.json`, replace line 11:

```json
"prestart": "node scripts/check-node.js",
```

With:

```json
"prestart": "node scripts/check-node.js && npm run generate:ipc && npm run verify:ipc",
```

- [ ] **Step 3: Verify the full build pipeline**

Run: `npm run prebuild`
Expected output (in order):
1. Node version check passes
2. Generator runs and reports channel count
3. Verify script runs and reports bidirectional sync

Run: `npm run build:main`
Expected: TypeScript compilation succeeds with no errors

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: wire IPC generator into prebuild and prestart pipelines"
```

---

### Task 6: End-to-End Verification

**Files:** None (verification only)

This task proves the system works by simulating a real drift scenario and confirming it's caught.

- [ ] **Step 1: Run the full test suite to confirm nothing is broken**

Run: `npm run test`
Expected: All tests pass, including the new contract test.

- [ ] **Step 2: Run lint to confirm no style issues**

Run: `npm run lint`
Expected: No new errors from any modified or created files.

- [ ] **Step 3: Simulate drift — add a channel to shared, skip generator**

Temporarily add a test channel to `src/shared/types/ipc.types.ts`, at the end of the object (before `} as const;`):

```typescript
  // Temporary test channel (DELETE AFTER VERIFICATION)
  _TEST_DRIFT_DETECTION: '_test:drift-detection',
```

- [ ] **Step 4: Confirm verify script catches the drift**

Run: `npm run verify:ipc`
Expected: **FAILURE** with error:
```
❌ 1 channel(s) in ipc.types.ts are missing from preload.ts.
   Run `npm run generate:ipc` to regenerate.
   Missing: _TEST_DRIFT_DETECTION
```

- [ ] **Step 5: Confirm contract test also catches the drift**

Run: `npx vitest run src/preload/__tests__/ipc-channel-contract.spec.ts`
Expected: **FAILURE** on "should have the same number of channels" and "should have every shared channel present in preload"

- [ ] **Step 6: Run generator to fix the drift**

Run: `npm run generate:ipc`
Expected: Generator picks up the new channel and writes it to preload.

Run: `npm run verify:ipc`
Expected: Passes.

Run: `npx vitest run src/preload/__tests__/ipc-channel-contract.spec.ts`
Expected: All tests pass.

- [ ] **Step 7: Clean up — remove the test channel**

Remove the `_TEST_DRIFT_DETECTION` line from `src/shared/types/ipc.types.ts`.

Run: `npm run generate:ipc && npm run verify:ipc`
Expected: Both pass with the original channel count.

- [ ] **Step 8: Final commit**

```bash
git add -A
git commit -m "chore: verify IPC single-source-of-truth pipeline works end-to-end"
```

---

## Summary

After completing all 6 tasks:

| Before | After |
|--------|-------|
| ~657 channels in shared, ~462 in preload (195 gap) | All channels generated from shared — exact parity |
| Verify script only checked preload ⊆ shared | Bidirectional: shared = preload enforced |
| Shared-only channels were silent warnings | Missing channels are hard errors with actionable fix command |
| No test coverage for channel sync | Vitest contract test with 6 assertions |
| Manual duplication between two files | Build-time code generation from single source |
| Drift could ship unnoticed | Caught by generator, verify script, contract test, and prebuild hook |

**Build pipeline flow:**
```
npm run build
  → prebuild: check-node → generate:ipc → verify:ipc
  → build:renderer (ng build)
  → build:main (tsc)
```

**Developer workflow for adding a new IPC channel:**
1. Add the channel to `src/shared/types/ipc.types.ts`
2. Run `npm run generate:ipc` (or just `npm run build` — it runs automatically)
3. Add handler in `src/main/ipc/handlers/`
4. Add wrapper in `src/preload/preload.ts` `electronAPI` object (this is still manual — only the channel constant is generated)
5. Add renderer service method
