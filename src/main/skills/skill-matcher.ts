/**
 * Enhanced Skill Matcher
 *
 * Advanced skill matching with:
 * - Auto-activation based on message content
 * - Context-aware skill suggestions
 * - Custom slash commands from .claude/commands/
 * - Intent detection and skill recommendations
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { SkillBundle, LoadedSkill } from '../../shared/types/skill.types';
import { TriggerMatcher, TriggerMatch } from './trigger-matcher';
import { SkillLoader } from './skill-loader';

export interface SkillMatchContext {
  /** Current message being processed */
  message: string;
  /** Recent conversation history */
  conversationHistory?: ConversationTurn[];
  /** Currently active files/paths */
  activeFiles?: string[];
  /** Current project type (detected or configured) */
  projectType?: string;
  /** User preferences for auto-activation */
  autoActivatePreferences?: AutoActivatePreferences;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AutoActivatePreferences {
  /** Enable auto-activation */
  enabled: boolean;
  /** Minimum confidence to auto-activate */
  minConfidence: number;
  /** Skills to never auto-activate */
  blocklist: string[];
  /** Skills to always suggest but not auto-activate */
  suggestOnly: string[];
  /** Maximum skills to suggest at once */
  maxSuggestions: number;
}

export interface SkillSuggestion {
  skillName: string;
  bundle: SkillBundle;
  confidence: number;
  reason: string;
  autoActivate: boolean;
  triggers: string[];
}

export interface CustomCommand {
  name: string;
  description: string;
  path: string;
  content: string;
  isProjectLevel: boolean;
}

export interface IntentAnalysis {
  primaryIntent: string;
  secondaryIntents: string[];
  entities: string[];
  actionType: 'create' | 'modify' | 'query' | 'debug' | 'explain' | 'other';
  confidence: number;
}

const DEFAULT_PREFERENCES: AutoActivatePreferences = {
  enabled: true,
  minConfidence: 0.75,
  blocklist: [],
  suggestOnly: [],
  maxSuggestions: 3,
};

// Intent patterns for common development tasks
const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: string; actionType: IntentAnalysis['actionType'] }> = [
  { pattern: /\b(create|make|generate|build|add|implement)\b/i, intent: 'creation', actionType: 'create' },
  { pattern: /\b(fix|repair|solve|debug|troubleshoot)\b/i, intent: 'debugging', actionType: 'debug' },
  { pattern: /\b(explain|describe|what is|how does|why)\b/i, intent: 'explanation', actionType: 'explain' },
  { pattern: /\b(update|modify|change|refactor|improve)\b/i, intent: 'modification', actionType: 'modify' },
  { pattern: /\b(find|search|look for|where|list)\b/i, intent: 'query', actionType: 'query' },
  { pattern: /\b(test|verify|check|validate)\b/i, intent: 'testing', actionType: 'query' },
  { pattern: /\b(deploy|release|publish|ship)\b/i, intent: 'deployment', actionType: 'create' },
  { pattern: /\b(review|audit|analyze)\b/i, intent: 'review', actionType: 'query' },
];

// Technology patterns
const TECH_PATTERNS: Array<{ pattern: RegExp; tech: string }> = [
  { pattern: /\b(react|jsx|component|hooks?|useState|useEffect)\b/i, tech: 'react' },
  { pattern: /\b(angular|ngModule|component|service|directive)\b/i, tech: 'angular' },
  { pattern: /\b(vue|vuex|composition api|ref|computed)\b/i, tech: 'vue' },
  { pattern: /\b(node|express|npm|package\.json)\b/i, tech: 'nodejs' },
  { pattern: /\b(python|pip|django|flask|pandas)\b/i, tech: 'python' },
  { pattern: /\b(rust|cargo|crate)\b/i, tech: 'rust' },
  { pattern: /\b(go|golang|goroutine)\b/i, tech: 'go' },
  { pattern: /\b(docker|container|kubernetes|k8s)\b/i, tech: 'docker' },
  { pattern: /\b(sql|database|postgres|mysql|mongodb)\b/i, tech: 'database' },
  { pattern: /\b(api|rest|graphql|endpoint)\b/i, tech: 'api' },
  { pattern: /\b(css|scss|sass|tailwind|styled)\b/i, tech: 'css' },
  { pattern: /\b(typescript|ts|interface|type)\b/i, tech: 'typescript' },
];

