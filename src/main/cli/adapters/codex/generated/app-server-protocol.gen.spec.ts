import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_PROTOCOL,
  CODEX_APP_SERVER_PROTOCOL_VERSION,
} from './app-server-protocol.gen';

describe('generated Codex app-server protocol manifest', () => {
  it('pins the installed Codex CLI contract used to generate the manifest', () => {
    expect(CODEX_APP_SERVER_PROTOCOL_VERSION).toMatch(/^codex-cli \d+\.\d+\.\d+$/);
    expect(CODEX_APP_SERVER_PROTOCOL.sourceHashes['v2/TurnStartParams.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(CODEX_APP_SERVER_PROTOCOL.sourceHashes['v2/TurnInterruptResponse.ts']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('contains every request and notification Harness consumes', () => {
    expect(CODEX_APP_SERVER_PROTOCOL.clientRequestMethods).toEqual(expect.arrayContaining([
      'initialize',
      'thread/start',
      'thread/resume',
      'thread/list',
      'thread/read',
      'thread/compact/start',
      'turn/start',
      'turn/interrupt',
    ]));
    expect(CODEX_APP_SERVER_PROTOCOL.serverNotificationMethods).toEqual(expect.arrayContaining([
      'thread/started',
      'thread/compacted',
      'turn/started',
      'turn/completed',
      'item/started',
      'item/completed',
      'item/agentMessage/delta',
      'error',
    ]));
  });

  it('records the generated empty response and effort parameter contracts', () => {
    expect(CODEX_APP_SERVER_PROTOCOL.responseContracts['turn/interrupt']).toEqual({
      kind: 'empty-object',
      requiredKeys: [],
    });
    expect(CODEX_APP_SERVER_PROTOCOL.responseContracts['thread/compact/start']).toEqual({
      kind: 'empty-object',
      requiredKeys: [],
    });
    expect(CODEX_APP_SERVER_PROTOCOL.requestContracts['turn/start']).toMatchObject({
      requiredKeys: ['threadId', 'input'],
      supportedKeys: expect.arrayContaining(['effort', 'serviceTier', 'outputSchema']),
    });
    expect(CODEX_APP_SERVER_PROTOCOL.requestContracts['turn/start'].supportedKeys)
      .not.toContain('reasoningEffort');
    expect(CODEX_APP_SERVER_PROTOCOL.requestContracts['thread/start'].supportedKeys)
      .not.toEqual(expect.arrayContaining(['effort', 'reasoningEffort']));
  });
});
