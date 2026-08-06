import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { hotSummarySourceHash } from '../discovery/summaryService.js';
import { generateHotSummary, generateProjectClassification, getActiveAIConcurrency } from '../discovery/aiGateway.js';
import { classifyProjectByRules, fetchRepositoryEnrichment, PRIMARY_CATEGORIES } from '../discovery/classificationService.js';
import { mapWithConcurrency } from '../classic-ranking/rankingService.js';
import { refreshDailyLibraryInBackground } from '../discovery/projectRefreshService.js';

const router = Router();
const generateSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), maxItems: z.number().int().min(12).max(40).default(30) });
const rebuildSchema = generateSchema.extend({ force: z.boolean().default(false) });
let historyRefresh = { status: 'idle' as 'idle' | 'running' | 'completed' | 'failed', startedAt: null as string | null, finishedAt: null as string | null };

async function generateDigest(digestDate: string, maxItems: number, force = false) {
  const db = getDb();
  const existing = db.prepare('SELECT id,status FROM daily_digests WHERE digest_date=?').get(digestDate) as { id: string; status: string } | undefined;
  if (existing?.status === 'generated' && !force) return { id: existing.id, digestDate, items: 0, archived: true };
  const now = new Date().toISOString(); const nextDigestDate = new Date(`${digestDate}T00:00:00.000Z`); nextDigestDate.setUTCDate(nextDigestDate.getUTCDate() + 1);
  const id = existing?.id ?? randomUUID();
  // The shared repositories table also stores users' starred repositories.
  // A digest must only include repositories that discovery explicitly captured.
  const candidateProjects = db.prepare(`
    SELECT r.*, COALESCE(ps.final_score, 0) AS final_score, latest.source_channel, latest.ranking,
      EXISTS(SELECT 1 FROM classic_top100_snapshots top WHERE top.repo_id=r.id AND top.snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots)) AS is_top100
    FROM repositories r
    JOIN (
      SELECT repo_id, MAX(captured_at) AS captured_at
      FROM metric_snapshots
      WHERE captured_at >= ? AND captured_at < ?
      GROUP BY repo_id
    ) discovered ON discovered.repo_id = r.id
    JOIN metric_snapshots latest ON latest.id = (
      SELECT MAX(snapshot.id) FROM metric_snapshots snapshot
      WHERE snapshot.repo_id = discovered.repo_id AND snapshot.captured_at = discovered.captured_at
    )
    LEFT JOIN project_scores ps ON ps.repo_id = r.id
    WHERE r.created_at >= datetime('now', '-120 days')
      AND NOT EXISTS (
        SELECT 1
        FROM daily_digest_items prior_item
        JOIN daily_digests prior_digest ON prior_digest.id = prior_item.digest_id
        WHERE prior_item.repo_id = r.id
          AND prior_digest.status = 'generated'
          AND prior_digest.id <> ?
      )
    ORDER BY final_score DESC, latest.ranking ASC, r.updated_at DESC, r.id ASC
    LIMIT ?
  `).all(`${digestDate}T00:00:00.000Z`, nextDigestDate.toISOString(), id, Math.min(48, Math.max(maxItems + PRIMARY_CATEGORIES.length, 36))) as Array<Record<string, unknown>>;
  const dailyCandidates = candidateProjects;
  // Select the complete digest with saved classifications or rules first. Only
  // final items need README fetching and AI enrichment.
  const categoryFor = (project: Record<string, unknown>) => String(project.primary_category ?? classifyProjectByRules(project).primaryCategory);
  const selectedDaily = PRIMARY_CATEGORIES.map((category) => dailyCandidates.find((project) => categoryFor(project) === category)).filter((project): project is Record<string, unknown> => Boolean(project));
  const dailyLimit = maxItems;
  const remainingDaily = dailyCandidates.filter((project) => !selectedDaily.includes(project)).slice(0, Math.max(0, dailyLimit - selectedDaily.length));
  const projects = [...selectedDaily, ...remainingDaily];
  const classifications = await mapWithConcurrency(projects, getActiveAIConcurrency(), async (project) => {
    if (project.primary_category) return { project, classification: null };
    const { readme, architecture } = await fetchRepositoryEnrichment(project);
    return { project, classification: await generateProjectClassification(project, readme, architecture, classifyProjectByRules(project)) };
  });
  const summaries = await mapWithConcurrency(projects, getActiveAIConcurrency(), async (project) => {
    const hash = hotSummarySourceHash(project);
    if (project.hot_summary_zh && project.hot_summary_zh_source_hash === hash) {
      return { project, summary: String(project.hot_summary_zh), source: project.hot_summary_zh_source === 'ai' ? 'ai' as const : 'rule' as const, model: project.hot_summary_zh_model as string | null, sourceHash: project.hot_summary_zh_source_hash as string ?? hash };
    }
    return { project, ...(await generateHotSummary(project)) };
  });
  const save = db.transaction(() => {
    db.prepare('INSERT INTO daily_digests (id,digest_date,title,summary,generated_at,status) VALUES (?,?,?,?,?,?) ON CONFLICT(digest_date) DO UPDATE SET title=excluded.title,summary=excluded.summary,generated_at=excluded.generated_at,status=excluded.status').run(id, digestDate, `${digestDate} 工具雷达`, `收录 ${projects.length} 个值得关注的开源项目。`, now, 'generated');
    db.prepare('DELETE FROM daily_digest_items WHERE digest_id=?').run(id);
    const add = db.prepare('INSERT INTO daily_digest_items (digest_id,repo_id,section,ranking,reason,score) VALUES (?,?,?,?,?,?)');
    const updateSummary = db.prepare("UPDATE repositories SET hot_summary_zh=?,hot_summary_zh_generated_at=?,hot_summary_zh_status='generated',hot_summary_zh_source_hash=?,hot_summary_zh_source='rule',hot_summary_zh_model=NULL WHERE id=?");
    const updateClassification = db.prepare(`UPDATE repositories SET primary_category=?,secondary_categories=?,function_tags=?,product_forms=?,platform_tags=?,target_users=?,deployment_modes=?,deployment_difficulty=?,hot_reason_tags=?,maturity_tag=?,cost_tags=?,license_tag=?,commercial_use_tags=?,privacy_tags=?,classification_confidence=?,classification_reason=?,classification_source=?,classification_source_hash=?,classified_at=? WHERE id=?`);
    summaries.forEach(({ project, summary, source, model, sourceHash }, index) => {
      updateSummary.run(summary, now, sourceHash, project.id);
      db.prepare("UPDATE repositories SET hot_summary_zh_source=?,hot_summary_zh_model=? WHERE id=?").run(source, model, project.id);
      const generatedClassification = classifications.find((item) => item.project.id === project.id)?.classification;
      if (generatedClassification && !project.classification_locked) {
        updateClassification.run(generatedClassification.primaryCategory, JSON.stringify(generatedClassification.secondaryCategories), JSON.stringify(generatedClassification.functionTags), JSON.stringify(generatedClassification.productForms), JSON.stringify(generatedClassification.platformTags), JSON.stringify(generatedClassification.targetUsers), JSON.stringify(generatedClassification.deploymentModes), generatedClassification.deploymentDifficulty, JSON.stringify(generatedClassification.hotReasonTags), generatedClassification.maturity, JSON.stringify(generatedClassification.costTags), generatedClassification.license, JSON.stringify(generatedClassification.commercialUseTags), JSON.stringify(generatedClassification.privacyTags), generatedClassification.confidence, generatedClassification.reason, generatedClassification.source, generatedClassification.sourceHash, now, project.id);
      }
      const primaryCategory = generatedClassification?.primaryCategory ?? String(project.primary_category ?? '其他 / 待分类');
      add.run(id, project.id, primaryCategory, index + 1, index < 5 ? '今日值得关注：基于热度评分、频道排名和近期活跃度入选' : '基于热度评分和 Star 指标入选', project.final_score);
    });
  }); save();
  return { id, digestDate, items: projects.length, archived: false };
}

