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
      const index = items.findIndex((item) => item.status === 'in_progress');
      return index < 0 ? null : `Step ${index + 1} of ${items.length}: ${items[index].content}`;
    }).catch(() => null);
    // Bound the cache to recently hovered sessions, including empty responses.
    for (const [key, entry] of this.cache) if (entry.until <= Date.now()) this.cache.delete(key);
    if (this.cache.size >= 200) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(sessionId, { until: Date.now() + 30_000, value });
    return value;
  }
}
