import type { IndexingError } from '../../shared/types/codebase.types';

export type CodebaseIndexingLaneJob =
  | {
      type: 'index-codebase';
      rootPath: string;
      storeId?: string;
      force?: boolean;
    };

export interface CodebaseIndexingLaneResult {
  rootPath: string;
  filesIndexed: number;
  chunksCreated: number;
  tokensProcessed: number;
  duration: number;
  errors: IndexingError[];
  completedAt: number;
}
