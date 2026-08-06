import { z } from 'zod';
import { getDb } from '../db/connection.js';
import { config } from '../config.js';
import { decrypt } from '../services/crypto.js';
import { proxyRequest } from '../services/proxyService.js';
import { logger } from '../services/logger.js';
import { hotSummarySourceHash, ruleHotSummary } from './summaryService.js';
import { PRIMARY_CATEGORIES, type ProjectClassification, classificationSourceHash } from './classificationService.js';

const summarySchema = z.object({ summaryZh: z.string().min(20).max(180) });
const classificationSchema = z.object({
  primaryCategory: z.enum(PRIMARY_CATEGORIES), secondaryCategories: z.array(z.string()).max(2),
  functionTags: z.array(z.string()).min(3).max(8), productForms: z.array(z.string()).min(1).max(3),
  platformTags: z.array(z.string()).max(6), targetUsers: z.array(z.string()).min(1).max(5),
  deploymentModes: z.array(z.string()).max(5), deploymentDifficulty: z.enum(['极低', '低', '中', '高', '极高']),
  hotReasonTags: z.array(z.string()).min(1).max(4), maturity: z.string().min(1), costTags: z.array(z.string()).max(4),
  license: z.string().min(1), commercialUseTags: z.array(z.string()).max(3), privacyTags: z.array(z.string()).max(4),
  confidence: z.number().min(0).max(1), reason: z.string().min(10).max(240),
});

function chatUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return /\/v\d+(?:beta|alpha)?$/.test(normalized) ? `${normalized}/chat/completions` : `${normalized}/v1/chat/completions`;
}

function parseJson(text: string): z.infer<typeof summarySchema> {
  return summarySchema.parse(JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim()));
}

export function getActiveAIConcurrency(): number {
  const db = getDb();
  const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('activeAIConfig') as { value?: string } | undefined;
  let selected: unknown = null;
  try { selected = setting?.value ? JSON.parse(setting.value) : null; } catch { selected = setting?.value ?? null; }
  const configId = typeof selected === 'string' || typeof selected === 'number' ? String(selected) : null;
  const row = configId ? db.prepare('SELECT concurrency FROM ai_configs WHERE id=?').get(configId) as { concurrency?: number } | undefined : undefined;
  return Math.max(1, Math.min(4, Number(row?.concurrency) || 1));
}

async function requestProvider(options: Parameters<typeof proxyRequest>[0]) {
  let response = await proxyRequest(options);
  if ([502, 503, 504].includes(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    response = await proxyRequest(options);
  }
  return response;
}

function normalizeDeploymentDifficulty(value: unknown): unknown {
  const normalized = String(value ?? '').trim();
  if (['极低', '很低', '最低'].includes(normalized)) return '极低';
  if (['低', '较低'].includes(normalized)) return '低';
  if (['中', '中等', '一般'].includes(normalized)) return '中';
  if (['高', '较高'].includes(normalized)) return '高';
  if (['极高', '很高', '最高'].includes(normalized)) return '极高';
  return value;
}

export async function generateHotSummary(repo: Record<string, unknown>): Promise<{ summary: string; source: 'ai' | 'rule'; model: string | null; sourceHash: string }> {
  const sourceHash = hotSummarySourceHash(repo);
  const db = getDb();
  // Reuse the existing application setting used by HotChasing's AI service.
  // is_active belongs to the persisted config record but does not represent the
  // frontend's selected activeAIConfig reliably after local-first edits.
  const activeSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('activeAIConfig') as { value?: string } | undefined;
  let activeConfigId: unknown = null;
  try { activeConfigId = activeSetting?.value ? JSON.parse(activeSetting.value) : null; } catch { activeConfigId = activeSetting?.value ?? null; }
  const selectedConfigId = typeof activeConfigId === 'string' || typeof activeConfigId === 'number' ? String(activeConfigId) : null;
  const aiConfig = selectedConfigId
    ? db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(selectedConfigId) as Record<string, unknown> | undefined
    : db.prepare('SELECT * FROM ai_configs WHERE is_active = 1 ORDER BY id LIMIT 1').get() as Record<string, unknown> | undefined;
  if (!aiConfig) return { summary: ruleHotSummary(repo), source: 'rule', model: null, sourceHash };
  try {
    const apiType = String(aiConfig.api_type || 'openai');
    const apiKey = aiConfig.api_key_encrypted ? decrypt(String(aiConfig.api_key_encrypted), config.encryptionKey) : '';
    const model = String(aiConfig.model || '');
    const prompt = `基于公开仓库信息，写 60 至 120 个中文字符的客观热点摘要。说明项目是什么、解决什么问题、适合谁以及为何近期值得关注。不得虚构 README、部署成功、实际验证或未提供的能力。只返回 JSON：{"summaryZh":"..."}。\n仓库：${repo.full_name}\n描述：${typeof repo.description === 'string' ? repo.description.slice(0, 800) : ''}\n主题：${typeof repo.topics === 'string' ? repo.topics.slice(0, 500) : '[]'}\n语言：${repo.language ?? '未知'}\nStars：${repo.stargazers_count ?? 0}\n更新时间：${repo.updated_at ?? '未知'}`;
    let url: string; let headers: Record<string, string>; let body: Record<string, unknown>;
    if (apiType === 'claude') {
      url = `${String(aiConfig.base_url).replace(/\/$/, '')}/v1/messages`;
      headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
      body = { model, max_tokens: 300, temperature: 0.2, messages: [{ role: 'user', content: prompt }] };
    } else if (apiType === 'ollama') {
      url = `${String(aiConfig.base_url).replace(/\/$/, '')}/api/chat`;
      headers = { 'Content-Type': 'application/json' };
      body = { model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }] };
    } else {
      url = apiType === 'openai-compatible' ? String(aiConfig.base_url).replace(/\/$/, '') : chatUrl(String(aiConfig.base_url));
      headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
      body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 300, response_format: { type: 'json_object' } };
    }
    const result = await requestProvider({ url, method: 'POST', headers, body, timeout: 60000, proxyConfig: null, allowPrivate: true });
    if (result.status < 200 || result.status >= 300) throw new Error(`Provider returned ${result.status}`);
    const data = result.data as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; message?: { content?: string } };
    const raw = apiType === 'ollama' ? data.message?.content ?? '' : apiType === 'claude' ? data.content?.map((item) => item.text ?? '').join('') ?? '' : data.choices?.[0]?.message?.content ?? '';
    return { summary: parseJson(raw).summaryZh, source: 'ai', model, sourceHash };
  } catch (error) {
    logger.errorFromError('ai.hot-summary', 'Hot project AI summary failed; using rule fallback', error, { repoId: repo.id });
    return { summary: ruleHotSummary(repo), source: 'rule', model: null, sourceHash };
  }
}

