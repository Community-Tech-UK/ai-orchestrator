import { ComposerSubmissionService } from './composer-submission.service';
import type { ComposerSubmissionStorage } from './composer-submission.types';

/**
 * Build a `ComposerSubmissionService` over a caller-supplied journal.
 *
 * The service constructs its own storage because an interface-typed
 * constructor parameter has no runtime value for Angular's JIT reflection to
 * resolve — see the note on the field. Tests swap it through the seam instead.
 */
export function makeService(storage: ComposerSubmissionStorage): ComposerSubmissionService {
  const service = new ComposerSubmissionService();
  service._setStorageForTesting(storage);
  return service;
}
