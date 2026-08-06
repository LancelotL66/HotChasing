import { getDb } from '../db/connection.js';
import { generateHotSummary } from './aiGateway.js';
import { fetchRepositoryEnrichment, githubHeaders } from './classificationService.js';

export async function refreshRepositoryFromGitHub(repoId: number, refreshSummary = false): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const current = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId) as Record<string, unknown> | undefined;
  if (!current || !current.full_name) return current ?? null;
  try {
    const response = await fetch(`https://api.github.com/repos/${current.full_name}`, { headers: { Accept: 'application/vnd.github+json', ...githubHeaders() }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return current;
    const remote = await response.json() as Record<string, unknown>;
    const contentChanged = String(remote.pushed_at ?? '') !== String(current.pushed_at ?? '');
    const owner = remote.owner as Record<string, unknown> | undefined;
    db.prepare(`UPDATE repositories SET name=?,full_name=?,description=?,html_url=?,stargazers_count=?,forks_count=?,language=?,updated_at=?,pushed_at=?,owner_login=?,owner_avatar_url=?,topics=?,repository_checked_at=? WHERE id=?`)
      .run(remote.name ?? current.name, remote.full_name ?? current.full_name, remote.description ?? current.description, remote.html_url ?? current.html_url, remote.stargazers_count ?? current.stargazers_count, remote.forks_count ?? current.forks_count, remote.language ?? current.language, remote.updated_at ?? current.updated_at, remote.pushed_at ?? current.pushed_at, owner?.login ?? current.owner_login, owner?.avatar_url ?? current.owner_avatar_url, JSON.stringify(remote.topics ?? []), new Date().toISOString(), repoId);
    const refreshed = db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId) as Record<string, unknown>;
    if (contentChanged) {
      const enrichment = await fetchRepositoryEnrichment(refreshed);
      if (refreshSummary && enrichment.readmeChanged) {
        const summary = await generateHotSummary({ ...refreshed, enrichment_readme: enrichment.readme });
        db.prepare("UPDATE repositories SET hot_summary_zh=?,hot_summary_zh_generated_at=?,hot_summary_zh_status='generated',hot_summary_zh_source_hash=?,hot_summary_zh_source=?,hot_summary_zh_model=? WHERE id=?")
          .run(summary.summary, new Date().toISOString(), summary.sourceHash, summary.source, summary.model, repoId);
      }
    }
    return db.prepare('SELECT * FROM repositories WHERE id=?').get(repoId) as Record<string, unknown>;
  } catch {
    return current;
  }
}

export async function refreshDailyLibraryInBackground(limit = 24): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`SELECT DISTINCT r.id FROM repositories r JOIN daily_digest_items i ON i.repo_id=r.id JOIN daily_digests d ON d.id=i.digest_id WHERE d.status='generated' ORDER BY r.repository_checked_at IS NOT NULL, r.repository_checked_at ASC LIMIT ?`).all(limit) as Array<{ id: number }>;
  for (let index = 0; index < rows.length; index += 4) {
    await Promise.all(rows.slice(index, index + 4).map((row) => refreshRepositoryFromGitHub(row.id, true)));
  }
}
