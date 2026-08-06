import { MATCH_LEVELS, type CandidateTier, type MatchLevel, type ResearchState, type ToolAnalysis } from '../state/researchStateSchema.js';
import type { GithubSearchRepo } from '../github/githubResearchClient.js';

/**
 * 工具推荐排序：不使用热点分、趋势分或 Top100 排名。
 * Stars / Forks / 更新时间只作为辅助质量信号，权重明显低于需求相关性与约束匹配。
 */

export interface ScoredCandidate {
  repo: GithubSearchRepo;
  stageId: string | null;
  score: number;
  matchLevel: MatchLevel;
  tier: CandidateTier;
  reasons: string[];
  blocked: boolean;
}

interface ScoreInput {
  repo: GithubSearchRepo;
  analysis: ToolAnalysis | null;
  stageIds: string[];
  hasReadme: boolean;
}

const FEATURED_PER_STAGE = 8;
const MORE_PER_STAGE = 30;

function keywordRelevance(repo: GithubSearchRepo, state: ResearchState, stageId: string | null): number {
  const stage = stageId ? state.stages.find((item) => item.id === stageId) : undefined;
  const keywords = [
    ...(stage?.toolRequirements.keywords ?? []),
    ...state.requirements.domains,
  ].map((keyword) => keyword.toLowerCase()).filter((keyword) => keyword.length >= 3);
  if (keywords.length === 0) return 12;
  const haystack = `${repo.name} ${repo.description ?? ''} ${repo.topics.join(' ')}`.toLowerCase();
  const hits = keywords.filter((keyword) => haystack.includes(keyword)).length;
  return Math.min(25, Math.round((hits / keywords.length) * 25) + (hits > 0 ? 6 : 0));
}

export function scoreCandidate(input: ScoreInput, state: ResearchState): ScoredCandidate {
  const { repo, analysis, stageIds, hasReadme } = input;
  const stageId = stageIds[0] ?? analysis?.stageIds[0] ?? null;
  const reasons: string[] = [];
  let score = 0;
  let blocked = false;

  const relevance = keywordRelevance(repo, state, stageId);
  score += relevance;
  if (relevance >= 18) reasons.push('与当前研究需求关键词高度重合');

  // 研究环节覆盖
  if (stageId) { score += 12; reasons.push('可以归入一个明确的研究环节'); }
  if (stageIds.length > 1) score += 4;

  // 硬约束
  const requirements = state.requirements;
  if (requirements.languages.length > 0 && repo.primaryLanguage) {
    if (requirements.languages.some((language) => language.toLowerCase() === repo.primaryLanguage?.toLowerCase())) {
      score += 12;
      reasons.push(`主语言 ${repo.primaryLanguage} 符合语言约束`);
    } else {
      score -= 20;
      blocked = true;
      reasons.push(`主语言 ${repo.primaryLanguage} 不符合语言约束`);
    }
  }
  if (analysis) {
    if (!requirements.gpuAllowed && analysis.deployment.gpuRequired) { score -= 30; blocked = true; reasons.push('需要 GPU，违反当前限制'); }
    if (!requirements.paidApiAllowed && analysis.deployment.paidApiRequired) { score -= 30; blocked = true; reasons.push('依赖付费 API，违反当前限制'); }
    if (requirements.localDeploymentPreferred && analysis.deployment.localSupported) { score += 10; reasons.push('支持本地运行'); }
    if (requirements.localDeploymentPreferred && !analysis.deployment.localSupported) { score -= 12; reasons.push('不支持本地运行'); }
    if (analysis.deployment.dockerAvailable) { score += 4; reasons.push('提供容器化入口'); }
    if (analysis.deployment.credentialsRequired) { score -= 4; reasons.push('需要配置凭据'); }
    if (analysis.inputs.length > 0 && analysis.outputs.length > 0) { score += 8; reasons.push('输入输出明确，便于串联'); }
    if (analysis.replicationSuitability === 'HIGH') { score += 8; reasons.push('适合整体复刻'); }
    if (analysis.replicationSuitability === 'LOW') { score -= 6; }
    if (analysis.maintenance.status === 'ACTIVE') { score += 6; reasons.push('维护活跃'); }
    if (analysis.maintenance.status === 'STALE') { score -= 8; reasons.push('长期未更新'); }
    if (analysis.evidenceLevel === 'README_AND_REPOSITORY_ANALYSIS') score += 4;
  }
  if (requirements.excludedProductForms.length > 0 && analysis) {
    if (analysis.productForm.some((form) => requirements.excludedProductForms.includes(form))) {
      score -= 18;
      reasons.push('产品形态被当前条件排除');
    }
  }

  // 文档完整性
  if (hasReadme) { score += 6; reasons.push('提供 README 说明'); }
  else reasons.push('缺少 README，需要进一步确认');

  // 辅助质量信号（权重低）
  score += Math.min(6, Math.round(Math.log10(Math.max(1, repo.stars)) * 2));
  if (repo.licenseSpdx) score += 2;
  if (repo.pushedAt) {
    const days = (Date.now() - Date.parse(repo.pushedAt)) / (1000 * 60 * 60 * 24);
    if (Number.isFinite(days) && days <= 180) score += 3;
  }

  const matchLevel = deriveMatchLevel(score, blocked, hasReadme, Boolean(analysis));
  return { repo, stageId, score, matchLevel, tier: 'POOL', reasons: reasons.slice(0, 6), blocked };
}

function deriveMatchLevel(score: number, blocked: boolean, hasReadme: boolean, analyzed: boolean): MatchLevel {
  if (blocked) return '不符合当前限制';
  if (!hasReadme && !analyzed) return '需要进一步确认';
  if (score >= 60) return '高度匹配';
  if (score >= 45) return '较为匹配';
  if (score >= 32) return '专业候选';
  if (score >= 20) return '可选补充';
  return '需要进一步确认';
}

/** 分层：精选 / 更多候选 / 原始候选池。按研究环节分别计算，避免单一环节垄断精选位。 */
export function assignTiers(candidates: ScoredCandidate[]): ScoredCandidate[] {
  const byStage = new Map<string, ScoredCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.stageId ?? '__unassigned__';
    const list = byStage.get(key) ?? [];
    list.push(candidate);
    byStage.set(key, list);
  }
  const result: ScoredCandidate[] = [];
  for (const list of byStage.values()) {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    sorted.forEach((candidate, index) => {
      const tier: CandidateTier = candidate.blocked
        ? 'POOL'
        : index < FEATURED_PER_STAGE
          ? 'FEATURED'
          : index < MORE_PER_STAGE
            ? 'MORE'
            : 'POOL';
      result.push({ ...candidate, tier });
    });
  }
  return result.sort((a, b) => b.score - a.score);
}

export function isValidMatchLevel(value: string): value is MatchLevel {
  return (MATCH_LEVELS as readonly string[]).includes(value);
}
