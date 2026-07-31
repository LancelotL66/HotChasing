import { describe, expect, it } from 'vitest';
import { parseHotSummaryJson } from '../../src/discovery/aiGateway.js';

describe('hot summary AI response validation', () => {
  it('accepts a valid structured Chinese summary', () => {
    expect(parseHotSummaryJson('{"summaryZh":"这是一个面向开发者的开源工具，帮助用户简化日常工作流，并因近期持续更新而值得关注。"}').summaryZh).toContain('开源工具');
  });

  it('rejects non-JSON and overly short summaries', () => {
    expect(() => parseHotSummaryJson('not json')).toThrow();
    expect(() => parseHotSummaryJson('{"summaryZh":"太短"}')).toThrow();
  });
});
