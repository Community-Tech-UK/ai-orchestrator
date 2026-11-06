/**
 * Plan 5a adapter-factory test: Harness-started Claude spawns get the machine
 * ceiling and a person's own chats get the chat ceiling, all the way to the
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable on the spawned process.
 *
 * The default settings reader loads the settings manager with a bare
 * `require()`, which vitest does not route through `vi.mock`, so the resolver
 * is replaced here with one that applies the same machine-or-chat split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MACHINE_CEILING = 300_000;
const CHAT_CEILING = 200_000;

vi.mock('../context-ceiling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context-ceiling')>()),
  resolveContextCeilingTokens: (machineSession: boolean) =>
    machineSession ? MACHINE_CEILING : CHAT_CEILING,
}));

import { applyInstanceSpawnPolicy } from '../../../instance/lifecycle/instance-spawn-policy';
import { createCliAdapter } from '../adapter-factory';
import type { BaseCliAdapter } from '../base-cli-adapter';

const WINDOW_VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
const base = { workingDirectory: '/tmp' };
const windowVarOf = (adapter: unknown): string | undefined =>
  (adapter as BaseCliAdapter).getConfig().env?.[WINDOW_VAR];

describe('adapter factory — context ceiling wiring', () => {
  let inherited: string | undefined;
  beforeEach(() => {
    inherited = process.env[WINDOW_VAR];
    delete process.env[WINDOW_VAR];
  });
  afterEach(() => {
    if (inherited === undefined) delete process.env[WINDOW_VAR];
    else process.env[WINDOW_VAR] = inherited;
  });

  it('gives a Harness-started Claude spawn the machine ceiling', () => {
    expect(windowVarOf(createCliAdapter('claude', { ...base, machineSession: 'loop' })))
      .toBe(String(MACHINE_CEILING));
  });

  it('gives a person\'s own Claude chat the chat ceiling', () => {
    expect(windowVarOf(createCliAdapter('claude', { ...base }))).toBe(String(CHAT_CEILING));
  });

  it('keeps an explicit ceiling over the settings, and 0 leaves the variable unset', () => {
    expect(windowVarOf(createCliAdapter('claude', { ...base, machineSession: 'loop', contextCeilingTokens: 150_000 })))
      .toBe('150000');
    expect(windowVarOf(createCliAdapter('claude', { ...base, machineSession: 'loop', contextCeilingTokens: 0 })))
      .toBeUndefined();
  });
});

describe('instance spawn policy — context ceiling', () => {
  const ownChat = { depth: 0, parentId: null, metadata: {}, id: 'chat' };
  const child = { depth: 1, parentId: 'parent', metadata: {}, id: 'child' };
  const reviewer = { depth: 0, parentId: null, metadata: { pingPongReviewer: true }, id: 'review' };

  it('stamps the machine ceiling on Harness-started Claude sessions and the chat ceiling on own chats', () => {
    expect(applyInstanceSpawnPolicy('claude', child, {}).contextCeilingTokens).toBe(MACHINE_CEILING);
    expect(applyInstanceSpawnPolicy('claude', reviewer, {}).contextCeilingTokens).toBe(MACHINE_CEILING);
    expect(applyInstanceSpawnPolicy('claude', ownChat, {}).contextCeilingTokens).toBe(CHAT_CEILING);
  });

  it('keeps an explicit ceiling and sets none for other providers', () => {
    expect(applyInstanceSpawnPolicy('claude', child, { contextCeilingTokens: 0 }).contextCeilingTokens).toBe(0);
    expect(applyInstanceSpawnPolicy('codex', child, {}).contextCeilingTokens).toBeUndefined();
  });

  it('reaches the spawned process through the factory for a machine child and an own chat', () => {
    const machine = applyInstanceSpawnPolicy('claude', child, { ...base });
    const chat = applyInstanceSpawnPolicy('claude', ownChat, { ...base });
    expect(windowVarOf(createCliAdapter('claude', machine))).toBe(String(MACHINE_CEILING));
    expect(windowVarOf(createCliAdapter('claude', chat))).toBe(String(CHAT_CEILING));
  });
});
