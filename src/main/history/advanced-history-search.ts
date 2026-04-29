import { getLogger } from '../logging/logger';
import type {
  AdvancedHistorySearchInput,
  AdvancedHistorySearchResult,
  ConversationHistoryEntry,
  HistoryLoadOptions,
  HistorySearchSource,
} from '../../shared/types/history.types';
import type {
  SessionRecallResult,
  SessionRecallSource,
} from '../../shared/types/session-recall.types';
import { getSessionRecallService, type SessionRecallService } from '../session/session-recall-service';
import { getHistoryManager, type HistoryManager } from './history-manager';

const logger = getLogger('AdvancedHistorySearch');

export interface AdvancedHistorySearch {
  search(input: AdvancedHistorySearchInput): Promise<AdvancedHistorySearchResult>;
}

type HistorySearchDep = Pick<HistoryManager, 'getEntries' | 'countEntries'>;
type SessionRecallDep = Pick<SessionRecallService, 'search'>;

export class AdvancedHistorySearchService implements AdvancedHistorySearch {
  constructor(
    private readonly history: HistorySearchDep = getHistoryManager(),
    private readonly recall: SessionRecallDep = getSessionRecallService(),
  ) {}

  async search(input: AdvancedHistorySearchInput): Promise<AdvancedHistorySearchResult> {
    const sources = normalizeSources(input.source);
    const wantsHistory = sources.has('history-transcript');
    const otherSources = [...sources].filter((source): source is Exclude<HistorySearchSource, 'history-transcript'> =>
      source !== 'history-transcript'
    );

    const historyOptions: HistoryLoadOptions = {
      searchQuery: input.searchQuery,
      snippetQuery: input.snippetQuery,
      workingDirectory: input.workingDirectory,
      projectScope: input.projectScope,
      timeRange: input.timeRange,
      source: 'history-transcript',
    };

    let entries: ConversationHistoryEntry[] = [];
    let totalCount = 0;
    if (wantsHistory) {
      totalCount = this.history.countEntries(historyOptions);
      entries = this.history.getEntries({
        ...historyOptions,
        page: input.page,
      });
    }

    let recallResults: SessionRecallResult[] = [];
    if (otherSources.length > 0) {
      try {
        recallResults = await this.recall.search({
          query: input.searchQuery ?? input.snippetQuery ?? '',
          sources: otherSources as SessionRecallSource[],
          includeHistoryTranscripts: false,
        });
      } catch (error) {
        logger.warn('Recall delegation failed during advanced history search', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const entryIds = new Set(entries.map(entry => entry.id));
    recallResults = recallResults.filter(result => {
      const entryId = result.metadata?.['entryId'];
      return typeof entryId !== 'string' || !entryIds.has(entryId);
    });

    const pageSize = input.page ? clamp(Math.floor(input.page.pageSize), 1, 100) : entries.length;
    const pageNumber = input.page ? Math.max(1, Math.floor(input.page.pageNumber)) : 1;
    const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

    return {
      entries,
      recallResults,
      page: {
        pageNumber,
        pageSize,
        totalCount,
        totalPages,
      },
    };
  }
}

function normalizeSources(source: HistorySearchSource | HistorySearchSource[] | undefined): Set<HistorySearchSource> {
  if (!source) {
    return new Set<HistorySearchSource>(['history-transcript']);
  }
  return new Set(Array.isArray(source) ? source : [source]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

let instance: AdvancedHistorySearch | null = null;

export function getAdvancedHistorySearch(): AdvancedHistorySearch {
  instance ??= new AdvancedHistorySearchService();
  return instance;
}

export function _resetAdvancedHistorySearchForTesting(): void {
  instance = null;
}
