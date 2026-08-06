import { initialParseSchema, type InitialParseResult } from '../state/researchStateSchema.js';
import { requestResearchJson } from '../ai/researchAi.js';

/**
 * 初始需求解析：支持一句话与大段文字两种输入。
 * AI 失败时使用规则兜底，保证用户原始输入永不丢失，并把兜底结论写入 assumptions。
 */

const LANGUAGE_HINTS: Array<[RegExp, string]> = [
  [/\bpython\b|py\b/i, 'Python'],
  [/\btypescript\b|\bts\b/i, 'TypeScript'],
  [/\bjavascript\b|\bnode(\.js)?\b/i, 'JavaScript'],
  [/\brust\b/i, 'Rust'],
  [/\bgo(lang)?\b/i, 'Go'],
  [/\bjava\b/i, 'Java'],
  [/\bc\+\+\b|\bcpp\b/i, 'C++'],
  [/\bR 语言\b|\bRStudio\b/i, 'R'],
  [/\bjulia\b/i, 'Julia'],
  [/\bmatlab\b/i, 'MATLAB'],
];

const PLATFORM_HINTS: Array<[RegExp, string]> = [
  [/windows|win10|win11/i, 'Windows'],
  [/macos|mac\b|苹果/i, 'macOS'],
  [/linux|ubuntu|debian/i, 'Linux'],
  [/docker|容器/i, 'Docker'],
];

const STAGE_TEMPLATES: Array<{ id: string; name: string; description: string; keywords: string[]; triggers: RegExp[] }> = [
  { id: 'data-acquisition', name: '数据获取', description: '获取研究所需的公开数据或数据源', keywords: ['dataset', 'data download', 'data source'], triggers: [/数据|dataset|采集|下载|爬/i] },
  { id: 'data-processing', name: '数据处理', description: '清洗、转换与预处理原始数据', keywords: ['data processing', 'preprocessing', 'etl'], triggers: [/清洗|预处理|处理|滤波|转换|etl/i] },
  { id: 'feature-engineering', name: '特征处理', description: '构建与筛选研究所需特征', keywords: ['feature engineering', 'feature selection'], triggers: [/特征|feature|因子/i] },
  { id: 'modeling', name: '建模与训练', description: '训练并调整研究模型', keywords: ['model training', 'deep learning', 'machine learning'], triggers: [/模型|建模|训练|train|cnn|transformer|机器学习|深度学习/i] },
  { id: 'evaluation', name: '结果评估', description: '评估模型或方法的效果', keywords: ['evaluation', 'metrics', 'benchmark'], triggers: [/评估|指标|回测|benchmark|验证/i] },
  { id: 'experiment-tracking', name: '实验追踪', description: '记录参数、指标与产物', keywords: ['experiment tracking', 'mlops'], triggers: [/实验追踪|实验管理|tracking|mlflow|wandb/i] },
  { id: 'visualization', name: '结果展示', description: '生成图表、报告或交互界面', keywords: ['visualization', 'dashboard', 'plotting'], triggers: [/可视化|图表|报告|展示|dashboard|plot/i] },
];

const DEFAULT_STAGE_IDS = ['data-acquisition', 'data-processing', 'modeling', 'evaluation', 'visualization'];

function extractTitle(requirement: string): string {
  const firstLine = requirement.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '研究主题';
  const trimmed = firstLine.replace(/^[我想要希望需要打算]+/, '').replace(/[。.!！]+$/, '');
  return (trimmed || firstLine).slice(0, 40) || '研究主题';
}

