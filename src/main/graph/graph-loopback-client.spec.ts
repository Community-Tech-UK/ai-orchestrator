import { describe, expect, it } from 'vitest';
import {
  GraphInteractiveTimeoutError,
  TimedGraphLoopbackClient,
} from './graph-loopback-client';

describe('TimedGraphLoopbackClient', () => {
  it('captures the loopback authorization response and closes cleanly', async () => {
    const client = new TimedGraphLoopbackClient(1_000);
    const responsePromise = client.listenForAuthCode();
    const redirectUri = await waitForRedirectUri(client);

    const browserResponse = await fetch(
      `${redirectUri}?code=code-placeholder&state=state-placeholder&client_info=client-placeholder`,
    );

    await expect(browserResponse.text()).resolves.toContain('successfully acquired');
    await expect(responsePromise).resolves.toMatchObject({
      code: 'code-placeholder',
      state: 'state-placeholder',
      client_info: 'client-placeholder',
    });
    client.closeServer();
  });

  it('rejects and closes an abandoned interactive login after its deadline', async () => {
    const client = new TimedGraphLoopbackClient(10);
    const responsePromise = client.listenForAuthCode();

    await expect(responsePromise).rejects.toBeInstanceOf(GraphInteractiveTimeoutError);
    expect(() => client.getRedirectUri()).toThrow(/not listening/);
  });
});

async function waitForRedirectUri(client: TimedGraphLoopbackClient): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return client.getRedirectUri();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error('loopback server did not start');
}