router.post('/api/digests/generate', async (req, res) => {
  const parsed = rebuildSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid digest request', code: 'INVALID_DIGEST_REQUEST' });
  try {
    const result = await generateDigest(parsed.data.date ?? new Date().toISOString().slice(0, 10), parsed.data.maxItems, parsed.data.force);
    res.status(result.archived ? 200 : 201).json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Digest generation failed' });
  }
});

router.post('/api/digests/refresh-library', (_req, res) => {
  if (historyRefresh.status === 'running') return res.status(202).json(historyRefresh);
  historyRefresh = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null };
  void refreshDailyLibraryInBackground()
    .then(() => { historyRefresh = { ...historyRefresh, status: 'completed', finishedAt: new Date().toISOString() }; })
    .catch(() => { historyRefresh = { ...historyRefresh, status: 'failed', finishedAt: new Date().toISOString() }; });
  res.status(202).json(historyRefresh);
});

router.get('/api/digests/refresh-library', (_req, res) => res.json(historyRefresh));

router.post('/api/digests/rebuild-all', async (_req, res) => {
  try {
    const dates = getDb().prepare("SELECT digest_date FROM daily_digests WHERE status='generated' ORDER BY digest_date ASC").all() as Array<{ digest_date: string }>;
    const rebuilt: string[] = []; const failed: Array<{ date: string; error: string }> = [];
    for (const { digest_date } of dates) {
      try { await generateDigest(digest_date, 30, true); rebuilt.push(digest_date); }
      catch (error) { failed.push({ date: digest_date, error: error instanceof Error ? error.message : 'Unknown error' }); }
    }
    res.json({ rebuilt: rebuilt.length, dates: rebuilt, failed });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Digest rebuild failed' });
  }
});

