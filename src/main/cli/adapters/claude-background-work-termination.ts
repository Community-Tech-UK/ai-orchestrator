import type { OutputMessage } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { errorDiagnostic } from '../../logging/source-diagnostics';
import { getLogger } from '../../logging/logger';
import type { StoppedHelper } from '../../session/session-continuity.types';

/** Retains the transcript sink when shutdown removes the adapter's listeners. */
export class ClaudeBackgroundWorkTermination {
  private reporter: ((message: OutputMessage) => void | Promise<void>) | null = null;
  private pending = Promise.resolve();
  private readonly reported = new Set<string>();

  constructor(private readonly emitOutput: (message: OutputMessage) => void) {}

  setReporter(reporter: ((message: OutputMessage) => void | Promise<void>) | null): void { this.reporter = reporter; }

  settle(): Promise<void> { return this.pending; }

  report(helpers: StoppedHelper[]): void {
    const fresh = helpers.filter((helper) => !this.reported.has(`${helper.toolUseId}:${helper.toolUseCount ?? 0}`));
    if (fresh.length === 0) return;
    for (const helper of fresh) this.reported.add(`${helper.toolUseId}:${helper.toolUseCount ?? 0}`);
    getLogger('ClaudeCliAdapter').warn('Stopping session also stops helper agents', { count: fresh.length });
    const message: OutputMessage = {
      id: generateId(), timestamp: Date.now(), type: 'system',
      content: `Stopped ${fresh.length} helper agent${fresh.length === 1 ? '' : 's'} that had not finished.`,
      metadata: { stoppedHelpers: fresh },
    };
    try {
      const result = this.reporter ? this.reporter(message) : this.emitOutput(message);
      this.pending = Promise.resolve(result).catch((error) => {
        getLogger('ClaudeCliAdapter').warn('Could not save stopped helper agents', { count: fresh.length, ...errorDiagnostic(error) });
      });
    } catch (error) {
      // A failed transcript sink must not abort shutdown and leave the process alive.
      getLogger('ClaudeCliAdapter').warn('Could not record stopped helper agents', { count: fresh.length, ...errorDiagnostic(error) });
    }
  }
}
