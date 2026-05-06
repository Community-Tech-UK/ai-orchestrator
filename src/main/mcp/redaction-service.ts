import type { McpTransport } from '../../shared/types/mcp-orchestrator.types';
import type { McpScope, SupportedProvider } from '../../shared/types/mcp-scopes.types';
import {
  REDACTED_SENTINEL,
  type RedactedMcpServerDto,
} from '../../shared/types/mcp-dtos.types';
import { SecretClassifier } from './secret-classifier';

export interface RawMcpRecord {
  id: string;
  name: string;
  description?: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  autoConnect: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface RedactionContext {
  scope: McpScope;
  readOnly: boolean;
  sourceFile?: string;
  sharedTargets?: readonly SupportedProvider[];
}

export class RedactionService {
  constructor(private readonly classifier: SecretClassifier) {}

  redact(raw: RawMcpRecord, ctx: RedactionContext): RedactedMcpServerDto {
    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      scope: ctx.scope,
      transport: raw.transport,
      command: raw.command,
      args: this.redactArgs(raw.args),
      url: this.redactUrl(raw.url),
      headers: this.redactRecord(raw.headers),
      env: this.redactRecord(raw.env),
      autoConnect: raw.autoConnect,
      sourceFile: ctx.sourceFile,
      readOnly: ctx.readOnly,
      sharedTargets: ctx.sharedTargets,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  private redactRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!record) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        this.classifier.isSecret(key, value) ? REDACTED_SENTINEL : value,
      ]),
    );
  }

  private redactUrl(url: string | undefined): string | undefined {
    if (!url) {
      return undefined;
    }
    try {
      const parsed = new URL(url);
      if (parsed.username) {
        parsed.username = REDACTED_SENTINEL;
      }
      if (parsed.password) {
        parsed.password = REDACTED_SENTINEL;
      }
      for (const [key, value] of parsed.searchParams.entries()) {
        if (this.classifier.isSecret(key, value)) {
          parsed.searchParams.set(key, REDACTED_SENTINEL);
        }
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  private redactArgs(args: string[] | undefined): string[] | undefined {
    if (!args) {
      return undefined;
    }
    let redactNext = false;
    return args.map((arg) => {
      if (redactNext) {
        redactNext = false;
        return REDACTED_SENTINEL;
      }

      const equalsMatch = arg.match(/^(--?[^=\s]+)=(.*)$/);
      if (equalsMatch) {
        const [, key, value] = equalsMatch;
        if (key && value !== undefined && this.classifier.isSecret(key, value)) {
          return `${key}=${REDACTED_SENTINEL}`;
        }
        return arg;
      }

      if (/^--?/.test(arg) && this.classifier.isSecret(arg, 'placeholder-secret-value')) {
        redactNext = true;
      }
      return arg;
    });
  }
}
