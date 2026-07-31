import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { logger } from '../services/logger.js';
import { calculateTrendingScore } from '../discovery/scoringService.js';
import { generateHotSummary } from '../discovery/aiGateway.js';

const router = Router();
const requestSchema = z.object({ query: z.string().min(1).max(200).optional(), channel: z.string().max(40).optional() });
const backfillSchema = z.object({ days: z.number().int().min(1).max(15).default(15) });

function getDiscoveryChannels(): Array<{ channel: string; query: string; sort: 'updated' | 'stars' }> {
  const today = new Date();
  const recentCreated = new Date(today); recentCreated.setDate(today.getDate() - 120);
  const createdSince = recentCreated.toISOString().slice(0, 10);
  return [
    { channel: 'ai_agents', query: `topic:ai created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'developer_tools', query: `topic:developer-tools created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'data_infrastructure', query: `topic:data-engineering created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'devops', query: `topic:devops created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'security', query: `topic:security created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'productivity', query: `topic:productivity created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'design_content', query: `topic:design created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'apps', query: `topic:desktop-app created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'business_finance', query: `topic:finance created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'learning_research', query: `topic:education created:>${createdSince} stars:>=20`, sort: 'stars' },
    { channel: 'new_and_notable', query: `created:>${createdSince} stars:>=50`, sort: 'stars' },
  ];
}

router.post('/api/discovery/run', async (req, res) => {
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid discovery request', code: 'INVALID_DISCOVERY_REQUEST' });
  const db = getDb(); const id = randomUUID(); const startedAt = new Date().toISOString();
  const channels = parsed.data.query ? [{ channel: parsed.data.channel ?? 'manual_search', query: parsed.data.query, sort: 'updated' as const }] : getDiscoveryChannels();
  db.prepare('INSERT INTO discovery_runs (id, source, channel, started_at, status) VALUES (?, ?, ?, ?, ?)').run(id, 'github_search', parsed.data.channel ?? 'multi_channel', startedAt, 'running');
  try {
    const settled = await Promise.allSettled(channels.map(async (item) => {
      const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(item.query)}&sort=${item.sort}&order=desc&per_page=20`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HotChasing' } });
      if (!response.ok) throw new Error(`GitHub Search for ${item.channel} returned ${response.status}`);
      const payload = await response.json() as { items?: Array<Record<string, unknown>> };
      return (payload.items ?? []).map((repo, index) => ({ repo, channel: item.channel, ranking: index + 1 }));
    }));
    const responses = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (!responses.length) throw new Error('All GitHub discovery channels failed');
    const candidates = responses.flat(); const unique = new Map<number, { repo: Record<string, unknown>; channel: string; ranking: number }>();
    candidates.forEach((candidate) => { const repoId = Number(candidate.repo.id); if (!unique.has(repoId)) unique.set(repoId, candidate); });
    const items = [...unique.values()]; const now = new Date().toISOString();
    const upsert = db.prepare(`INSERT INTO repositories (id,name,full_name,description,html_url,stargazers_count,forks_count,language,created_at,updated_at,pushed_at,owner_login,owner_avatar_url,topics)
      VALUES (@id,@name,@full_name,@description,@html_url,@stargazers_count,@forks_count,@language,@created_at,@updated_at,@pushed_at,@owner_login,@owner_avatar_url,@topics)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,full_name=excluded.full_name,description=excluded.description,html_url=excluded.html_url,stargazers_count=excluded.stargazers_count,forks_count=excluded.forks_count,language=excluded.language,updated_at=excluded.updated_at,pushed_at=excluded.pushed_at,topics=excluded.topics`);
    const snapshot = db.prepare('INSERT OR IGNORE INTO metric_snapshots (repo_id,captured_at,stars,forks,open_issues,ranking,source_channel) VALUES (?,?,?,?,?,?,?)');
    const tx = db.transaction(() => items.forEach(({ repo, channel, ranking }) => {
      const owner = repo.owner as Record<string, unknown> | undefined;
      upsert.run({ id: repo.id, name: repo.name, full_name: repo.full_name, description: repo.description, html_url: repo.html_url, stargazers_count: repo.stargazers_count ?? 0, forks_count: repo.forks_count ?? 0, language: repo.language, created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.pushed_at, owner_login: owner?.login ?? '', owner_avatar_url: owner?.avatar_url ?? '', topics: JSON.stringify(repo.topics ?? []) });
      snapshot.run(repo.id, now, repo.stargazers_count ?? 0, repo.forks_count ?? 0, repo.open_issues_count ?? 0, ranking, channel);
    })); tx();
    db.prepare('UPDATE discovery_runs SET finished_at=?,status=?,items_found=?,items_saved=? WHERE id=?').run(new Date().toISOString(), 'completed', items.length, items.length, id);
    logger.info('discovery.run.finish', 'Discovery run completed', { runId: id, status: 'completed' });
    res.status(201).json({ id, channels: channels.map((item) => item.channel), itemsFound: items.length, itemsSaved: items.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'; db.prepare('UPDATE discovery_runs SET finished_at=?,status=?,error_message=? WHERE id=?').run(new Date().toISOString(), 'failed', message, id);
    logger.errorFromError('discovery.run.fail', 'Discovery run failed', error, { runId: id }); res.status(502).json({ error: 'Discovery failed', code: 'DISCOVERY_FAILED' });
  }
});

