import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import type { AcpChildActivity, AcpChildProgressSource } from './acp-delegated-task-liveness';

const MAX_FRAME_CHARS = 256 * 1024;
const MAX_CHILDREN = 128;
const REQUEST_TIMEOUT_MS = 5_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** Bounded, metadata-only event observation. Server heartbeats never count as work. */
export function observeOpenCodeChildProgress(
  baseUrl: string,
  authorization: string,
  directory: string,
  parentId: string,
  onProgress: (child: AcpChildActivity) => void,
  onBackground?: (child: AcpChildActivity) => void,
): () => void {
  const target = new URL(baseUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new Error('Child progress requires a private loopback endpoint');
  const controller = new AbortController();
  const children = new Map<string, AcpChildActivity>();
  const pendingChildWork = new Set<string>();
  let refreshInFlight: Promise<void> | undefined;
  let refreshScheduled: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshAt = 0;
  let ownershipGeneration = 0;
  const headers = { Authorization: authorization, 'x-opencode-directory': encodeURIComponent(directory) };

  const taskOwners = async (): Promise<{ owners: Map<string, string>; background: Map<string, string> }> => {
    const owners = new Map<string, string>();
    const background = new Map<string, string>();
    const empty = { owners: new Map<string, string>(), background: new Map<string, string>() };
    const childrenByCall = new Map<string, string>();
    const ambiguous = new Set<string>();
    const response = await fetch(`${baseUrl}/session/${encodeURIComponent(parentId)}/message?limit=1`, {
      headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), redirect: 'error',
    });
    if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return empty; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > MAX_FRAME_CHARS) throw new Error('Parent task evidence too large');
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const messages: unknown = JSON.parse(text);
    if (!Array.isArray(messages) || messages.length !== 1) return empty;
    for (const message of messages) {
      if (!record(message) || !record(message['info']) || message['info']['role'] !== 'assistant'
        || message['info']['sessionID'] !== parentId || !Array.isArray(message['parts'])) continue;
      if (message['parts'].length > MAX_CHILDREN) return empty;
      for (const part of message['parts'].slice(0, MAX_CHILDREN)) {
        if (!record(part) || part['type'] !== 'tool' || part['tool'] !== 'task' || typeof part['callID'] !== 'string'
          || !record(part['state']) || part['state']['status'] !== 'running' || !record(part['state']['metadata'])) continue;
        const input = part['state']['input'];
        const metadata = part['state']['metadata'];
        const childId = metadata['sessionId'];
        if (metadata['parentSessionId'] !== parentId || typeof childId !== 'string') continue;
        if (!owners.has(childId) && owners.size >= MAX_CHILDREN) return empty;
        if (!childrenByCall.has(part['callID']) && childrenByCall.size >= MAX_CHILDREN) return empty;
        if (owners.has(childId) && owners.get(childId) !== part['callID']) ambiguous.add(childId);
        const previousChild = childrenByCall.get(part['callID']);
        if (previousChild && previousChild !== childId) { ambiguous.add(previousChild); ambiguous.add(childId); }
        childrenByCall.set(part['callID'], childId);
        owners.set(childId, part['callID']);
        if (metadata['background'] === true || (record(input) && (input['background'] === true || input['run_in_background'] === true))) {
          background.set(childId, part['callID']);
        }
      }
    }
    for (const childId of ambiguous) { owners.delete(childId); background.delete(childId); }
    for (const childId of background.keys()) owners.delete(childId);
    return { owners, background };
  };

  const refresh = (): Promise<void> => {
    if (refreshInFlight) return refreshInFlight;
    clearTimeout(refreshScheduled);
    refreshScheduled = undefined;
    lastRefreshAt = Date.now();
    const generation = ownershipGeneration;
    // Failed or superseded reads must not retain an old foreground proof.
    children.clear();
    refreshInFlight = (async () => {
      const response = await fetch(`${baseUrl}/session/${encodeURIComponent(parentId)}/children`, {
        headers,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        redirect: 'error',
      });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); return; }
      // Bound the response before parsing; a provider cannot grow Harness's heap without limit.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length > MAX_FRAME_CHARS) throw new Error('Child roster too large');
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || controller.signal.aborted) return;
      const { owners, background } = await taskOwners();
      if (controller.signal.aborted || generation !== ownershipGeneration) return;
      children.clear();
      for (const child of parsed.slice(0, MAX_CHILDREN)) {
        if (!record(child) || child['parentID'] !== parentId || typeof child['id'] !== 'string' || !record(child['time'])) continue;
        const createdAt = child['time']['created'];
        if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
        const activity = { sessionId: child['id'], title: typeof child['title'] === 'string' ? child['title'] : '', createdAt };
        const backgroundCallId = background.get(child['id']);
        if (backgroundCallId) onBackground?.({ ...activity, toolCallId: backgroundCallId });
        const toolCallId = owners.get(child['id']);
        if (!toolCallId) continue;
        children.set(child['id'], { ...activity, toolCallId });
      }
    })().catch(() => undefined).finally(() => {
      refreshInFlight = undefined;
      if (generation !== ownershipGeneration) { scheduleRefresh(); return; }
      for (const sessionId of pendingChildWork) {
        const child = children.get(sessionId);
        if (child && !controller.signal.aborted) onProgress(child);
      }
      pendingChildWork.clear();
    });
    return refreshInFlight;
  };

  const scheduleRefresh = (): void => {
    if (controller.signal.aborted || refreshInFlight || refreshScheduled) return;
    refreshScheduled = setTimeout(() => {
      refreshScheduled = undefined;
      if (!controller.signal.aborted) void refresh();
    }, Math.max(0, 1_000 - (Date.now() - lastRefreshAt)));
    refreshScheduled.unref();
  };
  const queueUnknownChild = (sessionId: string): void => {
    if (pendingChildWork.size < MAX_CHILDREN) pendingChildWork.add(sessionId);
    scheduleRefresh();
  };

  const handle = async (data: string): Promise<void> => {
    let event: unknown;
    try { event = JSON.parse(data); } catch { return; }
    if (!record(event)) return;
    if (record(event['payload'])) event = event['payload'];
    if (!record(event) || !['message.updated', 'message.part.updated', 'message.part.delta'].includes(String(event['type']))) return;
    const properties = event['properties'];
    if (!record(properties)) return;
    const nested = properties['part'] ?? properties['info'];
    const sessionId = properties['sessionID'] ?? (record(nested) ? nested['sessionID'] : undefined);
    if (typeof sessionId !== 'string') return;
    if (sessionId === parentId) {
      ownershipGeneration++;
      // Native promotion changes metadata, while ACP may retain foreground input.
      if (event['type'] === 'message.part.updated' && record(nested) && nested['sessionID'] === parentId
        && nested['type'] === 'tool' && nested['tool'] === 'task' && record(nested['state'])) {
        const state = nested['state'];
        const metadata = state['metadata'];
        const input = state['input'];
        if (record(metadata) && metadata['parentSessionId'] === parentId && typeof metadata['sessionId'] === 'string'
          && (metadata['background'] === true || (record(input) && (input['background'] === true || input['run_in_background'] === true)))) {
          const child = children.get(metadata['sessionId']);
          if (child && child.toolCallId === nested['callID'] && !controller.signal.aborted) onBackground?.(child);
        }
      }
      children.clear();
      pendingChildWork.clear();
      scheduleRefresh();
      return;
    }
    if (!children.has(sessionId)) { queueUnknownChild(sessionId); return; }
    const child = children.get(sessionId);
    if (child && !controller.signal.aborted) onProgress(child);
  };

  const consume = async (): Promise<void> => {
    const streamController = new AbortController();
    const abortStream = (): void => streamController.abort();
    controller.signal.addEventListener('abort', abortStream, { once: true });
    let idle = setTimeout(abortStream, REQUEST_TIMEOUT_MS);
    idle.unref();
    let response: Response;
    try { response = await fetch(`${baseUrl}/event`, { headers, signal: streamController.signal, redirect: 'error' }); }
    catch (error) { clearTimeout(idle); controller.signal.removeEventListener('abort', abortStream); throw error; }
    clearTimeout(idle);
    idle = setTimeout(abortStream, 30_000);
    idle.unref();
    if (!response.ok || !response.body) {
      clearTimeout(idle);
      controller.signal.removeEventListener('abort', abortStream);
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Child event stream unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(abortStream, 30_000);
        idle.unref();
        pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        if (pending.length > MAX_FRAME_CHARS) throw new Error('Child event frame too large');
        let end: number;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) await handle(data);
        }
      }
    } finally {
      clearTimeout(idle);
      controller.signal.removeEventListener('abort', abortStream);
      await reader.cancel().catch(() => undefined);
    }
  };

  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    if (controller.signal.aborted) return;
    void consume().catch(() => undefined).finally(() => {
      if (!controller.signal.aborted) {
        reconnect = setTimeout(run, 5_000);
        reconnect.unref();
      }
    });
  };
  void refresh();
  run();
  const poll = setInterval(() => { void refresh(); }, 10_000);
  poll.unref();
  return () => {
    controller.abort();
    clearInterval(poll);
    clearTimeout(reconnect);
    clearTimeout(refreshScheduled);
    children.clear();
    pendingChildWork.clear();
  };
}

