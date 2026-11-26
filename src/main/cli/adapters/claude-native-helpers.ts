import { asUnknownRecord } from './claude-cli-adapter.types';
import type { NativeHelperSummary } from '../../../shared/types/instance.types';

const MAX_TRACKED_IDS = 10_000;
interface Helper { ids: Set<string>; background: boolean }

/** Per-adapter native tasks, independent of usage/spend and the background-work inhibitor. */
export class ClaudeNativeHelpers {
  private readonly helpers = new Set<Helper>();
  private readonly byId = new Map<string, Helper>();
  private readonly ended = new Set<string>();
  private readonly shells = new Set<string>();

  get summary(): NativeHelperSummary { return { running: this.helpers.size }; }

  observe(message: unknown): void {
    const raw = asUnknownRecord(message);
    if (!raw) return;
    const ids = [raw['tool_use_id'] ?? raw['toolUseId'], raw['task_id']]
      .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512);
    const kind = raw['subtype'] ?? raw['type'];
    if (raw['task_type'] === 'local_bash') {
      for (const id of ids) {
        this.remember(this.shells, id);
        const helper = this.byId.get(id);
        if (helper) this.finish(helper);
      }
      return;
    }
    if (ids.some(id => this.shells.has(id))) return;
    if (kind === 'task_notification') {
      for (const id of ids) {
        const helper = this.byId.get(id);
        if (helper) this.finish(helper);
        this.remember(this.ended, id);
      }
    } else if (kind === 'task_started' && raw['task_type'] === 'local_agent') {
      this.upsert(ids, raw['is_backgrounded'] === true);
    } else if (kind === 'task_progress' && (raw['task_type'] === 'local_agent' || asUnknownRecord(raw['usage']))) {
      // Older CLI versions expose progress/usage without task_started.
      this.upsert(ids);
    } else if (kind === 'task_updated') {
      const background = asUnknownRecord(raw['patch'])?.['is_backgrounded'];
      if (typeof background === 'boolean') {
        for (const id of ids) {
          const helper = this.byId.get(id);
          if (helper) helper.background = background;
        }
      }
    } else if (kind === 'background_tasks_changed' && Array.isArray(raw['tasks'])) {
      const live = new Set<Helper>();
      for (const task of raw['tasks']) {
        const item = asUnknownRecord(task);
        if (typeof item?.['task_id'] !== 'string' || !item['task_id'] || item['task_id'].length > 512) continue;
        if (item['task_type'] === 'local_bash') {
          this.remember(this.shells, item['task_id']);
          const helper = this.byId.get(item['task_id']);
          if (helper) this.finish(helper);
          continue;
        }
        if (item['task_type'] !== 'local_agent') continue;
        const helper = this.upsert([item['task_id']], true);
        if (helper) live.add(helper);
      }
      // A background snapshot says nothing about foreground helpers.
      for (const helper of this.helpers) if (helper.background && !live.has(helper)) this.finish(helper);
    }
  }

  finishTurn(): void {
    for (const helper of this.helpers) if (!helper.background) this.finish(helper);
  }

  private upsert(ids: string[], background?: boolean): Helper | undefined {
    ids = ids.filter(id => id.length > 0 && id.length <= 512);
    if (!ids.length || ids.some(id => this.ended.has(id) || this.shells.has(id))) return undefined;
    const matches = new Set(ids.map(id => this.byId.get(id)).filter((helper): helper is Helper => !!helper));
    const helper = matches.values().next().value as Helper | undefined
      ?? { ids: new Set<string>(), background: false };
    // Snapshot task IDs and tool-use IDs can arrive independently, then alias.
    for (const other of matches) {
      if (other === helper) continue;
      helper.background ||= other.background;
      for (const id of other.ids) {
        if (helper.ids.size < 4) { helper.ids.add(id); this.byId.set(id, helper); }
        else { this.byId.delete(id); this.remember(this.ended, id); }
      }
      this.helpers.delete(other);
    }
    if (!this.helpers.has(helper) && this.helpers.size >= MAX_TRACKED_IDS) return undefined;
    this.helpers.add(helper);
    if (background !== undefined) helper.background = background;
    for (const id of ids) {
      if (id.length > 512 || !id || helper.ids.size >= 4) continue;
      helper.ids.add(id);
      this.byId.set(id, helper);
    }
    return helper;
  }

  private finish(helper: Helper): void {
    this.helpers.delete(helper);
    for (const id of helper.ids) { this.byId.delete(id); this.remember(this.ended, id); }
  }

  private remember(set: Set<string>, id: string): void {
    set.add(id);
    while (set.size > MAX_TRACKED_IDS) set.delete(set.values().next().value!);
  }
}
