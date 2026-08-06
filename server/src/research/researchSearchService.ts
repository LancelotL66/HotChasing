import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { logger } from '../services/logger.js';
import { researchStateSchema, type ResearchState } from './state/researchStateSchema.js';
import { requireCurrentState, saveNewVersion } from './state/researchStateService.js';
import { buildSearchStrategy, type SearchStrategy } from './github/githubQueryGenerator.js';
import {
  getCachedRepository,
  searchRepositories,
  upsertRepositoryCache,
  rateLimitResetAt,
  type GithubSearchRepo,
} from './github/githubResearchClient.js';
import { applyRuleFilters, deduplicateCandidates, type RawCandidate } from './github/githubCandidateFilter.js';
import { enrichRepository, getAnalysisCache, saveStructuredAnalysis } from './github/githubRepositoryEnricher.js';
import { analyzeTool, TOOL_ANALYSIS_VERSION } from './analysis/researchToolAnalyzer.js';
import { assignTiers, scoreCandidate, type ScoredCandidate } from './analysis/researchRecommendationService.js';
import { toolAnalysisSchema, type ToolAnalysis } from './state/researchStateSchema.js';
import { setTopicStatus } from './topicService.js';

/**
 * GitHub 全局动态搜索编排。
 *
 * 关键约束：
 * - 只根据当前 Research State 生成查询，不使用日报候选、Top100 候选或热点排名；
 * - 限流或请求失败时保留已完成结果，把搜索标记为 PARTIAL / RATE_LIMITED；
 * - 不对全部候选做 AI 分析：先规则过滤，再补充前 N 个仓库内容，最后分析前 M 个。
 */

