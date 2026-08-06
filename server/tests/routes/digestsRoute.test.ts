import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.fn();
const getDbMock = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getDb: getDbMock,
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
    getDbMock.mockReset();
    getDbMock.mockReturnValue({ prepare: prepareMock });
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

  it('returns an existing generated digest without loading candidates or calling AI', async () => {
    prepareMock.mockImplementation((sql: string) => ({
      get: () => sql.includes('FROM daily_digests') ? { id: 'digest-1', status: 'generated' } : undefined,
      all: () => [],
    }));

    const response = await request(createTestApp())
      .post('/api/digests/generate')
      .send({ date: '2026-07-21' })
      .expect(200);

    expect(response.body).toMatchObject({ id: 'digest-1', digestDate: '2026-07-21', archived: true });
    expect(prepareMock.mock.calls.some(([sql]) => String(sql).includes('FROM metric_snapshots'))).toBe(false);
  });

  it('excludes projects already included in a different generated digest', async () => {
    prepareMock.mockImplementation((sql: string) => ({
      get: () => sql.includes('FROM daily_digests') ? undefined : undefined,
      all: () => [],
      run: () => undefined,
    }));
    getDbMock.mockReturnValue({
      prepare: prepareMock,
      transaction: (callback: () => void) => callback,
    });

    await request(createTestApp())
      .post('/api/digests/generate')
      .send({ date: '2026-07-21' })
      .expect(201);

    const candidateQuery = prepareMock.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('FROM repositories r'));
    expect(candidateQuery).toContain('FROM daily_digest_items prior_item');
    expect(candidateQuery).toContain("prior_digest.status = 'generated'");
    expect(candidateQuery).toContain('prior_digest.id <> ?');
  });
});