export class SkillMatcher extends EventEmitter {
  private static instance: SkillMatcher | null = null;
  private triggerMatcher: TriggerMatcher;
  private skillLoader: SkillLoader;
  private customCommands: Map<string, CustomCommand> = new Map();
  private preferences: AutoActivatePreferences = { ...DEFAULT_PREFERENCES };
  private projectRoot: string = process.cwd();

  private constructor() {
    super();
    this.triggerMatcher = TriggerMatcher.getInstance();
    this.skillLoader = SkillLoader.getInstance();
  }

  static getInstance(): SkillMatcher {
    if (!SkillMatcher.instance) {
      SkillMatcher.instance = new SkillMatcher();
    }
    return SkillMatcher.instance;
  }

  /**
   * Initialize with project root
   */
  async initialize(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    await this.loadCustomCommands();
    this.emit('initialized', { projectRoot });
  }

  /**
   * Update auto-activation preferences
   */
  updatePreferences(prefs: Partial<AutoActivatePreferences>): void {
    this.preferences = { ...this.preferences, ...prefs };
    this.emit('preferences-updated', this.preferences);
  }

  /**
   * Get current preferences
   */
  getPreferences(): AutoActivatePreferences {
    return { ...this.preferences };
  }

  /**
   * Match skills based on context
   */
  async matchSkills(context: SkillMatchContext): Promise<SkillSuggestion[]> {
    const suggestions: SkillSuggestion[] = [];
    const prefs = context.autoActivatePreferences || this.preferences;

    // Analyze intent
    const intent = this.analyzeIntent(context.message);

    // Get trigger matches
    const triggerMatches = this.triggerMatcher.match(context.message, {
      minScore: 0.4,
      maxResults: 10,
    });

    // Convert trigger matches to suggestions
    for (const match of triggerMatches) {
      if (prefs.blocklist.includes(match.skillName)) {
        continue;
      }

      const autoActivate =
        prefs.enabled &&
        match.matchScore >= prefs.minConfidence &&
        !prefs.suggestOnly.includes(match.skillName);

      suggestions.push({
        skillName: match.skillName,
        bundle: match.bundle,
        confidence: match.matchScore,
        reason: `Matched trigger: "${match.matchedTrigger}" (${match.matchType})`,
        autoActivate,
        triggers: match.bundle.metadata.triggers,
      });
    }

    // Add context-aware suggestions
    const contextSuggestions = await this.getContextAwareSuggestions(context, intent);
    for (const suggestion of contextSuggestions) {
      // Avoid duplicates
      if (!suggestions.find(s => s.skillName === suggestion.skillName)) {
        suggestions.push(suggestion);
      }
    }

    // Sort by confidence
    suggestions.sort((a, b) => b.confidence - a.confidence);

    // Limit results
    const limited = suggestions.slice(0, prefs.maxSuggestions);

    this.emit('skills-matched', {
      context,
      suggestions: limited,
      intent,
    });

    return limited;
  }

  /**
   * Get context-aware skill suggestions
   */
  private async getContextAwareSuggestions(
    context: SkillMatchContext,
    intent: IntentAnalysis
  ): Promise<SkillSuggestion[]> {
    const suggestions: SkillSuggestion[] = [];
    const registeredSkills = this.triggerMatcher.getRegisteredSkills();

    // Match based on detected technologies
    const detectedTechs = this.detectTechnologies(context.message);
    const fileTechs = this.detectTechnologiesFromFiles(context.activeFiles || []);
    const allTechs = new Set([...detectedTechs, ...fileTechs]);

    for (const bundle of registeredSkills) {
      const metadata = bundle.metadata;

      // Check if skill category matches detected tech
      if (metadata.category && allTechs.has(metadata.category.toLowerCase())) {
        suggestions.push({
          skillName: metadata.name,
          bundle,
          confidence: 0.6,
          reason: `Relevant to ${metadata.category} (detected in context)`,
          autoActivate: false,
          triggers: metadata.triggers,
        });
      }

      // Check if skill name contains detected tech
      for (const tech of allTechs) {
        if (metadata.name.toLowerCase().includes(tech)) {
          const existing = suggestions.find(s => s.skillName === metadata.name);
          if (!existing) {
            suggestions.push({
              skillName: metadata.name,
              bundle,
              confidence: 0.55,
              reason: `Skill matches detected technology: ${tech}`,
              autoActivate: false,
              triggers: metadata.triggers,
            });
          }
        }
      }
    }

    return suggestions;
  }

