import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import { errorDiagnostic } from '../../../logging/source-diagnostics';
import { getLogger } from '../../../logging/logger';

/** Retains the transcript sink when shutdown removes the adapter's listeners. */
export class CodexBackgroundWorkTermination {
  private reporter: ((message: OutputMessage) => void | Promise<void>) | null = null;
  private pending = Promise.resolve();
  constructor(private readonly emitOutput: (message: OutputMessage) => void) {}

  setReporter(reporter: ((message: OutputMessage) => void | Promise<void>) | null): void { this.reporter = reporter; }

  settle(): Promise<void> { return this.pending; }

  report(count: number, commands: string[]): void {
    getLogger('CodexCliAdapter').warn('Stopping session also stops background commands', { count });
    const message: OutputMessage = {
      id: generateId(), timestamp: Date.now(), type: 'system',
      content: `Closing this session also stopped ${count} background command${count === 1 ? '' : 's'} (${commands.join('; ')}).`,
      metadata: { backgroundCommandsStopped: count },
    };
    try {
      const result = this.reporter ? this.reporter(message) : this.emitOutput(message);
      this.pending = Promise.resolve(result).catch((error) => {
        getLogger('CodexCliAdapter').warn('Could not save stopped background commands', { count, ...errorDiagnostic(error) });
      });
    } catch (error) {
      // A failed transcript sink must not abort shutdown and leave the process alive.
      getLogger('CodexCliAdapter').warn('Could not record stopped background commands', { count, ...errorDiagnostic(error) });
    }
  }
}
