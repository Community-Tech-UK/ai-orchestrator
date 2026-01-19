/**
 * Specialist Registry
 * Manages specialist profiles and provides recommendations
 */

import { EventEmitter } from 'events';
import type {
  SpecialistProfile,
  SpecialistRegistry,
  SpecialistSelectionContext,
  SpecialistRecommendation,
  SpecialistInstance,
  SpecialistFinding,
  SpecialistMetrics,
  SpecialistStatus,
  BUILT_IN_SPECIALISTS,
} from '../../../shared/types/specialist.types';
import { securitySpecialist } from './profiles/security-specialist';
import { testingSpecialist } from './profiles/testing-specialist';
import { designSpecialist } from './profiles/design-specialist';
import { reviewSpecialist } from './profiles/review-specialist';
import { devopsSpecialist } from './profiles/devops-specialist';
import { performanceSpecialist } from './profiles/performance-specialist';
import { accessibilitySpecialist } from './profiles/accessibility-specialist';
import { documentationSpecialist } from './profiles/documentation-specialist';

export class SpecialistRegistryManager extends EventEmitter {
  private static instance: SpecialistRegistryManager;
  private registry: SpecialistRegistry;
  private activeInstances: Map<string, SpecialistInstance> = new Map();

  static getInstance(): SpecialistRegistryManager {
    if (!this.instance) {
      this.instance = new SpecialistRegistryManager();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.registry = {
      builtIn: this.loadBuiltInSpecialists(),
      custom: [],
      lastUpdated: Date.now(),
    };
  }

  // ============ Built-in Specialists ============

  private loadBuiltInSpecialists(): SpecialistProfile[] {
    return [
      securitySpecialist,
      testingSpecialist,
      designSpecialist,
      reviewSpecialist,
      devopsSpecialist,
      performanceSpecialist,
      accessibilitySpecialist,
      documentationSpecialist,
    ];
  }

  // ============ Profile Management ============

  getAllProfiles(): SpecialistProfile[] {
    return [...this.registry.builtIn, ...this.registry.custom];
  }

  getBuiltInProfiles(): SpecialistProfile[] {
    return [...this.registry.builtIn];
  }

  getCustomProfiles(): SpecialistProfile[] {
    return [...this.registry.custom];
  }

  getProfile(profileId: string): SpecialistProfile | undefined {
    return this.getAllProfiles().find(p => p.id === profileId);
  }

  getProfilesByCategory(category: string): SpecialistProfile[] {
    return this.getAllProfiles().filter(p => p.category === category);
  }

  // ============ Custom Profile Management ============

  addCustomProfile(profile: SpecialistProfile): void {
    if (this.getProfile(profile.id)) {
      throw new Error(`Profile with id ${profile.id} already exists`);
    }
    this.registry.custom.push(profile);
    this.registry.lastUpdated = Date.now();
    this.emit('profile:added', profile);
  }

  updateCustomProfile(profileId: string, updates: Partial<SpecialistProfile>): SpecialistProfile | undefined {
    const index = this.registry.custom.findIndex(p => p.id === profileId);
    if (index === -1) return undefined;

    this.registry.custom[index] = { ...this.registry.custom[index], ...updates };
    this.registry.lastUpdated = Date.now();
    this.emit('profile:updated', this.registry.custom[index]);
    return this.registry.custom[index];
  }

  removeCustomProfile(profileId: string): boolean {
    const index = this.registry.custom.findIndex(p => p.id === profileId);
    if (index === -1) return false;

    const removed = this.registry.custom.splice(index, 1)[0];
    this.registry.lastUpdated = Date.now();
    this.emit('profile:removed', removed);
    return true;
  }

  // ============ Specialist Recommendations ============

  recommendSpecialists(context: SpecialistSelectionContext): SpecialistRecommendation[] {
    const recommendations: SpecialistRecommendation[] = [];
    const profiles = this.getAllProfiles();

    for (const profile of profiles) {
      const score = this.calculateRelevanceScore(profile, context);
      if (score > 0.3) {
        recommendations.push({
          profileId: profile.id,
          relevanceScore: score,
          reason: this.generateRecommendationReason(profile, context),
        });
      }
    }

    return recommendations.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  private calculateRelevanceScore(profile: SpecialistProfile, context: SpecialistSelectionContext): number {
    let score = 0;
    let factors = 0;

    // Task description matching
    if (context.taskDescription) {
      const taskLower = context.taskDescription.toLowerCase();
      const keywords = this.getProfileKeywords(profile);
      const matchedKeywords = keywords.filter(k => taskLower.includes(k.toLowerCase()));
      if (matchedKeywords.length > 0) {
        score += matchedKeywords.length / keywords.length;
        factors++;
      }
    }

    // File type matching
    if (context.fileTypes && context.fileTypes.length > 0) {
      const relevantTypes = this.getRelevantFileTypes(profile);
      const matches = context.fileTypes.filter(ft => relevantTypes.includes(ft));
      if (matches.length > 0) {
        score += matches.length / context.fileTypes.length;
        factors++;
      }
    }

    // User preferences
    if (context.userPreferences && context.userPreferences.length > 0) {
      if (context.userPreferences.includes(profile.category)) {
        score += 1;
        factors++;
      }
    }

    return factors > 0 ? score / factors : 0;
  }

  private getProfileKeywords(profile: SpecialistProfile): string[] {
    const categoryKeywords: Record<string, string[]> = {
      security: ['security', 'vulnerability', 'auth', 'injection', 'xss', 'csrf', 'secret', 'password', 'encrypt'],
      testing: ['test', 'coverage', 'unit', 'integration', 'e2e', 'mock', 'assert', 'spec'],
      design: ['architecture', 'design', 'pattern', 'api', 'interface', 'refactor', 'structure'],
      review: ['review', 'quality', 'best practice', 'clean code', 'improve', 'feedback'],
      devops: ['deploy', 'ci', 'cd', 'docker', 'kubernetes', 'pipeline', 'infrastructure'],
      performance: ['performance', 'optimize', 'speed', 'memory', 'cache', 'profile', 'benchmark'],
      accessibility: ['accessibility', 'a11y', 'aria', 'screen reader', 'wcag', 'contrast'],
      documentation: ['document', 'readme', 'comment', 'jsdoc', 'api doc', 'explain'],
    };
    return categoryKeywords[profile.category] || [];
  }

  private getRelevantFileTypes(profile: SpecialistProfile): string[] {
    const categoryTypes: Record<string, string[]> = {
      security: ['.ts', '.js', '.py', '.go', '.java', '.env', '.yml', '.yaml'],
      testing: ['.spec.ts', '.test.ts', '.spec.js', '.test.js', '_test.go', '_test.py'],
      design: ['.ts', '.js', '.py', '.go', '.java', '.md'],
      review: ['.ts', '.js', '.py', '.go', '.java', '.tsx', '.jsx'],
      devops: ['.yml', '.yaml', '.dockerfile', '.tf', '.sh', '.json'],
      performance: ['.ts', '.js', '.py', '.go', '.java', '.sql'],
      accessibility: ['.tsx', '.jsx', '.html', '.vue', '.svelte', '.css', '.scss'],
      documentation: ['.md', '.rst', '.txt', '.ts', '.js'],
    };
    return categoryTypes[profile.category] || [];
  }

  private generateRecommendationReason(profile: SpecialistProfile, context: SpecialistSelectionContext): string {
    const reasons: string[] = [];

    if (context.taskDescription) {
      const keywords = this.getProfileKeywords(profile);
      const matched = keywords.filter(k => context.taskDescription!.toLowerCase().includes(k.toLowerCase()));
      if (matched.length > 0) {
        reasons.push(`Task mentions ${matched.slice(0, 3).join(', ')}`);
      }
    }

    if (context.fileTypes && context.fileTypes.length > 0) {
      const relevantTypes = this.getRelevantFileTypes(profile);
      const matches = context.fileTypes.filter(ft => relevantTypes.includes(ft));
      if (matches.length > 0) {
        reasons.push(`Relevant file types: ${matches.join(', ')}`);
      }
    }

    return reasons.length > 0 ? reasons.join('; ') : `${profile.name} expertise applies`;
  }

  // ============ Instance Management ============

  createInstance(profileId: string, orchestratorInstanceId: string): SpecialistInstance {
    const profile = this.getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile ${profileId} not found`);
    }

    const instance: SpecialistInstance = {
      id: `specialist-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      profileId,
      profile,
      instanceId: orchestratorInstanceId,
      startTime: Date.now(),
      status: 'active',
      findings: [],
      metrics: {
        filesAnalyzed: 0,
        linesAnalyzed: 0,
        findingsCount: 0,
        findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        tokensUsed: 0,
        durationMs: 0,
      },
    };

    this.activeInstances.set(instance.id, instance);
    this.emit('instance:created', instance);
    return instance;
  }

  getInstance(instanceId: string): SpecialistInstance | undefined {
    return this.activeInstances.get(instanceId);
  }

  getActiveInstances(): SpecialistInstance[] {
    return Array.from(this.activeInstances.values()).filter(i => i.status === 'active');
  }

  updateInstanceStatus(instanceId: string, status: SpecialistStatus): void {
    const instance = this.activeInstances.get(instanceId);
    if (instance) {
      instance.status = status;
      if (status === 'completed') {
        instance.metrics.durationMs = Date.now() - instance.startTime;
      }
      this.emit('instance:status-changed', instance);
    }
  }

  addFinding(instanceId: string, finding: SpecialistFinding): void {
    const instance = this.activeInstances.get(instanceId);
    if (instance) {
      instance.findings.push(finding);
      instance.metrics.findingsCount++;
      instance.metrics.findingsBySeverity[finding.severity]++;
      this.emit('instance:finding-added', { instanceId, finding });
    }
  }

  updateMetrics(instanceId: string, updates: Partial<SpecialistMetrics>): void {
    const instance = this.activeInstances.get(instanceId);
    if (instance) {
      instance.metrics = { ...instance.metrics, ...updates };
      this.emit('instance:metrics-updated', { instanceId, metrics: instance.metrics });
    }
  }

  // ============ System Prompt Generation ============

  getSystemPromptAddition(profileId: string): string {
    const profile = this.getProfile(profileId);
    if (!profile) return '';

    let prompt = profile.systemPromptAddition;

    // Add tool restrictions
    if (profile.restrictedTools.length > 0) {
      prompt += `\n\nIMPORTANT: You must NOT use the following tools: ${profile.restrictedTools.join(', ')}`;
    }

    // Add constraints
    if (profile.constraints) {
      if (profile.constraints.readOnlyMode) {
        prompt += '\n\nIMPORTANT: You are in READ-ONLY mode. Do not modify any files.';
      }
      if (profile.constraints.requireApprovalFor && profile.constraints.requireApprovalFor.length > 0) {
        prompt += `\n\nIMPORTANT: You must ask for user approval before: ${profile.constraints.requireApprovalFor.join(', ')}`;
      }
    }

    return prompt;
  }
}

// Export singleton getter
export function getSpecialistRegistry(): SpecialistRegistryManager {
  return SpecialistRegistryManager.getInstance();
}
