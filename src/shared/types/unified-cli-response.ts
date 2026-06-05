/**
 * Unified CLI Response Types
 * Normalizes outputs from all CLI tools (Claude, Codex, Gemini, etc.)
 * into a common structure for the multi-agent verification system
 */

import { estimateTokens as sharedEstimateTokens } from '../utils/token-estimate';

/**
 * Source information for CLI responses
 */
export interface CliSource {
  /** CLI identifier: 'claude', 'codex', 'gemini', etc. */
  cli: string;
  /** Specific model used if applicable */
  model?: string;
  /** CLI version */
  version?: string;
  /** Capabilities of this CLI */
  capabilities: string[];
}

/**
 * Token usage information
 */
export interface TokenUsage {
  input?: number;
  output?: number;
  total: number;
  cost?: number;
}

/**
 * Timing information for responses
 */
export interface TimingInfo {
  startTime: Date;
  endTime: Date;
  /** Duration in milliseconds */
  duration: number;
  /** Time to first token in milliseconds */
  timeToFirstToken?: number;
}

/**
 * Extracted key point from a response
 */
export interface KeyPoint {
  id: string;
  text: string;
  importance: 'high' | 'medium' | 'low';
  category?: string;
  supportingEvidence?: string;
}

/**
 * Code block extracted from a response
 */
export interface CodeBlock {
  language: string;
  code: string;
  filename?: string;
  explanation?: string;
  lineNumbers?: { start: number; end: number };
}

/**
 * Tool execution result
 */
export interface ToolResult {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  success: boolean;
  duration?: number;
}

/**
 * Citation or reference
 */
export interface Citation {
  text: string;
  source: string;
  url?: string;
  confidence?: number;
}

/**
 * Unified response format that normalizes outputs from all CLI tools
 */
export interface UnifiedCliResponse {
  /** Unique response ID */
  id: string;
  /** Which CLI generated this response */
  source: CliSource;
  /** Timestamp */
  timestamp: Date;

  /** Main response content */
  content: string;
  /** Extracted reasoning/thinking (if available) */
  reasoning?: string;
  /** Final conclusion if identifiable */
  conclusion?: string;

  /** Extracted key points */
  keyPoints: KeyPoint[];
  /** Code snippets */
  codeBlocks: CodeBlock[];
  /** Tool execution results */
  toolResults: ToolResult[];
  /** References/citations */
  citations?: Citation[];

  /** Self-reported or inferred confidence (0-1) */
  confidence?: number;
  /** Token usage */
  tokens: TokenUsage;
  /** Timing information */
  timing: TimingInfo;

  /** Original CLI output for debugging */
  raw: unknown;
}

/**
 * Interface for normalizing CLI responses
 */
export interface ResponseNormalizer {
  /**
   * Normalize raw CLI output to unified format
   */
  normalize(raw: unknown, source: CliSource, timing: TimingInfo): UnifiedCliResponse;

  /**
   * Extract key points from response content
   */
  extractKeyPoints(content: string): KeyPoint[];

  /**
   * Extract code blocks from response content
   */
  extractCodeBlocks(content: string): CodeBlock[];

  /**
   * Extract reasoning/thinking from response content
   */
  extractReasoning(content: string): string | undefined;

  /**
   * Extract confidence from response content
   */
  extractConfidence(content: string): number | undefined;
}

/**
 * Base response normalizer with common extraction methods
 */
export class BaseResponseNormalizer implements ResponseNormalizer {
  normalize(raw: unknown, source: CliSource, timing: TimingInfo): UnifiedCliResponse {
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);

