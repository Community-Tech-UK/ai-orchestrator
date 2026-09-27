import type { DocReviewSession } from '@contracts/schemas/doc-review';
import { DOC_REVIEW_CHANGED_EVENT, getDocReviewService } from '../doc-review/doc-review-service';
import type {
  MobileDocReviewDetailDto,
  MobileDocReviewSummaryDto,
} from '../../shared/types/mobile-gateway.types';
import { parseDocReviewItems } from './mobile-gateway-doc-review-items';
import type { GatewayDocReviewSource } from './mobile-gateway-doc-review-handlers';

export function projectDocReviewSummary(session: DocReviewSession): MobileDocReviewSummaryDto {
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    instanceId: session.instanceId,
    createdAt: session.createdAt,
    decidedAt: session.decidedAt ?? null,
  };
}

export function createLiveDocReviewSource(): GatewayDocReviewSource {
  const service = getDocReviewService();
  return {
    listPending() {
      return service.listSessions('pending').map(projectDocReviewSummary);
    },
    async get(id) {
      const session = service.getSession(id);
      if (!session) return null;
      let items: MobileDocReviewDetailDto['items'] = [];
      try {
        items = parseDocReviewItems(await service.readArtifact(id));
      } catch {
        items = session.decisions.map((decision) => ({
          id: decision.itemId,
          title: decision.title || decision.itemId,
          decisionId: decision.decisionId ?? null,
          options: [],
        }));
      }
      return { review: projectDocReviewSummary(session), items };
    },
    async submit(id, body) {
      const session = await service.submitDecision(id, {
        overall: body.overall,
        decisions: body.decisions,
        generalComment: body.generalComment,
      });
      return { ok: true, status: session.status };
    },
    subscribe(listener) {
      const onChange = (event: { kind?: string; session?: DocReviewSession }) => {
        if (!event.session) return;
        listener(projectDocReviewSummary(event.session), event.kind || 'changed');
      };
      service.on(DOC_REVIEW_CHANGED_EVENT, onChange);
      return () => service.removeListener(DOC_REVIEW_CHANGED_EVENT, onChange);
    },
  };
}
