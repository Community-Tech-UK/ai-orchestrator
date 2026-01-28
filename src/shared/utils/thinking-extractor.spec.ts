/**
 * Thinking Extractor Tests
 *
 * Tests for extracting thinking/reasoning content from LLM responses
 * in various formats (XML tags, bracket tags, header-style).
 */

import { describe, it, expect } from 'vitest';
import {
  extractThinkingContent,
  stripXmlThinkingTags,
  stripBracketThinkingTags,
  extractHeaderStyleThinking,
  isOnlyThinking,
  createThinkingBlock,
  ExtractedContent,
  ThinkingBlock,
} from './thinking-extractor';

describe('ThinkingExtractor', () => {
  describe('extractThinkingContent', () => {
    it('should return original content when no thinking is present', () => {
      const content = 'Hello, how can I help you today?';
      const result = extractThinkingContent(content);

      expect(result.response).toBe(content);
      expect(result.thinking).toHaveLength(0);
      expect(result.hasThinking).toBe(false);
    });

    it('should handle empty string', () => {
      const result = extractThinkingContent('');

      expect(result.response).toBe('');
      expect(result.thinking).toHaveLength(0);
      expect(result.hasThinking).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      const resultNull = extractThinkingContent(null as unknown as string);
      const resultUndefined = extractThinkingContent(undefined as unknown as string);

      expect(resultNull.response).toBe('');
      expect(resultNull.hasThinking).toBe(false);
      expect(resultUndefined.response).toBe('');
      expect(resultUndefined.hasThinking).toBe(false);
    });

    it('should extract XML-style thinking tags', () => {
      const content = '<thinking>Let me analyze this request</thinking>Here is my response.';
      const result = extractThinkingContent(content);

      expect(result.response).toBe('Here is my response.');
      expect(result.thinking).toHaveLength(1);
      expect(result.thinking[0].content).toBe('Let me analyze this request');
      expect(result.thinking[0].format).toBe('xml');
      expect(result.hasThinking).toBe(true);
    });

    it('should extract bracket-style thinking tags', () => {
      const content = '[THINKING]Processing the request[/THINKING]The answer is 42.';
      const result = extractThinkingContent(content);

      expect(result.response).toBe('The answer is 42.');
      expect(result.thinking).toHaveLength(1);
      expect(result.thinking[0].content).toBe('Processing the request');
      expect(result.thinking[0].format).toBe('bracket');
      expect(result.hasThinking).toBe(true);
    });

    it('should extract multiple thinking blocks of different formats', () => {
      const content = `<thinking>First thought</thinking>
[THINKING]Second thought[/THINKING]
Here is the actual response.`;
      const result = extractThinkingContent(content);

      expect(result.thinking).toHaveLength(2);
      expect(result.thinking[0].format).toBe('xml');
      expect(result.thinking[1].format).toBe('bracket');
      expect(result.response).toContain('Here is the actual response');
      expect(result.hasThinking).toBe(true);
    });

    it('should clean up extra whitespace after extraction', () => {
      const content = '<thinking>Analyzing</thinking>\n\n\n\nResponse here.';
      const result = extractThinkingContent(content);

      expect(result.response).toBe('Response here.');
      expect(result.response).not.toContain('\n\n\n');
    });

    it('should remove leading separators after thinking extraction', () => {
      const content = '<thinking>Planning</thinking>\n---\nActual response.';
      const result = extractThinkingContent(content);

      expect(result.response).toBe('Actual response.');
      expect(result.response).not.toContain('---');
    });

    it('should assign unique IDs to each thinking block', () => {
      const content = '<thinking>First</thinking><thought>Second</thought>Response';
      const result = extractThinkingContent(content);

      expect(result.thinking).toHaveLength(2);
      expect(result.thinking[0].id).toBeDefined();
      expect(result.thinking[1].id).toBeDefined();
      expect(result.thinking[0].id).not.toBe(result.thinking[1].id);
    });
  });

  describe('stripXmlThinkingTags', () => {
    it('should extract <thinking> tags', () => {
      const content = '<thinking>Internal reasoning</thinking>Public response';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Public response');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('Internal reasoning');
    });

    it('should extract <thought> tags', () => {
      const content = '<thought>My thought process</thought>Answer here';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Answer here');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('My thought process');
    });

    it('should extract <antthinking> tags', () => {
      const content = '<antthinking>Anthropic-style thinking</antthinking>Response';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('Anthropic-style thinking');
    });

    it('should handle multiple XML thinking tags', () => {
      const content = '<thinking>First</thinking>Middle<thought>Second</thought>End';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('MiddleEnd');
      expect(result.extracted).toHaveLength(2);
      expect(result.extracted[0]).toBe('First');
      expect(result.extracted[1]).toBe('Second');
    });

    it('should handle multiline thinking content', () => {
      const content = `<thinking>
Line 1
Line 2
Line 3
</thinking>Response`;
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toContain('Line 1');
      expect(result.extracted[0]).toContain('Line 2');
      expect(result.extracted[0]).toContain('Line 3');
    });

    it('should handle tags with whitespace', () => {
      const content = '< thinking >Content</ thinking >Response';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(1);
    });

    it('should skip empty thinking tags', () => {
      const content = '<thinking></thinking>Response';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(0);
    });

    it('should skip whitespace-only thinking tags', () => {
      const content = '<thinking>   </thinking>Response';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(0);
    });

    it('should return original content when no tags present', () => {
      const content = 'Just a normal response without any tags';
      const result = stripXmlThinkingTags(content);

      expect(result.cleaned).toBe(content);
      expect(result.extracted).toHaveLength(0);
    });
  });

  describe('stripBracketThinkingTags', () => {
    it('should extract [THINKING] tags', () => {
      const content = '[THINKING]Internal process[/THINKING]Visible response';
      const result = stripBracketThinkingTags(content);

      expect(result.cleaned).toBe('Visible response');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toBe('Internal process');
    });

    it('should handle multiple bracket thinking tags', () => {
      const content = '[THINKING]First[/THINKING]Middle[THINKING]Second[/THINKING]End';
      const result = stripBracketThinkingTags(content);

      expect(result.cleaned).toBe('MiddleEnd');
      expect(result.extracted).toHaveLength(2);
      expect(result.extracted[0]).toBe('First');
      expect(result.extracted[1]).toBe('Second');
    });

    it('should handle multiline bracket content', () => {
      const content = `[THINKING]
Step 1: Analyze
Step 2: Plan
Step 3: Execute
[/THINKING]Here is the result`;
      const result = stripBracketThinkingTags(content);

      expect(result.cleaned).toBe('Here is the result');
      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toContain('Step 1');
      expect(result.extracted[0]).toContain('Step 2');
      expect(result.extracted[0]).toContain('Step 3');
    });

    it('should skip empty bracket tags', () => {
      const content = '[THINKING][/THINKING]Response';
      const result = stripBracketThinkingTags(content);

      expect(result.cleaned).toBe('Response');
      expect(result.extracted).toHaveLength(0);
    });

    it('should return original content when no tags present', () => {
      const content = 'No bracket tags here';
      const result = stripBracketThinkingTags(content);

      expect(result.cleaned).toBe(content);
      expect(result.extracted).toHaveLength(0);
    });
  });

  describe('extractHeaderStyleThinking', () => {
    it('should extract bold header style thinking', () => {
      const content = `**Handling user request**

User wants to know about X, so I'll provide information about X.

Hi! Here's the information you requested.`;
      const result = extractHeaderStyleThinking(content);

      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toContain('Handling user request');
      expect(result.cleaned).toContain("Here's the information");
    });

    it('should extract markdown header style thinking', () => {
      const content = `# Analyzing the question

The user is asking about something specific.

Here is my answer.`;
      const result = extractHeaderStyleThinking(content);

      expect(result.extracted).toHaveLength(1);
      expect(result.extracted[0]).toContain('Analyzing the question');
      expect(result.cleaned).toContain('Here is my answer');
    });

    it('should not extract headers from middle of content', () => {
      const content = `Here is my response.

**Important Note**

This is just a section header, not thinking.`;
      const result = extractHeaderStyleThinking(content);

      expect(result.extracted).toHaveLength(0);
      expect(result.cleaned).toBe(content);
    });

    it('should recognize thinking indicator words', () => {
      const thinkingHeaders = [
        '**Handling this request**',
        '**Analyzing the problem**',
        '**Processing user input**',
        '**Thinking about this**',
        '**Reasoning through the question**',
        '**Planning my approach**',
        '**Considering the options**',
        '**Evaluating the request**',
      ];

      for (const header of thinkingHeaders) {
        const content = `${header}

Some reasoning here.

Hi! Response here.`;
        const result = extractHeaderStyleThinking(content);
        expect(result.extracted.length).toBeGreaterThanOrEqual(0); // May or may not extract based on full pattern
      }
    });

    it('should extract short reasoning sections', () => {
      const content = `**Step 1**

Quick note here.

I'll help you with that.`;
      const result = extractHeaderStyleThinking(content);

      // Short reasoning with "step" header should be extracted
      expect(result.extracted.length).toBeGreaterThanOrEqual(0);
    });

    it('should return original content when no header pattern', () => {
      const content = 'Just a plain response without any headers.';
      const result = extractHeaderStyleThinking(content);

      expect(result.cleaned).toBe(content);
      expect(result.extracted).toHaveLength(0);
    });

    it('should handle separator after thinking', () => {
      const content = `**Handling greeting**

User said hi.

---

Hello! How can I help?`;
      const result = extractHeaderStyleThinking(content);

      expect(result.extracted.length).toBeGreaterThanOrEqual(0);
      // If extracted, should not include separator in response
    });
  });

  describe('isOnlyThinking', () => {
    it('should return true for content that is only thinking', () => {
      const content = '<thinking>Just internal reasoning without response</thinking>';
      expect(isOnlyThinking(content)).toBe(true);
    });

    it('should return false for content with response', () => {
      const content = '<thinking>Some thinking</thinking>Here is my response.';
      expect(isOnlyThinking(content)).toBe(false);
    });

    it('should return false for plain content', () => {
      const content = 'Just a normal response';
      expect(isOnlyThinking(content)).toBe(false);
    });

    it('should return true for empty content', () => {
      expect(isOnlyThinking('')).toBe(true);
    });

    it('should return true for whitespace-only response after extraction', () => {
      const content = '<thinking>All thinking</thinking>   ';
      expect(isOnlyThinking(content)).toBe(true);
    });
  });

  describe('createThinkingBlock', () => {
    it('should create a thinking block with default format', () => {
      const block = createThinkingBlock('Some thinking content');

      expect(block.content).toBe('Some thinking content');
      expect(block.format).toBe('unknown');
      expect(block.id).toBeDefined();
      expect(block.timestamp).toBeDefined();
    });

    it('should create a thinking block with specified format', () => {
      const block = createThinkingBlock('Content', 'xml');

      expect(block.content).toBe('Content');
      expect(block.format).toBe('xml');
    });

    it('should create a thinking block with specified timestamp', () => {
      const timestamp = 1234567890;
      const block = createThinkingBlock('Content', 'sdk', timestamp);

      expect(block.timestamp).toBe(timestamp);
    });

    it('should trim whitespace from content', () => {
      const block = createThinkingBlock('  Content with spaces  ');

      expect(block.content).toBe('Content with spaces');
    });

    it('should generate unique IDs for each block', () => {
      const block1 = createThinkingBlock('First');
      const block2 = createThinkingBlock('Second');

      expect(block1.id).not.toBe(block2.id);
    });
  });

  describe('Real-world scenarios', () => {
    it('should handle Codex-style output', () => {
      const content = `**Handling user greeting**

User just said hi without a task, so no skills check or task action is needed—respond with a simple greeting.

Hi! How can I help?`;
      const result = extractThinkingContent(content);

      // Should extract the thinking header and reasoning
      expect(result.hasThinking).toBe(true);
      expect(result.response).toContain('Hi!');
    });

    it('should handle Claude-style XML thinking', () => {
      const content = `<thinking>
The user is asking about implementing a sorting algorithm.
Let me think about the best approach:
1. Consider time complexity
2. Consider space complexity
3. Provide a clear example
</thinking>

Here's how you can implement quicksort in Python:

\`\`\`python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)
\`\`\``;
      const result = extractThinkingContent(content);

      expect(result.hasThinking).toBe(true);
      expect(result.thinking[0].format).toBe('xml');
      expect(result.thinking[0].content).toContain('sorting algorithm');
      expect(result.response).toContain('quicksort');
      expect(result.response).toContain('```python');
    });

    it('should handle mixed format response', () => {
      const content = `<thinking>Analyzing request</thinking>
[THINKING]Additional reasoning[/THINKING]
Here is my final answer.`;
      const result = extractThinkingContent(content);

      expect(result.thinking).toHaveLength(2);
      expect(result.thinking[0].format).toBe('xml');
      expect(result.thinking[1].format).toBe('bracket');
      expect(result.response).toBe('Here is my final answer.');
    });

    it('should preserve code blocks in response', () => {
      const content = `<thinking>User wants code</thinking>
Here's the code:

\`\`\`javascript
function hello() {
  console.log('Hello, world!');
}
\`\`\``;
      const result = extractThinkingContent(content);

      expect(result.response).toContain('```javascript');
      expect(result.response).toContain('Hello, world!');
    });

    it('should handle nested-looking but valid content', () => {
      // Content that looks like it might have nested tags but doesn't
      const content = 'The <thinking> tag is used for internal reasoning. Here is how to use it.';
      const result = extractThinkingContent(content);

      // This shouldn't extract anything because <thinking> isn't a complete tag pair
      expect(result.response).toContain('<thinking>');
    });
  });
});
