import { describe, expect, it } from 'vitest';
import {
  GraphInteractiveTimeoutError,
  TimedGraphLoopbackClient,
} from './graph-loopback-client';

describe('TimedGraphLoopbackClient', () => {
  it('captures the loopback authorization response and closes cleanly', async () => {
    const client = new TimedGraphLoopbackClient(1_000, 'state-placeholder');
    let browserResponse: Promise<Response> | undefined;
    const responsePromise = client.listenForAuthCode(async (redirectUri) => {
      browserResponse = postResponse(redirectUri, {
        code: 'code-placeholder',
        state: 'state-placeholder',
        client_info: 'client-placeholder',
      });
      await browserResponse;
    });

    await expect(responsePromise).resolves.toMatchObject({
      response: {
        code: 'code-placeholder',
        state: 'state-placeholder',
        client_info: 'client-placeholder',
      },
    });
    await expect(browserResponse?.then((value) => value.text())).resolves.toContain('successfully acquired');
    expect(() => client.getRedirectUri()).toThrow(/not listening/);
  });

  it('rejects and closes an abandoned interactive login after its deadline', async () => {
    const client = new TimedGraphLoopbackClient(10, 'state-placeholder');
    let redirectUri = '';
    const responsePromise = client.listenForAuthCode(async (value) => { redirectUri = value; });

    await expect(responsePromise).rejects.toBeInstanceOf(GraphInteractiveTimeoutError);
    expect(() => client.getRedirectUri()).toThrow(/not listening/);
    await expect(fetch(redirectUri, { signal: AbortSignal.timeout(200) })).rejects.toThrow();
  });

  it('rejects OAuth query responses and ignores a forged state before accepting the form post', async () => {
    const client = new TimedGraphLoopbackClient(1_000, 'state-placeholder');
    const rejectedStatuses: number[] = [];
    const responsePromise = client.listenForAuthCode(async (redirectUri) => {
      const query = await fetch(`${redirectUri}?code=query-code-placeholder&state=state-placeholder`);
      rejectedStatuses.push(query.status);
      await query.arrayBuffer();
      const forged = await postResponse(redirectUri, {
        code: 'forged-code-placeholder',
        state: 'wrong-state-placeholder',
      });
      rejectedStatuses.push(forged.status);
      await forged.arrayBuffer();
      await postResponse(redirectUri, { code: 'code-placeholder', state: 'state-placeholder' });
    });

    await expect(responsePromise).resolves.toMatchObject({
      response: { code: 'code-placeholder', state: 'state-placeholder' },
    });
    expect(rejectedStatuses).toEqual([400, 400]);
  });

  it('rejects oversized form responses without preventing a subsequent valid callback', async () => {
    const client = new TimedGraphLoopbackClient(1_000, 'state-placeholder');
    let oversizedStatus: number | undefined;
    const responsePromise = client.listenForAuthCode(async (redirectUri) => {
      const oversized = await postResponse(redirectUri, {
        code: 'x'.repeat(20_000),
        state: 'state-placeholder',
      });
      oversizedStatus = oversized.status;
      await oversized.arrayBuffer();
      await postResponse(redirectUri, { code: 'code-placeholder', state: 'state-placeholder' });
    });

    await expect(responsePromise).resolves.toMatchObject({ response: { code: 'code-placeholder' } });
    expect(oversizedStatus).toBe(413);
  });

  it('rejects unsupported and ambiguous callbacks while keeping the valid attempt alive', async () => {
    const client = new TimedGraphLoopbackClient(1_000, 'state-placeholder');
    const statuses: number[] = [];
    const responsePromise = client.listenForAuthCode(async (redirectUri) => {
      for (const init of [
        { method: 'PUT' },
        { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'code=code-placeholder' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'code=first-placeholder&code=second-placeholder&state=state-placeholder',
        },
      ]) {
        const response = await fetch(redirectUri, init);
        statuses.push(response.status);
        await response.arrayBuffer();
      }
      await postResponse(redirectUri, { code: 'code-placeholder', state: 'state-placeholder' });
    });

    await expect(responsePromise).resolves.toMatchObject({ response: { code: 'code-placeholder' } });
    expect(statuses).toEqual([405, 415, 400]);
  });

  it('closes the listener when opening the authorization URL fails', async () => {
    const client = new TimedGraphLoopbackClient(1_000, 'state-placeholder');
    const responsePromise = client.listenForAuthCode(async () => {
      throw new Error('browser unavailable');
    });

    await expect(responsePromise).rejects.toThrow('browser unavailable');
    expect(() => client.getRedirectUri()).toThrow(/not listening/);
  });
});

function postResponse(redirectUri: string, values: Record<string, string>): Promise<Response> {
  return fetch(redirectUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values).toString(),
  });
}
