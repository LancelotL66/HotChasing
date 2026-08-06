import {
  toolAnalysisSchema,
  type ResearchState,
  type ToolAnalysis,
} from '../state/researchStateSchema.js';
import { requestResearchJson } from '../ai/researchAi.js';
import type { GithubSearchRepo } from '../github/githubResearchClient.js';
import type { RepositoryEnrichment } from '../github/githubRepositoryEnricher.js';

/**
 * ResearchToolAnalyzer：为当前主题解释每个候选工具。
 *
 * 研究角色是相对于当前主题动态生成的，不复用日报分类结果。
 * AI 不可用或输出不合规时使用元数据规则兜底，并把 evidenceLevel 降级，
 * 避免在信息不足时给出确定性过强的结论。
 */

export const TOOL_ANALYSIS_VERSION = 'research-tool-analysis-v1';

const ROLE_KEYWORDS: Array<[RegExp, ToolAnalysis['roles'][number]]> = [
  [/dataset|data source|数据集|公开数据/i, 'DATA_SOURCE'],
  [/scrap|crawler|collect|采集|抓取/i, 'DATA_COLLECTION'],
  [/preprocess|clean|filter|etl|预处理|清洗|滤波/i, 'DATA_PROCESSING'],
  [/feature|因子|特征/i, 'FEATURE_ENGINEERING'],
  [/analysis|analytics|statistic|分析|统计/i, 'ANALYSIS'],
  [/train|model|neural|transformer|regression|建模|训练/i, 'MODELING'],
  [/eval|benchmark|metric|backtest|评估|回测/i, 'EVALUATION'],
  [/mlflow|wandb|experiment tracking|实验追踪/i, 'EXPERIMENT_TRACKING'],
  [/plot|chart|visuali|dashboard|可视化|图表/i, 'VISUALIZATION'],
  [/pipeline|workflow|orchestrat|airflow|prefect|编排/i, 'ORCHESTRATION'],
  [/\bui\b|frontend|notebook|jupyter|界面/i, 'USER_INTERFACE'],
  [/database|storage|duckdb|sqlite|postgres|存储/i, 'STORAGE'],
];

const PRODUCT_FORM_RULES: Array<[RegExp, ToolAnalysis['productForm'][number]]> = [
  [/\bcli\b|command line|命令行/i, 'CLI'],
  [/\blibrary\b|\bsdk\b|pip install|npm install|库/i, 'LIBRARY'],
  [/\bserver\b|\bapi\b|service|微服务/i, 'SERVICE'],
  [/desktop|electron|tauri|桌面/i, 'DESKTOP_APP'],
  [/web app|webui|web interface|网页/i, 'WEB_APP'],
  [/notebook|jupyter/i, 'NOTEBOOK'],
  [/dataset|数据集/i, 'DATASET'],
  [/platform|平台/i, 'PLATFORM'],
  [/\bmcp\b/i, 'MCP_SERVER'],
];

function maintenanceFromPushedAt(pushedAt: string | null): ToolAnalysis['maintenance'] {
  if (!pushedAt) return { status: 'UNKNOWN', evidence: '未获取到最近推送时间' };
  const days = (Date.now() - Date.parse(pushedAt)) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(days)) return { status: 'UNKNOWN', evidence: '推送时间无法解析' };
  if (days <= 120) return { status: 'ACTIVE', evidence: `最近 ${Math.round(days)} 天内有推送` };
  if (days <= 400) return { status: 'SLOW', evidence: `约 ${Math.round(days)} 天前最后一次推送` };
  return { status: 'STALE', evidence: `超过 ${Math.round(days)} 天没有推送` };
}

/** 规则兜底分析：只使用元数据与 README 文本中可直接观察到的事实。 */
export function analyzeToolByRules(
  repo: GithubSearchRepo,
  enrichment: RepositoryEnrichment | null,
  stageIds: string[],
): ToolAnalysis {
  const readme = enrichment?.readmeText ?? '';
  const text = `${repo.name} ${repo.description ?? ''} ${repo.topics.join(' ')} ${readme.slice(0, 4000)}`;
  const roles = [...new Set(ROLE_KEYWORDS.filter(([pattern]) => pattern.test(text)).map(([, role]) => role))].slice(0, 4);
  const productForm = [...new Set(PRODUCT_FORM_RULES.filter(([pattern]) => pattern.test(text)).map(([, form]) => form))].slice(0, 3);
  const deploymentFiles = enrichment?.deploymentFiles ?? [];
  const dockerAvailable = deploymentFiles.some((file) => /dockerfile|compose/i.test(file));
  const gpuRequired = /\bcuda\b|requires? (a )?gpu|nvidia|需要 ?gpu/i.test(readme);
  const credentialsRequired = /api[_ -]?key|token|credential|secret|需要密钥/i.test(readme);
  const paidApiRequired = /openai api key|paid api|billing|subscription required|付费 ?api/i.test(readme);
  const acquisition = deploymentFiles.some((file) => /package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod/i.test(file))
    ? 'PACKAGE'
    : dockerAvailable
      ? 'CLONE_UPSTREAM'
      : 'CLONE_UPSTREAM';
  return toolAnalysisSchema.parse({
    githubNodeId: repo.nodeId,
    repository: repo.fullName,
    name: repo.name,
    stageIds,
    roles: roles.length > 0 ? roles : ['SUPPORTING_INFRASTRUCTURE'],
    summary: repo.description ? repo.description.slice(0, 300) : '仓库未提供描述，需要进一步确认功能。',
    roleInTheme: readme
      ? '根据 README 与仓库元数据推断的候选定位，尚未经过 AI 深度分析。'
      : '仅根据仓库元数据推断，证据不足，建议先做深度分析。',
    howUserWouldUseIt: [],
    inputs: [],
    outputs: [],
    productForm: productForm.length > 0 ? productForm : ['LIBRARY'],
    deployment: {
      localSupported: true,
      dockerAvailable,
      gpuRequired,
      credentialsRequired,
      paidApiRequired,
      preferredAcquisitionMode: acquisition,
    },
    advantages: [],
    limitations: readme ? [] : ['未获取到 README，功能结论证据不足'],
    maintenance: maintenanceFromPushedAt(repo.pushedAt),
    replicationSuitability: dockerAvailable ? 'MEDIUM' : 'UNKNOWN',
    evidenceLevel: readme ? 'README_ONLY' : 'METADATA_ONLY',
    recommendationReason: '由规则生成的初步判断，未经过 AI 深度分析。',
  });
}

