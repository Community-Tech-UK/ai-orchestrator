/**
 * Factory-level cover for the ACP stall watchdog.
 *
 * The watchdog is fully implemented in AcpCliAdapter, but it only runs when a
 * caller passes `stallWarningMs`. Before this test only `createCopilotAdapter`
 * did, and only for child instances — so every Cursor and Grok session, and
 * every top-level chat on any ACP provider, ran with the watchdog switched off.
 * A cursor-agent session that went silent after a completed tool result showed
 * the user nothing for ten minutes and then failed the turn outright.
 *
 * Asserting on the constructed config is adequate here (unlike the spawn-env
 * case in copilot-acp-spawn-env.spec.ts): `stallWarningMs` has no overlay or
 * merge path — `armStallWatchdog` reads `acpConfig.stallWarningMs` directly,
 * and acp-cli-adapter.spec.ts covers what the adapter does with the value.
 */
import { describe, expect, it } from 'vitest';

import {
  createCopilotAdapter,
  createCursorAdapter,
  createGrokAdapter,
} from './adapter-factory';
import type { AcpCliAdapter } from './acp-cli-adapter';


/** Every Copilot spawn requires a resolved account route; the factory fails closed without one. */
const COPILOT_TEST_ROUTE = {
  profileId: 'legacy',
  source: 'legacy',
  executionNodeId: 'local',
} as const;

function stallWarningMs(adapter: AcpCliAdapter): number | undefined {
  return (adapter as unknown as { acpConfig: { stallWarningMs?: number } }).acpConfig.stallWarningMs;
}

const factories = [
  ['cursor', (childId?: string) => createCursorAdapter({ workingDirectory: '/tmp', ...(childId ? { childId } : {}) })],
  ['grok', (childId?: string) => createGrokAdapter({ workingDirectory: '/tmp', ...(childId ? { childId } : {}) })],
  [
    'copilot',
    (childId?: string) => createCopilotAdapter({
      workingDirectory: '/tmp',
      copilotAccountRoute: COPILOT_TEST_ROUTE,
      ...(childId ? { childId } : {}),
    }),
  ],
] as const;

describe('ACP stall watchdog wiring', () => {
  // Asserted against literals rather than the exported constants: comparing a
  // factory's output to the constant it was built from stays green even if the
  // constant is zeroed, which disables the watchdog entirely.
  it.each(factories)('arms the watchdog for a top-level %s session', (_name, build) => {
    const configured = stallWarningMs(build());

    expect(configured).toBe(300_000);
    expect(configured!).toBeGreaterThan(0);
  });

  it.each(factories)('keeps the tighter child interval for %s children', (_name, build) => {
    const configured = stallWarningMs(build('child-1'));

    expect(configured).toBe(90_000);
    expect(configured!).toBeGreaterThan(0);
  });
});
