import type { IncomingMessage, ServerResponse } from 'http';
import type { MobileBrowserActionClass, MobilePromptDto } from '../../shared/types/mobile-gateway.types';
import { MobileRouteError, readJsonBody, sendJsonResponse } from './mobile-gateway-http-utils';

/** Login, payment, and identity steps stay on the Mac. */
export const PHONE_BLOCKED_BROWSER_ACTIONS = new Set<MobileBrowserActionClass>([
  'credential',
  'payment',
  'financial_identity',
  'sensitive_identity',
]);

const ACTION_CLASSES = new Set<string>([
  'read', 'navigate', 'input', 'credential', 'file-upload', 'file-download',
  'submit', 'destructive', 'financial_identity', 'sensitive_identity', 'payment', 'unknown',
]);

export interface GatewayBrowserApprovalRecord {
  id: string;
  requestId: string;
  instanceId: string;
  toolName: string;
  action: string;
  actionClass: string;
  origin?: string;
  url?: string;
  createdAt: number;
  status: string;
}

export interface GatewayBrowserApprovalSource {
  listPending(): Promise<GatewayBrowserApprovalRecord[]>;
  approve(requestId: string): Promise<void>;
  deny(requestId: string, reason?: string): Promise<void>;
}

export interface BrowserPromptSink {
  syncBrowser(prompts: MobilePromptDto[]): void;
  get(requestId: string): MobilePromptDto | undefined;
  clear(requestId: string): void;
}

export function projectBrowserPrompt(record: GatewayBrowserApprovalRecord): MobilePromptDto | null {
  if (record.status !== 'pending') return null;
  const actionClass = ACTION_CLASSES.has(record.actionClass)
    ? record.actionClass as MobileBrowserActionClass
    : 'unknown';
  const site = record.origin || record.url;
  return {
    id: record.requestId,
    instanceId: record.instanceId,
    requestId: record.requestId,
    kind: 'browser',
    toolName: record.toolName,
    title: site ? `${record.toolName} on ${site}` : record.toolName,
    message: record.action,
    createdAt: record.createdAt,
    browserRequestId: record.requestId,
    actionClass,
    ...(site ? { site } : {}),
  };
}

export function browserPromptApprovable(prompt: MobilePromptDto): boolean {
  return prompt.kind === 'browser' && !!prompt.actionClass && !PHONE_BLOCKED_BROWSER_ACTIONS.has(prompt.actionClass);
}

export class MobileGatewayBrowserApprovalHandlers {
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly deps: {
    getSource(): GatewayBrowserApprovalSource;
    prompts: BrowserPromptSink;
    intervalMs?: number;
  }) {}

  attach(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.deps.intervalMs ?? 2_000);
  }

  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.read()
      .catch(() => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async read(): Promise<void> {
    const pending = await this.deps.getSource().listPending();
    const prompts = pending.flatMap((record) => {
      const prompt = projectBrowserPrompt(record);
      return prompt ? [prompt] : [];
    });
    this.deps.prompts.syncBrowser(prompts);
  }

  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (segments[1] !== 'browser-approvals' || segments.length !== 4 || segments[3] !== 'respond' || method !== 'POST') {
      return false;
    }
    let requestId: string;
    try {
      requestId = decodeURIComponent(segments[2]).trim();
    } catch {
      throw new MobileRouteError('A valid browser request id is required');
    }
    if (!requestId || requestId.length > 200) throw new MobileRouteError('A valid browser request id is required');
    const prompt = this.deps.prompts.get(requestId);
    if (!prompt || prompt.kind !== 'browser') {
      sendJsonResponse(res, 404, { error: 'Browser approval not found' });
      return true;
    }
    if (!browserPromptApprovable(prompt)) {
      throw new MobileRouteError('Open this step on your Mac. The phone cannot approve it.');
    }
    const body = await readJsonBody(req) as { decisionAction?: unknown; reason?: unknown };
    if (body.decisionAction !== 'allow' && body.decisionAction !== 'deny') {
      throw new MobileRouteError('decisionAction must be allow or deny');
    }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined;
    if (body.decisionAction === 'allow') await this.deps.getSource().approve(requestId);
    else await this.deps.getSource().deny(requestId, reason);
    this.deps.prompts.clear(requestId);
    sendJsonResponse(res, 200, { ok: true });
    return true;
  }
}