function buildPrompt(repo: GithubSearchRepo, enrichment: RepositoryEnrichment | null, state: ResearchState): string {
  const stageList = state.stages.map((stage) => `${stage.id}（${stage.name}）：${stage.description || '无说明'}`).join('\n');
  const requirements = state.requirements;
  return `你是开源研究工具分析专家。请判断这个 GitHub 仓库在当前研究主题中的作用。

约束：
1. 只根据提供的仓库信息作答，不得虚构 README 中不存在的功能、部署方式或验证结果；
2. 信息不足时把 evidenceLevel 设为 METADATA_ONLY 并在 limitations 中说明；
3. stageIds 只能从下面的研究环节 ID 中选择，可以为空数组；
4. 不要引用任何热度排名或榜单信息；
5. summary 与 roleInTheme 使用中文；
6. 只返回 JSON，字段：githubNodeId,repository,name,stageIds,roles,summary,roleInTheme,howUserWouldUseIt,inputs,outputs,productForm,deployment{localSupported,dockerAvailable,gpuRequired,credentialsRequired,paidApiRequired,preferredAcquisitionMode},advantages,limitations,maintenance{status,evidence},replicationSuitability,evidenceLevel,recommendationReason。
7. roles 只能取：DATA_SOURCE,DATA_COLLECTION,DATA_PROCESSING,FEATURE_ENGINEERING,ANALYSIS,MODELING,EVALUATION,EXPERIMENT_TRACKING,VISUALIZATION,ORCHESTRATION,USER_INTERFACE,STORAGE,SUPPORTING_INFRASTRUCTURE。
8. productForm 只能取：LIBRARY,CLI,SERVICE,DESKTOP_APP,WEB_APP,NOTEBOOK,DATASET,PLATFORM,MCP_SERVER。
9. preferredAcquisitionMode 只能取：PACKAGE,RELEASE,CLONE_UPSTREAM,FORK_AND_CLONE,EXTERNAL_SERVICE,MANUAL。
10. maintenance.status 只能取：ACTIVE,SLOW,STALE,UNKNOWN；replicationSuitability 只能取：HIGH,MEDIUM,LOW,UNKNOWN；evidenceLevel 只能取：METADATA_ONLY,README_ONLY,README_AND_REPOSITORY_ANALYSIS。

研究主题：${state.title}
研究目标：${state.objective || '未填写'}
用户约束：语言=${requirements.languages.join('/') || '不限'}；平台=${requirements.platforms.join('/') || '不限'}；本地优先=${requirements.localDeploymentPreferred}；允许 GPU=${requirements.gpuAllowed}；允许付费 API=${requirements.paidApiAllowed}
研究环节：
${stageList || '（暂无）'}

仓库：${repo.fullName}
node_id：${repo.nodeId}
Description：${repo.description ?? ''}
Topics：${repo.topics.join(', ') || '无'}
主语言：${repo.primaryLanguage ?? '未知'}
License：${repo.licenseSpdx ?? '未声明'}
Stars：${repo.stars}
最近推送：${repo.pushedAt ?? '未知'}
根目录文件：${(enrichment?.rootFiles ?? []).join(', ').slice(0, 1200) || '未获取'}
部署相关文件：${(enrichment?.deploymentFiles ?? []).join(', ') || '未发现'}
README：
${(enrichment?.readmeText ?? '').slice(0, 8000) || '未获取到 README'}`;
}

export interface ToolAnalysisResult {
  analysis: ToolAnalysis;
  source: 'ai' | 'rule';
  model: string | null;
}

export async function analyzeTool(
  repo: GithubSearchRepo,
  enrichment: RepositoryEnrichment | null,
  state: ResearchState,
  fallbackStageIds: string[],
): Promise<ToolAnalysisResult> {
  const fallback = analyzeToolByRules(repo, enrichment, fallbackStageIds);
  const ai = await requestResearchJson('tool-analysis', toolAnalysisSchema, buildPrompt(repo, enrichment, state), 1600, 0.1);
  if (!ai.data) return { analysis: fallback, source: 'rule', model: null };
  const knownStageIds = new Set(state.stages.map((stage) => stage.id));
  const stageIds = ai.data.stageIds.filter((stageId) => knownStageIds.has(stageId));
  return {
    analysis: toolAnalysisSchema.parse({
      ...ai.data,
      githubNodeId: repo.nodeId,
      repository: repo.fullName,
      stageIds: stageIds.length > 0 ? stageIds : fallbackStageIds,
      evidenceLevel: enrichment?.readmeText ? ai.data.evidenceLevel : 'METADATA_ONLY',
    }),
    source: 'ai',
    model: ai.model,
  };
}