export { parseJson as parseHotSummaryJson };

const classificationGuidance = '分类边界：框架、运行时、编译器、游戏引擎和可视化库归“基础设施与 DevOps”；Vue 归“数据与数据库”；代码工具、算法实现和工程配置归“开发者工具”；课程、教程、学习路径与资源索引归“学习与研究”。';

export async function generateProjectClassification(repo: Record<string, unknown>, readme: string, architecture: string, fallback: ProjectClassification): Promise<ProjectClassification> {
  const sourceHash = classificationSourceHash(repo, readme, architecture);
  const db = getDb(); const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('activeAIConfig') as { value?: string } | undefined;
  let selected: unknown = null; try { selected = setting?.value ? JSON.parse(setting.value) : null; } catch { selected = setting?.value ?? null; }
  const configId = typeof selected === 'string' || typeof selected === 'number' ? String(selected) : null;
  const aiConfig = configId ? db.prepare('SELECT * FROM ai_configs WHERE id=?').get(configId) as Record<string, unknown> | undefined : undefined;
  if (!aiConfig) return { ...fallback, sourceHash };
  try {
    const apiType = String(aiConfig.api_type || 'openai'); const apiKey = aiConfig.api_key_encrypted ? decrypt(String(aiConfig.api_key_encrypted), config.encryptionKey) : ''; const model = String(aiConfig.model || '');
    const prompt = `根据公开仓库的 Description、Topics、README 与根目录工程结构输出中文分类 JSON。优先根据 README 说明的核心用途和工程结构判断，不得仅因出现 Dockerfile、CI 或依赖文件就归为基础设施。${classificationGuidance} 主分类必须且只能是：${PRIMARY_CATEGORIES.join('、')}。functionTags 3-8 个，productForms 1-3 个，targetUsers 1-5 个。标签必须客观、简短；不得虚构部署、平台、验证或商业能力。置信度低于 0.60 时 primaryCategory 必须是“其他 / 待分类”。只返回 JSON，字段：primaryCategory,secondaryCategories,functionTags,productForms,platformTags,targetUsers,deploymentModes,deploymentDifficulty,hotReasonTags,maturity,costTags,license,commercialUseTags,privacyTags,confidence,reason。\n仓库：${repo.full_name}\nDescription：${repo.description ?? ''}\nTopics：${repo.topics ?? '[]'}\n语言：${repo.language ?? '未知'}\nLicense：${repo.license ?? '未知'}\n根目录工程结构：\n${architecture || '未获取到工程结构'}\nREADME：\n${readme || '未获取到 README'}`;
    let url: string; let headers: Record<string, string>; let body: Record<string, unknown>;
    if (apiType === 'claude') { url = `${String(aiConfig.base_url).replace(/\/$/, '')}/v1/messages`; headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }; body = { model, max_tokens: 1200, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }; }
    else if (apiType === 'ollama') { url = `${String(aiConfig.base_url).replace(/\/$/, '')}/api/chat`; headers = { 'Content-Type': 'application/json' }; body = { model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }] }; }
    else { url = apiType === 'openai-compatible' ? String(aiConfig.base_url).replace(/\/$/, '') : chatUrl(String(aiConfig.base_url)); headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }; body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 1200, response_format: { type: 'json_object' } }; }
    const response = await requestProvider({ url, method: 'POST', headers, body, timeout: 60000, proxyConfig: null, allowPrivate: true }); if (response.status < 200 || response.status >= 300) throw new Error(`Provider returned ${response.status}`);
    const data = response.data as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; message?: { content?: string } };
    const content = apiType === 'ollama' ? data.message?.content ?? '' : apiType === 'claude' ? data.content?.map((item) => item.text ?? '').join('') ?? '' : data.choices?.[0]?.message?.content ?? '';
    const rawClassification = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim());
    const parsed = classificationSchema.parse({ ...rawClassification, deploymentDifficulty: normalizeDeploymentDifficulty(rawClassification.deploymentDifficulty) });
    const learningByBuilding = /build-your-own|recreating.*from scratch|from scratch.*technolog/i.test(`${repo.full_name ?? ''} ${repo.description ?? ''} ${readme.slice(0, 2000)}`);
    if (learningByBuilding) return { ...parsed, primaryCategory: '开发者工具', functionTags: [...new Set(['编程实践', ...parsed.functionTags])].slice(0, 8), reason: '项目通过从零复现技术帮助开发者进行编程实践，归为开发者工具。', source: 'ai', sourceHash };
    return { ...parsed, source: 'ai', sourceHash };
  } catch (error) { logger.errorFromError('ai.classification', 'AI classification failed; using rule fallback', error, { repoId: repo.id }); return { ...fallback, sourceHash }; }
}

