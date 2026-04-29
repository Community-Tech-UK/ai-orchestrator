import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  inject,
} from '@angular/core';
import { JsonPipe } from '@angular/common';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { ChildDiagnosticBundleModalService } from './child-diagnostic-bundle.modal.service';
import type { ChildDiagnosticOutputLine } from '../../../../shared/types/agent-tree.types';

@Component({
  selector: 'app-child-diagnostic-bundle-modal',
  standalone: true,
  imports: [JsonPipe],
  templateUrl: './child-diagnostic-bundle.modal.component.html',
  styleUrl: './child-diagnostic-bundle.modal.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChildDiagnosticBundleModalComponent {
  private service = inject(ChildDiagnosticBundleModalService);
  private clipboard = inject(CLIPBOARD_SERVICE);

  bundle = computed(() => this.service.bundle());

  close(): void {
    this.service.close();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  copyPromptHash(): void {
    const bundle = this.bundle();
    if (!bundle?.spawnPromptHash) {
      return;
    }
    void this.clipboard.copyText(bundle.spawnPromptHash, { label: 'prompt hash' });
  }

  formatTimestamp(timestamp?: number): string {
    if (!timestamp) {
      return 'Unknown';
    }
    return new Date(timestamp).toLocaleString();
  }

  formatOutputLines(lines: ChildDiagnosticOutputLine[]): string {
    return lines.map((line) => `[${line.type}] ${line.content}`).join('\n');
  }
}
