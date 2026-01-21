/**
 * Root Application Component
 */

import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ElectronIpcService } from './core/services/electron-ipc.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: `
    <div class="app-container" [class.macos]="isMacOS">
      <!-- Draggable title bar area for macOS -->
      @if (isMacOS) {
        <div class="title-bar-drag-area"></div>
      }

      <main class="app-main">
        <router-outlet />
      </main>
    </div>
  `,
  styles: [`
    .app-container {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
      background: var(--bg-primary);
    }

    .app-container.macos {
      padding-top: 52px; /* Space for traffic lights (40px) + padding */
    }

    .title-bar-drag-area {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 52px;
      -webkit-app-region: drag;
      z-index: 1000;
      /* Allow clicks on buttons within the drag area */
    }

    .app-main {
      flex: 1;
      display: flex;
      overflow: hidden;
    }

    .app-main > router-outlet {
      flex: 0 0 0;
      width: 0;
      height: 0;
      overflow: hidden;
      display: contents;
    }

    /* Ensure routed components fill the container */
    .app-main > * {
      flex: 1;
      display: flex;
      height: 100%;
      width: 100%;
    }
  `],
})
export class AppComponent implements OnInit {
  private ipcService = inject(ElectronIpcService);

  isMacOS = false;

  async ngOnInit(): Promise<void> {
    // Check platform - use Electron API if available, fallback to navigator
    const electronPlatform = this.ipcService.platform;
    if (electronPlatform && electronPlatform !== 'browser') {
      this.isMacOS = electronPlatform === 'darwin';
    } else {
      // Fallback detection for when Electron API isn't available
      this.isMacOS = navigator.platform?.toLowerCase().includes('mac') ?? false;
    }

    console.log('Platform detected:', this.isMacOS ? 'macOS' : 'other', '(source:', electronPlatform, ')');

    // Signal app ready
    await this.ipcService.appReady();
    console.log('Claude Orchestrator UI ready');
  }
}
