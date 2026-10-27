import * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import { listenConnectorOAuth } from './connector-oauth-loopback';
describe('connector sign-in callback validation', () => {
  it('rejects a malformed request URL without crashing or consuming the sign-in', async () => {
    const callback = await listenConnectorOAuth('PLACEHOLDER_STATE', 3000);
    try {
      const url = new URL(callback.redirectUrl);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request(
          { host: url.hostname, port: url.port, path: 'http://[', method: 'GET' },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
          },
        );
        request.once('error', reject);
        request.end();
      });
      expect(status).toBe(400);
      url.searchParams.set('state', 'PLACEHOLDER_STATE');
      url.searchParams.set('code', 'PLACEHOLDER_CODE');
      expect((await fetch(url)).status).toBe(200);
      expect((await callback.result).get('code')).toBe('PLACEHOLDER_CODE');
    } finally {
      callback.close();
    }
  });
});