export async function generateTop100Enrichment(repo: Record<string, unknown>, readme: string, architecture: string, fallback: ProjectClassification): Promise<{ classification: ProjectClassification; summary: string; summarySource: 'ai' | 'rule'; model: string | null }> {
  const sourceHash = classificationSourceHash(repo, readme, architecture); const summaryFallback = ruleHotSummary(repo);
  const db = getDb(); const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('activeAIConfig') as { value?: string } | undefined;
  let selected: unknown = null; try { selected = setting?.value ? JSON.parse(setting.value) : null; } catch { selected = setting?.value ?? null; }
  const configId = typeof selected === 'string' || typeof selected === 'number' ? String(selected) : null;
  const aiConfig = configId ? db.prepare('SELECT * FROM ai_configs WHERE id=?').get(configId) as Record<string, unknown> | undefined : undefined;
  if (!aiConfig) return { classification: { ...fallback, sourceHash }, summary: summaryFallback, summarySource: 'rule', model: null };
  try {
    const apiType = String(aiConfig.api_type || 'openai'); const apiKey = aiConfig.api_key_encrypted ? decrypt(String(aiConfig.api_key_encrypted), config.encryptionKey) : ''; const model = String(aiConfig.model || '');
    const prompt = `根据公开仓库的 Description、Topics、README 与根目录工程结构输出一个 JSON。分类优先根据 README 的核心用途和工程结构判断，不得仅因 Dockerfile、CI 或依赖文件归为基础设施。${classificationGuidance} 主分类只能是：${PRIMARY_CATEGORIES.join('、')}。functionTags 3-8 个，productForms 1-3 个，targetUsers 1-5 个。summaryZh 为 60 至 120 个中文字符，客观说明项目是什么、解决什么问题、适合谁、为何值得关注；不得虚构能力。置信度低于 0.60 时 primaryCategory 必须是“其他 / 待分类”。只返回字段：primaryCategory,secondaryCategories,functionTags,productForms,platformTags,targetUsers,deploymentModes,deploymentDifficulty,hotReasonTags,maturity,costTags,license,commercialUseTags,privacyTags,confidence,reason,summaryZh。\n仓库：${repo.full_name}\nDescription：${repo.description ?? ''}\nTopics：${repo.topics ?? '[]'}\n语言：${repo.language ?? '未知'}\nLicense：${repo.license ?? '未知'}\nStars：${repo.stargazers_count ?? 0}\n更新时间：${repo.updated_at ?? '未知'}\n根目录工程结构：\n${architecture || '未获取到工程结构'}\nREADME：\n${readme || '未获取到 README'}`;
    let url: string; let headers: Record<string, string>; let body: Record<string, unknown>;
    if (apiType === 'claude') { url = `${String(aiConfig.base_url).replace(/\/$/, '')}/v1/messages`; headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }; body = { model, max_tokens: 1400, temperature: 0.1, messages: [{ role: 'user', content: prompt }] }; }
    else if (apiType === 'ollama') { url = `${String(aiConfig.base_url).replace(/\/$/, '')}/api/chat`; headers = { 'Content-Type': 'application/json' }; body = { model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }] }; }
    else { url = apiType === 'openai-compatible' ? String(aiConfig.base_url).replace(/\/$/, '') : chatUrl(String(aiConfig.base_url)); headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }; body = { model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 1400, response_format: { type: 'json_object' } }; }
    const response = await requestProvider({ url, method: 'POST', headers, body, timeout: 60000, proxyConfig: null, allowPrivate: true }); if (response.status < 200 || response.status >= 300) throw new Error(`Provider returned ${response.status}`);
    const data = response.data as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; message?: { content?: string } };
    const content = apiType === 'ollama' ? data.message?.content ?? '' : apiType === 'claude' ? data.content?.map((item) => item.text ?? '').join('') ?? '' : data.choices?.[0]?.message?.content ?? '';
    const raw = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim());
    // The AI summary is the primary content. Decouple it from the strict
    // classification schema so an out-of-spec optional field (e.g.
    // deploymentDifficulty, hotReasonTags) does not discard a valid summary.
    const summaryZh = typeof raw.summaryZh === 'string' ? raw.summaryZh.trim() : '';
    if (summaryZh.length < 20) throw new Error(`summaryZh too short (${summaryZh.length})`);
    const classification = classificationSchema.safeParse({ ...raw, deploymentDifficulty: normalizeDeploymentDifficulty(raw.deploymentDifficulty) });
    return classification.success
      ? { classification: { ...classification.data, source: 'ai' as const, sourceHash }, summary: summaryZh, summarySource: 'ai' as const, model }
      : { classification: { ...fallback, sourceHash }, summary: summaryZh, summarySource: 'ai' as const, model };
  } catch (error) { logger.errorFromError('ai.top100-enrichment', 'Top100 AI enrichment failed; using rule fallback', error, { repoId: repo.id }); return { classification: { ...fallback, sourceHash }, summary: summaryFallback, summarySource: 'rule', model: null }; }
}

