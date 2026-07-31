import { getDb } from '../db/connection.js';
import { classificationSourceHash, classifyProjectByRules, fetchRepositoryArchitecture, fetchRepositoryReadme } from '../discovery/classificationService.js';
import { generateProjectClassification } from '../discovery/aiGateway.js';

const VERSION = 'github-hot-v2';
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value * 100) / 100));
export async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await mapper(values[index]); }
  }));
  return results;
}

export async function generateTop100(snapshotDate = new Date().toISOString().slice(0, 10)) {
  const db = getDb(); const now = new Date().toISOString(); const activeSince = Date.now() - 365 * 86400000;
  const candidates = db.prepare(`SELECT DISTINCT r.* FROM repositories r JOIN metric_snapshots s ON s.repo_id=r.id
    WHERE s.source_channel='top100_candidates' AND r.updated_at >= ?
    `).all(new Date(activeSince).toISOString()) as Array<Record<string, unknown>>;
  const classifications = await mapWithConcurrency(candidates, 4, async (repo) => {
    const [readme, architecture] = await Promise.all([fetchRepositoryReadme(String(repo.full_name ?? '')), fetchRepositoryArchitecture(String(repo.full_name ?? ''))]);
    const sourceHash = classificationSourceHash(repo, readme, architecture);
    if (repo.classification_source_hash === sourceHash && repo.primary_category) {
      return { repo, classification: null };
    }
    const fallback = classifyProjectByRules(repo);
    return { repo, classification: await generateProjectClassification(repo, readme, architecture, fallback) };
  });
  const classificationFor = (repo: Record<string, unknown>) => classifications.find((item) => item.repo.id === repo.id)?.classification;
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
    const classification = classificationFor(repo) ?? fallbackClassification;
    return { repo, classification, primaryCategory: String(classification.primaryCategory ?? repo.primary_category ?? fallbackClassification.primaryCategory), adoption, longevity, ecosystem, community, engineering, currentHot, risk, classic, total, confidence };
  }).filter((item) => item.total >= 60 && item.confidence >= .6).sort((a, b) => b.total - a.total || b.adoption - a.adoption).slice(0, 100);
  const previous = db.prepare('SELECT repo_id,rank FROM classic_top100_snapshots WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM classic_top100_snapshots WHERE snapshot_date < ?)').all(snapshotDate) as Array<{ repo_id: number; rank: number }>;
  const oldRank = new Map(previous.map((item) => [item.repo_id, item.rank]));
  const save = db.transaction(() => {
    db.prepare('DELETE FROM classic_top100_snapshots WHERE snapshot_date=?').run(snapshotDate);
    const score = db.prepare('INSERT OR REPLACE INTO classic_project_scores VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const snapshot = db.prepare('INSERT INTO classic_top100_snapshots VALUES (?,?,?,?,?,?,?,?)');
    const updateClassification = db.prepare('UPDATE repositories SET primary_category=?,secondary_categories=?,function_tags=?,product_forms=?,platform_tags=?,target_users=?,deployment_modes=?,deployment_difficulty=?,hot_reason_tags=?,maturity_tag=?,cost_tags=?,license_tag=?,commercial_use_tags=?,privacy_tags=?,classification_confidence=?,classification_reason=?,classification_source=?,classification_source_hash=?,classified_at=? WHERE id=?');
    scored.forEach((item, index) => {
      const details = { adoption: item.adoption, longevity: item.longevity, ecosystem: item.ecosystem, community: item.community, engineering: item.engineering, currentHot: item.currentHot, dataCoverage: item.confidence };
      score.run(item.repo.id, item.adoption, item.longevity, item.ecosystem, item.community, item.engineering, item.currentHot, item.classic, item.currentHot, item.risk, item.total, item.confidence, JSON.stringify(details), JSON.stringify(item.risk ? ['License 信息不足'] : []), VERSION, now);
      if (item.classification && !item.repo.classification_locked) updateClassification.run(item.classification.primaryCategory, JSON.stringify(item.classification.secondaryCategories), JSON.stringify(item.classification.functionTags), JSON.stringify(item.classification.productForms), JSON.stringify(item.classification.platformTags), JSON.stringify(item.classification.targetUsers), JSON.stringify(item.classification.deploymentModes), item.classification.deploymentDifficulty, JSON.stringify(item.classification.hotReasonTags), item.classification.maturity, JSON.stringify(item.classification.costTags), item.classification.license, JSON.stringify(item.classification.commercialUseTags), JSON.stringify(item.classification.privacyTags), item.classification.confidence, item.classification.reason, item.classification.source, item.classification.sourceHash, now, item.repo.id);
      snapshot.run(snapshotDate, index + 1, item.repo.id, item.total, oldRank.has(Number(item.repo.id)) ? oldRank.get(Number(item.repo.id))! - index - 1 : null, item.primaryCategory, VERSION, now);
    });
  }); save(); return { snapshotDate, count: scored.length };
}
