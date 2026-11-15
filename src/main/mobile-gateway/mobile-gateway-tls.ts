import { readFileSync } from 'fs';
import { extractCertHostname } from './mobile-gateway-http-utils';
import { getLogger } from '../logging/logger';

const logger = getLogger('MobileGateway');

interface ResolvedTls {
  cert: Buffer;
  key: Buffer;
  hostname: string | null;
}

export function resolveMobileGatewayTls(certPath?: string, keyPath?: string): ResolvedTls | null {
  const certFile = certPath?.trim();
  const keyFile = keyPath?.trim();
  if (!certFile || !keyFile) return null;
  try {
    const cert = readFileSync(certFile);
    const key = readFileSync(keyFile);
    return {
      cert,
      key,
      hostname: extractCertHostname(cert.toString("utf-8")),
    };
  } catch (error) {
    logger.warn(
      "Mobile gateway TLS configured but cert/key unreadable — falling back to ws://",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return null;
  }
}