  /**
   * Analyze user intent from message
   */
  analyzeIntent(message: string): IntentAnalysis {
    const intents: string[] = [];
    let primaryActionType: IntentAnalysis['actionType'] = 'other';
    let maxConfidence = 0;

    for (const { pattern, intent, actionType } of INTENT_PATTERNS) {
      if (pattern.test(message)) {
        intents.push(intent);
        if (intents.length === 1) {
          primaryActionType = actionType;
        }
        maxConfidence = Math.max(maxConfidence, 0.7);
      }
    }

    // Extract entities (quoted strings, file paths, etc.)
    const entities: string[] = [];
    const quotedStrings = message.match(/["'`]([^"'`]+)["'`]/g);
    if (quotedStrings) {
      entities.push(...quotedStrings.map(s => s.slice(1, -1)));
    }

    const filePaths = message.match(/[\w./\\-]+\.(ts|js|py|rs|go|md|json|yaml|yml)/g);
    if (filePaths) {
      entities.push(...filePaths);
    }

    return {
      primaryIntent: intents[0] || 'general',
      secondaryIntents: intents.slice(1),
      entities,
      actionType: primaryActionType,
      confidence: maxConfidence || 0.5,
    };
  }

  /**
   * Detect technologies from message
   */
  private detectTechnologies(message: string): string[] {
    const techs: string[] = [];

    for (const { pattern, tech } of TECH_PATTERNS) {
      if (pattern.test(message)) {
        techs.push(tech);
      }
    }

    return techs;
  }

  /**
   * Detect technologies from file paths
   */
  private detectTechnologiesFromFiles(files: string[]): string[] {
    const techs = new Set<string>();

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      switch (ext) {
        case '.ts':
        case '.tsx':
          techs.add('typescript');
          if (file.includes('component')) techs.add('angular');
          break;
        case '.js':
        case '.jsx':
          techs.add('javascript');
          break;
        case '.py':
          techs.add('python');
          break;
        case '.rs':
          techs.add('rust');
          break;
        case '.go':
          techs.add('go');
          break;
        case '.vue':
          techs.add('vue');
          break;
        case '.scss':
        case '.sass':
        case '.css':
          techs.add('css');
          break;
      }

      // Check for specific files
      const basename = path.basename(file).toLowerCase();
      if (basename === 'package.json') techs.add('nodejs');
      if (basename === 'cargo.toml') techs.add('rust');
      if (basename === 'go.mod') techs.add('go');
      if (basename === 'dockerfile') techs.add('docker');
      if (basename === 'angular.json') techs.add('angular');
    }

    return [...techs];
  }

  // ============ Custom Commands ============

  /**
   * Load custom commands from .claude/commands/
   */
  async loadCustomCommands(): Promise<void> {
    this.customCommands.clear();

    // Project-level commands
    const projectCommandsPath = path.join(this.projectRoot, '.claude', 'commands');
    await this.loadCommandsFromPath(projectCommandsPath, true);

    // User-level commands (home directory)
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    if (homeDir) {
      const userCommandsPath = path.join(homeDir, '.claude', 'commands');
      await this.loadCommandsFromPath(userCommandsPath, false);
    }

    this.emit('commands-loaded', {
      count: this.customCommands.size,
      commands: [...this.customCommands.keys()],
    });
  }

  private async loadCommandsFromPath(commandsPath: string, isProjectLevel: boolean): Promise<void> {
    try {
      const entries = await fs.readdir(commandsPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const commandPath = path.join(commandsPath, entry.name);
          const content = await fs.readFile(commandPath, 'utf-8');
          const name = entry.name.replace('.md', '');

          // Parse description from first line if it starts with #
          let description = `Custom command: ${name}`;
          const firstLine = content.split('\n')[0];
          if (firstLine.startsWith('#')) {
            description = firstLine.replace(/^#+\s*/, '');
          }

          // Project-level commands override user-level
          if (isProjectLevel || !this.customCommands.has(name)) {
            this.customCommands.set(name, {
              name,
              description,
              path: commandPath,
              content,
              isProjectLevel,
            });
          }
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  /**
   * Get a custom command by name
   */
  getCustomCommand(name: string): CustomCommand | undefined {
    return this.customCommands.get(name);
  }

  /**
   * Get all custom commands
   */
  getCustomCommands(): CustomCommand[] {
    return [...this.customCommands.values()];
  }

  /**
   * Check if a message is a slash command
   */
  parseSlashCommand(message: string): { command: string; args: string } | null {
    const match = message.match(/^\/(\w+)(?:\s+(.*))?$/);
    if (match) {
      return {
        command: match[1],
        args: match[2] || '',
      };
    }
    return null;
  }

  /**
   * Execute a slash command
   */
  async executeCommand(commandName: string, args: string): Promise<{
    found: boolean;
    content?: string;
    error?: string;
  }> {
    const command = this.customCommands.get(commandName);

    if (!command) {
      return {
        found: false,
        error: `Command not found: /${commandName}`,
      };
    }

    // Replace $ARGUMENTS placeholder
    let content = command.content;
    content = content.replace(/\$ARGUMENTS/g, args);
    content = content.replace(/\$\{ARGUMENTS\}/g, args);

    this.emit('command-executed', {
      command: commandName,
      args,
      isProjectLevel: command.isProjectLevel,
    });

    return {
      found: true,
      content,
    };
  }

  // ============ Skill Auto-Loading ============

  /**
   * Process a message and auto-load/suggest skills
   */
  async processMessage(context: SkillMatchContext): Promise<{
    suggestions: SkillSuggestion[];
    autoLoaded: LoadedSkill[];
    command?: { name: string; content: string };
  }> {
    const result: {
      suggestions: SkillSuggestion[];
      autoLoaded: LoadedSkill[];
      command?: { name: string; content: string };
    } = {
      suggestions: [],
      autoLoaded: [],
    };

    // Check for slash command
    const parsed = this.parseSlashCommand(context.message);
    if (parsed) {
      const cmdResult = await this.executeCommand(parsed.command, parsed.args);
      if (cmdResult.found && cmdResult.content) {
        result.command = {
          name: parsed.command,
          content: cmdResult.content,
        };
        return result;
      }
    }

    // Match skills
    const suggestions = await this.matchSkills(context);
    result.suggestions = suggestions;

    // Auto-load skills that meet threshold
    for (const suggestion of suggestions) {
      if (suggestion.autoActivate) {
        try {
          const loaded = await this.skillLoader.loadSkill(suggestion.bundle, {
            loadReferences: true,
            loadExamples: false,
          });
          result.autoLoaded.push(loaded);
          this.emit('skill-auto-loaded', {
            skillName: suggestion.skillName,
            confidence: suggestion.confidence,
          });
        } catch (error) {
          this.emit('skill-load-error', {
            skillName: suggestion.skillName,
            error,
          });
        }
      }
    }

    return result;
  }

  /**
   * Register a skill bundle
   */
  registerSkill(bundle: SkillBundle): void {
    this.triggerMatcher.registerSkill(bundle);
  }

  /**
   * Register multiple skill bundles
   */
  registerSkills(bundles: SkillBundle[]): void {
    this.triggerMatcher.registerSkills(bundles);
  }

  /**
   * Get all registered skills
   */
  getRegisteredSkills(): SkillBundle[] {
    return this.triggerMatcher.getRegisteredSkills();
  }
}

export default SkillMatcher;
