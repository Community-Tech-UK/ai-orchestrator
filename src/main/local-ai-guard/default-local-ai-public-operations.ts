import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { getWorkerNodeRegistry } from '../remote-node/worker-node-registry';
import {
  createLocalAiManagementOperations,
  type LocalAiManagementOperations,
} from './local-ai-management-operations';
import { getLocalAiGuardRuntime } from './local-ai-runtime';
import { createLocalAiPublicOperations, type LocalAiPublicOperations } from './local-ai-public-operations';

/** Display name of a registered worker node, used for readable Local AI target labels. */
export function defaultLocalAiWorkerName(nodeId: string): string | undefined {
  try {
    return getWorkerNodeRegistry().getNode(nodeId)?.name;
  } catch {
    return undefined;
  }
}

export function createDefaultLocalAiPublicOperations(): LocalAiPublicOperations & LocalAiManagementOperations {
  return {
    ...createLocalAiPublicOperations({
      getRuntime: getLocalAiGuardRuntime,
      discoverCandidates: () => getAuxiliaryLlmService().discoverCandidates(),
      workerName: defaultLocalAiWorkerName,
    }),
    ...createLocalAiManagementOperations({ getRuntime: getLocalAiGuardRuntime }),
  };
}
