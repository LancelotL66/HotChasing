import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { decrypt } from '../services/crypto.js';
import { config } from '../config.js';

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': 'HotChasing' };
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get('github_token') as { value?: string } | undefined;
    if (row?.value) {
      const token = decrypt(row.value, config.encryptionKey);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // 无 Token 或解密失败时退化为匿名请求
  }
  return headers;
}

export const PRIMARY_CATEGORIES = ['AI 与 Agent', '开发者工具', '数据与数据库', '基础设施与 DevOps', '效率与自动化', '设计与内容创作', '安全与隐私', '桌面与移动应用', '学习与研究', '其他 / 待分类'] as const;
export type PrimaryCategory = typeof PRIMARY_CATEGORIES[number];

export interface ProjectClassification {
  primaryCategory: PrimaryCategory;
  secondaryCategories: string[];
  functionTags: string[];
  productForms: string[];
  platformTags: string[];
  targetUsers: string[];
  deploymentModes: string[];
  deploymentDifficulty: string;
  hotReasonTags: string[];
  maturity: string;
  costTags: string[];
  license: string;
  commercialUseTags: string[];
  privacyTags: string[];
  confidence: number;
  reason: string;
  source: 'ai' | 'rule';
  sourceHash: string;
}

const contains = (text: string, words: string[]) => words.some((word) => {
  // English taxonomy terms require word boundaries: "arbitrage" is not RAG.
  if (/^[a-z0-9 .-]+$/i.test(word)) {
    const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
  }
  return text.includes(word);
});
const take = (values: string[], maximum: number) => [...new Set(values)].slice(0, maximum);

export function classificationSourceHash(repo: Record<string, unknown>, readme = '', architecture = ''): string {
  return createHash('sha256').update(JSON.stringify(['taxonomy-ai-boundaries-v5', repo.full_name, repo.description, repo.topics, repo.language, repo.license, repo.updated_at, readme, architecture])).digest('hex');
}

export async function fetchRepositoryReadme(fullName: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return '';
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: { Accept: 'application/vnd.github.raw+json', ...githubHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok ? (await response.text()).slice(0, 12000) : '';
  } catch { return ''; }
}

