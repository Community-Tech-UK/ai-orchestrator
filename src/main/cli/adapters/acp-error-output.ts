import { presentError } from '../../../shared/present-error';
import type { OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { redactSecrets } from '../../security/secret-detector';

/** The raw Error still travels on the machine channel; only this copy is shown. */
export function buildAcpErrorOutput(error: Error, provider: string | undefined, recoverable: boolean, adapterName: string): OutputMessage {
  const errorPresentation = presentError(error, { provider });
  errorPresentation.rawDetail = redactSecrets(errorPresentation.rawDetail);
  return {
    id: generateId(), timestamp: Date.now(), type: 'error',
    content: `${errorPresentation.headline} ${errorPresentation.whatToDo}`,
    metadata: {
      source: 'acp-send-input', transport: 'acp', adapter: adapterName, errorPresentation,
      ...(recoverable ? { recoverable: true, retryKind: 'acp-prompt-timeout' } : {}),
    },
  };
}
