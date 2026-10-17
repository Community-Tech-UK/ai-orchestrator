import { TranscriptReplayIdentitySchema } from '../../../../../shared/utils/instance-transcript-replay';
import type { InstanceStateService } from './instance-state.service';

/** Unknown startup instances recover from main's already repaired buffer, without retaining transcript chunks. */
export class InstanceTranscriptResync {
  private readonly identities = new Map<string, number>();
  private pending = false;
  private failed = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly state: InstanceStateService,
    private readonly load: (incarnations: ReadonlyMap<string, number>) => Promise<void>, private readonly onFailure: () => void) {}

  request(payload: unknown): void {
    if (this.disposed || this.failed) return;
    const parsed = TranscriptReplayIdentitySchema.safeParse(payload);
    if (!parsed.success) { this.fail(); return; }
    const { instanceId, createdAt } = parsed.data;
    if (!this.identities.has(instanceId) && this.identities.size >= 8) { this.fail(); return; }
    this.identities.set(instanceId, createdAt);
    if (this.pending) return;
    this.pending = true;
    this.timer = setTimeout(() => this.fail(), 30_000);
    void this.load(this.identities).then(() => {
      if (this.disposed || this.failed) return;
      for (const id of this.identities.keys()) {
        const instance = this.state.getInstance(id);
        if (!instance) { this.fail(); return; }
      }
    }).catch(() => this.fail()).finally(() => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.identities.clear();
      this.pending = false;
      this.failed = false;
    });
  }

  remove(instanceId: string): void { this.identities.delete(instanceId); }

  clear(): void {
    this.disposed = true;
    this.identities.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fail(): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    this.identities.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.onFailure();
    if (!this.pending) this.failed = false;
  }
}
