/** Convert adapter event values into an IPC- and JSON-safe capture payload. */
export function toJsonSafeProviderEventPayload(value: unknown): unknown {
  return visit(value, new WeakSet<object>());
}

function visit(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') {
    return { type: 'bigint', value: value.toString() };
  }
  if (typeof value === 'undefined') {
    return { type: 'undefined' };
  }
  if (typeof value === 'symbol' || typeof value === 'function') {
    return { type: typeof value, value: String(value) };
  }
  if (value instanceof Error) {
    return {
      type: 'error',
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(value.cause !== undefined ? { cause: visit(value.cause, seen) } : {}),
    };
  }
  if (value instanceof Date) {
    return { type: 'date', value: value.toISOString() };
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { type: 'buffer', encoding: 'base64', value: value.toString('base64') };
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  if (seen.has(value)) {
    return { type: 'circular' };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => visit(item, seen));
  }
  if (value instanceof Map) {
    return {
      type: 'map',
      entries: [...value.entries()].map(([key, item]) => [visit(key, seen), visit(item, seen)]),
    };
  }
  if (value instanceof Set) {
    return { type: 'set', values: [...value].map((item) => visit(item, seen)) };
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = visit(item, seen);
  }
  return result;
}
