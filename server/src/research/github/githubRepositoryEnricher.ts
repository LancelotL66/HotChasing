import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import { githubHeaders } from '../../discovery/classificationService.js';
import { logger } from '../../services/logger.js';

/**
 * 仓库补充：只对高潜力候选读取 README、根目录文件与部署相关文件。
 * 禁止默认递归读取整个仓库；README Hash 未变化时复用分析缓存。
 */

const DEPLOYMENT_FILES = [
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
  'compose.yml',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'environment.yml',
  'Cargo.toml',
  'go.mod',
  'Makefile',
  'setup.py',
  'pom.xml',
  'build.gradle',
];

export interface RepositoryEnrichment {
  readmeText: string;
  readmeHash: string;
  rootFiles: string[];
  deploymentFiles: string[];
  fromCache: boolean;
  partial: boolean;
}

export interface AnalysisCacheRow {
  github_node_id: string;
  source_commit_sha: string | null;
  readme_hash: string | null;
  readme_text: string | null;
  root_files_json: string | null;
  deployment_files_json: string | null;
  structured_analysis_json: string | null;
  analysis_model: string | null;
  analysis_version: string | null;
  analyzed_at: string;
}

export function getAnalysisCache(nodeId: string): AnalysisCacheRow | undefined {
  return getDb().prepare('SELECT * FROM github_repository_analysis_cache WHERE github_node_id=?').get(nodeId) as AnalysisCacheRow | undefined;
}

function safeParseArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

async function fetchReadme(fullName: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return '';
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: { Accept: 'application/vnd.github.raw+json', ...githubHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    return response.ok ? (await response.text()).slice(0, 14000) : '';
  } catch {
    return '';
  }
}

async function fetchRootFiles(fullName: string): Promise<string[]> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return [];
  try {
    const response = await fetch(`https://api.github.com/repos/${fullName}/contents`, {
      headers: { Accept: 'application/vnd.github+json', ...githubHeaders() },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return [];
    const entries = await response.json() as Array<{ name?: string; type?: string }>;
    if (!Array.isArray(entries)) return [];
    return entries.slice(0, 100).map((entry) => `${entry.type === 'dir' ? 'dir' : 'file'}:${entry.name ?? ''}`);
  } catch {
    return [];
  }
}

/**
 * 读取并缓存单个仓库的补充信息。
 * pushedAt 用于判断仓库是否更新：未更新且缓存有内容时直接复用，不发起网络请求。
 */
export async function enrichRepository(nodeId: string, fullName: string, pushedAt: string | null): Promise<RepositoryEnrichment> {
  const cached = getAnalysisCache(nodeId);
  if (cached && cached.readme_text && cached.source_commit_sha === (pushedAt ?? '')) {
    return {
      readmeText: cached.readme_text,
      readmeHash: cached.readme_hash ?? '',
      rootFiles: safeParseArray(cached.root_files_json),
      deploymentFiles: safeParseArray(cached.deployment_files_json),
      fromCache: true,
      partial: false,
    };
  }

  const readmeText = await fetchReadme(fullName);
  const rootFiles = await fetchRootFiles(fullName);
  const readmeHash = createHash('sha256').update(readmeText).digest('hex');
  const fileNames = rootFiles.map((entry) => entry.replace(/^(file|dir):/, ''));
  const deploymentFiles = DEPLOYMENT_FILES.filter((file) => fileNames.some((name) => name.toLowerCase() === file.toLowerCase()));
  const partial = readmeText.length === 0 && rootFiles.length === 0;

  try {
    const db = getDb();
    const existing = getAnalysisCache(nodeId);
    // README Hash 未变化时保留已有的 AI 分析，避免重复调用模型。
    const keepAnalysis = existing && existing.readme_hash === readmeHash;
    db.prepare(
      `INSERT INTO github_repository_analysis_cache
         (github_node_id, source_commit_sha, readme_hash, readme_text, root_files_json, deployment_files_json,
          structured_analysis_json, analysis_model, analysis_version, analyzed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(github_node_id) DO UPDATE SET
         source_commit_sha=excluded.source_commit_sha, readme_hash=excluded.readme_hash, readme_text=excluded.readme_text,
         root_files_json=excluded.root_files_json, deployment_files_json=excluded.deployment_files_json,
         structured_analysis_json=excluded.structured_analysis_json, analysis_model=excluded.analysis_model,
         analysis_version=excluded.analysis_version, analyzed_at=excluded.analyzed_at`,
    ).run(
      nodeId,
      pushedAt ?? '',
      readmeHash,
      readmeText,
      JSON.stringify(rootFiles),
      JSON.stringify(deploymentFiles),
      keepAnalysis ? existing?.structured_analysis_json ?? null : null,
      keepAnalysis ? existing?.analysis_model ?? null : null,
      keepAnalysis ? existing?.analysis_version ?? null : null,
      new Date().toISOString(),
    );
  } catch (error) {
    logger.errorFromError('research.enrich', '写入仓库分析缓存失败', error, { fullName });
  }

  return { readmeText, readmeHash, rootFiles, deploymentFiles, fromCache: false, partial };
}

export function saveStructuredAnalysis(nodeId: string, analysisJson: string, model: string | null, analysisVersion: string): void {
  getDb()
    .prepare('UPDATE github_repository_analysis_cache SET structured_analysis_json=?, analysis_model=?, analysis_version=?, analyzed_at=? WHERE github_node_id=?')
    .run(analysisJson, model, analysisVersion, new Date().toISOString(), nodeId);
}
