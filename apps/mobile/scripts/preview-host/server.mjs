import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createFixtureState, loadPreviewFixture, normalizeScenario } from './fixture-state.mjs';

const PREVIEW_DEVICE_TOKEN = 'preview-device-token-placeholder';
const PREVIEW_PAIRING_TOKEN = 'preview-only';

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    ...corsHeaders(),
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(request, state) {
  if (state.scenario === '401') return false;
  return request.headers.authorization === `Bearer ${PREVIEW_DEVICE_TOKEN}`;
}

function messageEnvelope(state, instanceId, fromSeq, withCursor, includeFrom) {
  const sequenced = state.messages(instanceId).map((message, seq) => ({ ...message, seq }));
  const generation = state.cursor(instanceId);
  if (fromSeq === null) {
    if (!withCursor) return sequenced;
    return {
      messages: sequenced,
      meta: {
        fromSeq: -1,
        returned: sequenced.length,
        hasMore: false,
        maxSeq: sequenced.at(-1)?.seq ?? -1,
        ...generation,
      },
    };
  }
  const parsed = Number(fromSeq);
  const cursor = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  const messages = sequenced
    .filter((message) => includeFrom ? message.seq >= cursor : message.seq > cursor)
    .slice(0, 300);
  return {
    messages,
    meta: {
      fromSeq: cursor,
      returned: messages.length,
      hasMore: sequenced.some((message) => message.seq > (messages.at(-1)?.seq ?? cursor)),
      maxSeq: messages.at(-1)?.seq ?? cursor,
      ...generation,
    },
  };
}

