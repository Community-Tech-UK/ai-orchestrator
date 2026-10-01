/**
 * Factory-level cover for durable ACP image attachments.
 *
 * Copilot deletes its $TMPDIR copy of every inline image when the ACP session
 * closes, and hibernation closes it cleanly — so after a resume the transcript
 * pointed the model at screenshots that no longer existed. The adapter only
 * sends a durable file:// copy when `persistImageAttachments` is set, and
 * acp-cli-adapter.spec.ts covers what it does with the flag; this pins that
 * the Copilot factory actually sets it. Other ACP agents have not been
 * verified to honour a file:// image uri, so they stay inline-only.
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

function persistsImages(adapter: AcpCliAdapter): boolean | undefined {
  return (adapter as unknown as { acpConfig: { persistImageAttachments?: boolean } })
    .acpConfig.persistImageAttachments;
}

describe('ACP image attachment persistence wiring', () => {
  it('persists image attachments for Copilot sessions', () => {
    expect(persistsImages(createCopilotAdapter({
      workingDirectory: '/tmp',
      copilotAccountRoute: COPILOT_TEST_ROUTE,
    }))).toBe(true);
  });

  it('leaves unverified ACP agents on inline-only images', () => {
    expect(persistsImages(createCursorAdapter({ workingDirectory: '/tmp' }))).toBeFalsy();
    expect(persistsImages(createGrokAdapter({ workingDirectory: '/tmp' }))).toBeFalsy();
  });
});