// ---------------------------------------------------------------------------
// Fork 实验室：AI 部署分析 + 结构化部署计划（M1/M2，复用同一 AI Gateway）
// ---------------------------------------------------------------------------

export const RECOMMENDED_LEVELS = ['AUTO_TEST', 'AGENT_ASSISTED_TEST', 'MANUAL_TEST', 'SKIP'] as const;
export const DEPLOYMENT_METHODS = ['OFFICIAL_COMPOSE', 'OFFICIAL_DOCKERFILE', 'OFFICIAL_RELEASE', 'PACKAGE_MANAGER', 'AGENT_GENERATED'] as const;
export const PLAN_TEST_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export const PLAN_STEP_TYPES = ['docker_build', 'docker_run', 'http_check', 'command'] as const;

export const deploymentAssessmentSchema = z.object({
  deploymentValueScore: z.number().min(0).max(100),
  deploymentDifficultyScore: z.number().min(0).max(100),
  testabilityScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  recommendedLevel: z.enum(RECOMMENDED_LEVELS),
  recommendedMethod: z.enum(DEPLOYMENT_METHODS),
  estimatedResources: z.object({
    cpu: z.number().min(0).max(64),
    memoryMb: z.number().min(0).max(65536),
    diskMb: z.number().min(0).max(262144),
    gpuRequired: z.boolean(),
  }),
  requirements: z.object({
    database: z.boolean(),
    externalApi: z.boolean(),
    credentials: z.boolean(),
    accountLogin: z.boolean(),
    networkDuringBuild: z.boolean(),
    networkDuringRun: z.boolean(),
  }),
  valueReasons: z.array(z.string()).max(12),
  difficultyReasons: z.array(z.string()).max(12),
  riskReasons: z.array(z.string()).max(12),
  detectedFiles: z.array(z.string()).max(20),
  suspectedPorts: z.array(z.number()).max(10),
  suspectedCommands: z.array(z.string()).max(10),
  confidence: z.number().min(0).max(1),
});

export const deploymentPlanSchema = z.object({
  schemaVersion: z.number().default(1),
  strategy: z.enum(DEPLOYMENT_METHODS),
  summary: z.string().min(1).max(500),
  testLevel: z.enum(PLAN_TEST_LEVELS).default('L2'),
  estimatedResources: z.object({
    cpu: z.number().min(0).max(64).default(2),
    memoryMb: z.number().min(0).max(65536).default(1024),
    diskMb: z.number().min(0).max(262144).default(2048),
  }),
  requirements: z.object({
    environmentVariables: z.array(z.string()).max(20).default([]),
    credentials: z.array(z.string()).max(10).default([]),
    database: z.boolean().default(false),
    networkDuringBuild: z.boolean().default(true),
    networkDuringRun: z.boolean().default(false),
  }),
  steps: z.array(z.object({
    id: z.string(),
    type: z.enum(PLAN_STEP_TYPES),
    context: z.string().optional(),
    dockerfile: z.string().optional(),
    containerPort: z.number().optional(),
    hostPort: z.union([z.string(), z.number()]).optional(),
    path: z.string().optional(),
    expectedStatus: z.number().optional(),
    command: z.string().optional(),
  })).min(1),
  blockers: z.array(z.string()).max(12).default([]),
  needsUserApproval: z.boolean().default(false),
});

