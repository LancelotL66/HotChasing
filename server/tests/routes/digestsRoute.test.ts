import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getDb: () => ({ prepare: prepareMock }),
}));

const { default: digestsRouter } = await import('../../src/routes/digests.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(digestsRouter);
  return app;
}

describe('daily digest date preview', () => {
  beforeEach(() => {
    prepareMock.mockReset();
    prepareMock.mockImplementation((sql: string) => ({
      get: () => sql.includes('FROM daily_digests') ? undefined : undefined,
      all: (...params: unknown[]) => {
        if (!sql.includes('FROM repositories r')) return [];
        expect(params).toEqual(['2026-07-21T00:00:00.000Z', '2026-07-22T00:00:00.000Z']);
        return [{
          id: 42, name: 'agent-tool', full_name: 'owner/agent-tool',
          html_url: 'https://github.com/owner/agent-tool', description: 'An AI agent for developers.',
          language: 'TypeScript', stargazers_count: 100, forks_count: 10,
          owner_login: 'owner', owner_avatar_url: '', created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-21T12:00:00.000Z', pushed_at: '2026-07-21T12:00:00.000Z',
          topics: '["ai","agent"]', final_score: 50, source_channel: 'ai_agents', ranking: 1,
          primary_category: null, hot_summary_zh: null, is_top100: 0,
        }];
      },
    }));
  });

  it('returns all projects captured on an ungenerated UTC date with rule classification', async () => {
    const response = await request(createTestApp()).get('/api/digests/2026-07-21').expect(200);

    expect(response.body).toMatchObject({
      digest_date: '2026-07-21',
      status: 'discovery-preview',
      items: [{
        repo_id: 42,
        reason: '当日由 ai_agents 频道采集',
        primary_category: 'AI 与 Agent',
        classification_source: 'rule',
      }],
    });
    expect(prepareMock.mock.calls.some(([sql]) => String(sql).includes('captured_at>=? AND captured_at<?'))).toBe(true);
  });
});
