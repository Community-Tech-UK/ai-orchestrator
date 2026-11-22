import { Injectable, inject } from '@angular/core';
import { TodoIpcService } from '../../core/services/ipc/todo-ipc.service';
import type { TodoList } from '../../../../shared/types/todo.types';

@Injectable({ providedIn: 'root' })
export class SessionTodoPeekService {
  private readonly ipc = inject(TodoIpcService);
  private readonly cache = new Map<string, { until: number; value: Promise<string | null> }>();

  peek(sessionId: string): Promise<string | null> {
    const cached = this.cache.get(sessionId);
    if (cached && cached.until > Date.now()) return cached.value;
    const value = this.ipc.todoGetList(sessionId).then((result) => {
      const list = result.success ? result.data as TodoList | null : null;
      const items = list?.items?.filter((item) => item.status !== 'cancelled') ?? [];
      const active = items.find((item) => item.status === 'in_progress');
      // The list comes back sorted by status (active first), so its order is not the plan's order:
      // the step number is how many steps are done, plus this one.
      const done = items.filter((item) => item.status === 'completed').length;
      return active ? `Step ${done + 1} of ${items.length}: ${active.content}` : null;
    }).catch(() => null);
    // Bound the cache to recently hovered sessions, including empty responses.
    for (const [key, entry] of this.cache) if (entry.until <= Date.now()) this.cache.delete(key);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(sessionId, { until: Date.now() + 30_000, value });
    return value;
  }
}