export async function fetchRepositoryArchitecture(fullName: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return '';
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/contents`, {
      headers: { Accept: 'application/vnd.github+json', ...githubHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return '';
    const entries = await response.json() as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(entries)) return '';
    const names = entries.slice(0, 80).map((entry) => `${entry.type === 'dir' ? 'dir' : 'file'}:${entry.name ?? ''}`);
    return names.join('\n');
  } catch { return ''; }
}

export async function fetchRepositoryEnrichment(repo: Record<string, unknown>): Promise<{ readme: string; architecture: string }> {
  const updatedAt = typeof repo.updated_at === 'string' ? repo.updated_at : '';
  const cachedAt = typeof repo.enrichment_updated_at === 'string' ? repo.enrichment_updated_at : '';
  const cachedReadme = typeof repo.enrichment_readme === 'string' ? repo.enrichment_readme : '';
  const cachedArchitecture = typeof repo.enrichment_architecture === 'string' ? repo.enrichment_architecture : '';
  // 仅在缓存确实有内容时复用；之前限流写入的空缓存需要重新拉取
  if (updatedAt && updatedAt === cachedAt && (cachedReadme || cachedArchitecture)) {
    return { readme: cachedReadme, architecture: cachedArchitecture };
  }

  const fullName = String(repo.full_name ?? '');
  const [readme, architecture] = await Promise.all([fetchRepositoryReadme(fullName), fetchRepositoryArchitecture(fullName)]);
  if (repo.id !== undefined) {
    getDb().prepare('UPDATE repositories SET enrichment_readme=?,enrichment_architecture=?,enrichment_updated_at=? WHERE id=?')
      .run(readme, architecture, updatedAt || null, repo.id);
  }
  return { readme, architecture };
}

export function classifyProjectByRules(repo: Record<string, unknown>): ProjectClassification {
  const text = `${repo.name ?? ''} ${repo.description ?? ''} ${repo.topics ?? ''}`.toLowerCase();
  const tags: string[] = []; const platforms: string[] = []; const forms: string[] = []; const deploy: string[] = []; const users: string[] = [];
  let primary: PrimaryCategory = '其他 / 待分类'; let confidence = 0.62; let reason = '仓库公开信息不足，进入待分类。';
  if (contains(text, ['vue'])) { primary = '数据与数据库'; confidence = 0.76; reason = '前端框架在本分类体系中归入数据与数据库。'; users.push('开发者'); }
  else if (contains(text, ['framework', 'runtime', 'compiler', 'game engine', 'visualization'])) { primary = '基础设施与 DevOps'; confidence = 0.78; reason = '项目提供应用或软件生态的底层框架、运行时、编译器、引擎或可视化基础能力。'; users.push('开发者'); }
  else if (contains(text, ['agent', 'llm', 'rag', 'ai ', 'artificial intelligence', 'model', 'gpt', 'embedding'])) { primary = 'AI 与 Agent'; confidence = 0.84; reason = '项目核心描述包含模型、智能体或 AI 应用能力。'; if (contains(text, ['agent'])) tags.push('AI Agent'); if (contains(text, ['rag'])) tags.push('RAG'); if (contains(text, ['embedding', 'vector'])) tags.push('向量检索'); if (contains(text, ['code', 'coding'])) tags.push('AI 编程'); users.push('AI 工程师', '开发者'); }
  else if (contains(text, ['database', 'sql', 'etl', 'data pipeline', 'analytics', 'search engine'])) { primary = '数据与数据库'; confidence = 0.82; reason = '项目核心描述指向数据存储、处理、分析或检索。'; if (contains(text, ['database'])) tags.push('数据库'); if (contains(text, ['etl', 'pipeline'])) tags.push('数据管道'); if (contains(text, ['search'])) tags.push('搜索引擎'); users.push('数据工程师', '开发者'); }
  else if (contains(text, ['docker', 'kubernetes', 'devops', 'terraform', 'monitoring', 'proxy', 'gateway'])) { primary = '基础设施与 DevOps'; confidence = 0.8; reason = '项目核心描述指向部署、运维、网络或可观测性。'; if (contains(text, ['docker'])) tags.push('Docker'); if (contains(text, ['kubernetes'])) tags.push('Kubernetes'); if (contains(text, ['monitoring'])) tags.push('监控'); users.push('DevOps 工程师', '开发者'); }
  else if (contains(text, ['security', 'privacy', 'auth', 'oauth', 'password', 'vulnerability'])) { primary = '安全与隐私'; confidence = 0.8; reason = '项目核心描述指向安全、认证、漏洞或隐私保护。'; if (contains(text, ['auth', 'oauth'])) tags.push('身份认证'); if (contains(text, ['privacy'])) tags.push('隐私保护'); users.push('安全工程师', '开发者'); }
  else if (contains(text, ['note', 'task', 'workflow', 'automation', 'productivity', 'calendar'])) { primary = '效率与自动化'; confidence = 0.78; reason = '项目核心描述指向任务、知识管理或流程自动化。'; if (contains(text, ['workflow', 'automation'])) tags.push('工作流自动化'); if (contains(text, ['note'])) tags.push('知识库'); users.push('普通个人用户', '团队'); }
  else if (contains(text, ['awesome list', 'awesome lists', 'resource list', 'learning path', 'study plan', 'course', 'tutorial', 'interview university', 'coding interview', 'computer science curriculum', '学习路径', '资源索引', '面试准备'])) { primary = '学习与研究'; confidence = 0.84; reason = '项目核心内容是学习路径、教程、面试准备或主题资源索引。'; if (contains(text, ['awesome', 'resource list', '资源索引'])) tags.push('资源索引'); if (contains(text, ['interview', '面试'])) tags.push('面试准备'); if (contains(text, ['course', 'tutorial', 'learning path', 'study plan', '学习路径'])) tags.push('学习路径'); users.push('学习者', '开发者'); }
  else if (contains(text, ['build your own', 'from scratch', 'programming', 'coding', 'algorithm', 'algorithms', 'data structure', 'data structures', '数据结构', '算法', 'editor', 'ide', 'cli', 'developer tool', 'testing', 'git', 'api'])) { primary = '开发者工具'; confidence = 0.8; reason = '项目核心描述面向编程实践、算法实现或软件开发。'; if (contains(text, ['build your own', 'from scratch'])) tags.push('编程实践'); if (contains(text, ['algorithm', 'algorithms', 'data structure', 'data structures', '数据结构', '算法'])) tags.push('算法实现'); if (contains(text, ['cli'])) tags.push('CLI'); if (contains(text, ['test'])) tags.push('测试'); if (contains(text, ['api'])) tags.push('API 开发'); users.push('开发者'); }
  if (contains(text, ['docker', 'container'])) { platforms.push('Docker'); deploy.push('Docker'); forms.push('Self-hosted Service'); }
  if (contains(text, ['web', 'browser'])) { platforms.push('Browser'); forms.push('Web App'); }
  if (contains(text, ['cli', 'command line'])) forms.push('CLI');
  if (repo.language) platforms.push(String(repo.language));
  if (!forms.length) forms.push('Library');
  const license = typeof repo.license === 'string' && repo.license ? String(repo.license) : 'License Unknown';
  const commercial = license === 'MIT' || license === 'Apache-2.0' || license === 'BSD' ? ['允许商业使用', '需要保留版权'] : ['商用需确认'];
  return { primaryCategory: primary, secondaryCategories: [], functionTags: take(tags, 8), productForms: take(forms, 3), platformTags: take(platforms, 6), targetUsers: take(users.length ? users : ['技术爱好者'], 5), deploymentModes: take(deploy.length ? deploy : ['本地源码运行'], 5), deploymentDifficulty: deploy.length ? '低' : '中', hotReasonTags: ['今日新上榜'], maturity: '未知', costTags: ['开源免费'], license, commercialUseTags: commercial, privacyTags: deploy.length ? ['支持私有部署'] : [], confidence, reason, source: 'rule', sourceHash: classificationSourceHash(repo) };
}
