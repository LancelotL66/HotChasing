import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { githubHeaders } from '../../discovery/classificationService.js';
import { logger } from '../../services/logger.js';

/**
 * 主题研究专用 GitHub 搜索客户端。
 *
 * 与现有实现的区别：
 * - 显式处理速率限制（403 + x-ratelimit-remaining:0 / 429 / secondary rate limit）；
 * - 查询结果写入独立缓存表，缓存键为 normalized_query + page + per_page；
 * - 命中限流时不抛错到用户，由上层把搜索标记为 PARTIAL / RATE_LIMITED 并保留已有结果。
 */

export interface GithubSearchRepo {
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string | null;
  primaryLanguage: string | null;
  topics: string[];
  licenseSpdx: string | null;
  stars: number;
  forks: number;
  openIssues: number;
  archived: boolean;
  disabled: boolean;
  isFork: boolean;
  parentFullName: string | null;
  pushedAt: string | null;
  updatedAt: string | null;
}

export interface GithubSearchResult {
  repos: GithubSearchRepo[];
  totalCount: number;
  status: 'OK' | 'RATE_LIMITED' | 'FAILED' | 'CACHED';
  errorMessage?: string;
  rateLimitResetAt?: string | null;
}

const QUERY_CACHE_TTL_MS = 1000 * 60 * 60 * 6;

export function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, ' ').trim().toLowerCase();
}

function cacheKey(query: string, page: number, perPage: number): string {
  return createHash('sha256').update(`${normalizeQuery(query)}|${page}|${perPage}`).digest('hex');
}

function mapRepo(raw: Record<string, unknown>): GithubSearchRepo | null {
  const fullName = typeof raw.full_name === 'string' ? raw.full_name : '';
  const nodeId = typeof raw.node_id === 'string' ? raw.node_id : '';
  if (!fullName || !nodeId) return null;
  const owner = (raw.owner ?? {}) as Record<string, unknown>;
  const license = (raw.license ?? null) as Record<string, unknown> | null;
  const parent = (raw.parent ?? null) as Record<string, unknown> | null;
  return {
    nodeId,
    owner: typeof owner.login === 'string' ? owner.login : fullName.split('/')[0],
    name: typeof raw.name === 'string' ? raw.name : fullName.split('/')[1] ?? '',
    fullName,
    htmlUrl: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${fullName}`,
    description: typeof raw.description === 'string' ? raw.description : null,
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch : null,
    primaryLanguage: typeof raw.language === 'string' ? raw.language : null,
    topics: Array.isArray(raw.topics) ? raw.topics.map((topic) => String(topic)).slice(0, 30) : [],
    licenseSpdx: license && typeof license.spdx_id === 'string' ? license.spdx_id : null,
    stars: Number(raw.stargazers_count) || 0,
    forks: Number(raw.forks_count) || 0,
    openIssues: Number(raw.open_issues_count) || 0,
    archived: Boolean(raw.archived),
    disabled: Boolean(raw.disabled),
    isFork: Boolean(raw.fork),
    parentFullName: parent && typeof parent.full_name === 'string' ? parent.full_name : null,
    pushedAt: typeof raw.pushed_at === 'string' ? raw.pushed_at : null,
    updatedAt: typeof raw.updated_at === 'string' ? raw.updated_at : null,
  };
}

function readCache(query: string, page: number, perPage: number): GithubSearchResult | null {
  try {
    const row = getDb()
      .prepare('SELECT result_json, fetched_at FROM research_github_query_cache WHERE cache_key=?')
      .get(cacheKey(query, page, perPage)) as { result_json?: string; fetched_at?: string } | undefined;
    if (!row?.result_json || !row.fetched_at) return null;
    if (Date.now() - Date.parse(row.fetched_at) > QUERY_CACHE_TTL_MS) return null;
    const parsed = JSON.parse(row.result_json) as { repos: GithubSearchRepo[]; totalCount: number };
    return { repos: parsed.repos, totalCount: parsed.totalCount, status: 'CACHED' };
  } catch {
    return null;
  }
}

function writeCache(query: string, page: number, perPage: number, result: { repos: GithubSearchRepo[]; totalCount: number }): void {
  try {
    getDb()
      .prepare('INSERT OR REPLACE INTO research_github_query_cache (cache_key, normalized_query, page, per_page, result_json, fetched_at) VALUES (?,?,?,?,?,?)')
      .run(cacheKey(query, page, perPage), normalizeQuery(query), page, perPage, JSON.stringify(result), new Date().toISOString());
  } catch (error) {
    logger.errorFromError('research.github-cache', '写入搜索缓存失败', error);
  }
}

let rateLimitedUntil = 0;

export function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}

export function rateLimitResetAt(): string | null {
  return rateLimitedUntil > Date.now() ? new Date(rateLimitedUntil).toISOString() : null;
}

/** 仅供测试重置模块内的限流状态。 */
export function resetRateLimitState(): void {
  rateLimitedUntil = 0;
}

export async function searchRepositories(query: string, options: { page?: number; perPage?: number; useCache?: boolean } = {}): Promise<GithubSearchResult> {
  const page = options.page ?? 1;
  const perPage = Math.min(100, options.perPage ?? 50);
  if (options.useCache !== false) {
    const cached = readCache(query, page, perPage);
    if (cached) return cached;
  }
  if (isRateLimited()) {
    return { repos: [], totalCount: 0, status: 'RATE_LIMITED', errorMessage: 'GitHub 搜索处于限流冷却中', rateLimitResetAt: rateLimitResetAt() };
  }
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=best-match`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...githubHeaders() },
      signal: AbortSignal.timeout(20000),
    });
    const remaining = response.headers.get('x-ratelimit-remaining');
    const reset = response.headers.get('x-ratelimit-reset');
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || (response.status === 403 && (remaining === '0' || retryAfter))) {
      const resetMs = reset ? Number(reset) * 1000 : Date.now() + (Number(retryAfter) || 60) * 1000;
      rateLimitedUntil = Number.isFinite(resetMs) ? resetMs : Date.now() + 60000;
      logger.warn('research.github-search', 'GitHub 搜索被限流，保留已有结果', { query: normalizeQuery(query), resetAt: rateLimitResetAt() });
      return { repos: [], totalCount: 0, status: 'RATE_LIMITED', errorMessage: 'GitHub 搜索速率受限', rateLimitResetAt: rateLimitResetAt() };
    }
    if (!response.ok) {
      return { repos: [], totalCount: 0, status: 'FAILED', errorMessage: `GitHub 返回 ${response.status}` };
    }
    const body = await response.json() as { total_count?: number; items?: Array<Record<string, unknown>> };
    const repos = (body.items ?? []).map(mapRepo).filter((repo): repo is GithubSearchRepo => repo !== null);
    const result = { repos, totalCount: Number(body.total_count) || repos.length };
    writeCache(query, page, perPage, result);
    return { ...result, status: 'OK' };
  } catch (error) {
    logger.errorFromError('research.github-search', 'GitHub 搜索请求失败', error, { query: normalizeQuery(query) });
    return { repos: [], totalCount: 0, status: 'FAILED', errorMessage: (error as Error).message };
  }
}