export function getActiveAIConfigRow(): Record<string, unknown> | undefined {
  const db = getDb();
  const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('activeAIConfig') as { value?: string } | undefined;
  let selected: unknown = null;
  try { selected = setting?.value ? JSON.parse(setting.value) : null; } catch { selected = setting?.value ?? null; }
  const configId = typeof selected === 'string' || typeof selected === 'number' ? String(selected) : null;
  return configId
    ? db.prepare('SELECT * FROM ai_configs WHERE id=?').get(configId) as Record<string, unknown> | undefined
    : db.prepare('SELECT * FROM ai_configs WHERE is_active = 1 ORDER BY id LIMIT 1').get() as Record<string, unknown> | undefined;
}

export async function requestJsonContent(aiConfig: Record<string, unknown>, prompt: string, maxTokens: number, temperature: number): Promise<string> {
  const apiType = String(aiConfig.api_type || 'openai');
  const apiKey = aiConfig.api_key_encrypted ? decrypt(String(aiConfig.api_key_encrypted), config.encryptionKey) : '';
  const model = String(aiConfig.model || '');
  let url: string; let headers: Record<string, string>; let body: Record<string, unknown>;
  if (apiType === 'claude') {
    url = `${String(aiConfig.base_url).replace(/\/$/, '')}/v1/messages`;
    headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    body = { model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content: prompt }] };
  } else if (apiType === 'ollama') {
    url = `${String(aiConfig.base_url).replace(/\/$/, '')}/api/chat`;
    headers = { 'Content-Type': 'application/json' };
    body = { model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt }] };
  } else {
    url = apiType === 'openai-compatible' ? String(aiConfig.base_url).replace(/\/$/, '') : chatUrl(String(aiConfig.base_url));
    headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
    body = { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens, response_format: { type: 'json_object' } };
  }
  const response = await requestProvider({ url, method: 'POST', headers, body, timeout: 60000, proxyConfig: null, allowPrivate: true });
  if (response.status < 200 || response.status >= 300) throw new Error(`Provider returned ${response.status}`);
  const data = response.data as { choices?: Array<{ message?: { content?: string } }>; content?: Array<{ text?: string }>; message?: { content?: string } };
  return (apiType === 'ollama' ? data.message?.content ?? '' : apiType === 'claude' ? data.content?.map((item) => item.text ?? '').join('') ?? '' : data.choices?.[0]?.message?.content ?? '').replace(/^```json\s*|\s*```$/g, '').trim();
}

const clampNum = (value: unknown, fallback: number, min = 0, max = 100) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 12) : []);
const numArray = (value: unknown): number[] => (Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item)).slice(0, 10) : []);

function normalizeAssessment(raw: unknown): z.infer<typeof deploymentAssessmentSchema> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const resources = (r.estimatedResources ?? {}) as Record<string, unknown>;
  const requirements = (r.requirements ?? {}) as Record<string, unknown>;
  const level = String(r.recommendedLevel ?? 'AGENT_ASSISTED_TEST');
  const method = String(r.recommendedMethod ?? 'OFFICIAL_DOCKERFILE');
  return {
    deploymentValueScore: clampNum(r.deploymentValueScore, 50),
    deploymentDifficultyScore: clampNum(r.deploymentDifficultyScore, 50),
    testabilityScore: clampNum(r.testabilityScore, 50),
    riskScore: clampNum(r.riskScore, 50),
    recommendedLevel: ((RECOMMENDED_LEVELS as readonly string[]).includes(level) ? level : 'AGENT_ASSISTED_TEST') as z.infer<typeof deploymentAssessmentSchema>['recommendedLevel'],
    recommendedMethod: ((DEPLOYMENT_METHODS as readonly string[]).includes(method) ? method : 'OFFICIAL_DOCKERFILE') as z.infer<typeof deploymentAssessmentSchema>['recommendedMethod'],
    estimatedResources: {
      cpu: clampNum(resources.cpu, 2, 0, 64),
      memoryMb: clampNum(resources.memoryMb, 1024, 0, 65536),
      diskMb: clampNum(resources.diskMb, 2048, 0, 262144),
      gpuRequired: Boolean(resources.gpuRequired),
    },
    requirements: {
      database: Boolean(requirements.database),
      externalApi: Boolean(requirements.externalApi),
      credentials: Boolean(requirements.credentials),
      accountLogin: Boolean(requirements.accountLogin),
      networkDuringBuild: requirements.networkDuringBuild !== false,
      networkDuringRun: Boolean(requirements.networkDuringRun),
    },
    valueReasons: strArray(r.valueReasons),
    difficultyReasons: strArray(r.difficultyReasons),
    riskReasons: strArray(r.riskReasons),
    detectedFiles: strArray(r.detectedFiles),
    suspectedPorts: numArray(r.suspectedPorts),
    suspectedCommands: strArray(r.suspectedCommands),
    confidence: clampNum(r.confidence, 0.6, 0, 1),
  };
}

