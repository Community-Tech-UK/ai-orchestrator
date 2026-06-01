import type {
  BrowserActionClass,
  BrowserGatewayDecision,
  BrowserGatewayOutcome,
  BrowserGatewayResult,
} from '@contracts/types/browser';
import type { BrowserAuditStore, BrowserAuditEntryInput } from './browser-audit-store';
import { redactAgentString } from './browser-safe-dto';
import type { BrowserGatewayContext } from './browser-gateway-service-types';

export interface BrowserGatewayResultInput<T> {
  context: BrowserGatewayContext;
  profileId?: string;
  targetId?: string;
  action: string;
  toolName: string;
  actionClass: BrowserActionClass;
  decision: BrowserGatewayDecision;
  outcome: BrowserGatewayOutcome;
  summary: string;
  reason?: string;
  origin?: string;
  url?: string;
  data: T;
  requestId?: string;
  grantId?: string;
  autonomous?: boolean;
}

export class BrowserGatewayResultRecorder {
  constructor(private readonly auditStore: Pick<BrowserAuditStore, 'record'>) {}

  record<T>(params: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> {
    const safeSummary = this.safeAgentString(params.summary, 2_000);
    const safeReason = params.reason
      ? this.safeAgentString(params.reason, 1_000)
      : undefined;
    const auditInput: BrowserAuditEntryInput = {
      instanceId: params.context.instanceId,
      provider: params.context.provider ?? 'orchestrator',
      profileId: params.profileId,
      targetId: params.targetId,
      action: params.action,
      toolName: params.toolName,
      actionClass: params.actionClass,
      origin: params.origin ? this.safeAgentString(params.origin, 2_000) : undefined,
      url: params.url ? this.safeAgentString(params.url, 2_000) : undefined,
      decision: params.decision,
      outcome: params.outcome,
      summary: safeSummary,
      redactionApplied: true,
      requestId: params.requestId,
      grantId: params.grantId,
      autonomous: params.autonomous,
    };
    const audit = this.auditStore.record(auditInput);
    const result = {
      decision: params.decision,
      outcome: params.outcome,
      data: params.data,
      reason: safeReason,
      auditId: audit.id,
    };
    return params.requestId
      ? { ...result, requestId: params.requestId } as BrowserGatewayResult<T>
      : result as BrowserGatewayResult<T>;
  }

  private safeAgentString(value: string, maxLength: number): string {
    return redactAgentString(value).slice(0, maxLength);
  }
}
