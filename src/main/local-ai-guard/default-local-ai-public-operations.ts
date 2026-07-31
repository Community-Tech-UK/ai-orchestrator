import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { getLocalAiGuardRuntime } from './local-ai-runtime';
import { createLocalAiPublicOperations, type LocalAiPublicOperations } from './local-ai-public-operations';

export function createDefaultLocalAiPublicOperations(): LocalAiPublicOperations {
  return createLocalAiPublicOperations({
    getRuntime: getLocalAiGuardRuntime,
    discoverCandidates: () => getAuxiliaryLlmService().discoverCandidates(),
  });
}