    return {
      id: this.generateId(source.cli),
      source,
      timestamp: new Date(),
      content,
      reasoning: this.extractReasoning(content),
      conclusion: this.extractConclusion(content),
      keyPoints: this.extractKeyPoints(content),
      codeBlocks: this.extractCodeBlocks(content),
      toolResults: [],
      citations: this.extractCitations(content),
      confidence: this.extractConfidence(content),
      tokens: {
        total: this.estimateTokens(content),
      },
      timing,
      raw,
    };
  }

  extractKeyPoints(content: string): KeyPoint[] {
    const keyPoints: KeyPoint[] = [];

    // Look for explicit key points section
    const keyPointsMatch = content.match(/##\s*Key\s*Points?\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (keyPointsMatch) {
      const lines = keyPointsMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));

      for (const line of lines) {
        const text = line.replace(/^-\s*/, '').trim();
        if (text) {
          keyPoints.push({
            id: this.generateId('kp'),
            text,
            importance: this.inferImportance(text),
            category: this.inferCategory(text),
          });
        }
      }
    }

    // Fallback: extract bullet points
    if (keyPoints.length === 0) {
      const bullets = content.match(/^[-*]\s+.+$/gm);
      if (bullets) {
        for (const bullet of bullets.slice(0, 10)) {
          const text = bullet.replace(/^[-*]\s*/, '').trim();
          if (text) {
            keyPoints.push({
              id: this.generateId('kp'),
              text,
              importance: 'medium',
            });
          }
        }
      }
    }

    return keyPoints;
  }

  extractCodeBlocks(content: string): CodeBlock[] {
    const codeBlocks: CodeBlock[] = [];

    // Match fenced code blocks
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(content)) !== null) {
      codeBlocks.push({
        language: match[1] || 'text',
        code: match[2].trim(),
      });
    }

    return codeBlocks;
  }

  extractReasoning(content: string): string | undefined {
    // Look for thinking/reasoning sections
    const patterns = [
      /##\s*(?:Thinking|Reasoning|Analysis)\s*\n([\s\S]*?)(?=\n##|$)/i,
      /<thinking>([\s\S]*?)<\/thinking>/i,
      /\[THINKING\]([\s\S]*?)\[\/THINKING\]/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  extractConfidence(content: string): number | undefined {
    const confidenceMatch = content.match(/(?:Overall\s*)?Confidence[:\s]*(\d+)%?/i);
    if (confidenceMatch) {
      return parseInt(confidenceMatch[1]) / 100;
    }
    return undefined;
  }

  protected extractConclusion(content: string): string | undefined {
    // Look for conclusion/summary sections
    const patterns = [
      /##\s*(?:Conclusion|Summary|Answer)\s*\n([\s\S]*?)(?=\n##|$)/i,
      /(?:In\s*conclusion|To\s*summarize|The\s*answer\s*is)[,:]?\s*([\s\S]{10,200}?)(?:\n\n|$)/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  protected extractCitations(content: string): Citation[] {
    const citations: Citation[] = [];

    // Look for markdown links
    const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      citations.push({
        text: match[1],
        source: match[2],
        url: match[2].startsWith('http') ? match[2] : undefined,
      });
    }

    return citations;
  }

  protected generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  protected estimateTokens(content: string): number {
    return sharedEstimateTokens(content);
  }

  protected inferImportance(text: string): 'high' | 'medium' | 'low' {
    const highIndicators = ['critical', 'important', 'must', 'required', 'essential', 'warning'];
    const lowIndicators = ['optional', 'might', 'could', 'consider', 'minor'];

    const lowerText = text.toLowerCase();

    if (highIndicators.some((ind) => lowerText.includes(ind))) {
      return 'high';
    }
    if (lowIndicators.some((ind) => lowerText.includes(ind))) {
      return 'low';
    }
    return 'medium';
  }

  protected inferCategory(text: string): string | undefined {
    const categories: Record<string, string[]> = {
      recommendation: ['recommend', 'suggest', 'should', 'consider'],
      warning: ['warning', 'caution', 'avoid', 'danger', 'risk'],
      fact: ['is', 'are', 'was', 'were', 'has', 'have'],
      opinion: ['believe', 'think', 'feel', 'seems'],
    };

    const lowerText = text.toLowerCase();

    for (const [category, indicators] of Object.entries(categories)) {
      if (indicators.some((ind) => lowerText.includes(ind))) {
        return category;
      }
    }

    return undefined;
  }
}

/**
 * Claude-specific response normalizer
 */
export class ClaudeResponseNormalizer extends BaseResponseNormalizer {
  override normalize(raw: unknown, source: CliSource, timing: TimingInfo): UnifiedCliResponse {
    // Parse NDJSON if string
    if (typeof raw === 'string') {
      const lines = raw.split('\n').filter((l) => l.trim());
      let content = '';
      const toolResults: ToolResult[] = [];

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);

          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text') {
                content += block.text;
              } else if (block.type === 'tool_use') {
                toolResults.push({
                  tool: block.name,
                  input: block.input || {},
                  output: '',
                  success: true,
                });
              }
            }
          }

          if (msg.type === 'tool_result') {
            const lastTool = toolResults[toolResults.length - 1];
            if (lastTool) {
              lastTool.output = msg.content;
              lastTool.success = !msg.is_error;
            }
          }
        } catch {
          // Not JSON, treat as plain text
          content += line;
        }
      }

      const base = super.normalize(content, source, timing);
      base.toolResults = toolResults;
      base.raw = raw;
      return base;
    }

    return super.normalize(raw, source, timing);
  }
}

