import type { ResearchStage, ResearchState } from '../state/researchStateSchema.js';

/**
 * GithubResearchQueryGenerator：把 Research State 转成多条 GitHub 仓库搜索查询。
 *
 * 规则（来自方案第 10、11 节）：
 * - 每个研究环节 3～8 条查询，不要只生成一条超长查询；
 * - 查询包含功能关键词、英文同义词、Topics、语言、更新时间与排除项；
 * - 只依赖 Research State，不引用日报、Top100 或热点数据。
 */

export interface GeneratedQuery {
  query: string;
  purpose: string;
  stageId: string;
}

export interface StageQueryPlan {
  stageId: string;
  stageName: string;
  queries: GeneratedQuery[];
  expectedCandidateCount: number;
  deduplicationGroup: string;
}

export interface SearchStrategy {
  topicId: string;
  researchStateVersion: number;
  scope: 'FULL' | 'STAGE';
  plans: StageQueryPlan[];
  maxUniqueCandidates: number;
  enrichLimit: number;
  analyzeLimit: number;
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'use', 'using', 'tool', 'tools', 'open', 'source']);

const SYNONYMS: Record<string, string[]> = {
  data: ['dataset', 'data pipeline'],
  processing: ['preprocessing', 'transformation'],
  preprocessing: ['data cleaning', 'signal processing'],
  model: ['modeling', 'machine learning'],
  modeling: ['model training', 'deep learning'],
  training: ['model training', 'trainer'],
  evaluation: ['benchmark', 'metrics'],
  visualization: ['plotting', 'dashboard'],
  tracking: ['experiment tracking', 'mlops'],
  feature: ['feature engineering', 'feature extraction'],
  backtest: ['backtesting', 'strategy backtest'],
  factor: ['factor research', 'factor investing'],
  parser: ['parsing', 'extraction'],
  pdf: ['document parsing', 'document ai'],
  eeg: ['electroencephalography', 'neurophysiology'],
  agent: ['ai agent', 'agent framework'],
  rag: ['retrieval augmented generation', 'vector search'],
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function keywordTokens(stage: ResearchStage, state: ResearchState): string[] {
  const explicit = stage.toolRequirements.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  const fromName = /^[\x20-\x7e]+$/.test(stage.name) ? [stage.name] : [];
  const domains = state.requirements.domains
    .map((domain) => domain.trim())
    .filter((domain) => domain.length >= 3 && /^[\x20-\x7e]+$/.test(domain) && !STOP_WORDS.has(domain.toLowerCase()));
  return [...new Set([...explicit, ...fromName, ...domains.slice(0, 3)])].slice(0, 8);
}

function expandSynonyms(keywords: string[]): string[] {
  const expanded: string[] = [];
  for (const keyword of keywords) {
    for (const word of keyword.toLowerCase().split(/\s+/)) {
      const list = SYNONYMS[word];
      if (list) expanded.push(...list);
    }
  }
  return [...new Set(expanded)];
}

function qualifiers(): string[] {
  const parts = ['archived:false', 'is:public'];
  // 更新时间只作为质量辅助信号，不作为硬性排除条件。
  const cutoff = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 3).toISOString().slice(0, 10);
  parts.push(`pushed:>${cutoff}`);
  return parts;
}

function languageQualifiers(stage: ResearchStage, state: ResearchState): string[] {
  const languages = stage.toolRequirements.languages.length > 0 ? stage.toolRequirements.languages : state.requirements.languages;
  return languages.slice(0, 2).map((language) => `language:${language}`);
}

/** 为单个研究环节生成 3～8 条查询。 */
export function buildStageQueries(stage: ResearchStage, state: ResearchState): StageQueryPlan {
  const keywords = keywordTokens(stage, state);
  const synonyms = expandSynonyms(keywords);
  const base = qualifiers().join(' ');
  const languages = languageQualifiers(stage, state);
  const queries: GeneratedQuery[] = [];
  const push = (query: string, purpose: string) => {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    if (queries.some((item) => item.query === normalized)) return;
    if (queries.length >= 8) return;
    queries.push({ query: normalized, purpose, stageId: stage.id });
  };

  const primary = keywords.slice(0, 3);
  for (const keyword of primary) {
    if (languages.length > 0) {
      push(`${keyword} ${languages[0]} ${base}`, `在 ${languages[0].replace('language:', '')} 生态中查找「${stage.name}」工具`);
    } else {
      push(`${keyword} ${base}`, `查找「${stage.name}」相关工具`);
    }
  }
  for (const keyword of primary.slice(0, 2)) {
    push(`${keyword} in:name,description,readme ${base}`, `按名称与说明匹配「${stage.name}」工具`);
  }
  for (const synonym of synonyms.slice(0, 2)) {
    push(`${synonym} ${base}`, `使用同义词「${synonym}」扩大召回`);
  }
  for (const keyword of primary.slice(0, 2)) {
    const slug = slugify(keyword);
    if (slug && slug.length >= 3) push(`topic:${slug} ${base}`, `按 GitHub Topic「${slug}」召回`);
  }
  if (languages.length > 1) {
    push(`${primary[0] ?? stage.name} ${languages[1]} ${base}`, `补充第二语言生态候选`);
  }
  if (queries.length < 3) {
    push(`${stage.name} ${base}`, `以环节名称兜底查询`);
    push(`${state.title} ${base}`, '以主题名称兜底查询');
  }

  return {
    stageId: stage.id,
    stageName: stage.name,
    queries,
    expectedCandidateCount: Math.max(stage.toolRequirements.minimumCandidates, queries.length * 10),
    deduplicationGroup: `${stage.id}-v${stage.version}`,
  };
}

export function buildSearchStrategy(state: ResearchState, stageId?: string): SearchStrategy {
  const stages = stageId ? state.stages.filter((stage) => stage.id === stageId) : state.stages;
  const plans = stages.map((stage) => buildStageQueries(stage, state));
  return {
    topicId: state.topicId,
    researchStateVersion: state.version,
    scope: stageId ? 'STAGE' : 'FULL',
    plans,
    // 第一版规模上限：初始搜索最多 200 个去重候选，补充前 50 个仓库内容，详细分析前 30 个。
    maxUniqueCandidates: stageId ? 80 : 200,
    enrichLimit: stageId ? 20 : 50,
    analyzeLimit: stageId ? 12 : 30,
  };
}
