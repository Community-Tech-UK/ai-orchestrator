import { JsonChunkAssembler } from '../../../../../shared/utils/json-chunks';
import { parseInstanceTranscriptReplay, TranscriptReplayIdentitySchema, type InstanceTranscriptReplay } from '../../../../../shared/utils/instance-transcript-replay';
import type { Instance, OutputMessage } from './instance.types';
import { appendInstanceOutputMessage } from './instance-output-message-merge';

type Identity = Omit<InstanceTranscriptReplay, 'messages'>;
interface Transfer { identity: Identity; transferId: string; startedAt: number; live: OutputMessage[]; characters: number; timer?: ReturnType<typeof setTimeout> }
const MAX_LIVE_CHARACTERS = 16 * 1024 * 1024;
/** Assembly owns no UI hooks. Only live arrivals after the snapshot's first chunk survive replacement. */
export class InstanceTranscriptReplayAssembler {
  private readonly assembler = new JsonChunkAssembler();
  private readonly transfers = new Map<string, Transfer>();
  private readonly revisions = new Map<string, { createdAt: number; value: number }>();
  constructor(private readonly now: () => number = Date.now, private readonly onFailure: () => void = () => undefined) {}

  accept(input: unknown, instance: Instance | undefined): InstanceTranscriptReplay | undefined {
    if (!instance) return undefined;
    const packet = input as { chunk?: unknown };
    const identity = TranscriptReplayIdentitySchema.parse(input);
    if (identity.instanceId !== instance.id || identity.createdAt !== instance.createdAt
      || identity.adapterGeneration < (instance.adapterGeneration ?? 0) || identity.restartEpoch < instance.restartEpoch) return undefined;
    let known = this.revisions.get(instance.id);
    if (known && known.createdAt !== identity.createdAt) { this.clear(instance.id); known = undefined; }
    if (known && identity.revision < known.value) return undefined;
    let transfer = this.transfers.get(instance.id);
    if (transfer && this.now() - transfer.startedAt >= 30_000) { this.fail(instance.id); transfer = undefined; }
    const chunk = packet.chunk as { transferId?: unknown };
    if (typeof chunk?.transferId !== 'string') throw new Error('Invalid history replay transfer.');
    if (!transfer || transfer.transferId !== chunk.transferId) {
      if (known && identity.revision <= known.value) return undefined;
      this.drop(instance.id);
      if (this.transfers.size >= 8) throw new Error('Too many history replay transfers.');
      transfer = { identity, transferId: chunk.transferId, startedAt: this.now(), live: [], characters: 0 };
      this.transfers.set(instance.id, transfer);
      const expiring = transfer;
      transfer.timer = setTimeout(() => { if (this.transfers.get(instance.id) === expiring) this.fail(instance.id); }, 30_000);
      this.revisions.set(instance.id, { createdAt: identity.createdAt, value: identity.revision });
    }
    if (JSON.stringify(transfer.identity) !== JSON.stringify(identity)) { this.drop(instance.id); throw new Error('Conflicting history replay identity.'); }
    try {
      const completed = this.assembler.accept(packet.chunk);
      if (!completed) return undefined;
      const snapshot = parseInstanceTranscriptReplay(completed.value);
      if (JSON.stringify(transfer.identity) !== JSON.stringify(TranscriptReplayIdentitySchema.parse(snapshot))) throw new Error('Conflicting history replay snapshot.');
      const messages = [...snapshot.messages];
      const userIds = new Set(messages.filter(message => message.type === 'user').map(message => message.id));
      for (const message of transfer.live) appendInstanceOutputMessage(messages, message, userIds);
      this.drop(instance.id);
      return { ...snapshot, messages };
    } catch (error) { this.drop(instance.id); throw error; }
  }

  noteLive(instanceId: string, message: OutputMessage): void {
    const transfer = this.transfers.get(instanceId);
    if (!transfer) return;
    const generation = message.metadata?.['adapterGeneration'];
    if (typeof generation === 'number' && generation > transfer.identity.adapterGeneration) { this.drop(instanceId); return; }
    const characters = JSON.stringify(message).length;
    const pendingCharacters = [...this.transfers.values()].reduce((sum, pending) => sum + pending.characters, 0);
    if (this.now() - transfer.startedAt >= 30_000 || pendingCharacters + characters > MAX_LIVE_CHARACTERS) { this.fail(instanceId); return; }
    transfer.live.push(message); transfer.characters += characters;
  }
  private drop(instanceId: string): void {
    const transfer = this.transfers.get(instanceId);
    if (transfer?.timer) clearTimeout(transfer.timer);
    if (transfer) this.assembler.clear(transfer.transferId);
    this.transfers.delete(instanceId);
  }
  private fail(instanceId: string): void { this.drop(instanceId); this.onFailure(); }
  clear(instanceId?: string): void {
    if (instanceId !== undefined) { this.drop(instanceId); this.revisions.delete(instanceId); }
    else { for (const id of this.transfers.keys()) this.drop(id); this.revisions.clear(); this.assembler.clear(); }
  }
}
