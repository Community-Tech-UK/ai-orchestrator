import type { IncomingMessage, ServerResponse } from 'http';
import type {
  MobileDocReviewDecisionRequest,
  MobileDocReviewDecisionResponse,
  MobileDocReviewDetailDto,
  MobileDocReviewItemDecisionDto,
  MobileDocReviewSummaryDto,
} from '../../shared/types/mobile-gateway.types';
import { MobileRouteError, readJsonBody, sendJsonResponse } from './mobile-gateway-http-utils';

const OVERALL = new Set(['approved', 'changes_requested', 'rejected']);
const ITEM_DECISION = new Set(['approve', 'reject']);

export interface GatewayDocReviewSource {
  listPending(): MobileDocReviewSummaryDto[];
  get(id: string): Promise<MobileDocReviewDetailDto | null>;
  submit(id: string, body: MobileDocReviewDecisionRequest): Promise<MobileDocReviewDecisionResponse>;
  subscribe(listener: (summary: MobileDocReviewSummaryDto, kind: string) => void): () => void;
}

function decodeId(raw: string): string {
  try {
    const id = decodeURIComponent(raw).trim();
    if (!id || id.length > 200) throw new Error('bad');
    return id;
  } catch {
    throw new MobileRouteError('A valid review id is required');
  }
}

function text(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

function decisionOf(value: unknown): MobileDocReviewItemDecisionDto {
  if (!value || typeof value !== 'object') throw new MobileRouteError('Each decision must be an object');
  const raw = value as Record<string, unknown>;
  const itemId = text(raw, 'itemId')?.trim() ?? '';
  if (!itemId || itemId.length > 200) throw new MobileRouteError('Each decision needs an itemId');
  const decision = raw['decision'] === null ? null : raw['decision'];
  if (decision !== null && (typeof decision !== 'string' || !ITEM_DECISION.has(decision))) {
    throw new MobileRouteError('Item decision must be approve, reject, or null');
  }
  const choiceList = raw['choices'];
  const choices = Array.isArray(choiceList)
    ? choiceList.filter((choice): choice is string => typeof choice === 'string' && choice.length > 0 && choice.length <= 200)
    : undefined;
  const title = text(raw, 'title');
  const decisionId = raw['decisionId'];
  const comment = text(raw, 'comment');
  const choice = raw['choice'];
  return {
    itemId,
    ...(title !== undefined ? { title: title.slice(0, 500) } : {}),
    ...(decisionId === null || typeof decisionId === 'string'
      ? { decisionId: decisionId === null ? null : decisionId.slice(0, 50) }
      : {}),
    decision: decision as MobileDocReviewItemDecisionDto['decision'],
    ...(comment !== undefined ? { comment: comment.slice(0, 10_000) } : {}),
    ...(choice === null || typeof choice === 'string'
      ? { choice: choice === null ? null : choice.slice(0, 200) }
      : {}),
    ...(choices ? { choices: choices.slice(0, 100) } : {}),
  };
}

export function parseDocReviewDecision(body: unknown): MobileDocReviewDecisionRequest {
  if (!body || typeof body !== 'object') throw new MobileRouteError('A decision body is required');
  const raw = body as Record<string, unknown>;
  const overall = text(raw, 'overall');
  if (!overall || !OVERALL.has(overall)) {
    throw new MobileRouteError('overall must be approved, changes_requested, or rejected');
  }
  const decisions = raw['decisions'];
  if (!Array.isArray(decisions)) throw new MobileRouteError('decisions must be a list');
  const generalComment = text(raw, 'generalComment');
  return {
    overall: overall as MobileDocReviewDecisionRequest['overall'],
    decisions: decisions.map(decisionOf),
    ...(generalComment !== undefined ? { generalComment: generalComment.slice(0, 10_000) } : {}),
  };
}

export class MobileGatewayDocReviewHandlers {
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: {
    getSource(): GatewayDocReviewSource;
    sendPendingPush(summary: MobileDocReviewSummaryDto): void;
  }) {}

  attach(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.getSource().subscribe((summary, kind) => {
      if (kind === 'created' && summary.status === 'pending') this.deps.sendPendingPush(summary);
    });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
    if (segments[1] !== 'doc-reviews') return false;
    const source = this.deps.getSource();
    if (segments.length === 2 && method === 'GET') {
      sendJsonResponse(res, 200, source.listPending());
      return true;
    }
    if (segments.length === 3 && method === 'GET') {
      const detail = await source.get(decodeId(segments[2]));
      if (!detail) {
        sendJsonResponse(res, 404, { error: 'Review not found' });
        return true;
      }
      sendJsonResponse(res, 200, detail);
      return true;
    }
    if (segments.length === 4 && segments[3] === 'decision' && method === 'POST') {
      const body = parseDocReviewDecision(await readJsonBody(req));
      sendJsonResponse(res, 200, await source.submit(decodeId(segments[2]), body));
      return true;
    }
    return false;
  }
}
