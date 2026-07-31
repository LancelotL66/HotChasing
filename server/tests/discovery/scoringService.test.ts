import { describe, expect, it } from 'vitest';
import { calculateTrendingScore } from '../../src/discovery/scoringService.js';

describe('calculateTrendingScore', () => {
  it('rewards measurable growth and fresh project activity', () => {
    const result = calculateTrendingScore({ stars: 1000, stars24h: 100, stars7d: 300, ranking: 2, previousRanking: 10, updatedAt: new Date().toISOString(), latestReleaseAt: new Date().toISOString(), snapshotCount: 2 });
    expect(result.score).toBeGreaterThan(0);
    expect(result.details.rankGain).toBe(80);
    expect(result.details.recentUpdate).toBe(10);
  });

  it('does not assign negative growth a score', () => {
    const result = calculateTrendingScore({ stars: 1, stars24h: -5, stars7d: -10, snapshotCount: 2 });
    expect(result.details.starVelocity).toBe(0);
    expect(result.details.weeklyVelocity).toBe(0);
  });
});
