/**
 * Checks the real embedding model end to end: that it is installed, loads, and
 * scores meaning rather than shared words. Run with `npm run verify:embedding-model`.
 *
 * This is a script rather than a Vitest spec because the ONNX runtime rejects
 * typed arrays from Vitest's sandboxed context. Bundled, it also runs under
 * Electron, which is how to confirm the native runtime loads in the shipped app.
 */

import {
  LOCAL_EMBEDDING_MODEL,
  resolveEmbeddingModelDir,
} from '../src/main/rlm/embedding/embedding-model';
import { OnnxTextEmbedder } from '../src/main/rlm/embedding/onnx-text-embedder';

function dot(a: Float32Array, b: Float32Array): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function check(label: string, passed: boolean, detail: string): boolean {
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${label} (${detail})`);
  return passed;
}

async function main(): Promise<void> {
  const modelDir = process.argv[2] ?? resolveEmbeddingModelDir(__dirname);
  if (!modelDir) {
    throw new Error('Model not installed. Run: node scripts/fetch-embedding-model.js');
  }

  const startedAt = performance.now();
  const embedder = await OnnxTextEmbedder.load(modelDir, LOCAL_EMBEDDING_MODEL);
  const loadMs = Math.round(performance.now() - startedAt);
  const instruction = LOCAL_EMBEDDING_MODEL.queryInstruction;

  const [query, paraphrase, unrelated] = await embedder.embed([
    `${instruction}my login keeps failing`,
    'authentication errors when signing in to the account',
    'a recipe for slow cooked tomato sauce',
  ]);
  const short = 'retry with backoff';
  const [alone] = await embedder.embed([short]);
  const [batched] = await embedder.embed([short, 'a much longer sentence, so that padding is needed in this batch']);

  const queryTimer = performance.now();
  await embedder.embed([`${instruction}how do we stop the worker exiting while it waits`]);
  const queryMs = performance.now() - queryTimer;
  await embedder.release();

  const results = [
    check('loads', true, `${LOCAL_EMBEDDING_MODEL.id} in ${loadMs} ms from ${modelDir}`),
    check('has the expected size', query.length === 384, `${query.length} dimensions`),
    check('produces unit vectors', Math.abs(dot(query, query) - 1) < 1e-3, dot(query, query).toFixed(4)),
    check(
      'scores meaning above shared words',
      dot(query, paraphrase) > dot(query, unrelated) + 0.1,
      `related ${dot(query, paraphrase).toFixed(3)}, unrelated ${dot(query, unrelated).toFixed(3)}`,
    ),
    check('is unaffected by batching', dot(alone, batched) > 0.999, dot(alone, batched).toFixed(5)),
    check('fits the send deadline', queryMs < 250, `${queryMs.toFixed(1)} ms for a query`),
  ];
  if (results.includes(false)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
