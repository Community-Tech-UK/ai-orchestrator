import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HASH_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODEL,
  resolveEmbeddingModelDir,
} from '../embedding-model';

const repoRoot = path.resolve(__dirname, '../../../../..');

describe('resolveEmbeddingModelDir', () => {
  let root: string;
  const savedOverride = process.env['AIO_EMBEDDING_MODEL_DIR'];

  function installModel(...segments: string[]): string {
    const directory = path.join(root, ...segments, 'embedding-model', LOCAL_EMBEDDING_MODEL.id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'model.onnx'), 'model');
    return directory;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aio-embedding-model-'));
    delete process.env['AIO_EMBEDDING_MODEL_DIR'];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env['AIO_EMBEDDING_MODEL_DIR'] = savedOverride;
  });

  it('finds the model beside a packaged app archive', () => {
    const installed = installModel('Resources');
    const insideAsar = path.join(root, 'Resources/app.asar/dist/main/rlm/embedding');

    expect(resolveEmbeddingModelDir(insideAsar)).toBe(installed);
  });

  it('finds the model in a checkout', () => {
    const installed = installModel('repo', 'resources');
    const compiled = path.join(root, 'repo/dist/main/rlm/embedding');

    expect(resolveEmbeddingModelDir(compiled)).toBe(installed);
  });

  it('reports no model when none is installed', () => {
    expect(resolveEmbeddingModelDir(path.join(root, 'empty/dist/main/rlm/embedding'))).toBeNull();
  });

  it('lets an explicit directory replace the search', () => {
    const installed = installModel('elsewhere');
    process.env['AIO_EMBEDDING_MODEL_DIR'] = installed;

    expect(resolveEmbeddingModelDir(path.join(root, 'unrelated'))).toBe(installed);
  });

  it('treats an empty override as no model, even if one is installed nearby', () => {
    installModel('resources');
    process.env['AIO_EMBEDDING_MODEL_DIR'] = '';

    expect(resolveEmbeddingModelDir(root)).toBeNull();
  });
});

describe('model definitions', () => {
  it('keeps the runtime model id in step with what the fetch script installs', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, 'scripts/embedding-model.json'), 'utf8'),
    ) as { id: string; files: { to: string; sha256: string }[] };

    expect(manifest.id).toBe(LOCAL_EMBEDDING_MODEL.id);
    expect(manifest.files.map((file) => file.to).sort()).toEqual(['model.onnx', 'tokenizer.json']);
    for (const file of manifest.files) {
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('never gives the two models the same id, which would let their vectors mix', () => {
    expect(HASH_EMBEDDING_MODEL.id).not.toBe(LOCAL_EMBEDDING_MODEL.id);
  });

  it('keeps the id already written on stored hash vectors', () => {
    expect(HASH_EMBEDDING_MODEL.id).toBe('local-tfidf');
  });

  it('sets search floors above the chance level measured for this model', () => {
    const chanceAtP99 = 0.68;
    const { similarityFloors } = LOCAL_EMBEDDING_MODEL;

    expect(similarityFloors['context-search']).toBeGreaterThan(chanceAtP99);
    expect(similarityFloors['session-search']).toBeGreaterThan(chanceAtP99);
    expect(similarityFloors['pattern-search']).toBeGreaterThan(chanceAtP99);
  });
});
