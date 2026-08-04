import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { requireProject, setProjectStatus } from './forkLabService.js';

function getGithubToken(): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('github_token') as { value?: string } | undefined;
  if (!row?.value) {
    const error = new Error('GitHub token not configured');
    (error as Error & { code?: string }).code = 'GITHUB_TOKEN_NOT_CONFIGURED';
    throw error;
  }
  try {
    return decrypt(row.value, config.encryptionKey);
  } catch {
    const error = new Error('Failed to decrypt GitHub token');
    (error as Error & { code?: string }).code = 'GITHUB_TOKEN_DECRYPT_FAILED';
    throw error;
  }
}

async function githubRequest(path: string, init: RequestInit = {}): Promise<{ status: number; data: unknown }> {
  const token = getGithubToken();
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'HotChasing-Backend',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

function extractRepoInfo(repo: Record<string, unknown> | null): { forkFullName: string; defaultBranch: string | null } {
  const fullName = typeof repo?.full_name === 'string' ? repo.full_name : '';
  const defaultBranch = typeof repo?.default_branch === 'string' ? repo.default_branch : null;
  return { forkFullName: fullName, defaultBranch };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function createFork(projectId: string): Promise<Record<string, unknown>> {
  const project = requireProject(projectId);
  const db = getDb();
  if (project.fork_status === 'READY' && project.fork_full_name) {
    return { project: project, created: false };
  }
  const tokenOwner = await currentGithubLogin();
  const upstream = project.upstream_full_name;
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstream)) {
    const error = new Error('Invalid upstream repository name');
    (error as Error & { code?: string }).code = 'INVALID_UPSTREAM';
    throw error;
  }
  setProjectStatus(project.id, 'FORK_CREATING');
  db.prepare("UPDATE fork_workspace_projects SET fork_status='CREATING' WHERE id=?").run(project.id);

  const forkResult = await githubRequest(`/repos/${upstream}/forks`, { method: 'POST', body: JSON.stringify({}) });
  if (forkResult.status >= 300) {
    db.prepare("UPDATE fork_workspace_projects SET fork_status='FAILED' WHERE id=?").run(project.id);
    setProjectStatus(project.id, 'FAILED');
    const error = new Error(`GitHub fork request failed (${forkResult.status})`);
    (error as Error & { code?: string }).code = 'FORK_CREATE_FAILED';
    throw error;
  }
  const forkRepo = forkResult.data as Record<string, unknown> | null;
  const { forkFullName, defaultBranch } = extractRepoInfo(forkRepo);

  // Poll until the fork is fully ready.
  let ready = false;
  let commitSha: string | null = null;
  for (let attempt = 0; attempt < 30 && !ready; attempt += 1) {
    await sleep(3000);
    const check = await githubRequest(`/repos/${forkFullName || `${tokenOwner}/${upstream.split('/')[1]}`}`);
    const body = check.data as Record<string, unknown> | null;
    const inProgress = check.status === 202 || body?.status === 'in_progress';
    if (!inProgress && body && body.fork) {
      ready = true;
      const info = extractRepoInfo(body);
      if (!forkFullName && info.forkFullName) { /* keep original */ }
    }
  }
  if (!ready) {
    db.prepare("UPDATE fork_workspace_projects SET fork_status='FAILED' WHERE id=?").run(project.id);
    setProjectStatus(project.id, 'FAILED');
    const error = new Error('GitHub fork did not become ready in time');
    (error as Error & { code?: string }).code = 'FORK_TIMEOUT';
    throw error;
  }
  const actualFork = forkFullName || `${tokenOwner}/${upstream.split('/')[1]}`;
  const branch = defaultBranch || 'main';
  const head = await githubRequest(`/repos/${upstream}/commits/${branch}`);
  const headData = head.data as Record<string, unknown> | null;
  commitSha = typeof headData?.sha === 'string' ? headData.sha : null;

  const testBranch = `hotchasing/test/${project.id.slice(0, 8)}`;
  db.prepare(`UPDATE fork_workspace_projects SET fork_status='READY', fork_full_name=?, upstream_commit_sha=?, test_branch=?, forked_at=?, project_status='FORK_READY' WHERE id=?`)
    .run(actualFork, commitSha, testBranch, new Date().toISOString(), project.id);
  const updated = requireProject(projectId);
  logger.info('fork-lab.fork', `Fork ready for ${upstream} -> ${actualFork} @ ${commitSha}`);
  return { project: updated, created: true };
}

export async function getForkStatus(projectId: string): Promise<Record<string, unknown>> {
  const project = requireProject(projectId);
  return { project, status: project.fork_status };
}

export async function syncUpstream(projectId: string): Promise<Record<string, unknown>> {
  const project = requireProject(projectId);
  if (project.fork_status !== 'READY' || !project.fork_full_name) {
    const error = new Error('Fork is not ready; cannot sync upstream');
    (error as Error & { code?: string }).code = 'FORK_NOT_READY';
    throw error;
  }
  const db = getDb();
  const upstream = project.upstream_full_name;
  const upstreamBranch = (await getForkInfo(project.fork_full_name)).default_branch ?? 'main';
  const result = await githubRequest(`/repos/${project.fork_full_name}/merge-upstream`, {
    method: 'POST',
    body: JSON.stringify({ branch: upstreamBranch }),
  });
  if (result.status >= 300 && result.status !== 409) {
    const error = new Error(`Upstream sync failed (${result.status})`);
    (error as Error & { code?: string }).code = 'SYNC_FAILED';
    throw error;
  }
  const head = await githubRequest(`/repos/${upstream}/commits/${upstreamBranch}`);
  const headData = head.data as Record<string, unknown> | null;
  if (typeof headData?.sha === 'string') {
    db.prepare('UPDATE fork_workspace_projects SET upstream_commit_sha=? WHERE id=?').run(headData.sha, project.id);
  }
  return { project: requireProject(projectId), synced: true };
}

async function getForkInfo(forkFullName: string): Promise<{ default_branch: string | null }> {
  const result = await githubRequest(`/repos/${forkFullName}`);
  const data = result.data as Record<string, unknown> | null;
  return { default_branch: typeof data?.default_branch === 'string' ? data.default_branch : null };
}

export async function currentGithubLogin(): Promise<string> {
  const result = await githubRequest('/user');
  const data = result.data as Record<string, unknown> | null;
  if (typeof data?.login === 'string') return data.login;
  return 'unknown';
}
