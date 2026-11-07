/**
 * Minimal Anthropic-message translator for Claude Code against llama.cpp-family
 * servers (LM Studio). Claude Code 2.x appends trailing `role: "system"`
 * messages to `messages` (context-management reminders). Several GGUF chat
 * templates (Qwen3.8's, e.g.) raise "System message must be at the beginning"
 * on any system message after position 0. This proxy lifts every in-array
 * system message into the top-level `system` field and forwards the request
 * unchanged otherwise. Referenced from the plan's step 2 ("through a
 * translator").
 */
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage } from 'http';
import { appendFileSync } from 'fs';

interface MessageLike {
  role?: string;
  content?: unknown;
}

export interface NormalizedBody {
  system?: unknown;
  messages?: MessageLike[];
  [key: string]: unknown;
}

/** Move in-array system messages into the top-level system blocks. */
export function normalizeBody(parsed: NormalizedBody): NormalizedBody {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const lifted: unknown[] = [];
  const kept: MessageLike[] = [];
  for (const message of messages) {
    if (message && message.role === 'system') {
      const content = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') }];
      lifted.push(...content);
    } else {
      kept.push(message);
    }
  }
  if (lifted.length === 0) return parsed;
  const system: unknown[] = Array.isArray(parsed.system)
    ? [...parsed.system]
    : parsed.system
      ? [{ type: 'text', text: String(parsed.system) }]
      : [];
  system.push(...lifted);
  return { ...parsed, system, messages: kept };
}

export interface ProxyOptions {
  port: number;
  upstream: string;
  logPath?: string;
  /** Test seam: how long one upstream connect attempt may hang before retry. */
  connectDeadlineMs?: number;
  /** Test seam: after a successful connect, how long response headers may take. */
  responseDeadlineMs?: number;
  /** Test seam: delay between upstream attempts. */
  retryDelayMs?: number;
  /** Test seam: how many upstream attempts before surfacing a 502. */
  maxAttempts?: number;
}

/**
 * Errors that mean "the upstream did not accept or dropped the connection",
 * not "the model answered with an error". LM Studio 0.4.x stops accepting new
 * TCP connections while a long generation is in flight (measured 16 Oct:
 * 6/6 connects time out mid-generation while ICMP to the same host stays 1ms),
 * which killed agent runs with 502s. These are retried instead of surfaced.
 */
export function isConnectClassError(message: string): boolean {
  return /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up/i.test(message);
}

/** Errors worth retrying at this layer: the upstream never answered, it did not fail. */
export function isRetryableUpstreamError(message: string): boolean {
  return isConnectClassError(message)
    || message.startsWith('connect deadline')
    || message.startsWith('response deadline');
}

const CONNECT_DEADLINE_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
const MAX_UPSTREAM_ATTEMPTS = 60;
// Long prompt processing must fit: the slowest measured prompt speed (~70
// tok/s on a cold Flash-Next load) needs ~16 min for a 65k-token prompt
// before the first response byte. Nothing sane is silent for longer.
const RESPONSE_DEADLINE_MS = 1_200_000;

