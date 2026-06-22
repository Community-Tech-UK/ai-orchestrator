import type { AppSettings, ConfigSource } from './settings.types';

/**
 * Project-level configuration file format.
 * Stored in .ai-orchestrator.json in project root.
 */
export interface ProjectConfig {
  name?: string;
  description?: string;
  settings?: Partial<AppSettings>;
  defaultAgent?: string;
  commands?: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }[];
  ignorePatterns?: string[];
  systemPromptAdditions?: string;
}

export interface ResolvedConfig {
  settings: AppSettings;
  sources: Record<keyof AppSettings, ConfigSource>;
  projectConfig?: ProjectConfig;
  projectPath?: string;
}

export const PROJECT_CONFIG_FILE = '.ai-orchestrator.json';
export const LEGACY_PROJECT_CONFIG_FILE = '.claude-orchestrator.json';

export function mergeConfigs(
  defaultSettings: AppSettings,
  userSettings: Partial<AppSettings>,
  projectSettings?: Partial<AppSettings>,
): ResolvedConfig {
  const settings = { ...defaultSettings };
  const sources: Record<string, ConfigSource> = {};
  const applySetting = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
    source: ConfigSource,
  ) => {
    settings[key] = value;
    sources[key] = source;
  };

  for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[]) {
    sources[key] = 'default';
  }

  for (const [key, value] of Object.entries(userSettings)) {
    if (value !== undefined) {
      const typedKey = key as keyof AppSettings;
      applySetting(typedKey, value as AppSettings[typeof typedKey], 'user');
    }
  }

  if (projectSettings) {
    for (const [key, value] of Object.entries(projectSettings)) {
      if (value !== undefined) {
        const typedKey = key as keyof AppSettings;
        applySetting(typedKey, value as AppSettings[typeof typedKey], 'project');
      }
    }
  }

  return {
    settings,
    sources: sources as Record<keyof AppSettings, ConfigSource>,
  };
}