/** Credentials remain in the private spawn environment and this closure, never config files. */
export function createOpenCodeChildProgressSource(directory: string): {
  source: AcpChildProgressSource;
  prepareSpawn(args: string[], env: NodeJS.ProcessEnv): Promise<() => void>;
  request(path: string, init?: RequestInit): Promise<unknown>;
} {
  let endpoint: { url: string; authorization: string; controller: AbortController } | undefined;
  let stop: (() => void) | undefined;
  return {
    request: async (path, init) => {
      if (!endpoint || !path.startsWith('/') || path.startsWith('//')) throw new Error('OpenCode local endpoint unavailable');
      const current = endpoint;
      const headers = new Headers(init?.headers);
      headers.set('Authorization', current.authorization);
      headers.set('x-opencode-directory', encodeURIComponent(directory));
      const response = await fetch(`${current.url}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.any([current.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init?.signal ? [init.signal] : [])]),
        redirect: 'error',
      });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => undefined); throw new Error('OpenCode local request failed'); }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length > MAX_FRAME_CHARS) throw new Error('OpenCode local response too large');
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (current !== endpoint || current.controller.signal.aborted) throw new Error('OpenCode local endpoint changed');
      return JSON.parse(text);
    },
    source: {
      start: (parentId, onProgress, onBackground) => {
        stop?.();
        if (!endpoint) return () => undefined;
        const active = observeOpenCodeChildProgress(endpoint.url, endpoint.authorization, directory, parentId, onProgress, onBackground);
        stop = active;
        return () => { active(); if (stop === active) stop = undefined; };
      },
    },
    prepareSpawn: async (args, env) => {
      stop?.();
      endpoint?.controller.abort();
      const port = await freeLoopbackPort();
      const password = randomBytes(32).toString('base64url');
      env['OPENCODE_SERVER_PASSWORD'] = password;
      env['OPENCODE_SERVER_USERNAME'] = 'opencode';
      args.splice(0, args.length, 'acp', '--cwd', directory, '--hostname', '127.0.0.1', '--port', String(port), '--mdns=false');
      const current = { url: `http://127.0.0.1:${port}`, authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, controller: new AbortController() };
      endpoint = current;
      return () => {
        if (endpoint !== current) return;
        stop?.();
        current.controller.abort();
        stop = undefined;
        endpoint = undefined;
        delete env['OPENCODE_SERVER_PASSWORD'];
        delete env['OPENCODE_SERVER_USERNAME'];
      };
    },
  };
}