router.get('/api/digests', (_req, res) => res.json(getDb().prepare('SELECT * FROM daily_digests ORDER BY digest_date DESC').all()));
router.get('/api/taxonomy', (_req, res) => res.json(getDb().prepare('SELECT dimension,name,aliases,sort_order FROM taxonomy_tags WHERE enabled=1 ORDER BY dimension,sort_order').all()));
router.get('/api/digests/:date', (req, res) => {
  const db = getDb();
  const digest = db.prepare('SELECT * FROM daily_digests WHERE digest_date=?').get(req.params.date) as Record<string, unknown> | undefined;
  if (digest) {
    const items = db.prepare(`SELECT i.*,r.name,r.full_name,r.html_url,r.description,r.language,r.stargazers_count,r.forks_count,r.owner_login,r.owner_avatar_url,r.created_at,r.updated_at,r.pushed_at,r.topics,r.hot_summary_zh,r.hot_summary_zh_status,r.hot_summary_zh_source,r.primary_category,r.secondary_categories,r.function_tags,r.product_forms,r.platform_tags,r.target_users,r.deployment_modes,r.deployment_difficulty,r.hot_reason_tags,r.cost_tags,r.license_tag,r.privacy_tags,r.classification_confidence,r.classification_reason,r.classification_source,EXISTS(SELECT 1 FROM classic_top100_snapshots top WHERE top.repo_id=r.id AND top.snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots)) AS is_top100 FROM daily_digest_items i JOIN repositories r ON r.id=i.repo_id WHERE i.digest_id=? ORDER BY i.ranking`).all(digest.id);
    return res.json({ ...digest, items });
  }

  const dayStart = `${req.params.date}T00:00:00.000Z`;
  const dayEnd = new Date(dayStart);
  if (Number.isNaN(dayEnd.getTime())) return res.status(400).json({ error: 'Invalid digest date', code: 'INVALID_DIGEST_DATE' });
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
  const projects = db.prepare(`
    SELECT r.*,COALESCE(ps.final_score,0) AS final_score,latest.source_channel,latest.ranking,
      EXISTS(SELECT 1 FROM classic_top100_snapshots top WHERE top.repo_id=r.id AND top.snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots)) AS is_top100
    FROM repositories r
    JOIN (SELECT repo_id,MAX(captured_at) AS captured_at FROM metric_snapshots WHERE captured_at>=? AND captured_at<? GROUP BY repo_id) captured ON captured.repo_id=r.id
    JOIN metric_snapshots latest ON latest.id=(SELECT MAX(snapshot.id) FROM metric_snapshots snapshot WHERE snapshot.repo_id=captured.repo_id AND snapshot.captured_at=captured.captured_at)
    LEFT JOIN project_scores ps ON ps.repo_id=r.id
    ORDER BY final_score DESC,latest.ranking ASC,r.updated_at DESC
  `).all(dayStart, dayEnd.toISOString()) as Array<Record<string, unknown>>;
  const items = projects.map((project, index) => {
    const storedCategory = typeof project.primary_category === 'string' && PRIMARY_CATEGORIES.includes(project.primary_category as typeof PRIMARY_CATEGORIES[number]);
    const fallback = storedCategory ? null : classifyProjectByRules(project);
    return {
      repo_id: project.id, name: project.name, full_name: project.full_name, html_url: project.html_url,
      description: project.description, language: project.language, stargazers_count: project.stargazers_count,
      forks_count: project.forks_count, owner_login: project.owner_login, owner_avatar_url: project.owner_avatar_url,
      created_at: project.created_at, updated_at: project.updated_at, pushed_at: project.pushed_at, topics: project.topics,
      hot_summary_zh: project.hot_summary_zh, hot_summary_zh_status: project.hot_summary_zh_status ?? 'pending', hot_summary_zh_source: project.hot_summary_zh_source ?? null,
      section: fallback?.primaryCategory ?? project.primary_category, ranking: index + 1,
      reason: `当日由 ${project.source_channel} 频道采集`, score: project.final_score,
      primary_category: fallback?.primaryCategory ?? project.primary_category,
      secondary_categories: fallback ? JSON.stringify(fallback.secondaryCategories) : project.secondary_categories,
      function_tags: fallback ? JSON.stringify(fallback.functionTags) : project.function_tags,
      product_forms: fallback ? JSON.stringify(fallback.productForms) : project.product_forms,
      platform_tags: fallback ? JSON.stringify(fallback.platformTags) : project.platform_tags,
      target_users: fallback ? JSON.stringify(fallback.targetUsers) : project.target_users,
      deployment_modes: fallback ? JSON.stringify(fallback.deploymentModes) : project.deployment_modes,
      deployment_difficulty: fallback?.deploymentDifficulty ?? project.deployment_difficulty,
      hot_reason_tags: fallback ? JSON.stringify(fallback.hotReasonTags) : project.hot_reason_tags,
      maturity_tag: fallback?.maturity ?? project.maturity_tag, cost_tags: fallback ? JSON.stringify(fallback.costTags) : project.cost_tags,
      license_tag: fallback?.license ?? project.license_tag, privacy_tags: fallback ? JSON.stringify(fallback.privacyTags) : project.privacy_tags,
      classification_confidence: fallback?.confidence ?? project.classification_confidence,
      classification_reason: fallback?.reason ?? project.classification_reason,
      classification_source: fallback?.source ?? project.classification_source, is_top100: project.is_top100,
    };
  });
  res.json({ id: `discovery-${req.params.date}`, digest_date: req.params.date, title: `${req.params.date} 发现项目`, summary: `该日期尚未生成日报，展示当日采集的 ${items.length} 个已分类项目。`, generated_at: dayStart, status: 'discovery-preview', items });
});
export default router;
