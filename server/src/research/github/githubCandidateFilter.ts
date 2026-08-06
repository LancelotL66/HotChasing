import type { ResearchState } from '../state/researchStateSchema.js';
import type { GithubSearchRepo } from './githubResearchClient.js';

/**
 * 候选去重与基础规则过滤。
 *
 * 去重顺序：node_id → full_name → canonical URL → fork parent → 明显镜像。
 * 过滤原则：只排除与硬约束冲突或明显无价值的仓库；不能只根据 Stars 删除项目。
 */

export interface RawCandidate {
  repo: GithubSearchRepo;
  stageId: string;
  sourceQuery: string;
}

export interface DedupedCandidate {
  repo: GithubSearchRepo;
  stageIds: string[];
  sourceQueries: string[];
}

export interface FilterOutcome {
  kept: DedupedCandidate[];
  excluded: Array<{ fullName: string; reason: string }>;
}

function canonicalUrl(repo: GithubSearchRepo): string {
  return repo.htmlUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
}

export function deduplicateCandidates(raw: RawCandidate[]): DedupedCandidate[] {
  const byNodeId = new Map<string, DedupedCandidate>();
  const seenFullName = new Map<string, string>();
  const seenCanonical = new Map<string, string>();
  const seenParent = new Map<string, string>();

  for (const item of raw) {
    const { repo } = item;
    const existingKey =
      (byNodeId.has(repo.nodeId) ? repo.nodeId : undefined)
      ?? seenFullName.get(repo.fullName.toLowerCase())
      ?? seenCanonical.get(canonicalUrl(repo))
      ?? (repo.isFork && repo.parentFullName ? seenFullName.get(repo.parentFullName.toLowerCase()) : undefined)
      ?? (repo.parentFullName ? seenParent.get(repo.parentFullName.toLowerCase()) : undefined);

    if (existingKey && byNodeId.has(existingKey)) {
      const existing = byNodeId.get(existingKey) as DedupedCandidate;
      if (!existing.stageIds.includes(item.stageId)) existing.stageIds.push(item.stageId);
      if (!existing.sourceQueries.includes(item.sourceQuery)) existing.sourceQueries.push(item.sourceQuery);
      // Fork 折叠：同一族保留 Star 更高的作为代表。
      if (repo.stars > existing.repo.stars && !repo.isFork) existing.repo = repo;
      continue;
    }

    byNodeId.set(repo.nodeId, { repo, stageIds: [item.stageId], sourceQueries: [item.sourceQuery] });
    seenFullName.set(repo.fullName.toLowerCase(), repo.nodeId);
    seenCanonical.set(canonicalUrl(repo), repo.nodeId);
    if (repo.parentFullName) seenParent.set(repo.parentFullName.toLowerCase(), repo.nodeId);
  }

  return [...byNodeId.values()];
}

const MIRROR_PATTERN = /\b(mirror|mirrors|readonly mirror|镜像)\b/i;
const COURSEWORK_PATTERN = /\b(homework|assignment|coursework|课程作业|大作业|实验报告|my solutions|leetcode solutions)\b/i;
const DEMO_PATTERN = /\b(my first|personal demo|toy example|练手|学习笔记|test repo|hello world)\b/i;

export function applyRuleFilters(candidates: DedupedCandidate[], state: ResearchState): FilterOutcome {
  const kept: DedupedCandidate[] = [];
  const excluded: Array<{ fullName: string; reason: string }> = [];
  const languages = state.requirements.languages.map((language) => language.toLowerCase());

  for (const candidate of candidates) {
    const { repo } = candidate;
    const text = `${repo.name} ${repo.description ?? ''} ${repo.topics.join(' ')}`;
    if (repo.archived) { excluded.push({ fullName: repo.fullName, reason: '仓库已归档' }); continue; }
    if (repo.disabled) { excluded.push({ fullName: repo.fullName, reason: '仓库已禁用' }); continue; }
    if (!repo.description && repo.topics.length === 0 && repo.stars === 0) {
      excluded.push({ fullName: repo.fullName, reason: '缺少 Description 与 Topics，信息不足' });
      continue;
    }
    if (MIRROR_PATTERN.test(text)) { excluded.push({ fullName: repo.fullName, reason: '明显是镜像仓库' }); continue; }
    if (COURSEWORK_PATTERN.test(text)) { excluded.push({ fullName: repo.fullName, reason: '明显是课程作业仓库' }); continue; }
    if (DEMO_PATTERN.test(text)) { excluded.push({ fullName: repo.fullName, reason: '明显是个人练习或 Demo' }); continue; }
    if (languages.length > 0 && repo.primaryLanguage && !languages.includes(repo.primaryLanguage.toLowerCase())) {
      // 语言是硬约束时排除；这里只在用户显式声明语言后生效。
      excluded.push({ fullName: repo.fullName, reason: `主语言 ${repo.primaryLanguage} 不在语言约束内` });
      continue;
    }
    if (state.requirements.licenseRequired && !repo.licenseSpdx) {
      excluded.push({ fullName: repo.fullName, reason: '未声明开源许可证' });
      continue;
    }
    kept.push(candidate);
  }

  return { kept, excluded };
}
