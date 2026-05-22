/**
 * Display Settings Tab - Appearance panel plus output/display preferences.
 *
 * Theme and font size use a live preview-then-apply flow (copilot_todo.md
 * item 2): changes are previewed on the document immediately but are only
 * persisted when the user applies them. The remaining display preferences
 * keep the existing instant-save behavior.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { SettingRowComponent } from './setting-row.component';
import { SettingsCardComponent } from './ui/settings-card.component';
import { SegmentedControlComponent, type SegmentOption } from './ui/segmented-control.component';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import { InlineHelpComponent } from './ui/inline-help.component';
import type {
  AppSettings,
  DisplayDensity,
  SidebarStyle,
  ThemeMode,
} from '../../../../shared/types/settings.types';

@Component({
  selector: 'app-display-settings-tab',
  standalone: true,
  imports: [
    SettingRowComponent,
    SettingsCardComponent,
    SegmentedControlComponent,
    SaveStateBannerComponent,
    InlineHelpComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-settings-card
      icon="display"
      title="Appearance"
      description="Preview the theme and text size live, then apply when you're happy."
    >
      <div class="field">
        <div class="field-text">
          <span class="field-label">Theme</span>
          <span class="field-hint">Switch the whole app between light and dark.</span>
        </div>
        <div class="field-control">
          <app-segmented-control
            ariaLabel="Theme"
            [options]="themeOptions"
            [value]="effectiveTheme()"
            (valueChange)="onThemeChange($event)"
          />
        </div>
      </div>

      <div class="field">
        <div class="field-text">
          <span class="field-label">Font size</span>
          <span class="field-hint">Base text size for agent output.</span>
        </div>
        <div class="field-control font-control">
          <input
            type="range"
            min="12"
            max="20"
            step="1"
            [value]="effectiveFontSize()"
            (input)="onFontSizeChange($event)"
            aria-label="Font size"
          />
          <span class="font-readout">{{ effectiveFontSize() }}px</span>
        </div>
      </div>

      <div class="field">
        <div class="field-text">
          <span class="field-label">Density</span>
          <span class="field-hint">Adjust spacing for repeated settings and workspace surfaces.</span>
        </div>
        <div class="field-control">
          <app-segmented-control
            ariaLabel="Display density"
            [options]="densityOptions"
            [value]="effectiveDisplayDensity()"
            (valueChange)="onDensityChange($event)"
          />
        </div>
      </div>

      <div class="field">
        <div class="field-text">
          <span class="field-label">Sidebar</span>
          <span class="field-hint">Choose the standard workspace sidebar or a tighter layout.</span>
        </div>
        <div class="field-control">
          <app-segmented-control
            ariaLabel="Sidebar style"
            [options]="sidebarOptions"
            [value]="effectiveSidebarStyle()"
            (valueChange)="onSidebarStyleChange($event)"
          />
        </div>
      </div>

      <p class="font-preview">The quick brown fox jumps over the lazy dog.</p>

      <app-inline-help variant="tip">
        Font size changes the agent output text only — menus and the rest of the
        app keep their standard size. Theme, density, and sidebar changes
        preview instantly, so you can try them before saving.
      </app-inline-help>

      <app-save-state-banner
        card-footer
        [state]="saveState()"
        (apply)="apply()"
        (discard)="resetPreview()"
      />
    </app-settings-card>

    <section class="output-section">
      <h3 class="subsection-title">Output &amp; messages</h3>
      @for (setting of outputSettings(); track setting.key) {
        <app-setting-row
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
    </section>

    <div class="setting-row reset-layout-row">
      <div class="setting-info">
        <h3 class="setting-label">Reset View Layout</h3>
        <p class="setting-description">
          Reset sidebar and file explorer panel widths to their default
          positions. This will not affect other settings.
        </p>
      </div>
      <div class="setting-control">
        <button type="button" class="btn-reset-layout" (click)="resetViewLayout()">
          Reset Layout
        </button>
      </div>
    </div>
  `,
  styleUrl: './display-settings-tab.component.scss',
})
export class DisplaySettingsTabComponent {
  readonly store = inject(SettingsStore);
  private viewLayoutService = inject(ViewLayoutService);

  /** Display-category settings other than the live-preview appearance ones. */
  readonly outputSettings = computed(() =>
    this.store.displaySettings().filter(
      (s) => s.key !== 'theme'
        && s.key !== 'fontSize'
        && s.key !== 'displayDensity'
        && s.key !== 'sidebarStyle',
    ),
  );

  readonly themeOptions: SegmentOption[] = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'System' },
  ];
  readonly densityOptions: SegmentOption[] = [
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' },
  ];
  readonly sidebarOptions: SegmentOption[] = [
    { value: 'standard', label: 'Standard' },
    { value: 'compact', label: 'Compact' },
  ];

  /** The previewed value when a preview is staged, otherwise the saved value. */
  readonly effectiveTheme = computed<ThemeMode>(
    () => this.store.appearancePreview()?.theme ?? this.store.theme(),
  );
  readonly effectiveFontSize = computed(
    () => this.store.appearancePreview()?.fontSize ?? this.store.fontSize(),
  );
  readonly effectiveDisplayDensity = computed(
    () => this.store.appearancePreview()?.displayDensity ?? this.store.displayDensity(),
  );
  readonly effectiveSidebarStyle = computed(
    () => this.store.appearancePreview()?.sidebarStyle ?? this.store.sidebarStyle(),
  );

  private readonly committing = signal(false);

  readonly dirty = computed(() => {
    const preview = this.store.appearancePreview();
    if (!preview) {
      return false;
    }
    const themeDirty = preview.theme !== undefined && preview.theme !== this.store.theme();
    const fontDirty = preview.fontSize !== undefined && preview.fontSize !== this.store.fontSize();
    const densityDirty =
      preview.displayDensity !== undefined
      && preview.displayDensity !== this.store.displayDensity();
    const sidebarDirty =
      preview.sidebarStyle !== undefined
      && preview.sidebarStyle !== this.store.sidebarStyle();
    return themeDirty || fontDirty || densityDirty || sidebarDirty;
  });

  readonly saveState = computed<SaveState>(() => {
    if (this.committing()) {
      return 'saving';
    }
    return this.dirty() ? 'dirty' : 'saved';
  });

  constructor() {
    // Discard any un-applied preview if the user leaves this tab so the
    // document is not left showing an un-saved theme.
    inject(DestroyRef).onDestroy(() => {
      this.store.clearAppearancePreview();
    });
  }

  onThemeChange(value: string): void {
    this.store.previewAppearance({ theme: value as ThemeMode });
  }

  onFontSizeChange(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) {
      this.store.previewAppearance({ fontSize: value });
    }
  }

  onDensityChange(value: string): void {
    this.store.previewAppearance({ displayDensity: value as DisplayDensity });
  }

  onSidebarStyleChange(value: string): void {
    this.store.previewAppearance({ sidebarStyle: value as SidebarStyle });
  }

  async apply(): Promise<void> {
    this.committing.set(true);
    try {
      await this.store.commitAppearancePreview();
    } finally {
      this.committing.set(false);
    }
  }

  resetPreview(): void {
    this.store.clearAppearancePreview();
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    void this.store.set(
      event.key as keyof AppSettings,
      event.value as AppSettings[keyof AppSettings],
    );
  }

  resetViewLayout(): void {
    this.viewLayoutService.reset();
  }
}
