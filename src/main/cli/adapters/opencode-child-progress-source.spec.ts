// @vitest-environment node
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenCodeChildProgressSource, observeOpenCodeChildProgress } from './opencode-child-progress-source';

describe('OpenCode child event transport', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

  it('binds a private loopback endpoint and rejects requests after its spawn cleanup', async () => {
    const runtime = createOpenCodeChildProgressSource('/tmp');
    const args: string[] = [];
    const env: NodeJS.ProcessEnv = {};
    const cleanup = await runtime.prepareSpawn(args, env);
    cleanups.push(cleanup);
    const port = Number(args[args.indexOf('--port') + 1]);
    const server = createServer((request, response) => {
      const auth = `Basic ${Buffer.from(`opencode:${env['OPENCODE_SERVER_PASSWORD']}`).toString('base64')}`;
      // Assert a boolean only: a failing test must never print runtime credentials.
      if (request.headers.authorization !== auth) { response.writeHead(401).end(); return; }
      response.end('{"healthy":true}');
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    expect(args[args.indexOf('--hostname') + 1]).toBe('127.0.0.1');
    await expect(runtime.request('/global/health')).resolves.toEqual({ healthy: true });
    await expect(runtime.request('//example.com')).rejects.toThrow();
    cleanup();
    await expect(runtime.request('/global/health')).rejects.toThrow();
    expect(Boolean(env['OPENCODE_SERVER_PASSWORD'])).toBe(false);
  });

  it('uses authenticated child events instead of heartbeat/status or static timestamps', async () => {
    let stream: ServerResponse | undefined;
    let rosterRequests = 0;
    const server = createServer((request, response) => {
      if (request.headers.authorization !== 'Basic PLACEHOLDER') { response.writeHead(401).end(); return; }
      if (request.url === '/session/parent/children') {
        rosterRequests++;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(['child', 'old', 'wrong-parent', 'ambiguous', 'background', 'promoted', 'shared-first', 'shared-second'].map((id) => ({
          id, parentID: 'parent', title: 'Gate', time: { created: 123, updated: 124 },
        }))));
        return;
      }
      if (request.url === '/event') {
        stream = response;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"server.connected","properties":{}}\n\n');
        return;
      }
      if (request.url === '/session/parent/message?limit=1') {
        response.end(JSON.stringify([{ info: { role: 'assistant', sessionID: 'parent' }, parts: [
          { type: 'tool', tool: 'task', callID: 'native-task', state: { status: 'running', metadata: { parentSessionId: 'parent', sessionId: 'child' } } },
          { type: 'tool', tool: 'task', callID: 'old-task', state: { status: 'completed', metadata: { parentSessionId: 'parent', sessionId: 'old' } } },
          { type: 'tool', tool: 'task', callID: 'wrong-task', state: { status: 'running', metadata: { parentSessionId: 'other', sessionId: 'wrong-parent' } } },
          ...['first', 'second'].map((callID) => ({ type: 'tool', tool: 'task', callID, state: { status: 'running', metadata: { parentSessionId: 'parent', sessionId: 'ambiguous' } } })),
          ...['shared-first', 'shared-second'].map((sessionId) => ({ type: 'tool', tool: 'task', callID: 'shared-call', state: { status: 'running', metadata: { parentSessionId: 'parent', sessionId } } })),
          { type: 'tool', tool: 'task', callID: 'background-task', state: { status: 'running', input: { background: true }, metadata: { parentSessionId: 'parent', sessionId: 'background' } } },
          { type: 'tool', tool: 'task', callID: 'promoted-task', state: { status: 'running', input: { background: false }, metadata: { parentSessionId: 'parent', sessionId: 'promoted', background: true, jobId: 'promoted' } } },
        ] }]));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    const progress: { sessionId: string; toolCallId?: string }[] = [];
    const stop = observeOpenCodeChildProgress(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'Basic PLACEHOLDER', '/tmp', 'parent', (child) => progress.push(child));
    cleanups.push(stop);
    await expect.poll(() => Boolean(stream) && rosterRequests > 0).toBe(true);
    stream?.write('data: {"type":"server.heartbeat","properties":{}}\n\n');
    stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"parent","delta":"ignore"}}\n\n');
    stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"unrelated","delta":"ignore"}}\n\n');
    for (const sessionID of ['old', 'wrong-parent', 'ambiguous', 'background', 'promoted', 'shared-first', 'shared-second']) {
      stream?.write(`data: ${JSON.stringify({ type: 'message.part.delta', properties: { sessionID, delta: 'ignore' } })}\n\n`);
    }
    stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"child","delta":"work"}}\n\n');
    await expect.poll(() => progress).toEqual([{ sessionId: 'child', title: 'Gate', createdAt: 123, toolCallId: 'native-task' }]);
    const rosterBeforeDuplicates = rosterRequests;
    for (let index = 0; index < 100; index++) {
      stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"unrelated","delta":"ignore"}}\n\n');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rosterRequests - rosterBeforeDuplicates).toBeLessThanOrEqual(1);
    stop();
    stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"child","delta":"late"}}\n\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(progress).toEqual([{ sessionId: 'child', title: 'Gate', createdAt: 123, toolCallId: 'native-task' }]);
  });

  it('coalesces unrelated work while retaining a newly owned child first event', async () => {
    let stream: ServerResponse | undefined;
    let taskReady = false;
    let ownerReads = 0;
    const server = createServer((request, response) => {
      if (request.url === '/event') {
        stream = response;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"server.connected"}\n\n');
      } else if (request.url === '/session/parent/children') {
        response.end(JSON.stringify([{ id: 'new-child', parentID: 'parent', title: 'Gate', time: { created: 123 } }]));
      } else if (request.url === '/session/parent/message?limit=1') {
        ownerReads++;
        response.end(JSON.stringify([{ info: { role: 'assistant', sessionID: 'parent' }, parts: taskReady ? [{
          type: 'tool', tool: 'task', callID: 'new-call', state: { status: 'running',
            metadata: { parentSessionId: 'parent', sessionId: 'new-child' } },
        }] : [] }]));
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    const progress: string[] = [];
    cleanups.push(observeOpenCodeChildProgress(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'Basic PLACEHOLDER', '/tmp', 'parent', (child) => progress.push(child.toolCallId ?? 'missing')));
    await expect.poll(() => Boolean(stream) && ownerReads === 1).toBe(true);
    taskReady = true;
    for (let index = 0; index < 100; index++) {
      stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"unrelated","delta":"ignore"}}\n\n');
    }
    stream?.write('data: {"type":"message.part.delta","properties":{"sessionID":"new-child","delta":"first-work"}}\n\n');
    await expect.poll(() => progress, { timeout: 2_000 }).toEqual(['new-call']);
    expect(ownerReads).toBe(2);
  });

  it.each([false, true])('revokes promoted ownership and fences queued stale reads (in-flight refresh: %s)', async (inFlight) => {
    let stream: ServerResponse | undefined;
    let heldRead: ServerResponse | undefined;
    let ownerReads = 0;
    let promoted = false;
    const nativeTask = () => ({
      type: 'tool', tool: 'task', sessionID: 'parent', callID: 'call', state: {
        status: 'running', input: { background: false }, metadata: {
          parentSessionId: 'parent', sessionId: 'child', ...(promoted ? { background: true, jobId: 'child' } : {}),
        },
      },
    });
    const messages = (part: unknown) => JSON.stringify([{ info: { role: 'assistant', sessionID: 'parent' }, parts: [part] }]);
    const server = createServer((request, response) => {
      if (request.url === '/event') {
        stream = response;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write('data: {"type":"server.connected"}\n\n');
      } else if (request.url === '/session/parent/children') {
        response.end(JSON.stringify([{ id: 'child', parentID: 'parent', title: 'Gate', time: { created: 123 } }]));
      } else if (request.url === '/session/parent/message?limit=1') {
        ownerReads++;
        if (inFlight && ownerReads === 2) heldRead = response;
        else response.end(messages(nativeTask()));
      } else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { server.closeAllConnections(); server.close(); });
    const progress: string[] = [];
    const background: string[] = [];
    cleanups.push(observeOpenCodeChildProgress(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'Basic PLACEHOLDER', '/tmp', 'parent',
      (child) => progress.push(child.toolCallId ?? 'missing'), (child) => background.push(child.toolCallId ?? 'missing')));
    await expect.poll(() => Boolean(stream) && ownerReads === 1).toBe(true);
    const childEvent = 'data: {"type":"message.part.delta","properties":{"sessionID":"child","delta":"work"}}\n\n';
    stream?.write(childEvent);
    await expect.poll(() => progress).toEqual(['call']);
    const foregroundSnapshot = nativeTask();
    if (inFlight) {
      stream?.write('data: {"type":"message.updated","properties":{"sessionID":"parent","info":{"sessionID":"parent"}}}\n\n');
      stream?.write(childEvent);
      await expect.poll(() => Boolean(heldRead), { timeout: 2_000 }).toBe(true);
    }
    promoted = true;
    stream?.write(`data: ${JSON.stringify({ type: 'message.part.updated', properties: { sessionID: 'parent', part: nativeTask() } })}\n\n`);
    stream?.write(childEvent);
    // Flush a stale foreground response only after the promotion frame was processed.
    await new Promise((resolve) => setTimeout(resolve, 100));
    heldRead?.end(messages(foregroundSnapshot));
    await expect.poll(() => background.includes('call'), { timeout: 3_000 }).toBe(true);
    expect(progress).toEqual(['call']);
    for (let index = 0; index < 100; index++) stream?.write(childEvent);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(progress).toEqual(['call']);
    expect(ownerReads).toBeLessThanOrEqual(inFlight ? 3 : 2);
  });
});
