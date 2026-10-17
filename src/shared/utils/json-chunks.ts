export interface JsonChunk {
  transferId: string;
  index: number;
  total: number;
  text: string;
}

const MAX_CHUNK_CHARACTERS = 65_536;
const MAX_CHUNKS = 1024;
const DEFAULT_MAX_CHARACTERS = 16 * 1024 * 1024;
const MAX_RECENT_TRANSFERS = 128;

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validTransferId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Split the serialized payload, including messages larger than a single transport frame. */
export function encodeJsonChunks(
  value: unknown,
  transferId: string,
  options: { chunkSize?: number; maxCharacters?: number } = {},
): JsonChunk[] {
  const chunkSize = options.chunkSize ?? MAX_CHUNK_CHARACTERS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  if (!validTransferId(transferId) || !positiveInteger(chunkSize) ||
      chunkSize > MAX_CHUNK_CHARACTERS || !positiveInteger(maxCharacters)) {
    throw new Error('Invalid JSON transfer options');
  }
  const text = JSON.stringify(value);
  if (text === undefined || text.length > maxCharacters) {
    throw new Error('JSON transfer is unserializable or exceeds its character limit');
  }
  const total = Math.ceil(text.length / chunkSize);
  if (total > MAX_CHUNKS) throw new Error('JSON transfer exceeds its chunk limit');
  return Array.from({ length: total }, (_, index) => ({
    transferId, index, total, text: text.slice(index * chunkSize, (index + 1) * chunkSize),
  }));
}

interface PendingTransfer {
  startedAt: number;
  total: number;
  characters: number;
  chunks: Map<number, string>;
}

/** Bounds aggregate pending memory; consumers own instance identity and payload validation. */
export class JsonChunkAssembler<T = unknown> {
  private readonly pending = new Map<string, PendingTransfer>();
  private readonly recent = new Map<string, number>();
  private readonly maxCharacters: number;
  private readonly maxTransfers: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private characters = 0;

  constructor(options: {
    maxCharacters?: number; maxTransfers?: number; maxAgeMs?: number; now?: () => number;
  } = {}) {
    this.maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
    this.maxTransfers = options.maxTransfers ?? 8;
    this.maxAgeMs = options.maxAgeMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (![this.maxCharacters, this.maxTransfers, this.maxAgeMs].every(positiveInteger)) {
      throw new Error('Invalid JSON assembler limits');
    }
  }

  accept(input: unknown): { transferId: string; value: T } | undefined {
    const now = this.now();
    this.expire(now);
    const chunk = input as Partial<JsonChunk> | null;
    if (!chunk || !validTransferId(chunk.transferId) ||
        !Number.isSafeInteger(chunk.index) || !positiveInteger(chunk.total ?? 0) ||
        chunk.total! > MAX_CHUNKS || chunk.index! < 0 || chunk.index! >= chunk.total! ||
        typeof chunk.text !== 'string' || chunk.text.length > MAX_CHUNK_CHARACTERS) {
      if (chunk && validTransferId(chunk.transferId)) this.invalidate(chunk.transferId, now);
      throw new Error('Invalid JSON transfer chunk');
    }
    const { transferId, index, total, text } = chunk as JsonChunk;
    if (this.recent.has(transferId)) return undefined;
    let transfer = this.pending.get(transferId);
    if (!transfer) {
      if (this.pending.size >= this.maxTransfers) {
        this.invalidate(transferId, now);
        throw new Error('Too many pending JSON transfers');
      }
      transfer = { startedAt: now, total, characters: 0, chunks: new Map<number, string>() };
      this.pending.set(transferId, transfer);
    }
    const previous = transfer.chunks.get(index);
    if (transfer.total !== total || (previous !== undefined && previous !== text)) {
      this.invalidate(transferId, now);
      throw new Error('Conflicting JSON transfer chunks');
    }
    if (previous !== undefined) return undefined;
    if (this.characters + text.length > this.maxCharacters) {
      this.invalidate(transferId, now);
      throw new Error('Pending JSON transfers exceed their character limit');
    }
    transfer.chunks.set(index, text);
    transfer.characters += text.length;
    this.characters += text.length;
    if (transfer.chunks.size < total) return undefined;
    const serialized = Array.from({ length: total }, (_, i) => transfer.chunks.get(i)!).join('');
    this.invalidate(transferId, now);
    return { transferId, value: JSON.parse(serialized) as T };
  }

  clear(transferId?: string): void {
    if (transferId !== undefined) {
      this.removePending(transferId);
      this.recent.delete(transferId);
    } else {
      this.pending.clear();
      this.recent.clear();
      this.characters = 0;
    }
  }

  private removePending(transferId: string): void {
    const transfer = this.pending.get(transferId);
    if (transfer) this.characters -= transfer.characters;
    this.pending.delete(transferId);
  }

  private invalidate(transferId: string, now: number): void {
    this.removePending(transferId);
    this.recent.set(transferId, now);
    if (this.recent.size > MAX_RECENT_TRANSFERS) this.recent.delete(this.recent.keys().next().value!);
  }

  private expire(now: number): void {
    for (const [id, startedAt] of this.recent) {
      if (now - startedAt >= this.maxAgeMs) this.recent.delete(id);
    }
    for (const [id, transfer] of this.pending) {
      if (now - transfer.startedAt >= this.maxAgeMs) this.invalidate(id, now);
    }
  }
}
