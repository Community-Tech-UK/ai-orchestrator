export interface FocusTrapHandle {
  activate(): void;
  deactivate(): void;
  restore(): void;
}

interface FocusTrapOptions {
  initialFocus?: HTMLElement | null;
}

interface ActiveTrap {
  container: HTMLElement;
  previousFocus: Element | null;
  temporaryTabIndex: boolean;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const activeTraps: ActiveTrap[] = [];
let keydownListenerAttached = false;

export function createFocusTrap(container: HTMLElement, options: FocusTrapOptions = {}): FocusTrapHandle {
  let active: ActiveTrap | null = null;
  let restoreTarget: Element | null = null;

  return {
    activate(): void {
      if (active) return;

      restoreTarget = document.activeElement;
      active = {
        container,
        previousFocus: restoreTarget,
        temporaryTabIndex: false,
      };
      activeTraps.push(active);
      attachKeydownListener();
      focusInitialElement(active, options.initialFocus ?? null);
    },

    deactivate(): void {
      if (!active) return;

      const index = activeTraps.indexOf(active);
      if (index >= 0) activeTraps.splice(index, 1);
      if (active.temporaryTabIndex) {
        active.container.removeAttribute('tabindex');
        active.temporaryTabIndex = false;
      }
      detachKeydownListenerIfIdle();
      active = null;
    },

    restore(): void {
      const target = restoreTarget;
      if (active) {
        const index = activeTraps.indexOf(active);
        if (index >= 0) activeTraps.splice(index, 1);
        if (active.temporaryTabIndex) {
          active.container.removeAttribute('tabindex');
          active.temporaryTabIndex = false;
        }
        active = null;
        detachKeydownListenerIfIdle();
      }
      restoreTarget = null;
      if (target instanceof HTMLElement && target.isConnected) {
        target.focus();
      }
    },
  };
}

function attachKeydownListener(): void {
  if (keydownListenerAttached) return;
  document.addEventListener('keydown', onDocumentKeydown);
  keydownListenerAttached = true;
}

function detachKeydownListenerIfIdle(): void {
  if (!keydownListenerAttached || activeTraps.length > 0) return;
  document.removeEventListener('keydown', onDocumentKeydown);
  keydownListenerAttached = false;
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const trap = activeTraps[activeTraps.length - 1];
  if (!trap) return;

  const focusables = getFocusableElements(trap.container);
  if (focusables.length === 0) {
    event.preventDefault();
    focusContainer(trap);
    return;
  }

  const activeElement = document.activeElement;
  const currentIndex = focusables.findIndex((el) => el === activeElement);
  const fallbackIndex = event.shiftKey ? focusables.length - 1 : 0;
  const nextIndex = currentIndex === -1
    ? fallbackIndex
    : (currentIndex + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;

  event.preventDefault();
  focusables[nextIndex]?.focus();
}

function focusInitialElement(trap: ActiveTrap, requested: HTMLElement | null): void {
  const focusables = getFocusableElements(trap.container);
  const target = requested && requested.isConnected && trap.container.contains(requested)
    ? requested
    : focusables[0] ?? null;

  if (target) {
    target.focus();
    return;
  }

  focusContainer(trap);
}

function focusContainer(trap: ActiveTrap): void {
  if (!trap.container.hasAttribute('tabindex')) {
    trap.container.setAttribute('tabindex', '-1');
    trap.temporaryTabIndex = true;
  }
  trap.container.focus();
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => isFocusable(el));
}

function isFocusable(el: HTMLElement): boolean {
  if (!el.isConnected) return false;
  if (el.hasAttribute('hidden')) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  return true;
}
