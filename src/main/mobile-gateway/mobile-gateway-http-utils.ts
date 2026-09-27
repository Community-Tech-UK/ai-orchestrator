import { X509Certificate } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

const MAX_BODY_BYTES = 8 * 1024 * 1024; // generous: input may carry base64 attachments

/**
 * Extract the primary DNS name from a PEM certificate's subjectAltName, so the
 * gateway can advertise the hostname a phone must connect to for the TLS cert to
 * validate (e.g. a `tailscale cert` name like `mac.tailnet.ts.net`). Returns null
 * if the cert exposes no DNS SAN.
 */
export function extractCertHostname(certPem: string): string | null {
  try {
    const san = new X509Certificate(certPem).subjectAltName;
    if (!san) return null;
    // Format: "DNS:a.example, IP Address:1.2.3.4, DNS:b.example"
    for (const part of san.split(',')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('DNS:')) {
        return trimmed.slice('DNS:'.length).trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

const CAPACITOR_ORIGINS = ['capacitor://localhost', 'ionic://localhost'];
const responseOrigins = new WeakMap<ServerResponse, string | undefined>();
let corsDev = false;

/** Dev browsers (ng serve, the preview host) are allowed only while the app is unpackaged. */
export function setMobileGatewayCorsDev(dev: boolean): void {
  corsDev = dev;
}

export function bindCorsOrigin(res: ServerResponse, origin: string | string[] | undefined): void {
  responseOrigins.set(res, Array.isArray(origin) ? origin[0] : origin);
}

export function allowedCorsOrigin(origin: string | undefined, dev = corsDev): string | null {
  if (!origin) return null;
  if (CAPACITOR_ORIGINS.includes(origin)) return origin;
  if (!dev) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin;
  } catch {
    return null;
  }
  return null;
}

export function corsHeaders(res?: ServerResponse): Record<string, string> {
  const allow = allowedCorsOrigin(res ? responseOrigins.get(res) : undefined);
  return {
    ...(allow ? { 'Access-Control-Allow-Origin': allow } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}

/** Remove a device token from a URL before it can reach a log line. */
export function redactUrlToken(raw: string): string {
  return raw.replace(/([?&])token=[^&#]*/gi, '$1token=redacted');
}

export class MobileRouteError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'MobileRouteError';
  }
}

export function routeErrorStatus(error: unknown): number | null {
  if (error instanceof MobileRouteError) return error.statusCode;
  if (error && typeof error === 'object' && 'statusCode' in error
    && typeof (error as { statusCode: unknown }).statusCode === 'number'
    && (error as { name?: string }).name === 'MobileAutomationRequestError') {
    return (error as { statusCode: number }).statusCode;
  }
  return null;
}

export function sendJsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(res),
  });
  res.end(JSON.stringify(payload));
}

export function bearerFromHeader(authHeader: string | string[] | undefined): string | undefined {
  const value = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (typeof value === 'string' && value.startsWith('Bearer ')) {
    return value.slice('Bearer '.length).trim();
  }
  return undefined;
}

export function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