export interface SearchRunRow {
  id: string;
  topic_id: string;
  requirement_version: number;
  status: string;
  scope: string;
  stage_id: string | null;
  search_strategy_json: string;
  query_count: number;
  raw_result_count: number;
  unique_result_count: number;
  analyzed_result_count: number;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface CandidateRow {
  id: string;
  topic_id: string;
  research_state_version: number;
  search_run_id: string | null;
  github_node_id: string;
  full_name: string;
  stage_id: string | null;
  match_level: string | null;
  match_score: number | null;
  tier: string | null;
  source_query: string | null;
  ai_explanation_json: string | null;
  filter_reason: string | null;
  selection_status: string;
  created_at: string;
}

export interface CandidateView extends CandidateRow {
  repo: {
    fullName: string;
    htmlUrl: string;
    description: string | null;
    primaryLanguage: string | null;
    topics: string[];
    licenseSpdx: string | null;
    stars: number;
    forks: number;
    pushedAt: string | null;
    archived: boolean;
  } | null;
  analysis: ToolAnalysis | null;
}

function codedError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function createRun(state: ResearchState, strategy: SearchStrategy, stageId?: string): string {
  const id = `run-${randomUUID().slice(0, 8)}`;
  getDb()
    .prepare(
      `INSERT INTO research_github_search_runs
        (id, topic_id, requirement_version, status, scope, stage_id, search_strategy_json, query_count, raw_result_count, unique_result_count, analyzed_result_count, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      state.topicId,
      state.version,
      'RUNNING',
      strategy.scope,
      stageId ?? null,
      JSON.stringify(strategy),
      strategy.plans.reduce((total, plan) => total + plan.queries.length, 0),
      0,
      0,
      0,
      new Date().toISOString(),
    );
  return id;
}

function recordQuery(runId: string, stageId: string, query: string, purpose: string, status: string, resultCount: number, errorMessage?: string): void {
  getDb()
    .prepare('INSERT INTO research_github_search_queries (id, search_run_id, stage_id, query, purpose, status, result_count, error_message) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), runId, stageId, query, purpose, status, resultCount, errorMessage ?? null);
}

function finishRun(runId: string, status: string, counts: { raw: number; unique: number; analyzed: number }, errorMessage?: string): void {
  getDb()
    .prepare('UPDATE research_github_search_runs SET status=?, raw_result_count=?, unique_result_count=?, analyzed_result_count=?, error_message=?, finished_at=? WHERE id=?')
    .run(status, counts.raw, counts.unique, counts.analyzed, errorMessage ?? null, new Date().toISOString(), runId);
}

function repoFromCache(nodeId: string): GithubSearchRepo | null {
  const row = getCachedRepository(nodeId);
  if (!row) return null;
  let topics: string[] = [];
  try {
    const parsed = JSON.parse(row.topics_json ?? '[]');
    topics = Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    topics = [];
  }
  return {
    nodeId: row.github_node_id,
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    htmlUrl: row.html_url,
    description: row.description,
    defaultBranch: row.default_branch,
    primaryLanguage: row.primary_language,
    topics,
    licenseSpdx: row.license_spdx,
    stars: Number(row.stars ?? 0),
    forks: Number(row.forks ?? 0),
    openIssues: Number(row.open_issues ?? 0),
    archived: row.archived === 1,
    disabled: row.disabled === 1,
    isFork: row.is_fork === 1,
    parentFullName: row.parent_full_name,
    pushedAt: row.pushed_at,
    updatedAt: row.github_updated_at,
  };
}

function persistCandidate(topicId: string, stateVersion: number, runId: string, scored: ScoredCandidate, sourceQuery: string, analysis: ToolAnalysis | null): void {
  const db = getDb();
  const existing = db
    .prepare('SELECT id, selection_status FROM research_tool_candidates WHERE topic_id=? AND github_node_id=?')
    .get(topicId, scored.repo.nodeId) as { id?: string; selection_status?: string } | undefined;
  const selectionStatus = existing?.selection_status && existing.selection_status !== 'CANDIDATE' ? existing.selection_status : 'CANDIDATE';
  if (existing?.id) {
    db.prepare(
      `UPDATE research_tool_candidates SET research_state_version=?, search_run_id=?, stage_id=?, match_level=?, match_score=?, tier=?, source_query=?, ai_explanation_json=COALESCE(?, ai_explanation_json), filter_reason=?, selection_status=? WHERE id=?`,
    ).run(
      stateVersion, runId, scored.stageId, scored.matchLevel, scored.score, scored.tier, sourceQuery,
      analysis ? JSON.stringify(analysis) : null, scored.blocked ? scored.reasons.join('；') : null, selectionStatus, existing.id,
    );
    return;
  }
  db.prepare(
    `INSERT INTO research_tool_candidates
      (id, topic_id, research_state_version, search_run_id, github_node_id, full_name, stage_id, match_level, match_score, tier, source_query, ai_explanation_json, filter_reason, selection_status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    randomUUID(), topicId, stateVersion, runId, scored.repo.nodeId, scored.repo.fullName, scored.stageId,
    scored.matchLevel, scored.score, scored.tier, sourceQuery, analysis ? JSON.stringify(analysis) : null,
    scored.blocked ? scored.reasons.join('；') : null, 'CANDIDATE', new Date().toISOString(),
  );
}

export interface SearchOutcome {
  runId: string;
  status: string;
  queryCount: number;
  rawCount: number;
  uniqueCount: number;
  analyzedCount: number;
  excludedCount: number;
  rateLimitResetAt: string | null;
}

/**
 * 执行一次搜索。stageId 存在时只做局部搜索（新增或修改单个研究环节的场景）。
 */
export async function runSearch(topicId: string, stageId?: string): Promise<SearchOutcome> {
  const state = requireCurrentState(topicId);
  if (state.stages.length === 0) throw codedError('NO_RESEARCH_STAGE', '当前没有研究环节，无法搜索');
  if (stageId && !state.stages.some((stage) => stage.id === stageId)) {
    throw codedError('RESEARCH_STAGE_NOT_FOUND', `研究环节 ${stageId} 不存在`);
  }
  const strategy = buildSearchStrategy(state, stageId);
  const runId = createRun(state, strategy, stageId);
  setTopicStatus(topicId, 'SEARCHING');

  const raw: RawCandidate[] = [];
  let rateLimited = false;
  let failedQueries = 0;

  for (const plan of strategy.plans) {
    for (const generated of plan.queries) {
      if (rateLimited) {
        recordQuery(runId, plan.stageId, generated.query, generated.purpose, 'SKIPPED', 0, '已触发限流，跳过剩余查询');
        continue;
      }
      const result = await searchRepositories(generated.query, { perPage: 30 });
      if (result.status === 'RATE_LIMITED') {
        rateLimited = true;
        recordQuery(runId, plan.stageId, generated.query, generated.purpose, 'RATE_LIMITED', 0, result.errorMessage);
        continue;
      }
      if (result.status === 'FAILED') {
        failedQueries += 1;
        recordQuery(runId, plan.stageId, generated.query, generated.purpose, 'FAILED', 0, result.errorMessage);
        continue;
      }
      recordQuery(runId, plan.stageId, generated.query, generated.purpose, 'COMPLETED', result.repos.length);
      for (const repo of result.repos) raw.push({ repo, stageId: plan.stageId, sourceQuery: generated.query });
    }
  }

  const deduped = deduplicateCandidates(raw);
  const { kept, excluded } = applyRuleFilters(deduped, state);
  const limited = kept.slice(0, strategy.maxUniqueCandidates);

  for (const candidate of limited) {
    try {
      upsertRepositoryCache(candidate.repo);
    } catch (error) {
      logger.errorFromError('research.search', '写入仓库缓存失败', error, { fullName: candidate.repo.fullName });
    }
  }

  // 先用元数据打分，决定补充与深度分析的顺序。
  const preliminary = limited
    .map((candidate) => ({
      candidate,
      scored: scoreCandidate({ repo: candidate.repo, analysis: null, stageIds: candidate.stageIds, hasReadme: false }, state),
    }))
    .sort((a, b) => b.scored.score - a.scored.score);

  const analyses = new Map<string, ToolAnalysis>();
  let analyzedCount = 0;
  for (const [index, item] of preliminary.entries()) {
    if (index >= strategy.enrichLimit) break;
    const enrichment = await enrichRepository(item.candidate.repo.nodeId, item.candidate.repo.fullName, item.candidate.repo.pushedAt);
    if (index >= strategy.analyzeLimit) continue;
    const cached = getAnalysisCache(item.candidate.repo.nodeId);
    if (cached?.structured_analysis_json && cached.analysis_version === TOOL_ANALYSIS_VERSION && cached.readme_hash === enrichment.readmeHash) {
      const parsed = toolAnalysisSchema.safeParse(JSON.parse(cached.structured_analysis_json));
      if (parsed.success) {
        analyses.set(item.candidate.repo.nodeId, parsed.data);
        analyzedCount += 1;
        continue;
      }
    }
    const result = await analyzeTool(item.candidate.repo, enrichment, state, item.candidate.stageIds);
    analyses.set(item.candidate.repo.nodeId, result.analysis);
    analyzedCount += 1;
    try {
      saveStructuredAnalysis(item.candidate.repo.nodeId, JSON.stringify(result.analysis), result.model, TOOL_ANALYSIS_VERSION);
    } catch (error) {
      logger.errorFromError('research.search', '写入结构化分析失败', error, { fullName: item.candidate.repo.fullName });
    }
  }

  const scored = limited.map((candidate) => {
    const analysis = analyses.get(candidate.repo.nodeId) ?? null;
    const stageIds = analysis && analysis.stageIds.length > 0 ? analysis.stageIds : candidate.stageIds;
    const hasReadme = Boolean(getAnalysisCache(candidate.repo.nodeId)?.readme_text);
    return {
      candidate,
      analysis,
      scored: scoreCandidate({ repo: candidate.repo, analysis, stageIds, hasReadme }, state),
    };
  });
  const tiered = assignTiers(scored.map((item) => item.scored));
  const tierByNodeId = new Map(tiered.map((item) => [item.repo.nodeId, item]));

  for (const item of scored) {
    const finalScored = tierByNodeId.get(item.candidate.repo.nodeId) ?? item.scored;
    persistCandidate(topicId, state.version, runId, finalScored, item.candidate.sourceQueries[0] ?? '', item.analysis);
  }

  // 更新研究环节的搜索状态与候选数量（写入新的状态版本，保持单一事实来源）。
  const countByStage = new Map<string, number>();
  for (const item of tiered) {
    if (!item.stageId) continue;
    countByStage.set(item.stageId, (countByStage.get(item.stageId) ?? 0) + 1);
  }
  const searchStatus = rateLimited ? 'RATE_LIMITED' : failedQueries > 0 ? 'PARTIAL' : 'COMPLETED';
  const nextState = researchStateSchema.parse({
    ...state,
    stages: state.stages.map((stage) => {
      if (stageId && stage.id !== stageId) return stage;
      const count = countByStage.get(stage.id) ?? 0;
      return { ...stage, candidateCount: count, searchStatus: count > 0 ? searchStatus : stage.searchStatus === 'NOT_STARTED' ? searchStatus : stage.searchStatus };
    }),
    consistencyStatus: 'NEEDS_RESEARCH_UPDATE',
  });
  saveNewVersion(topicId, nextState, {
    changeSummary: stageId ? `局部搜索：${stageId}` : 'GitHub 全局搜索完成',
    createdBy: 'SYSTEM_DEFAULT',
  });

  const runStatus = rateLimited ? 'RATE_LIMITED' : failedQueries > 0 && tiered.length === 0 ? 'FAILED' : failedQueries > 0 ? 'PARTIAL' : 'COMPLETED';
  finishRun(runId, runStatus, { raw: raw.length, unique: kept.length, analyzed: analyzedCount }, rateLimited ? 'GitHub 搜索速率受限，已保留部分结果' : undefined);
  setTopicStatus(topicId, 'REVIEWING_TOOLS');

  return {
    runId,
    status: runStatus,
    queryCount: strategy.plans.reduce((total, plan) => total + plan.queries.length, 0),
    rawCount: raw.length,
    uniqueCount: kept.length,
    analyzedCount,
    excludedCount: excluded.length,
    rateLimitResetAt: rateLimitResetAt(),
  };
}

export function listSearchRuns(topicId: string): SearchRunRow[] {
  return getDb().prepare('SELECT * FROM research_github_search_runs WHERE topic_id=? ORDER BY created_at DESC').all(topicId) as SearchRunRow[];
}

export function getSearchRun(runId: string): (SearchRunRow & { queries: Array<Record<string, unknown>> }) | null {
  const run = getDb().prepare('SELECT * FROM research_github_search_runs WHERE id=?').get(runId) as SearchRunRow | undefined;
  if (!run) return null;
  const queries = getDb().prepare('SELECT * FROM research_github_search_queries WHERE search_run_id=?').all(runId) as Array<Record<string, unknown>>;
  return { ...run, queries };
}

export interface CandidateFilters {
  stageId?: string;
  tier?: string;
  language?: string;
  productForm?: string;
  localOnly?: boolean;
  dockerOnly?: boolean;
  excludeGpu?: boolean;
  excludeCredentials?: boolean;
  maintenance?: string;
  license?: string;
  limit?: number;
}

function toCandidateView(row: CandidateRow): CandidateView {
  const repo = repoFromCache(row.github_node_id);
  let analysis: ToolAnalysis | null = null;
  if (row.ai_explanation_json) {
    try {
      const parsed = toolAnalysisSchema.safeParse(JSON.parse(row.ai_explanation_json));
      analysis = parsed.success ? parsed.data : null;
    } catch {
      analysis = null;
    }
  }
  return {
    ...row,
    repo: repo
      ? {
        fullName: repo.fullName,
        htmlUrl: repo.htmlUrl,
        description: repo.description,
        primaryLanguage: repo.primaryLanguage,
        topics: repo.topics,
        licenseSpdx: repo.licenseSpdx,
        stars: repo.stars,
        forks: repo.forks,
        pushedAt: repo.pushedAt,
        archived: repo.archived,
      }
      : null,
    analysis,
  };
}

export function listCandidates(topicId: string, filters: CandidateFilters = {}): CandidateView[] {
  const rows = getDb()
    .prepare('SELECT * FROM research_tool_candidates WHERE topic_id=? ORDER BY match_score DESC')
    .all(topicId) as CandidateRow[];
  let views = rows.map(toCandidateView);
  if (filters.stageId) views = views.filter((view) => view.stage_id === filters.stageId);
  if (filters.tier) views = views.filter((view) => view.tier === filters.tier);
  if (filters.language) views = views.filter((view) => view.repo?.primaryLanguage?.toLowerCase() === filters.language?.toLowerCase());
  if (filters.license) views = views.filter((view) => (view.repo?.licenseSpdx ?? '').toLowerCase() === filters.license?.toLowerCase());
  if (filters.productForm) views = views.filter((view) => view.analysis?.productForm.includes(filters.productForm as never));
  if (filters.localOnly) views = views.filter((view) => view.analysis?.deployment.localSupported !== false);
  if (filters.dockerOnly) views = views.filter((view) => view.analysis?.deployment.dockerAvailable === true);
  if (filters.excludeGpu) views = views.filter((view) => view.analysis?.deployment.gpuRequired !== true);
  if (filters.excludeCredentials) views = views.filter((view) => view.analysis?.deployment.credentialsRequired !== true);
  if (filters.maintenance) views = views.filter((view) => view.analysis?.maintenance.status === filters.maintenance);
  return typeof filters.limit === 'number' ? views.slice(0, filters.limit) : views;
}

/** 对单个候选做深度分析（用户点击"查看完整 AI 分析"时触发）。 */
export async function analyzeCandidate(topicId: string, githubNodeId: string): Promise<CandidateView> {
  const state = requireCurrentState(topicId);
  const row = getDb()
    .prepare('SELECT * FROM research_tool_candidates WHERE topic_id=? AND github_node_id=?')
    .get(topicId, githubNodeId) as CandidateRow | undefined;
  if (!row) throw codedError('RESEARCH_CANDIDATE_NOT_FOUND', '候选工具不存在');
  const repo = repoFromCache(githubNodeId);
  if (!repo) throw codedError('RESEARCH_REPOSITORY_NOT_CACHED', '仓库元数据缺失，请重新搜索');
  const enrichment = await enrichRepository(repo.nodeId, repo.fullName, repo.pushedAt);
  const result = await analyzeTool(repo, enrichment, state, row.stage_id ? [row.stage_id] : []);
  const scored = scoreCandidate(
    { repo, analysis: result.analysis, stageIds: result.analysis.stageIds.length > 0 ? result.analysis.stageIds : row.stage_id ? [row.stage_id] : [], hasReadme: Boolean(enrichment.readmeText) },
    state,
  );
  getDb()
    .prepare('UPDATE research_tool_candidates SET ai_explanation_json=?, stage_id=?, match_level=?, match_score=?, filter_reason=? WHERE id=?')
    .run(JSON.stringify(result.analysis), scored.stageId, scored.matchLevel, scored.score, scored.blocked ? scored.reasons.join('；') : null, row.id);
  try {
    saveStructuredAnalysis(repo.nodeId, JSON.stringify(result.analysis), result.model, TOOL_ANALYSIS_VERSION);
  } catch {
    // 缓存写入失败不影响本次结果
  }
  const updated = getDb().prepare('SELECT * FROM research_tool_candidates WHERE id=?').get(row.id) as CandidateRow;
  return toCandidateView(updated);
}
