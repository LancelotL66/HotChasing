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
const top100EnrichmentSchema = classificationSchema.extend({ summaryZh: z.string().min(20).max(180) });

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
  // Reuse the existing application setting used by Stars Manager's AIService.
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
    const raw = JSON.parse(content.replace(/^```json\s*|\s*```$/g, '').trim()); const parsed = top100EnrichmentSchema.parse({ ...raw, deploymentDifficulty: normalizeDeploymentDifficulty(raw.deploymentDifficulty) });
    const { summaryZh, ...classification } = parsed;
    return { classification: { ...classification, source: 'ai', sourceHash }, summary: summaryZh, summarySource: 'ai', model };
  } catch (error) { logger.errorFromError('ai.top100-enrichment', 'Top100 AI enrichment failed; using rule fallback', error, { repoId: repo.id }); return { classification: { ...fallback, sourceHash }, summary: summaryFallback, summarySource: 'rule', model: null }; }
}
