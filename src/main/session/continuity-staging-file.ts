const ATOMIC_WRITER_ID = `${process.pid}-${Date.now()}`;
let atomicWriteSequence = 0;

const LEGACY_STAGING_NAME = /^(.+\.json)\.tmp$/u;
const UNIQUE_STAGING_NAME = /^(.+\.json)\.(\d+)-(\d+)-(\d+)\.tmp$/u;

export interface ContinuityStagingFileName {
  finalFileName: string;
  writerProcessId: number;
  writerStartedAt: number;
  sequence: number;
}

export function getContinuityStagingPath(filePath: string): string {
  atomicWriteSequence += 1;
  return `${filePath}.${ATOMIC_WRITER_ID}-${atomicWriteSequence}.tmp`;
}

export function parseContinuityStagingFileName(fileName: string): ContinuityStagingFileName | null {
  const uniqueMatch = UNIQUE_STAGING_NAME.exec(fileName);
  const match = uniqueMatch ?? LEGACY_STAGING_NAME.exec(fileName);
  const finalFileName = match?.[1];
  if (!finalFileName || finalFileName.length <= '.json'.length || /[\\/]/u.test(finalFileName)) {
    return null;
  }
  const ordering = uniqueMatch ? uniqueMatch.slice(2).map(Number) : [0, 0, 0];
  if (!ordering.every(Number.isSafeInteger)) return null;
  return {
    finalFileName,
    writerProcessId: ordering[0],
    writerStartedAt: ordering[1],
    sequence: ordering[2],
  };
}