function ruleAssessment(repo: Record<string, unknown>, architecture = ''): Record<string, unknown> {
  const text = `${repo.name ?? ''} ${repo.description ?? ''} ${repo.topics ?? ''}`.toLowerCase();
  const arch = architecture.toLowerCase();
  const hasDockerfile = /dockerfile/i.test(arch) || /docker-compose|compose\.ya?ml/i.test(arch);
  const hasNode = /package\.json|yarn\.lock|pnpm-lock/i.test(arch);
  const hasPython = /pyproject\.toml|requirements\.txt|setup\.py/i.test(arch);
  const hasGo = /go\.mod/i.test(arch);
  const hasRust = /cargo\.toml/i.test(arch);
  const stars = Number(repo.stargazers_count) || 0;
  const valueScore = Math.min(100, Math.round(40 + Math.log10(Math.max(1, stars)) * 9));
  const difficultyScore = hasDockerfile ? 25 : hasNode || hasPython || hasGo || hasRust ? 55 : 72;
  const testabilityScore = hasNode || hasPython ? 70 : 55;
  const riskScore = /password|secret|api.?key|credential|database|auth/i.test(text) ? 45 : 20;
  const detectedFiles: string[] = [];
  if (/dockerfile/i.test(arch)) detectedFiles.push('Dockerfile');
  if (/docker-compose|compose\.ya?ml/i.test(arch)) detectedFiles.push('compose.yaml');
  if (hasNode) detectedFiles.push('package.json');
  if (hasPython) detectedFiles.push('pyproject.toml');
  if (hasGo) detectedFiles.push('go.mod');
  if (hasRust) detectedFiles.push('Cargo.toml');
  const suggestedPort = hasNode ? 3000 : hasPython ? 8000 : hasGo ? 8080 : 3000;
  const level = valueScore >= 70 && difficultyScore <= 35 && riskScore <= 30 ? 'AUTO_TEST' : difficultyScore >= 70 || riskScore >= 60 ? 'MANUAL_TEST' : 'AGENT_ASSISTED_TEST';
  const method = /docker-compose|compose\.ya?ml/i.test(arch) ? 'OFFICIAL_COMPOSE' : hasDockerfile ? 'OFFICIAL_DOCKERFILE' : hasNode || hasPython || hasGo || hasRust ? 'PACKAGE_MANAGER' : 'AGENT_GENERATED';
  return {
    deploymentValueScore: valueScore,
    deploymentDifficultyScore: difficultyScore,
    testabilityScore,
    riskScore,
    recommendedLevel: level,
    recommendedMethod: method,
    estimatedResources: { cpu: difficultyScore <= 35 ? 1 : 2, memoryMb: difficultyScore <= 35 ? 1024 : 2048, diskMb: 2048, gpuRequired: false },
    requirements: { database: /database|postgres|mysql|mongodb|redis/i.test(text), externalApi: false, credentials: /password|secret|api.?key|token|auth/i.test(text), accountLogin: /login|account|sign.?in|oauth/i.test(text), networkDuringBuild: true, networkDuringRun: false },
    valueReasons: [stars >= 500 ? '仓库采用度高，具有明确使用价值' : '功能定位清晰，具备本地使用价值'],
    difficultyReasons: [hasDockerfile ? '提供官方容器化入口' : '需要从源码安装依赖并运行'],
    riskReasons: riskScore >= 40 ? ['涉及凭据、账号或数据库，需人工确认配置'] : [],
    detectedFiles,
    suspectedPorts: [suggestedPort],
    suspectedCommands: [hasNode ? 'npm run build && npm run start' : hasPython ? 'pip install -r requirements.txt && python main.py' : '请参考项目 README'],
    confidence: 0.6,
  };
}

export interface DeploymentAssessmentResult {
  valueScore: number;
  difficultyScore: number;
  testabilityScore: number;
  riskScore: number;
  recommendedLevel: string;
  recommendedMethod: string;
  assessmentJson: Record<string, unknown>;
  aiConfigId: string | null;
  confidence: number | null;
  source: 'ai' | 'rule';
}

