/**
 * Command Palette Component - Quick command launcher (Cmd/Ctrl+K)
 */

import {
  Component,
  inject,
  signal,
  computed,
  output,
  input,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  ElementRef,
  ViewChild,
  AfterViewInit,
} from '@angular/core';
import { CommandStore } from '../../core/state/command.store';
import { InstanceStore } from '../../core/state/instance.store';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Component({
  selector: 'app-command-palette',
  standalone: true,
  template: `
    <div class="palette-overlay" (click)="onOverlayClick($event)">
      <div class="palette-container">
        <!-- Search input -->
        <div class="palette-header">
          <span class="palette-icon">/</span>
          <input
            #searchInput
            type="text"
            class="palette-search"
            placeholder="Search commands..."
            [value]="searchQuery()"
            (input)="onSearchInput($event)"
            (keydown)="onKeyDown($event)"
          />
          <span class="palette-shortcut">ESC</span>
        </div>

        <!-- Command list -->
        <div class="palette-list">
          @if (commandStore.loading()) {
            <div class="palette-loading">Loading commands...</div>
          } @else if (filteredCommands().length === 0) {
            <div class="palette-empty">
              @if (searchQuery()) {
                No commands matching "{{ searchQuery() }}"
              } @else {
                No commands available
              }
            </div>
          } @else {
            @for (cmd of filteredCommands(); track cmd.id; let i = $index) {
              <button
                class="palette-item"
                [class.selected]="i === selectedIndex()"
                [class.builtin]="cmd.builtIn"
                (click)="onSelectCommand(cmd)"
                (mouseenter)="selectedIndex.set(i)"
              >
                <div class="item-main">
                  <span class="item-name">/{{ cmd.name }}</span>
                  <span class="item-desc">{{ cmd.description }}</span>
                </div>
                @if (cmd.hint) {
                  <span class="item-hint">{{ cmd.hint }}</span>
                }
                @if (cmd.builtIn) {
                  <span class="item-badge">Built-in</span>
                }
              </button>
            }
          }
        </div>

        <!-- Footer with hints -->
        <div class="palette-footer">
          <span class="footer-hint">
            <kbd>↑</kbd><kbd>↓</kbd> Navigate
          </span>
          <span class="footer-hint">
            <kbd>Enter</kbd> Select
          </span>
          <span class="footer-hint">
            <kbd>Esc</kbd> Close
          </span>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .palette-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      justify-content: center;
      padding-top: 15vh;
      z-index: 9999;
    }

    .palette-container {
      width: 560px;
      max-width: 90vw;
      max-height: 60vh;
      background: var(--bg-primary);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      border: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .palette-header {
      display: flex;
      align-items: center;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      gap: var(--spacing-sm);
    }

    .palette-icon {
      font-size: 18px;
      color: var(--text-muted);
      font-weight: bold;
    }

    .palette-search {
      flex: 1;
      border: none;
      background: transparent;
      font-size: 16px;
      color: var(--text-primary);
      outline: none;

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .palette-shortcut {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 11px;
      color: var(--text-muted);
      font-weight: 500;
    }

    .palette-list {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-sm);
    }

    .palette-loading,
    .palette-empty {
      padding: var(--spacing-lg);
      text-align: center;
      color: var(--text-secondary);
    }

    .palette-item {
      width: 100%;
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: none;
      border-radius: var(--radius-md);
      text-align: left;
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover,
      &.selected {
        background: var(--bg-secondary);
      }

      &.selected {
        outline: 2px solid var(--primary-color);
        outline-offset: -2px;
      }
    }

    .item-main {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .item-name {
      font-weight: 600;
      color: var(--primary-color);
      font-family: var(--font-mono);
    }

    .item-desc {
      font-size: 13px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-hint {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      max-width: 150px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .item-badge {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-muted);
      font-weight: 500;
      text-transform: uppercase;
    }

    .palette-footer {
      display: flex;
      justify-content: center;
      gap: var(--spacing-lg);
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .footer-hint {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      color: var(--text-muted);
    }

    .footer-hint kbd {
      padding: 2px 5px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--font-mono);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandPaletteComponent implements OnInit, AfterViewInit, OnDestroy {
  commandStore = inject(CommandStore);
  private instanceStore = inject(InstanceStore);

  @ViewChild('searchInput') searchInput!: ElementRef<HTMLInputElement>;

  close = output<void>();
  commandExecuted = output<{ commandId: string; args: string[] }>();

  instanceId = input<string | null>(null);

  searchQuery = signal('');
  selectedIndex = signal(0);

  filteredCommands = computed(() => {
    const query = this.searchQuery().toLowerCase().trim();
    const commands = this.commandStore.commands();

    if (!query) return commands;

    return commands.filter(cmd =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    );
  });

  ngOnInit(): void {
    this.commandStore.loadCommands();
    document.addEventListener('keydown', this.handleGlobalKeydown);
  }

  ngAfterViewInit(): void {
    // Focus search input when palette opens
    setTimeout(() => {
      this.searchInput?.nativeElement?.focus();
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.handleGlobalKeydown);
  }

  private handleGlobalKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close.emit();
    }
  };

  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
    this.selectedIndex.set(0);
  }

  onKeyDown(event: KeyboardEvent): void {
    const commands = this.filteredCommands();

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedIndex.update(i =>
          i < commands.length - 1 ? i + 1 : 0
        );
        break;

      case 'ArrowUp':
        event.preventDefault();
        this.selectedIndex.update(i =>
          i > 0 ? i - 1 : commands.length - 1
        );
        break;

      case 'Enter':
        event.preventDefault();
        const selected = commands[this.selectedIndex()];
        if (selected) {
          this.onSelectCommand(selected);
        }
        break;

      case 'Escape':
        event.preventDefault();
        this.close.emit();
        break;
    }
  }

  onSelectCommand(command: CommandTemplate): void {
    if (command.name === 'rlm') {
      this.commandExecuted.emit({ commandId: command.id, args: [] });
      this.close.emit();
      return;
    }

    const instId = this.instanceId() || this.instanceStore.selectedInstance()?.id;

    if (!instId) {
      console.warn('No instance selected for command execution');
      this.close.emit();
      return;
    }

    // Parse any arguments from the search query
    const query = this.searchQuery().trim();
    const args: string[] = [];

    // If query contains more than just the command name, treat the rest as args
    if (query && !query.startsWith('/')) {
      // The search query might have args after the command match
      const afterCommand = query.replace(new RegExp(`^${command.name}\\s*`, 'i'), '');
      if (afterCommand) {
        args.push(...afterCommand.split(/\s+/).filter(Boolean));
      }
    }

    this.commandExecuted.emit({ commandId: command.id, args });
    this.commandStore.executeCommand(command.id, instId, args);
    this.close.emit();
  }

  onOverlayClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close.emit();
    }
  }
}
