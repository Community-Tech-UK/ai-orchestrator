export interface StorageField<T> {
  key: string;
  version: number;
  defaultValue: T;
  validate?: (value: unknown) => value is T;
}

export function readStorage<T>(field: StorageField<T>): T {
  try {
    const raw = localStorage.getItem(field.key);
    if (!raw) return field.defaultValue;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return field.defaultValue;
    const obj = parsed as Record<string, unknown>;
    if (obj['__v'] !== field.version) return field.defaultValue;
    const value = obj['value'] as unknown;
    if (field.validate && !field.validate(value)) return field.defaultValue;
    return value as T;
  } catch {
    return field.defaultValue;
  }
}

export function writeStorage<T>(field: StorageField<T>, value: T): void {
  try {
    localStorage.setItem(field.key, JSON.stringify({ __v: field.version, value }));
  } catch {
    // Ignore quota errors
  }
}

export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore
  }
}
