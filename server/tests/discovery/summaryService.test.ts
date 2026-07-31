import { describe, expect, it } from 'vitest';
import { hotSummarySourceHash, ruleHotSummary } from '../../src/discovery/summaryService.js';

describe('hot project rule summary', () => {
  const repo = { name: 'example', description: 'A useful developer tool.', language: 'TypeScript', topics: '["tool"]', stargazers_count: 42, updated_at: '2026-01-01' };

  it('creates a deterministic source hash', () => {
    expect(hotSummarySourceHash(repo)).toBe(hotSummarySourceHash(repo));
    expect(hotSummarySourceHash({ ...repo, description: 'Changed.' })).not.toBe(hotSummarySourceHash(repo));
  });

  it('returns a Chinese fallback summary without unverified claims', () => {
    expect(ruleHotSummary(repo)).toContain('近期进入热门候选池');
    expect(ruleHotSummary({ name: 'example' })).toContain('当前可确认的信息有限');
  });
});