function proxyToAngular(request, response, upstreamOrigin) {
  const target = new URL(request.url || '/', upstreamOrigin);
  const proxy = http.request(target, {
    method: request.method,
    headers: { ...request.headers, host: target.host },
  }, (upstream) => {
    response.writeHead(upstream.statusCode ?? 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.on('error', () => {
    sendJson(response, 502, { error: 'Angular preview is still starting. Refresh in a moment.' });
  });
  request.pipe(proxy);
}

function broadcast(clients, event) {
  const payload = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function scriptedOutput(state, legacySeq, streamSeq, content) {
  const current = state.messages('preview-active');
  const bufferIndex = current.length;
  const message = {
    id: `preview-stream-${streamSeq}`,
    timestamp: Date.now(),
    type: 'assistant',
    content,
    seq: bufferIndex,
  };
  state.appendMessage('preview-active', message);
  state.recordStream('preview-active', streamSeq);
  return {
    type: 'instance-output',
    data: {
      instanceId: 'preview-active',
      seq: legacySeq,
      streamSeq,
      bufferIndex,
      ...state.cursor('preview-active'),
      message,
    },
  };
}

export function previewPairingCode(host, port) {
  return JSON.stringify({
    v: 1,
    host,
    port,
    pairingToken: PREVIEW_PAIRING_TOKEN,
    secure: false,
  });
}

export async function createPreviewHost(options = {}) {
  const fixture = await loadPreviewFixture();
  if (options.hostName) fixture.snapshot.hostName = options.hostName;
  const previewHostName = fixture.snapshot.hostName;
  let previewDeviceId = options.deviceId ?? null;
  const state = createFixtureState(fixture, options.scenario);
  const timers = new Set();
  const wss = new WebSocketServer({ noServer: true });
  const upstreamOrigin = options.upstreamOrigin;
  const requestCounts = new Map();

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://preview.local');
    const method = request.method || 'GET';
    const requestedScenario = url.searchParams.get('scenario');
    if (requestedScenario !== null) state.setScenario(requestedScenario);
    requestCounts.set(url.pathname, (requestCounts.get(url.pathname) ?? 0) + 1);

    if (method === 'OPTIONS') {
      response.writeHead(204, corsHeaders());
      response.end();
      return;
    }
    if (url.pathname === '/health') {
      sendJson(response, state.scenario === 'offline' ? 503 : 200, {
        ok: state.scenario !== 'offline', scenario: state.scenario,
      });
      return;
    }
    if (url.pathname === '/__preview/scenario') {
      const selected = state.setScenario(requestedScenario ?? 'default');
      broadcast(wss.clients, { type: 'quota-state', data: state.quota() });
      sendJson(response, 200, { scenario: selected });
      return;
    }
    if (url.pathname === '/__preview/metrics') {
      const payload = { requests: Object.fromEntries(requestCounts) };
      if (method === 'DELETE') requestCounts.clear();
      sendJson(response, 200, payload);
      return;
    }
    if (url.pathname === '/pair' && method === 'POST') {
      const body = await readJson(request).catch(() => ({}));
      if (body.pairingToken !== PREVIEW_PAIRING_TOKEN) {
        sendJson(response, 401, { error: 'Preview pairing token not recognised' });
        return;
      }
      sendJson(response, 200, {
        deviceId: previewDeviceId,
        token: PREVIEW_DEVICE_TOKEN,
        hostName: previewHostName,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      if (upstreamOrigin) proxyToAngular(request, response, upstreamOrigin);
      else sendJson(response, 200, { preview: true, scenario: state.scenario });
      return;
    }
    if (!isAuthorized(request, state)) {
      sendJson(response, 401, { error: 'Unauthorized preview scenario' });
      return;
    }

    if (state.scenario === 'stale-probe'
      && method === 'GET'
      && (url.pathname === '/api/prompts' || url.pathname === '/api/snapshot')) {
      await new Promise((resolve) => setTimeout(resolve, options.attentionDelayMs ?? 250));
    }

    const segments = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/api/snapshot' && method === 'GET') return sendJson(response, 200, state.snapshot());
      if (url.pathname === '/api/quota' && method === 'GET') return sendJson(response, 200, state.quota());
      if (url.pathname === '/api/automations' && method === 'GET') return sendJson(response, 200, state.automations());
      if (url.pathname === '/api/instances' && method === 'GET') return sendJson(response, 200, state.instances());
      if (url.pathname === '/api/projects' && method === 'GET') return sendJson(response, 200, state.projects());
      if (url.pathname === '/api/prompts' && method === 'GET') return sendJson(response, 200, state.prompts());
      if (url.pathname === '/api/models' && method === 'GET') return sendJson(response, 200, state.models());
      if (url.pathname === '/api/recent-dirs' && method === 'GET') return sendJson(response, 200, state.recentDirs());
      if (url.pathname === '/api/history' && method === 'GET') return sendJson(response, 200, state.history());
      if (url.pathname === '/api/pause' && method === 'GET') return sendJson(response, 200, state.pause());
      if (url.pathname === '/api/pause' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.paused !== 'boolean') return sendJson(response, 400, { error: 'paused (boolean) required' });
        const pause = state.setPause(body.paused);
        broadcast(wss.clients, { type: 'pause-state', data: pause });
        return sendJson(response, 200, pause);
      }
      if (segments[1] === 'automations' && segments.length === 4 && segments[3] === 'run' && method === 'POST') {
        const id = decodeURIComponent(segments[2]);
        const body = await readJson(request);
        if (!id || id.length > 100 || typeof body.idempotencyKey !== 'string'
          || !body.idempotencyKey.trim() || body.idempotencyKey.length > 500) {
          return sendJson(response, 400, { error: 'A valid automation id and idempotencyKey are required' });
        }
        return sendJson(response, 200, state.runAutomation(id, body.idempotencyKey.trim()));
      }
      if (url.pathname === '/api/session-plan' && method === 'GET') {
        return sendJson(response, 200, state.sessionPlan(
          url.searchParams.get('provider'),
          url.searchParams.get('model'),
          url.searchParams.get('reasoningEffort'),
        ));
      }
      if (segments[1] === 'history' && segments.length === 4 && segments[3] === 'messages' && method === 'GET') {
        return sendJson(response, 200, state.historyMessages(decodeURIComponent(segments[2])));
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'messages' && method === 'GET') {
        return sendJson(response, 200, messageEnvelope(
          state,
          decodeURIComponent(segments[2]),
          url.searchParams.get('fromSeq'),
          url.searchParams.get('withCursor') === '1',
          url.searchParams.get('includeFrom') === '1',
        ));
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'input' && method === 'POST') {
        const instanceId = decodeURIComponent(segments[2]);
        const body = await readJson(request);
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message && !Array.isArray(body.attachments)) return sendJson(response, 400, { error: 'message or attachments required' });
        if (message) state.appendMessage(instanceId, {
          id: `preview-input-${Date.now()}`, timestamp: Date.now(), type: 'user', content: message,
        });
        return sendJson(response, 200, { ok: true, queued: false });
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'respond' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.requestId !== 'string') return sendJson(response, 400, { error: 'requestId required' });
        state.clearPrompt(body.requestId);
        broadcast(wss.clients, { type: 'permission-cleared', data: { requestId: body.requestId, instanceId: decodeURIComponent(segments[2]) } });
        return sendJson(response, 200, { ok: true, resumed: true });
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'interrupt' && method === 'POST') {
        return sendJson(response, 200, { ok: true, accepted: true });
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'terminate' && method === 'POST') {
        return sendJson(response, state.terminate(decodeURIComponent(segments[2])) ? 200 : 404, { ok: true });
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'rename' && method === 'POST') {
        const body = await readJson(request);
        const updated = typeof body.displayName === 'string' ? state.rename(decodeURIComponent(segments[2]), body.displayName) : null;
        return sendJson(response, updated ? 200 : 404, updated ? { ok: true } : { error: 'Instance not found' });
      }
      if (segments[1] === 'instances' && segments.length === 4 && segments[3] === 'model' && method === 'POST') {
        const body = await readJson(request);
        const updated = typeof body.model === 'string' ? state.changeModel(decodeURIComponent(segments[2]), body.model) : null;
        return sendJson(response, updated ? 200 : 404, updated ?? { error: 'Instance not found' });
      }
      if (segments[1] === 'instances' && segments.length === 5 && segments[3] === 'queue' && method === 'DELETE') {
        const cancelled = state.cancelQueue(decodeURIComponent(segments[2]), decodeURIComponent(segments[4]));
        return sendJson(response, cancelled ? 200 : 404, cancelled ?? { error: 'Queued input not found' });
      }
      if (url.pathname === '/api/instances' && method === 'POST') {
        const body = await readJson(request);
        if (typeof body.workingDirectory !== 'string' || !body.workingDirectory.trim()) {
          return sendJson(response, 400, { error: 'workingDirectory required' });
        }
        return sendJson(response, 200, state.createInstance(body));
      }
      if (segments[1] === 'devices' && method === 'POST') return sendJson(response, 200, { ok: true });
      if (segments[1] === 'devices' && method === 'DELETE') return sendJson(response, 200, { ok: true });
      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Preview fixture error' });
    }
  });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url || '/', 'http://preview.local');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const authorized = state.scenario !== '401' && url.searchParams.get('token') === PREVIEW_DEVICE_TOKEN;
    if (!authorized) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });

  wss.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'snapshot', data: state.snapshot() }));
    client.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString());
        if (event?.type === 'ping') {
          client.send(JSON.stringify({ type: 'pong', data: { sentAt: event.sentAt } }));
        }
      } catch {
        // Ignore malformed preview control frames, like the real gateway.
      }
    });
    const delay = options.scenarioDelayMs ?? 350;
    const schedule = (callback, multiplier) => {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay * multiplier);
      timers.add(timer);
    };
    if (state.scenario === 'streaming') {
      // Legacy provider seq skips ordinary status/tool lifecycle events; the
      // new output-only stream remains contiguous and must not refetch.
      schedule(() => client.send(JSON.stringify(scriptedOutput(state, 4, 0, 'Streaming preview started.'))), 1);
      schedule(() => client.send(JSON.stringify(scriptedOutput(state, 9, 1, 'Streaming preview complete.'))), 2);
    } else if (state.scenario === 'gap') {
      schedule(() => client.send(JSON.stringify(scriptedOutput(state, 1, 0, 'First preview frame.'))), 1);
      schedule(() => client.send(JSON.stringify(scriptedOutput(state, 3, 2, 'Frame two was intentionally skipped.'))), 2);
    } else if (state.scenario === 'disconnect') {
      schedule(() => client.close(1012, 'Preview disconnect scenario'), 1);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4173, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Preview host did not bind a TCP port');
  const publicHost = options.publicHost ?? '127.0.0.1';
  previewDeviceId ??= `preview-device-${publicHost.replace(/[^a-z0-9]+/gi, '-')}-${address.port}`;

  return {
    baseUrl: `http://${publicHost}:${address.port}`,
    wsUrl: `ws://${publicHost}:${address.port}`,
    port: address.port,
    scenario: () => state.scenario,
    pairingCode: previewPairingCode(publicHost, address.port),
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