export function upsertRepositoryCache(repo: GithubSearchRepo): void {
  getDb()
    .prepare(
      `INSERT INTO github_repository_cache
        (github_node_id, owner, name, full_name, html_url, description, default_branch, primary_language, topics_json,
         license_spdx, stars, forks, open_issues, archived, disabled, is_fork, parent_full_name, pushed_at, github_updated_at, metadata_fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(github_node_id) DO UPDATE SET
         owner=excluded.owner, name=excluded.name, full_name=excluded.full_name, html_url=excluded.html_url,
         description=excluded.description, default_branch=excluded.default_branch, primary_language=excluded.primary_language,
         topics_json=excluded.topics_json, license_spdx=excluded.license_spdx, stars=excluded.stars, forks=excluded.forks,
         open_issues=excluded.open_issues, archived=excluded.archived, disabled=excluded.disabled, is_fork=excluded.is_fork,
         parent_full_name=excluded.parent_full_name, pushed_at=excluded.pushed_at, github_updated_at=excluded.github_updated_at,
         metadata_fetched_at=excluded.metadata_fetched_at`,
    )
    .run(
      repo.nodeId, repo.owner, repo.name, repo.fullName, repo.htmlUrl, repo.description, repo.defaultBranch,
      repo.primaryLanguage, JSON.stringify(repo.topics), repo.licenseSpdx, repo.stars, repo.forks, repo.openIssues,
      repo.archived ? 1 : 0, repo.disabled ? 1 : 0, repo.isFork ? 1 : 0, repo.parentFullName, repo.pushedAt,
      repo.updatedAt, new Date().toISOString(),
    );
}

export interface CachedRepositoryRow {
  github_node_id: string;
  owner: string;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string | null;
  primary_language: string | null;
  topics_json: string | null;
  license_spdx: string | null;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  archived: number;
  disabled: number;
  is_fork: number;
  parent_full_name: string | null;
  pushed_at: string | null;
  github_updated_at: string | null;
  metadata_fetched_at: string;
}

export function getCachedRepository(nodeId: string): CachedRepositoryRow | undefined {
  return getDb().prepare('SELECT * FROM github_repository_cache WHERE github_node_id=?').get(nodeId) as CachedRepositoryRow | undefined;
}
