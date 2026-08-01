import { Router } from 'express';
import { getDb } from '../db/connection.js';
import { generateTop100 } from '../classic-ranking/rankingService.js';
import { ruleHotSummary } from '../discovery/summaryService.js';
const router = Router();
router.post('/api/classic-ranking/generate-top100', async (req, res) => {
  try {
    const snapshotDate = new Date().toISOString().slice(0, 10); const force = req.body?.force === true; const db = getDb();
    const existing = db.prepare('SELECT COUNT(*) AS count FROM classic_top100_snapshots WHERE snapshot_date=?').get(snapshotDate) as { count: number };
    if (existing.count && !force) return res.json({ snapshotDate, count: existing.count, summariesGenerated: 0, archived: true });
    const recent = new Date(); recent.setDate(recent.getDate() - 365); const queries = [`stars:>=10000`, `created:>${recent.toISOString().slice(0, 10)} stars:>=100`];
    const settled = await Promise.allSettled(queries.map(async (query) => { const response = await fetch(`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'HotChasing' } }); if (!response.ok) throw new Error(`GitHub Search returned ${response.status}`); return response.json() as Promise<{ items?: Array<Record<string, unknown>> }>; }));
    const responses = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []); const items = [...new Map(responses.flatMap((payload) => payload.items ?? []).map((repo) => [Number(repo.id), repo])).values()]; const now = new Date().toISOString();
    const upsert = db.prepare(`INSERT INTO repositories (id,name,full_name,description,html_url,stargazers_count,forks_count,language,created_at,updated_at,pushed_at,owner_login,owner_avatar_url,topics)
      VALUES (@id,@name,@full_name,@description,@html_url,@stargazers_count,@forks_count,@language,@created_at,@updated_at,@pushed_at,@owner_login,@owner_avatar_url,@topics)
      ON CONFLICT(id) DO UPDATE SET description=excluded.description,html_url=excluded.html_url,stargazers_count=excluded.stargazers_count,forks_count=excluded.forks_count,language=excluded.language,updated_at=excluded.updated_at,pushed_at=excluded.pushed_at,topics=excluded.topics`);
    const snapshot = db.prepare('INSERT OR IGNORE INTO metric_snapshots (repo_id,captured_at,stars,forks,open_issues,ranking,source_channel) VALUES (?,?,?,?,?,?,?)');
    if (items.length) { const save = db.transaction(() => items.forEach((repo, index) => { const owner = repo.owner as Record<string, unknown> | undefined; upsert.run({ id: repo.id, name: repo.name, full_name: repo.full_name, description: repo.description, html_url: repo.html_url, stargazers_count: repo.stargazers_count ?? 0, forks_count: repo.forks_count ?? 0, language: repo.language, created_at: repo.created_at, updated_at: repo.updated_at, pushed_at: repo.pushed_at, owner_login: owner?.login ?? '', owner_avatar_url: owner?.avatar_url ?? '', topics: JSON.stringify(repo.topics ?? []) }); snapshot.run(repo.id, now, repo.stargazers_count ?? 0, repo.forks_count ?? 0, repo.open_issues_count ?? 0, index + 1, 'top100_candidates'); })); save(); }
    const existingCandidates = db.prepare("SELECT COUNT(*) AS count FROM metric_snapshots WHERE source_channel='top100_candidates'").get() as { count: number };
    if (!items.length && !existingCandidates.count) throw new Error('GitHub 候选采集失败且本地没有可用的 Top100 候选池');
    const ranking = await generateTop100(snapshotDate);
    res.status(201).json({ ...ranking, archived: false });
  } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : 'Top100 generation failed' }); }
});
router.get('/api/classic-ranking/top100/:date?', (req, res) => {
  const db = getDb(); const date = req.params.date ?? (db.prepare('SELECT MAX(snapshot_date) AS date FROM classic_top100_snapshots').get() as { date?: string }).date;
  if (!date) return res.json({ snapshotDate: null, items: [] });
  const rows = db.prepare(`SELECT s.*,r.name,r.full_name,r.html_url,r.description,r.language,r.stargazers_count,r.forks_count,r.created_at,r.updated_at,r.topics,r.hot_summary_zh,r.primary_category,r.function_tags,r.product_forms,r.platform_tags,r.deployment_difficulty,r.classification_reason,c.*
    FROM classic_top100_snapshots s JOIN repositories r ON r.id=s.repo_id JOIN classic_project_scores c ON c.repo_id=s.repo_id
    WHERE s.snapshot_date=? ORDER BY s.rank`).all(date) as Array<Record<string, unknown>>;
  const items = rows.map((item) => ({ ...item, hot_summary_zh: item.hot_summary_zh || ruleHotSummary(item) }));
  const generatedAt = db.prepare('SELECT MAX(generated_at) AS generatedAt FROM classic_top100_snapshots WHERE snapshot_date=?').get(date) as { generatedAt?: string };
  res.json({ snapshotDate: date, generatedAt: generatedAt.generatedAt ?? null, items });
});
export default router;