export async function generateDeploymentAssessment(repo: Record<string, unknown>, readme: string, architecture: string): Promise<DeploymentAssessmentResult> {
  const aiConfig = getActiveAIConfigRow();
  const fallback = ruleAssessment(repo, architecture);
  if (!aiConfig) return { valueScore: fallback.deploymentValueScore as number, difficultyScore: fallback.deploymentDifficultyScore as number, testabilityScore: fallback.testabilityScore as number, riskScore: fallback.riskScore as number, recommendedLevel: fallback.recommendedLevel as string, recommendedMethod: fallback.recommendedMethod as string, assessmentJson: fallback, aiConfigId: null, confidence: fallback.confidence as number, source: 'rule' };
  try {
    const prompt = `你是开源项目部署评估专家。基于公开仓库信息给出部署分析。只返回 JSON，字段：deploymentValueScore(0-100),deploymentDifficultyScore(0-100),testabilityScore(0-100),riskScore(0-100),recommendedLevel(AUTO_TEST|AGENT_ASSISTED_TEST|MANUAL_TEST|SKIP),recommendedMethod(OFFICIAL_COMPOSE|OFFICIAL_DOCKERFILE|OFFICIAL_RELEASE|PACKAGE_MANAGER|AGENT_GENERATED),estimatedResources{cpu,memoryMb,diskMb,gpuRequired},requirements{database,externalApi,credentials,accountLogin,networkDuringBuild,networkDuringRun},valueReasons[],difficultyReasons[],riskReasons[],detectedFiles[],suspectedPorts[],suspectedCommands[],confidence(0-1)。不得虚构仓库未提供的能力。\n仓库：${repo.full_name}\nDescription：${repo.description ?? ''}\nTopics：${repo.topics ?? '[]'}\n语言：${repo.language ?? '未知'}\nLicense：${repo.license ?? '未知'}\nStars：${repo.stargazers_count ?? 0}\n根目录工程结构：\n${architecture || '未获取到工程结构'}\nREADME：\n${readme || '未获取到 README'}`;
    const content = await requestJsonContent(aiConfig, prompt, 1000, 0.1);
    const raw = JSON.parse(content);
    const parsed = deploymentAssessmentSchema.safeParse(raw);
    const assessment = parsed.success ? parsed.data : normalizeAssessment(raw);
    return { valueScore: assessment.deploymentValueScore, difficultyScore: assessment.deploymentDifficultyScore, testabilityScore: assessment.testabilityScore, riskScore: assessment.riskScore, recommendedLevel: assessment.recommendedLevel, recommendedMethod: assessment.recommendedMethod, assessmentJson: assessment as unknown as Record<string, unknown>, aiConfigId: String(aiConfig.id ?? ''), confidence: assessment.confidence, source: 'ai' };
  } catch (error) {
    logger.errorFromError('ai.deployment-assessment', 'Deployment assessment AI failed; using rule fallback', error, { repoId: repo.id });
    return { valueScore: fallback.deploymentValueScore as number, difficultyScore: fallback.deploymentDifficultyScore as number, testabilityScore: fallback.testabilityScore as number, riskScore: fallback.riskScore as number, recommendedLevel: fallback.recommendedLevel as string, recommendedMethod: fallback.recommendedMethod as string, assessmentJson: fallback, aiConfigId: null, confidence: fallback.confidence as number, source: 'rule' };
  }
}

function rulePlan(repo: Record<string, unknown>, assessment: Record<string, unknown>, architecture = ''): Record<string, unknown> {
  const method = String(assessment.recommendedMethod ?? 'OFFICIAL_DOCKERFILE');
  const ports = numArray(assessment.suspectedPorts);
  const port = ports[0] ?? 3000;
  const detectedFiles = strArray(assessment.detectedFiles);
  const arch = architecture.toLowerCase();
  const hasDockerfile = detectedFiles.some((file) => /dockerfile/i.test(file)) || /dockerfile/i.test(arch);
  const hasCompose = detectedFiles.some((file) => /compose/i.test(file)) || /docker-compose|compose\.ya?ml/i.test(arch);
  const hasNode = /package\.json/i.test(arch);
  const hasPython = /pyproject\.toml|requirements\.txt|setup\.py/i.test(arch);
  const hasGo = /go\.mod/i.test(arch);
  const hasRust = /cargo\.toml/i.test(arch);
  const steps = hasCompose
    ? [{ id: 'inspect-official-workflow', type: 'command', command: '阅读 README 与 Compose 配置，确认可安全执行的本地测试入口' }, { id: 'local-test', type: 'command', command: '按仓库官方文档执行最小可复现的构建和功能测试' }]
    : hasDockerfile
      ? [{ id: 'inspect-official-workflow', type: 'command', command: '阅读 README、Dockerfile 与测试配置，确认本地测试入口' }, { id: 'local-test', type: 'command', command: '优先运行仓库已有测试；必要时构建并验证关键本地功能' }]
      : hasGo
        ? [{ id: 'inspect-workflow', type: 'command', command: '阅读 README、Makefile 与 Go 包配置，确认构建和测试目标' }, { id: 'local-test', type: 'command', command: '优先执行 README 或 Makefile 提供的构建、测试和 CLI 功能验证' }]
        : hasNode || hasPython || hasRust
          ? [{ id: 'inspect-workflow', type: 'command', command: '阅读 README、包管理器脚本与测试配置，确认本地功能测试入口' }, { id: 'local-test', type: 'command', command: '安装最小依赖后优先运行已有测试，并验证一个关键本地功能' }]
          : [{ id: 'inspect', type: 'command', command: '检查仓库结构、README 和测试配置，选择可在隔离工作区验证的功能' }];
  return {
    schemaVersion: 1,
    strategy: method,
    summary: '在隔离工作区按仓库官方部署方式完成本地部署，再按测试配置进行多项功能验证；Agent 可在安全策略内调整测试路径，并产出简要报告。',
    testLevel: 'L2',
    estimatedResources: assessment.estimatedResources ?? { cpu: 2, memoryMb: 1024, diskMb: 2048 },
    requirements: assessment.requirements ?? { environmentVariables: [], credentials: [], database: false, networkDuringBuild: true, networkDuringRun: false },
    steps,
    blockers: [],
    needsUserApproval: false,
  };
}

