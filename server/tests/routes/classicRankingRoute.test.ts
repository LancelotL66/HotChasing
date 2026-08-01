import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prepareMock = vi.fn();
const generateTop100Mock = vi.fn();

vi.mock('../../src/db/connection.js', () => ({ getDb: () => ({ prepare: prepareMock }) }));
vi.mock('../../src/classic-ranking/rankingService.js', () => ({ generateTop100: generateTop100Mock, mapWithConcurrency: vi.fn() }));

const { default: classicRankingRouter } = await import('../../src/routes/classicRanking.js');

describe('Top100 daily archive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'));
    prepareMock.mockReset();
    generateTop100Mock.mockReset();
    prepareMock.mockImplementation(() => ({ get: () => ({ count: 100 }), all: () => [] }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('returns the current snapshot without fetching or regenerating it', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = express(); app.use(express.json()); app.use(classicRankingRouter);

    const response = await request(app).post('/api/classic-ranking/generate-top100').send({}).expect(200);

    expect(response.body).toMatchObject({ snapshotDate: '2026-08-01', count: 100, archived: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateTop100Mock).not.toHaveBeenCalled();
  });
});
