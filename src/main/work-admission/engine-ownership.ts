import { isAdapterOnLoan } from '../instance/lifecycle/adapter-loan-registry';

interface OwnershipCandidate { id: string; parentId?: string | null; metadata?: Record<string, unknown> }
const ENGINE_MARKERS = ['planQueueRole', 'planQueueRunId', 'pingPongReviewer', 'automationRunId', 'repoJobId', 'loopRunId', 'campaignId'] as const;

/** Engine workers may be roots or children; ancestry alone is not ownership. */
export function ownedByEngine(instance: OwnershipCandidate, includeAdapterLoan = true): boolean {
  return (includeAdapterLoan && isAdapterOnLoan(instance.id)) || ENGINE_MARKERS.some(marker => Boolean(instance.metadata?.[marker]));
}
