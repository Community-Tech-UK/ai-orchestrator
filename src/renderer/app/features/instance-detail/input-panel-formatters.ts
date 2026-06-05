export function getFileIcon(file: File): string {
  if (file.type.startsWith('image/')) return '🖼️';
  if (file.type.includes('pdf')) return '📄';
  if (file.type.includes('text')) return '📝';
  if (file.type.includes('json') || file.type.includes('javascript')) return '📋';
  return '📎';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function defaultWakeupLocal(): string {
  return toDatetimeLocal(Date.now() + 60 * 60 * 1000);
}

export function parseWakeupLocal(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncateQueuedMessage(message: string): string {
  const firstLine = message.split('\n')[0];
  if (firstLine.length > 50) {
    return firstLine.slice(0, 50) + '...';
  }
  return firstLine + (message.includes('\n') ? '...' : '');
}

function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
