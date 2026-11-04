import { AcpCliAdapter } from '../acp-cli-adapter';
import type { AdapterInputDispatch, CliMessage, CliResponse } from '../base-cli-adapter';
import { CopilotAdapterUsage } from './copilot-adapter-usage';

/** Copilot-specific lifetime wiring; the ACP protocol implementation remains shared. */
export class CopilotAcpAdapter extends AcpCliAdapter {
  private readonly numericUsage: CopilotAdapterUsage;

  constructor(config: ConstructorParameters<typeof AcpCliAdapter>[0], home: string) {
    super(config);
    this.numericUsage = new CopilotAdapterUsage(this, home);
  }

  override async spawn(): Promise<number> {
    try {
      const pid = await super.spawn();
      const id = this.getSessionId();
      if (id) this.numericUsage.monitor.start(id);
      await this.numericUsage.monitor.refresh();
      return pid;
    } catch (error) { this.numericUsage.monitor.stop(); throw error; }
  }

  override async sendMessage(message: CliMessage, dispatch?: AdapterInputDispatch,
    writePhase = { accepted: false, cancelledByClient: false }): Promise<CliResponse> {
    try { return await super.sendMessage(message, dispatch, writePhase); }
    finally { await this.numericUsage.monitor.refresh(); }
  }

  getCopilotUsage() { return this.numericUsage.monitor.snapshot(); }

  override async terminate(graceful = true): Promise<void> {
    this.numericUsage.monitor.stop();
    await super.terminate(graceful);
  }
}