export interface DeploymentPlanResult {
  planJson: Record<string, unknown>;
  summary: string;
  source: 'ai' | 'rule';
  model: string | null;
}

export async function generateDeploymentPlan(repo: Record<string, unknown>, assessment: Record<string, unknown>, readme = '', architecture = ''): Promise<DeploymentPlanResult> {
  const aiConfig = getActiveAIConfigRow();
  const fallback = rulePlan(repo, assessment, architecture);
  if (!aiConfig) return { planJson: fallback, summary: String(fallback.summary ?? ''), source: 'rule', model: null };
  try {
    const prompt = `基于公开仓库的真实信息生成结构化“本地功能测试计划”JSON。目标是在隔离工作区让 Agent 验证尽可能多的真实功能，而不是机械地完成部署或要求 Web 首页 HTTP 200。建议流程只是起点：Agent 会阅读完整 README、测试配置和源码，并可在安全策略范围内调整命令、补充合理的本地测试和最小修复。优先使用仓库已有的 test/check/build/Makefile/CLI 示例；只有项目明确是 Web 服务且可安全启动时才加入 http_check。CLI、桌面端、库、MCP 或 Agent 项目应验证相应二进制、单元测试、命令帮助、样例或核心调用，不要为了 HTTP 校验虚构端口或服务。每次测试最后必须生成简要报告，说明已验证功能、证据、未覆盖项和失败原因。strategy 只能是 OFFICIAL_COMPOSE|OFFICIAL_DOCKERFILE|OFFICIAL_RELEASE|PACKAGE_MANAGER|AGENT_GENERATED。testLevel 只能是 L0|L1|L2|L3。steps 每项 type 只能是 docker_build|docker_run|http_check|command。hostPort 用 "dynamic"。不得虚构仓库中不存在的文件、命令、端口或外部凭据。只返回字段：schemaVersion,strategy,summary,testLevel,estimatedResources{cpu,memoryMb,diskMb},requirements{environmentVariables[],credentials[],database,externalApi,accountLogin,networkDuringBuild,networkDuringRun},steps[{id,type,context?,dockerfile?,containerPort?,hostPort?,path?,expectedStatus?,command?}],blockers[],needsUserApproval。\n仓库：${repo.full_name}\nDescription：${repo.description ?? ''}\nTopics：${repo.topics ?? '[]'}\n语言：${repo.language ?? '未知'}\n根目录工程结构：\n${architecture || '未获取到工程结构'}\nREADME：\n${readme || '未获取到 README'}\n部署分析：${JSON.stringify(assessment)}`;
    const content = await requestJsonContent(aiConfig, prompt, 1400, 0.1);
    const raw = JSON.parse(content);
    const parsed = deploymentPlanSchema.safeParse(raw);
    if (parsed.success) return { planJson: parsed.data as unknown as Record<string, unknown>, summary: parsed.data.summary, source: 'ai', model: String(aiConfig.model ?? '') };
    const rawResources = (raw?.estimatedResources ?? {}) as Record<string, unknown>;
    const rawRequirements = (raw?.requirements ?? {}) as Record<string, unknown>;
    const fallbackResources = (fallback.estimatedResources ?? {}) as Record<string, unknown>;
    const fallbackRequirements = (fallback.requirements ?? {}) as Record<string, unknown>;
    const merged = { ...(raw ?? {}), estimatedResources: { ...rawResources, ...fallbackResources }, requirements: { ...fallbackRequirements, ...rawRequirements } };
    return { planJson: merged, summary: String(merged.summary ?? fallback.summary ?? ''), source: 'ai', model: String(aiConfig.model ?? '') };
  } catch (error) {
    logger.errorFromError('ai.deployment-plan', 'Deployment plan AI failed; using rule fallback', error, { repoId: repo.id });
    return { planJson: fallback, summary: String(fallback.summary ?? ''), source: 'rule', model: null };
  }
}