router.post('/api/discovery/backfill-daily', async (req, res) => {
  const parsed = backfillSchema.safeParse(req.body ?? {}); if (!parsed.success) return res.status(400).json({ error: 'Invalid backfill request' });
  const db = getDb(); const upsert = db.prepare(`INSERT INTO repositories (id,name,full_name,description,html_url,stargazers_count,forks_count,language,created_at,updated_at,pushed_at,owner_login,owner_avatar_url,topics)
    VALUES (@id,@name,@full_name,@description,@html_url,@stargazers_count,@forks_count,@language,@created_at,@updated_at,@pushed_at,@owner_login,@owner_avatar_url,@topics)
    ON CONFLICT(id) DO UPDATE SET description=excluded.description,html_url=excluded.html_url,stargazers_count=excluded.stargazers_count,forks_count=excluded.forks_count,language=excluded.language,updated_at=excluded.updated_at,pushed_at=excluded.pushed_at,topics=excluded.topics`);
  const snapshot = db.prepare('INSERT OR IGNORE INTO metric_snapshots (repo_id,captured_at,stars,forks,open_issues,ranking,source_channel) VALUES (?,?,?,?,?,?,?)'); const dates: string[] = [];
  try {
    for (let offset = 0; offset < parsed.data.days; offset++) {
      const day = new Date(); day.setUTCDate(day.getUTCDate() - offset); const date = day.toISOString().slice(0, 10);
      const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(`created:${date} stars:>=5`)}&sort=stars&order=desc&per_page=30`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HotChasing' } });
      if (!response.ok) continue; const payload = await response.json() as { items?: Array<Record<string, unknown>> }; const capturedAt = `${date}T12:00:00.000Z`;
      const save = db.transaction(() => (payload.items ?? []).forEach((repo, index) => { const owner = repo.owner as Record<string, unknown> | undefined; upsert.run({ id: repo.id, name: repo.name, full_name: repo.full_name, description: repo.description, html_url: repo.html_url, stargazers_count: repo.stargazers_count ?? 0, forks_count: repo.forks_count ?? 0, language: repo.language, created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.pushed_at, owner_login: owner?.login ?? '', owner_avatar_url: owner?.avatar_url ?? '', topics: JSON.stringify(repo.topics ?? []) }); snapshot.run(repo.id, capturedAt, repo.stargazers_count ?? 0, repo.forks_count ?? 0, repo.open_issues_count ?? 0, index + 1, 'historical_daily'); })); save(); dates.push(date);
    }
    res.status(201).json({ dates });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Historical discovery failed' }); }
});

router.get('/api/discovery/runs', (_req, res) => res.json(getDb().prepare('SELECT * FROM discovery_runs ORDER BY started_at DESC LIMIT 100').all()));
router.get('/api/discovery/projects', (_req, res) => {
  const db = getDb(); const rows = db.prepare(`
    SELECT r.*, ps.final_score, ps.score_details
    FROM repositories r
    JOIN (SELECT DISTINCT repo_id FROM metric_snapshots) discovered ON discovered.repo_id = r.id
    LEFT JOIN project_scores ps ON ps.repo_id = r.id
    ORDER BY ps.final_score DESC, r.stargazers_count DESC
    LIMIT 100
  `).all() as Array<Record<string, unknown>>;
  res.json(rows);
});
router.post('/api/discovery/projects/:repoId/score', (req, res) => {
  const repoId = Number(req.params.repoId); const db = getDb(); const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId) as Record<string, unknown> | undefined;
  if (!repo) return res.status(404).json({ error: 'Repository not found', code: 'REPOSITORY_NOT_FOUND' });
  const snapshots = db.prepare('SELECT * FROM metric_snapshots WHERE repo_id=? ORDER BY captured_at DESC').all(repoId) as Array<{ stars: number; ranking: number | null; captured_at: string }>;
  const latest = snapshots[0]; const day = snapshots.find((item) => Date.now() - Date.parse(item.captured_at) >= 86400000); const week = snapshots.find((item) => Date.now() - Date.parse(item.captured_at) >= 7 * 86400000);
  const result = calculateTrendingScore({ stars: Number(repo.stargazers_count), stars24h: latest && day ? latest.stars - day.stars : 0, stars7d: latest && week ? latest.stars - week.stars : 0, ranking: latest?.ranking, previousRanking: day?.ranking, updatedAt: repo.updated_at as string | null, snapshotCount: snapshots.length });
  db.prepare('INSERT INTO project_scores (repo_id,trending_score,final_score,score_details,calculated_at) VALUES (?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET trending_score=excluded.trending_score,final_score=excluded.final_score,score_details=excluded.score_details,calculated_at=excluded.calculated_at').run(repoId, result.score, result.score, JSON.stringify(result.details), new Date().toISOString());
  res.json(result);
});
router.get('/api/discovery/projects/:repoId/trend', (req, res) => res.json(getDb().prepare('SELECT * FROM metric_snapshots WHERE repo_id=? ORDER BY captured_at ASC').all(Number(req.params.repoId))));
router.post('/api/projects/:repoId/hot-summary-zh/regenerate', async (req, res) => {
  const db = getDb(); const repo = db.prepare('SELECT * FROM repositories WHERE id=?').get(Number(req.params.repoId)) as Record<string, unknown> | undefined;
  if (!repo) return res.status(404).json({ error: 'Repository not found', code: 'REPOSITORY_NOT_FOUND' });
  const result = await generateHotSummary(repo);
  db.prepare("UPDATE repositories SET hot_summary_zh=?,hot_summary_zh_generated_at=?,hot_summary_zh_status='generated',hot_summary_zh_source_hash=?,hot_summary_zh_source=?,hot_summary_zh_model=? WHERE id=?").run(result.summary, new Date().toISOString(), result.sourceHash, result.source, result.model, repo.id);
  res.json({ summaryZh: result.summary, source: result.source, model: result.model });
});
export default router;
