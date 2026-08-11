import type {
  DesktopAccessibilitySnapshotResult,
  DesktopInputActionRequest,
  DesktopWaitForRequest,
} from '../../shared/types/desktop-gateway.types';

export function isDeniedHotkey(keys: string[]): boolean {
  const normalized = new Set(keys.map((key) => key.trim().toLowerCase()));
  if (normalized.has('enter') || normalized.has('return') || normalized.has('space')) {
    return true;
  }
  const hasCommand = normalized.has('cmd') || normalized.has('command') || normalized.has('meta');
  if (hasCommand && normalized.has('q')) {
    return true;
  }
  if (hasCommand && normalized.has('option') && normalized.has('escape')) {
    return true;
  }
  const hasControl = normalized.has('ctrl') || normalized.has('control');
  if ((hasCommand || normalized.has('shift'))
    && (normalized.has('delete') || normalized.has('backspace'))) {
    return true;
  }
  return hasControl && hasCommand && (
    normalized.has('power')
    || normalized.has('eject')
    || normalized.has('delete')
  );
}

export function isSecretLikeInput(request: DesktopInputActionRequest): boolean {
  if (!('text' in request) || typeof request.text !== 'string') {
    return false;
  }
  const text = request.text.trim();
  if (/^(sk-|xox[baprs]-|gh[pousr]_)/i.test(text)) {
    return true;
  }
  const noWhitespace = !/\s/.test(text);
  const hasLetters = /[a-z]/i.test(text);
  const hasDigits = /\d/.test(text);
  const hasSymbols = /[^a-z0-9]/i.test(text);
  return text.length >= 48 && noWhitespace && hasLetters && hasDigits && hasSymbols;
}

export function matchesWaitCondition(
  nodes: DesktopAccessibilitySnapshotResult['nodes'],
  condition: DesktopWaitForRequest['condition'],
): boolean {
  for (const node of nodes) {
    const nodeText = [node.label, node.value].filter(Boolean).join(' ');
    if (condition.text && nodeText.includes(condition.text)) {
      return true;
    }
    if (condition.label && node.label?.includes(condition.label)) {
      return true;
    }
    if (condition.role && node.role === condition.role) {
      return true;
    }
    if (node.children && matchesWaitCondition(node.children, condition)) {
      return true;
    }
  }
  return false;
}
