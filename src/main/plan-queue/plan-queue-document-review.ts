/** Review identity covers every candidate linked spec, including absent files. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const documentReviewSchema = z.object({ version: z.literal(1), documentSha256: hash.nullable(),
  linkedSpecSha256: z.array(hash.nullable()).max(2) });
export type DocumentReview = z.infer<typeof documentReviewSchema>;

export function linkedSpecPaths(documentPath: string): string[] {
  if (!/_plan\.md$/i.test(documentPath)) return [];
  const name = path.basename(documentPath).replace(/_plan\.md$/i, '_spec_planned.md');
  return [path.join(path.dirname(documentPath), name), path.resolve(path.dirname(documentPath), '..', 'specs', name)];
}

export async function readDocumentReview(documentPath: string): Promise<DocumentReview> {
  const digest = async (file: string): Promise<string | null> => {
    try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const documentSha256 = await digest(documentPath);
  return { version: 1, documentSha256, linkedSpecSha256: await Promise.all(linkedSpecPaths(documentPath).map(digest)) };
}

export function assertDocumentReview(actual: DocumentReview, reviewed: DocumentReview): void {
  if (actual.documentSha256 !== reviewed.documentSha256 || JSON.stringify(actual.linkedSpecSha256) !== JSON.stringify(reviewed.linkedSpecSha256)) {
    throw new Error('The source document or linked specification changed after its checker passed; keep it open and check it again.');
  }
}
