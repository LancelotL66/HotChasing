import { getDb } from '../db/connection.js';
import { classificationSourceHash, classifyProjectByRules, fetchRepositoryEnrichment } from '../discovery/classificationService.js';
import { generateTop100Enrichment, getActiveAIConcurrency } from '../discovery/aiGateway.js';
import { hotSummarySourceHash } from '../discovery/summaryService.js';

const VERSION = 'github-hot-v2';
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value * 100) / 100));
export async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await mapper(values[index]); }
  }));
  return results;
}

export async function generateTop100(snapshotDate = new Date().toISOString().slice(0, 10), onProgress?: (progress: { phase: 'collect' | 'enrich' | 'save'; done: number; total: number }) => void) {
  const db = getDb(); const now = new Date().toISOString(); const activeSince = Date.now() - 365 * 86400000;
  const candidates = db.prepare(`SELECT DISTINCT r.* FROM repositories r JOIN metric_snapshots s ON s.repo_id=r.id
    WHERE s.source_channel='top100_candidates' AND r.updated_at >= ?
    `).all(new Date(activeSince).toISOString()) as Array<Record<string, unknown>>;
  const scored = candidates.map((repo) => {
    const fallbackClassification = classifyProjectByRules(repo);
    const ageDays = Math.max(1, (Date.now() - Date.parse(String(repo.created_at))) / 86400000);
    const stars = Number(repo.stargazers_count ?? 0); const forks = Number(repo.forks_count ?? 0);
    const adoption = clamp(Math.log1p(stars) / Math.log(1_000_000) * 100);
    const longevity = clamp(Math.min(100, Math.log1p(ageDays) / Math.log(3651) * 100));
    const ecosystem = clamp(Math.log1p(stars + forks * 4) / Math.log(1_500_000) * 100);
    const community = clamp(Math.log1p(forks) / Math.log(100_000) * 100);
    const engineering = clamp((repo.description ? 40 : 0) + (repo.topics ? 30 : 0) + (repo.license_tag ? 30 : 0));
    const freshProject = ageDays <= 30 ? 100 : ageDays <= 180 ? 80 : ageDays <= 730 ? 55 : 25;
    const recentUpdate = Date.now() - Date.parse(String(repo.updated_at)) < 14 * 86400000 ? 100 : Date.now() - Date.parse(String(repo.updated_at)) < 90 * 86400000 ? 70 : 25;
    const snapshot = db.prepare('SELECT stars,forks,captured_at FROM metric_snapshots WHERE repo_id=? ORDER BY captured_at DESC LIMIT 2').all(repo.id) as Array<{ stars: number; forks: number }>;
    const starGrowth = snapshot.length > 1 ? Math.max(0, snapshot[0].stars - snapshot[1].stars) : 0;
    const currentHot = clamp(recentUpdate * .45 + freshProject * .25 + Math.log1p(starGrowth) / Math.log(1000) * 100 * .30);
    const risk = repo.license_tag ? 0 : 10;
    const classic = clamp(adoption * .20 + longevity * .10 + ecosystem * .15 + community * .10 + engineering * .10 + currentHot * .35);
    const total = clamp(classic - risk); const confidence = Math.min(1, (repo.description ? .3 : .1) + (repo.topics ? .2 : .05) + .3 + (repo.license_tag ? .2 : 0));
    return { repo, fallbackClassification, adoption, longevity, ecosystem, community, engineering, currentHot, risk, classic, total, confidence };
  }).filter((item) => item.total >= 60 && item.confidence >= .6).sort((a, b) => b.total - a.total || b.adoption - a.adoption || Number(a.repo.id) - Number(b.repo.id)).slice(0, 100);
  // Ranking is deterministic before enrichment. AI only processes final items,
  // and cached AI classifications are reused while the repository is unchanged.
  let enriched = 0;
  const enrichments = await mapWithConcurrency(scored, Math.max(2, getActiveAIConcurrency()), async (item) => {
    if (item.repo.classification_locked) return null;
    const { readme, architecture } = await fetchRepositoryEnrichment(item.repo);
    const sourceHash = classificationSourceHash(item.repo, readme, architecture);
    const summaryCurrent = item.repo.hot_summary_zh_source === 'ai' && item.repo.hot_summary_zh_source_hash === hotSummarySourceHash(item.repo);
    if (item.repo.primary_category && item.repo.classification_source === 'ai' && item.repo.classification_source_hash === sourceHash && summaryCurrent) return null;
    const result = await generateTop100Enrichment(item.repo, readme, architecture, item.fallbackClassification);
    enriched += 1;
    onProgress?.({ phase: 'enrich', done: enriched, total: scored.length });
    return result;
  });
  const previous = db.prepare('SELECT repo_id,rank FROM classic_top100_snapshots WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots WHERE snapshot_date < ?)').all(snapshotDate) as Array<{ repo_id: number; rank: number }>;
  const oldRank = new Map(previous.map((item) => [item.repo_id, item.rank]));
  const save = db.transaction(() => {
    db.prepare('DELETE FROM classic_top100_snapshots WHERE snapshot_date=?').run(snapshotDate);
    const score = db.prepare('INSERT OR REPLACE INTO classic_project_scores VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const snapshot = db.prepare('INSERT INTO classic_top100_snapshots VALUES (?,?,?,?,?,?,?,?)');
    const updateClassification = db.prepare('UPDATE repositories SET primary_category=?,secondary_categories=?,function_tags=?,product_forms=?,platform_tags=?,target_users=?,deployment_modes=?,deployment_difficulty=?,hot_reason_tags=?,maturity_tag=?,cost_tags=?,license_tag=?,commercial_use_tags=?,privacy_tags=?,classification_confidence=?,classification_reason=?,classification_source=?,classification_source_hash=?,classified_at=? WHERE id=?');
    const updateSummary = db.prepare("UPDATE repositories SET hot_summary_zh=?,hot_summary_zh_generated_at=?,hot_summary_zh_status='generated',hot_summary_zh_source_hash=?,hot_summary_zh_source=?,hot_summary_zh_model=? WHERE id=?");
    scored.forEach((item, index) => {
      const enrichment = enrichments[index]; const generatedClassification = enrichment?.classification?.source === 'ai' ? enrichment.classification : undefined; const classification = generatedClassification ?? item.fallbackClassification;
      const details = { adoption: item.adoption, longevity: item.longevity, ecosystem: item.ecosystem, community: item.community, engineering: item.engineering, currentHot: item.currentHot, dataCoverage: item.confidence };
      score.run(item.repo.id, item.adoption, item.longevity, item.ecosystem, item.community, item.engineering, item.currentHot, item.classic, item.currentHot, item.risk, item.total, item.confidence, JSON.stringify(details), JSON.stringify(item.risk ? ['License 信息不足'] : []), VERSION, now);
      if (generatedClassification) updateClassification.run(classification.primaryCategory, JSON.stringify(classification.secondaryCategories), JSON.stringify(classification.functionTags), JSON.stringify(classification.productForms), JSON.stringify(classification.platformTags), JSON.stringify(classification.targetUsers), JSON.stringify(classification.deploymentModes), classification.deploymentDifficulty, JSON.stringify(classification.hotReasonTags), classification.maturity, JSON.stringify(classification.costTags), classification.license, JSON.stringify(classification.commercialUseTags), JSON.stringify(classification.privacyTags), classification.confidence, classification.reason, classification.source, classification.sourceHash, now, item.repo.id);
      if (enrichment) updateSummary.run(enrichment.summary, now, hotSummarySourceHash(item.repo), enrichment.summarySource, enrichment.model, item.repo.id);
      snapshot.run(snapshotDate, index + 1, item.repo.id, item.total, oldRank.has(Number(item.repo.id)) ? oldRank.get(Number(item.repo.id))! - index - 1 : null, String(generatedClassification?.primaryCategory ?? item.repo.primary_category ?? classification.primaryCategory), VERSION, now);
    });
  }); save(); return { snapshotDate, count: scored.length, summariesGenerated: enrichments.filter(Boolean).length };
}
