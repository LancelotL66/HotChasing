import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { hotSummarySourceHash } from '../discovery/summaryService.js';
import { generateHotSummary, generateProjectClassification } from '../discovery/aiGateway.js';
import { classifyProjectByRules, classificationSourceHash, fetchRepositoryArchitecture, fetchRepositoryReadme, PRIMARY_CATEGORIES } from '../discovery/classificationService.js';

const router = Router();
const generateSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), maxItems: z.number().int().min(12).max(40).default(30) });

router.post('/api/digests/generate', async (req, res) => {
  const parsed = generateSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid digest request', code: 'INVALID_DIGEST_REQUEST' });
  const db = getDb(); const digestDate = parsed.data.date ?? new Date().toISOString().slice(0, 10); const now = new Date().toISOString(); const nextDigestDate = new Date(`${digestDate}T00:00:00.000Z`); nextDigestDate.setUTCDate(nextDigestDate.getUTCDate() + 1);
  const existing = db.prepare('SELECT id FROM daily_digests WHERE digest_date=?').get(digestDate) as { id: string } | undefined; const id = existing?.id ?? randomUUID();
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
    ORDER BY final_score DESC, latest.ranking ASC, r.updated_at DESC
    LIMIT ?
  `).all(`${digestDate}T00:00:00.000Z`, nextDigestDate.toISOString(), Math.min(48, Math.max(parsed.data.maxItems + PRIMARY_CATEGORIES.length, 36))) as Array<Record<string, unknown>>;
  const classifications = await Promise.all(candidateProjects.map(async (project) => {
    const [readme, architecture] = await Promise.all([fetchRepositoryReadme(String(project.full_name ?? '')), fetchRepositoryArchitecture(String(project.full_name ?? ''))]);
    const hash = classificationSourceHash(project, readme, architecture);
    if (project.classification_source_hash === hash && project.primary_category) return { project, classification: null };
    const fallback = classifyProjectByRules(project);
    return { project, classification: await generateProjectClassification(project, readme, architecture, fallback) };
  }));
  const classificationFor = (project: Record<string, unknown>) => classifications.find((item) => item.project.id === project.id)?.classification;
  const dailyCandidates = candidateProjects;
  const selectedDaily = PRIMARY_CATEGORIES.map((category) => dailyCandidates.find((project) => (classificationFor(project)?.primaryCategory ?? project.primary_category) === category)).filter((project): project is Record<string, unknown> => Boolean(project));
  const dailyLimit = parsed.data.maxItems;
  const remainingDaily = dailyCandidates.filter((project) => !selectedDaily.includes(project)).slice(0, Math.max(0, dailyLimit - selectedDaily.length));
  const projects = [...selectedDaily, ...remainingDaily];
  const summaries = await Promise.all(projects.map(async (project) => {
    const hash = hotSummarySourceHash(project);
    if (project.hot_summary_zh_source_hash === hash && project.hot_summary_zh && project.hot_summary_zh_source === 'ai') {
      return { project, summary: String(project.hot_summary_zh), source: 'ai' as const, model: project.hot_summary_zh_model as string | null, sourceHash: hash };
    }
    return { project, ...(await generateHotSummary(project)) };
  }));
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
  res.status(201).json({ id, digestDate, items: projects.length });
});

router.get('/api/digests', (_req, res) => res.json(getDb().prepare('SELECT * FROM daily_digests ORDER BY digest_date DESC').all()));
router.get('/api/taxonomy', (_req, res) => res.json(getDb().prepare('SELECT dimension,name,aliases,sort_order FROM taxonomy_tags WHERE enabled=1 ORDER BY dimension,sort_order').all()));
router.get('/api/digests/:date', (req, res) => {
  const digest = getDb().prepare('SELECT * FROM daily_digests WHERE digest_date=?').get(req.params.date) as Record<string, unknown> | undefined;
  if (!digest) return res.status(404).json({ error: 'Digest not found', code: 'DIGEST_NOT_FOUND' });
  const items = getDb().prepare(`SELECT i.*,r.name,r.full_name,r.html_url,r.description,r.language,r.stargazers_count,r.forks_count,r.owner_login,r.owner_avatar_url,r.created_at,r.updated_at,r.pushed_at,r.topics,r.hot_summary_zh,r.hot_summary_zh_status,r.hot_summary_zh_source,r.primary_category,r.secondary_categories,r.function_tags,r.product_forms,r.platform_tags,r.target_users,r.deployment_modes,r.deployment_difficulty,r.hot_reason_tags,r.cost_tags,r.license_tag,r.privacy_tags,r.classification_confidence,r.classification_reason,r.classification_source,EXISTS(SELECT 1 FROM classic_top100_snapshots top WHERE top.repo_id=r.id AND top.snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots)) AS is_top100 FROM daily_digest_items i JOIN repositories r ON r.id=i.repo_id WHERE i.digest_id=? ORDER BY i.ranking`).all(digest.id);
  res.json({ ...digest, items });
});
export default router;