export function startProxy({
  port,
  upstream,
  logPath,
  connectDeadlineMs,
  responseDeadlineMs,
  retryDelayMs,
  maxAttempts,
}: ProxyOptions): ReturnType<typeof createServer> {
  const up = new URL(upstream);
  const deadlineMs = connectDeadlineMs ?? CONNECT_DEADLINE_MS;
  const responseDeadline = responseDeadlineMs ?? RESPONSE_DEADLINE_MS;
  const delayMs = retryDelayMs ?? RETRY_DELAY_MS;
  const attemptsMax = maxAttempts ?? MAX_UPSTREAM_ATTEMPTS;
  const server = createServer((req, res) => {
    res.on('error', () => { /* A disconnected client is handled by the upstream retry guard. */ });
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if ((req.url ?? '').includes('/v1/messages')) {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          const before = parsed.messages?.length ?? 0;
          const normalized = normalizeBody(parsed);
          body = Buffer.from(JSON.stringify(normalized), 'utf8');
          const after = normalized.messages?.length ?? 0;
          if (logPath && before !== after) {
            appendFileSync(logPath, `${new Date().toISOString()} lifted ${before - after} in-array system message(s) into system field\n`);
          }
        } catch {
          // Non-JSON bodies pass through untouched.
        }
      }
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: up.host,
        'content-length': String(body.length),
      };
      // The body is buffered and re-sent with a content-length; a forwarded
      // chunked transfer-encoding would make the upstream reject the request.
      delete fwdHeaders['transfer-encoding'];

      let aborted = false;
      let activeFwd: ClientRequest | null = null;
      let activeUpRes: IncomingMessage | null = null;
      const abortUpstream = (): void => {
        activeUpRes?.destroy();
        activeUpRes = null;
        activeFwd?.destroy();
        activeFwd = null;
      };
      // A killed/timed-out agent run closes the downstream connection while the
      // upstream may still be generating. Leaving that inference running wedges
      // the serving layer (recorded: accept-blocking after orphan generations),
      // so the active upstream request is destroyed with the client.
      res.on('close', () => {
        if (res.writableFinished) return;
        aborted = true;
        abortUpstream();
        if (logPath) appendFileSync(logPath, `${new Date().toISOString()} client disconnected - aborted the upstream request\n`);
      });

      const sendUpstream = (attempt: number): void => {
        if (aborted || res.writableEnded || res.destroyed) return;
        const fwd = httpRequest(
          {
            hostname: up.hostname,
            port: up.port,
            path: req.url,
            method: req.method,
            headers: fwdHeaders,
            agent: false,
          },
          (upRes) => {
            clearTimeout(connectTimer);
            clearTimeout(responseTimer);
            if (aborted) {
              upRes.destroy();
              fwd.destroy();
              return;
            }
            activeUpRes = upRes;
            if (!res.headersSent) res.writeHead(upRes.statusCode || 502, upRes.headers);
            upRes.on('error', () => { res.destroy(); });
            upRes.pipe(res);
          },
        );
        activeFwd = fwd;
        let connected = false;
        let responseTimer: NodeJS.Timeout | undefined;
        const connectTimer = setTimeout(() => {
          if (!connected) fwd.destroy(new Error(`connect deadline after ${deadlineMs}ms`));
        }, deadlineMs);
        fwd.on('socket', (socket) => {
          const onConnect = (): void => {
            connected = true;
            clearTimeout(connectTimer);
            // The connect timer alone leaves a connected-but-silent upstream
            // unbounded; response headers get their own deadline from here.
            responseTimer = setTimeout(() => {
              fwd.destroy(new Error(`response deadline after ${responseDeadline}ms`));
            }, responseDeadline);
          };
          socket.once('connect', onConnect);
          socket.once('secureConnect', onConnect);
        });
        fwd.on('error', (err) => {
          clearTimeout(connectTimer);
          clearTimeout(responseTimer);
          const clientGone = aborted || res.writableEnded || res.destroyed;
          if (!clientGone && attempt < attemptsMax && isRetryableUpstreamError(err.message)) {
            if (logPath) appendFileSync(logPath, `${new Date().toISOString()} upstream retry ${attempt + 1} after: ${err.message}\n`);
            setTimeout(() => sendUpstream(attempt + 1), delayMs);
            return;
          }
          if (logPath) appendFileSync(logPath, `${new Date().toISOString()} upstream error: ${err.message}\n`);
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain' });
            res.end(`proxy upstream error: ${err.message}`);
          } else {
            res.destroy();
          }
        });
        fwd.write(body);
        fwd.end();
      };
      sendUpstream(0);
    });
  });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  server.listen(port, '127.0.0.1');
  return server;
}

if (process.argv[1]?.endsWith('local-anthropic-proxy.ts')) {
  const [upstream, portArg, logPath] = process.argv.slice(2);
  const port = Number(portArg ?? 8900);
  const target = upstream ?? 'http://127.0.0.1:1234';
  startProxy({ port, upstream: target, logPath });
  process.stdout.write(`local-anthropic-proxy on 127.0.0.1:${port} -> ${target}\n`);
}
