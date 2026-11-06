/**
 * Default wiring for the "Where your usage went" service: where Claude keeps its
 * transcripts, where Harness keeps its cost logs, and how to look a session up.
 * Kept apart from the service so the service itself stays free of Electron and
 * database imports and can be tested with plain objects.
 */

import { getLogger } from '../logging/logger';
import { getProviderStateRoot } from '../cli/adapters/adapter-spawn-helpers';
import { CLAUDE_PROFILES_ROOT_DIR } from '../cli/adapters/account-pool/provider-account-home-resolver';
import { getCostAttributionDirectory } from '../core/system/cost-attribution';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ClaudeTranscriptScanner } from './claude-transcript-usage-scanner';
import { resolveClaudeConfigRoots } from './claude-transcript-files';
import { UsageAttributionReader } from './usage-attribution-reader';
import {
  UsageInsightService,
  type SessionLinks,
  type SessionLinksResult,
  type UsageInsightDeps,
} from './usage-insight-service';

const logger = getLogger('UsageInsight');

interface SessionLinkRow {
  session_id: string;
  instance_id: string;
}

/**
 * Which Harness session ran each Claude session, from the persisted cost log.
 * The query is bounded to the 7-day window and uses the timestamp index.
 */
export function createCostLogSessionLinks(getDb: () => SqliteDriver): (sinceMs: number) => Promise<SessionLinksResult> {
  return async (sinceMs) => {
    const links: SessionLinks = new Map();
    try {
      const rows = getDb().prepare(
        `SELECT session_id, instance_id FROM cost_entries
          WHERE timestamp >= ? AND session_id <> '' AND instance_id <> ''
          GROUP BY session_id, instance_id
          ORDER BY MAX(timestamp) ASC`,
      ).all<SessionLinkRow>(sinceMs);
      for (const row of rows) {
        const list = links.get(row.session_id) ?? [];
        list.push(row.instance_id);
        links.set(row.session_id, list);
      }
    } catch (error) {
      // Without the cost log no session is linked. The result says so, and the report carries a note.
      logger.warn('Could not read session links from the cost log', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { links: new Map(), unavailable: true };
    }
    return { links };
  };
}

let service: UsageInsightService | null = null;

/** The one service for the app. `resolveInstance` is supplied where IPC is registered. */
export function getUsageInsightService(resolveInstance: UsageInsightDeps['resolveInstance']): UsageInsightService {
  if (!service) {
    const stateRoot = getProviderStateRoot();
    service = new UsageInsightService({
      scanner: new ClaudeTranscriptScanner({
        roots: () => resolveClaudeConfigRoots({ stateRoot, profilesDirName: CLAUDE_PROFILES_ROOT_DIR }),
      }),
      attribution: new UsageAttributionReader(getCostAttributionDirectory),
      loadSessionLinks: createCostLogSessionLinks(() => getRLMDatabase().getRawDb()),
      resolveInstance,
    });
  }
  return service;
}

export function _resetUsageInsightServiceForTesting(): void {
  service?.dispose();
  service = null;
}