/** 规则兜底解析：不调用 AI，也能得到可用的研究环节与约束。 */
export function parseRequirementByRules(requirement: string): InitialParseResult {
  const text = requirement.slice(0, 6000);
  const languages = [...new Set(LANGUAGE_HINTS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name))];
  const platforms = [...new Set(PLATFORM_HINTS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name))];
  const gpuAllowed = !/不.{0,4}(使用|需要|依赖).{0,4}gpu|no gpu|无 ?gpu|cpu ?only|仅 ?cpu/i.test(text);
  const paidApiAllowed = !/不.{0,6}(付费|收费|花钱)|免费|no paid|without paid/i.test(text);
  const localDeploymentPreferred = /本地|离线|local|windows|自己电脑/i.test(text) || platforms.length > 0;
  const externalNetworkAllowed = !/离线|不联网|no network|air ?gap/i.test(text);
  const matched = STAGE_TEMPLATES.filter((template) => template.triggers.some((trigger) => trigger.test(text)));
  const chosen = matched.length >= 2 ? matched : STAGE_TEMPLATES.filter((template) => DEFAULT_STAGE_IDS.includes(template.id));
  const domainWords = [...new Set(
    (text.match(/[A-Za-z][A-Za-z+#.-]{2,}/g) ?? [])
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !/^(the|and|for|with|use|using|from|that|this|need|want|python|windows|linux|macos|docker)$/i.test(word)),
  )].slice(0, 8);
  return initialParseSchema.parse({
    title: extractTitle(requirement),
    objective: text.slice(0, 400) || '根据用户需求搜索并组合开源研究工具',
    requirements: {
      domains: domainWords,
      languages,
      platforms,
      localDeploymentPreferred,
      gpuAllowed,
      paidApiAllowed,
      externalNetworkAllowed,
      licenseRequired: /license|开源协议|商用/i.test(text),
    },
    stages: chosen.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      required: true,
      inputs: [],
      outputs: [],
      keywords: template.keywords,
    })),
    assumptions: [
      'AI 结构化解析不可用或失败，当前研究环节由关键词规则生成。',
      '研究环节与约束可以通过对话继续调整。',
    ],
    unresolvedIssues: languages.length === 0 ? ['未识别到明确的编程语言约束，搜索将不限制语言。'] : [],
  });
}

const PARSE_PROMPT_HEADER = `你是开源研究工具链规划专家。用户会用一句话或一大段文字描述研究需求。
请把它解析为结构化研究需求与研究环节。要求：
1. 只根据用户输入推断，不得虚构用户没有表达的目标、数据集或工具；
2. 不要推荐任何具体 GitHub 仓库或工具名称，本步骤只规划研究环节；
3. stages 是完成该研究必须经过的环节，3 至 8 个，按执行顺序排列；
4. stage.id 使用小写英文短横线命名（如 data-processing）；
5. stage.keywords 是用于后续 GitHub 搜索的英文关键词，每个环节 2 至 6 个；
6. assumptions 写出你做的假设；unresolvedIssues 写出仍然含糊、需要用户澄清的点；
7. 若用户明确说明不使用 GPU 或不使用付费 API，必须在 requirements 中体现；
8. 只返回 JSON，字段：title,objective,requirements{domains,languages,platforms,localDeploymentPreferred,gpuAllowed,paidApiAllowed,externalNetworkAllowed,licenseRequired},stages[{id,name,description,required,inputs,outputs,keywords}],assumptions,unresolvedIssues。`;

export async function parseInitialRequirement(requirement: string): Promise<{ result: InitialParseResult; source: 'ai' | 'rule' }> {
  const fallback = parseRequirementByRules(requirement);
  const prompt = `${PARSE_PROMPT_HEADER}\n\n用户研究需求：\n${requirement.slice(0, 6000)}`;
  const ai = await requestResearchJson('initial-parse', initialParseSchema, prompt, 1800, 0.15);
  if (!ai.data) return { result: fallback, source: 'rule' };
  // AI 未给出关键词时补上规则关键词，避免后续查询生成退化为单一查询。
  const stages = ai.data.stages.map((stage) => ({
    ...stage,
    keywords: stage.keywords.length > 0
      ? stage.keywords
      : (STAGE_TEMPLATES.find((template) => template.id === stage.id)?.keywords ?? [stage.name]),
  }));
  return { result: { ...ai.data, stages }, source: 'ai' };
}