/**
 * Codex-specific response normalizer
 */
export class CodexResponseNormalizer extends BaseResponseNormalizer {
  override extractReasoning(content: string): string | undefined {
    // Codex-specific thinking format
    const match = content.match(/\[THINKING\]([\s\S]*?)\[\/THINKING\]/i);
    return match ? match[1].trim() : super.extractReasoning(content);
  }

  override normalize(raw: unknown, source: CliSource, timing: TimingInfo): UnifiedCliResponse {
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const toolResults: ToolResult[] = [];

    // Extract Codex tool blocks
    const toolPattern = /\[TOOL:\s*(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match;

    while ((match = toolPattern.exec(content)) !== null) {
      toolResults.push({
        tool: match[1],
        input: { raw: match[2].trim() },
        output: '',
        success: true,
      });
    }

    // Clean content
    const cleanContent = content
      .replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/g, '')
      .replace(/\[THINKING\][\s\S]*?\[\/THINKING\]/g, '')
      .trim();

    const base = super.normalize(cleanContent, source, timing);
    base.toolResults = toolResults;
    base.raw = raw;
    return base;
  }
}

/**
 * Gemini-specific response normalizer
 */
export class GeminiResponseNormalizer extends BaseResponseNormalizer {
  override normalize(raw: unknown, source: CliSource, timing: TimingInfo): UnifiedCliResponse {
    const content = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const toolResults: ToolResult[] = [];

    // Extract Gemini tool calls
    const toolPattern = /```tool\n(\w+)\(([\s\S]*?)\)\n```/g;
    let match;

    while ((match = toolPattern.exec(content)) !== null) {
      try {
        toolResults.push({
          tool: match[1],
          input: JSON.parse(match[2] || '{}'),
          output: '',
          success: true,
        });
      } catch {
        toolResults.push({
          tool: match[1],
          input: { raw: match[2] },
          output: '',
          success: true,
        });
      }
    }

    // Clean content
    const cleanContent = content
      .replace(/```tool\n[\s\S]*?\n```/g, '')
      .replace(/^\[.*?\]\s*/gm, '') // Remove status prefixes
      .trim();

    const base = super.normalize(cleanContent, source, timing);
    base.toolResults = toolResults;
    base.raw = raw;
    return base;
  }
}

/**
 * Factory function to get the appropriate normalizer for a CLI type
 */
export function getNormalizer(cliType: string): ResponseNormalizer {
  switch (cliType) {
    case 'claude':
    case 'claude-cli':
      return new ClaudeResponseNormalizer();
    case 'codex':
    case 'codex-cli':
      return new CodexResponseNormalizer();
    case 'gemini':
    case 'gemini-cli':
      return new GeminiResponseNormalizer();
    default:
      return new BaseResponseNormalizer();
  }
}

// CLI Detection Types moved to cli-detection.types.ts
// Re-export for backward compatibility
export type { CliType, CliInfo } from './cli-detection.types';
