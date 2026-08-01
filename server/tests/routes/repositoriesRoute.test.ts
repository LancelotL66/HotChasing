import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const starredRow = {
  id: 1, name: 'starred', full_name: 'owner/starred', description: null,
  html_url: 'https://github.com/owner/starred', stargazers_count: 10, language: 'TypeScript',
  created_at: null, updated_at: null, pushed_at: null, starred_at: '2026-07-31T00:00:00.000Z',
  owner_login: 'owner', owner_avatar_url: '', topics: '[]', ai_summary: null, ai_tags: '[]',
  ai_platforms: '[]', analyzed_at: null, analysis_failed: 0, custom_description: null,
  custom_tags: '[]', custom_category: null, category_locked: 0, last_edited: null,
  subscribed_to_releases: 0,
};
const discoveryRow = { ...starredRow, id: 2, name: 'discovery', full_name: 'owner/discovery', starred_at: null };

const prepareMock = vi.fn();
vi.mock('../../src/db/connection.js', () => ({
  getDb: () => ({ prepare: prepareMock }),
}));

const { default: repositoriesRouter } = await import('../../src/routes/repositories.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(repositoriesRouter);
  return app;
}

describe('repository route scopes', () => {
  beforeEach(() => {
    prepareMock.mockReset();
    prepareMock.mockImplementation((sql: string) => ({
      all: () => sql.includes('starred_at IS NOT NULL') ? [starredRow] : [starredRow, discoveryRow],
      get: () => ({ total: sql.includes('starred_at IS NOT NULL') ? 1 : 2 }),
    }));
  });

  it('returns only starred repositories when requested by the client sync', async () => {
    const response = await request(createTestApp()).get('/api/repositories?scope=starred').expect(200);

    expect(response.body).toMatchObject({ total: 1, repositories: [{ id: starredRow.id }] });
    expect(response.body.repositories).toHaveLength(1);
  });

  it('keeps the unscoped API available for shared discovery data', async () => {
    const response = await request(createTestApp()).get('/api/repositories').expect(200);

    expect(response.body).toMatchObject({ total: 2 });
    expect(response.body.repositories).toHaveLength(2);
  });
});
