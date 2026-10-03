import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  SideChatAuthorityPolicy,
  SideChatParentRef,
} from '../../shared/types/side-chat.types';
import { sideChatParentKey } from '../../shared/types/side-chat.types';

interface PolicyRow {
  parent_key: string;
  policy_json: string;
  updated_at: number;
}

/**
 * Persisted authority policy provenance for sidechat parents. Stores enough to
 * re-apply the parent's effective permissions on runtime replacement without
 * copying credentials, execution tokens or completed approval grants.
 */
export class SideChatPolicyStore {
  constructor(private readonly db: SqliteDriver) {}

  get(parent: SideChatParentRef): SideChatAuthorityPolicy | null {
    const row = this.db
      .prepareCached('SELECT * FROM side_chat_policies WHERE parent_key = ?')
      .get<PolicyRow>(sideChatParentKey(parent));
    if (!row) return null;
    try {
      return JSON.parse(row.policy_json) as SideChatAuthorityPolicy;
    } catch {
      return null;
    }
  }

  put(parent: SideChatParentRef, policy: SideChatAuthorityPolicy): void {
    const now = Date.now();
    this.db.prepareCached(`
      INSERT INTO side_chat_policies (parent_key, policy_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(parent_key) DO UPDATE SET
        policy_json = excluded.policy_json,
        updated_at = excluded.updated_at
    `).run(sideChatParentKey(parent), JSON.stringify(policy), now);
  }

  delete(parent: SideChatParentRef): boolean {
    return this.db
      .prepareCached('DELETE FROM side_chat_policies WHERE parent_key = ?')
      .run(sideChatParentKey(parent)).changes === 1;
  }
}
