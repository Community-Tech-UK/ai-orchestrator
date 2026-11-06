/**
 * Runs a sentence-embedding model locally with ONNX Runtime.
 *
 * Inference happens on the runtime's own threads and resolves a promise, so it
 * does not block the calling event loop. Calls are serialised and the thread
 * count is capped: this machine usually has many agents competing for CPU.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { InferenceSession } from 'onnxruntime-node';
import { WordPieceTokenizer } from './wordpiece-tokenizer';

const INFERENCE_THREADS = 2;

export interface OnnxModelFormat {
  /** How token vectors combine into one text vector. Set by how the model was trained. */
  pooling: 'mean' | 'cls';
  maxTokens: number;
}

export class OnnxTextEmbedder {
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly session: InferenceSession,
    private readonly tensor: typeof import('onnxruntime-node').Tensor,
    private readonly tokenizer: WordPieceTokenizer,
    private readonly format: OnnxModelFormat,
  ) {}

  static async load(modelDir: string, format: OnnxModelFormat): Promise<OnnxTextEmbedder> {
    const ort = await import('onnxruntime-node');
    const tokenizerJson = JSON.parse(await readFile(path.join(modelDir, 'tokenizer.json'), 'utf8')) as unknown;
    const session = await ort.InferenceSession.create(path.join(modelDir, 'model.onnx'), {
      executionProviders: ['cpu'],
      intraOpNumThreads: INFERENCE_THREADS,
      interOpNumThreads: 1,
      graphOptimizationLevel: 'all',
    });
    return new OnnxTextEmbedder(session, ort.Tensor, WordPieceTokenizer.fromJson(tokenizerJson), format);
  }

  /** One unit-length vector per text, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]> {
    const run = this.tail.then(() => this.runBatch(texts));
    this.tail = run.catch(() => undefined);
    return run;
  }

  async release(): Promise<void> {
    await this.tail;
    await this.session.release();
  }

  private async runBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const encoded = texts.map((text) => this.tokenizer.encode(text, this.format.maxTokens));
    const width = Math.max(...encoded.map((ids) => ids.length));
    const size = encoded.length * width;
    const inputIds = new BigInt64Array(size);
    const attentionMask = new BigInt64Array(size);
    encoded.forEach((ids, row) => {
      ids.forEach((id, column) => {
        inputIds[row * width + column] = BigInt(id);
        attentionMask[row * width + column] = 1n;
      });
    });

    const shape = [encoded.length, width];
    const feeds: Record<string, InstanceType<typeof this.tensor>> = {
      input_ids: new this.tensor('int64', inputIds, shape),
      attention_mask: new this.tensor('int64', attentionMask, shape),
    };
    if (this.session.inputNames.includes('token_type_ids')) {
      feeds['token_type_ids'] = new this.tensor('int64', new BigInt64Array(size), shape);
    }

    const output = (await this.session.run(feeds))[this.session.outputNames[0]];
    const hidden = output.data as Float32Array;
    const dimensions = output.dims[2];
    return encoded.map((ids, row) => normalize(this.pool(hidden, row, ids.length, width, dimensions)));
  }

  private pool(
    hidden: Float32Array,
    row: number,
    tokens: number,
    width: number,
    dimensions: number,
  ): Float32Array {
    const rowStart = row * width * dimensions;
    if (this.format.pooling === 'cls') {
      return hidden.slice(rowStart, rowStart + dimensions);
    }
    const pooled = new Float32Array(dimensions);
    for (let token = 0; token < tokens; token += 1) {
      const tokenStart = rowStart + token * dimensions;
      for (let dimension = 0; dimension < dimensions; dimension += 1) {
        pooled[dimension] += hidden[tokenStart + dimension];
      }
    }
    return pooled.map((value) => value / tokens);
  }
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  return vector.map((value) => value / norm);
}
