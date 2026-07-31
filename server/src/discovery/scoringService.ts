export interface ScoreInput {
  stars: number;
  stars24h: number;
  stars7d: number;
  ranking?: number | null;
  previousRanking?: number | null;
  updatedAt?: string | null;
  latestReleaseAt?: string | null;
  snapshotCount?: number;
}

export function calculateTrendingScore(input: ScoreInput): { score: number; details: Record<string, number> } {
  if ((input.snapshotCount ?? 0) < 2) {
    return { score: 0, details: { snapshotCount: input.snapshotCount ?? 0, insufficientHistory: 1 } };
  }
  const starVelocity = Math.log1p(Math.max(0, input.stars24h)) * 30;
  const weeklyVelocity = Math.log1p(Math.max(0, input.stars7d / 7)) * 20;
  const rankGain = input.ranking && input.previousRanking ? Math.max(0, input.previousRanking - input.ranking) * 10 : 0;
  const recentUpdate = input.updatedAt && Date.now() - Date.parse(input.updatedAt) < 14 * 86400000 ? 10 : 0;
  const recentRelease = input.latestReleaseAt && Date.now() - Date.parse(input.latestReleaseAt) < 30 * 86400000 ? 10 : 0;
  const score = Math.round((starVelocity + weeklyVelocity + rankGain + recentUpdate + recentRelease) * 100) / 100;
  return { score, details: { starVelocity, weeklyVelocity, rankGain, recentUpdate, recentRelease, stars: input.stars } };
}
